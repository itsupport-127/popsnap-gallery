const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { db, getSetting, setSetting, retentionDays, DATA_DIR } = require("./db");
const zipEnabled = () => getSetting("zip_enabled", "1") !== "0";
const zipMode = () => { const v = getSetting("zip_enabled", "1"); return v === "0" ? "0" : v === "2" ? "2" : "1"; }; // 1 = ZIP, 0 = tanpa ZIP, 2 = keduanya
const s3 = require("./s3");
const auth = require("./auth");
const { streamZip, zipSize } = require("./zip");
const { renderPage, landingPage, messagePage, catFiles } = require("./page");

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", true);
const PUBLIC_URL = () => String(process.env.PUBLIC_URL || "").replace(/\/+$/, "");
const TOKEN_RE = /^[A-Za-z0-9_-]{10,40}$/;
// Kode baru = 10 karakter kapital/angka (mudah diketik): abaikan spasi, tanda hubung, dan huruf kecil. Token lama (16+ karakter) apa adanya.
const normToken = (t) => { const s = String(t || ""); const c = s.replace(/[\s-]/g, "").toUpperCase(); return /^[23456789A-HJ-NP-Z]{10}$/.test(c) ? c : s; };
const EXTS = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", mp4: "video/mp4", webm: "video/webm" };
const MAX_FILE = 300 * 1024 * 1024, MAX_FILES = 80;
const KINDS = {
  final: { group: "main", rank: 1, label: () => "Foto template", name: () => "popsnap-foto" },
  boomerang: { group: "main", rank: 2, label: () => "Boomerang", name: () => "popsnap-boomerang" },
  video: { group: "main", rank: 3, label: () => "Video", name: () => "popsnap-video" },
  live: { group: "main", rank: 4, label: () => "Video Live (momen bergerak)", name: () => "popsnap-live" },
  gif: { group: "main", rank: 5, label: () => "GIF foto", name: () => "popsnap-gif" },
  gifplain: { group: "main", rank: 6, label: () => "GIF foto polos", name: () => "popsnap-gif-polos" },
  raw: { group: "raw", rank: 7, label: (i) => `Foto mentah ${i}`, name: (i) => `popsnap-mentah-${i}` },
  clip: { group: "clips", rank: 8, label: (i) => `Klip foto ${i}`, name: (i) => `popsnap-klip-${i}` },
};
const now = () => Date.now();
const safe = (s, max = 40) => String(s ?? "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, max) || "studio";

// ---------- pemilihan bucket ----------
function usedBytes() {
  const m = new Map();
  for (const r of db.prepare("SELECT bucket_id, SUM(MAX(size, 0)) used FROM files GROUP BY bucket_id").all()) m.set(r.bucket_id, r.used || 0);
  return m;
}
/** Bucket aktif dengan prioritas terkecil yang masih muat. `exclude` = bucket yang barusan gagal. */
function pickBucket(size, exclude = null) {
  const used = usedBytes();
  const list = db.prepare("SELECT * FROM buckets WHERE enabled = 1 ORDER BY priority, id").all()
    .filter((b) => b.id !== exclude && (!b.quota_bytes || (used.get(b.id) || 0) + size <= b.quota_bytes));
  if (!list.length) return null;
  const top = list[0].priority; // sama prioritas -> yang paling kosong dulu (bagi rata)
  return list.filter((b) => b.priority === top).sort((a, b) => (used.get(a.id) || 0) - (used.get(b.id) || 0))[0];
}
const bucketById = (id) => db.prepare("SELECT * FROM buckets WHERE id = ?").get(id);

// ---------- Studio: status pantauan, blokir, nama ----------
const skey = (n) => String(n || "").trim().toLowerCase();
const bearerOf = (req) => (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
const ONLINE_MS = 5 * 60 * 1000, RECENT_MS = 60 * 60 * 1000;
const studioStatus = (r) => (r.blocked ? "blocked" : !r.last_seen_at ? "never" : now() - r.last_seen_at < ONLINE_MS ? "online" : now() - r.last_seen_at < RECENT_MS ? "recent" : "offline");
/** Pindahkan / ganti nama studio (juga semua sesinya). Nama sudah dipakai studio lain = digabung ke studio itu. */
function renameStudio(oldKey, newName, { lock = false } = {}) {
  const name = String(newName).replace(/[<>]/g, "").trim().slice(0, 60);
  const row = db.prepare("SELECT * FROM studios WHERE skey = ?").get(oldKey);
  if (!row || !name) return null;
  const nk = skey(name);
  const target = nk !== oldKey ? db.prepare("SELECT * FROM studios WHERE skey = ?").get(nk) : null;
  if (target) { // gabung
    db.prepare("UPDATE sessions SET studio = ? WHERE lower(trim(studio)) = ?").run(target.name, oldKey);
    db.prepare("UPDATE studios SET last_seen_at = MAX(COALESCE(last_seen_at, 0), ?), first_seen_at = MIN(COALESCE(first_seen_at, ?), ?), note = CASE WHEN note = '' THEN ? ELSE note END, blocked = MAX(blocked, ?) WHERE skey = ?")
      .run(row.last_seen_at || 0, row.first_seen_at || now(), row.first_seen_at || now(), row.note, row.blocked, nk);
    db.prepare("DELETE FROM studios WHERE skey = ?").run(oldKey);
    return { merged: true, row: db.prepare("SELECT * FROM studios WHERE skey = ?").get(nk) };
  }
  db.prepare("UPDATE sessions SET studio = ? WHERE lower(trim(studio)) = ?").run(name, oldKey);
  db.prepare("UPDATE studios SET skey = ?, name = ?, name_locked = CASE WHEN ? THEN 1 ELSE name_locked END WHERE skey = ?").run(nk, name, lock ? 1 : 0, oldKey);
  return { merged: false, row: db.prepare("SELECT * FROM studios WHERE skey = ?").get(nk) };
}
/** Pastikan studio ada di daftar (tanpa mencatat 'terlihat'). */
function ensureStudio(name) {
  const n = String(name).replace(/[<>]/g, "").trim().slice(0, 60) || "Studio", k = skey(n);
  db.prepare("INSERT OR IGNORE INTO studios (skey, name, created_at) VALUES (?, ?, ?)").run(k, n, now());
  return db.prepare("SELECT * FROM studios WHERE skey = ?").get(k);
}
/** Dipanggil tiap booth menghubungi galeri: catat 'terlihat', ikuti nama dari kasir. Mengembalikan baris studio. */
function touchStudio(a, req, event) {
  const th = crypto.createHash("sha256").update(bearerOf(req)).digest("hex"), k = skey(a.studio), t = now();
  let row = db.prepare("SELECT * FROM studios WHERE token_hash = ?").get(th);
  if (row && row.skey !== k && !row.name_locked) { const r = renameStudio(row.skey, a.studio); row = r ? r.row : row; } // nama di kasir diganti -> ikut
  if (!row) row = ensureStudio(a.studio);
  db.prepare("UPDATE studios SET token_hash = ?, first_seen_at = COALESCE(first_seen_at, ?), last_seen_at = ?, last_ip = ?, last_event = ? WHERE skey = ?")
    .run(th, t, t, String(req.headers["x-real-ip"] || req.ip || "").slice(0, 64), event, row.skey);
  return db.prepare("SELECT * FROM studios WHERE skey = ?").get(row.skey);
}
/** Catat + tolak bila studio diputus admin. null = sudah dibalas 403. */
function studioGuard(a, req, res, event) {
  const row = touchStudio(a, req, event);
  if (row.blocked) { res.status(403).json({ error: "Studio ini diputus dari galeri oleh admin. Hubungi admin.", blocked: true }); return null; }
  return row;
}

// ---------- API booth ----------
app.use("/assets", express.static(path.join(__dirname, "..", "public"), { maxAge: "7d", index: false }));
app.use(["/api", "/admin/api"], express.json({ limit: "1mb" }));
app.get("/api/v1/ping", async (req, res) => {
  try {
    const a = await auth.verify((req.headers.authorization || "").replace(/^Bearer\s+/i, ""));
    if (!a) return res.status(401).json({ ok: false, error: "Token tidak valid." });
    const st = studioGuard(a, req, res, "ping"); if (!st) return;
    const buckets = db.prepare("SELECT COUNT(*) n FROM buckets WHERE enabled = 1").get().n;
    res.json({ ok: true, studio: st.name, buckets, retentionDays: st.retention_days || retentionDays() });
  } catch (e) { res.status(e.status || 500).json({ ok: false, error: e.message }); }
});

/** Daftarkan sesi + file, kembalikan daftar yang perlu diunggah. Dipakai booth (token studio) dan unggah manual dari website (login admin). */
// Izin foto dari tamu: bit 1 = boleh di sosmed, bit 2 = boleh dipajang di mading (3 = keduanya, 0 = tidak, NULL = belum dijawab)
const normSocial = (v) => (v === null || v === undefined || v === "" ? undefined : Number.isInteger(Number(v)) && Number(v) >= 0 && Number(v) <= 3 ? Number(v) : undefined);
function registerSession(studio, { token, mode, studioCode, files, retry, manual, social }) {
  token = normToken(token);
  if (!TOKEN_RE.test(String(token))) return { status: 400, error: "Token sesi tidak valid." };
  if (!Array.isArray(files) || files.length > MAX_FILES) return { status: 400, error: "Daftar file tidak valid." };
  let sess = db.prepare("SELECT * FROM sessions WHERE token = ?").get(token);
  if (sess && skey(sess.studio) !== skey(studio)) {
    if (sess.manual && !manual) { db.prepare("UPDATE sessions SET studio = ?, manual = 0 WHERE token = ?").run(studio, token); sess.studio = studio; } // booth menyusul: ambil alih sesi yang diunggah manual
    else if (!manual) return { status: 409, error: "Token sesi sudah dipakai studio lain." };
    else studio = sess.studio; // unggah manual untuk sesi yang sudah ada: ikut studio yang tercatat
  }
  if (!sess) {
    const t = now();
    db.prepare("INSERT INTO sessions (token, studio, studio_code, mode, created_at, expires_at, manual) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(token, studio, safe(studioCode, 20), String(mode || "photo").slice(0, 12), t, t + (db.prepare("SELECT retention_days r FROM studios WHERE skey = ?").get(skey(studio))?.r || retentionDays()) * 86400000, manual ? 1 : 0);
    sess = db.prepare("SELECT * FROM sessions WHERE token = ?").get(token);
  }
  const soc = normSocial(social);
  if (soc !== undefined && soc !== sess.social) db.prepare("UPDATE sessions SET social = ? WHERE token = ?").run(soc, token);
  const uploads = [], skipped = [];
  const d = new Date(sess.created_at), ym = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  for (const f of files) {
    const kind = KINDS[f?.kind] ? f.kind : null, ext = String(f?.ext || "").toLowerCase(), fid = safe(f?.fid, 30), size = Math.max(0, Number(f?.size) || 0);
    if (!kind || !EXTS[ext] || !f?.fid || size > MAX_FILE) { skipped.push({ fid: f?.fid, error: "File tidak valid" }); continue; }
    const row = db.prepare("SELECT * FROM files WHERE token = ? AND fid = ?").get(token, fid);
    if (row && row.state === "ok") continue;
    let bucket = row ? bucketById(row.bucket_id) : null;
    if (!bucket || !bucket.enabled || retry === fid) {
      bucket = pickBucket(size, retry === fid && row ? row.bucket_id : null) || pickBucket(size);
      if (!bucket) return { status: 503, error: "Tidak ada penyimpanan cloud yang aktif / masih muat. Atur di halaman admin galeri." };
    }
    const key = `${sess.studio_code}/${ym}/${token}/${fid}.${ext}`;
    if (row) db.prepare("UPDATE files SET bucket_id = ?, key = ?, size = ?, state = 'pending' WHERE id = ?").run(bucket.id, key, size, row.id);
    else db.prepare("INSERT INTO files (token, fid, kind, idx, ext, size, bucket_id, key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(token, fid, kind, Math.max(0, Math.min(99, Number(f.idx) || 0)), ext, size, bucket.id, key, now());
    uploads.push({ fid: f.fid, url: s3.presign(bucket, "PUT", key, { expires: 3600 }), contentType: EXTS[ext] });
  }
  return { status: 200, body: { ok: true, shareUrl: PUBLIC_URL() ? `${PUBLIC_URL()}/s/${token}` : `/s/${token}`, expiresAt: sess.expires_at, uploads, skipped } };
}

app.post("/api/v1/sessions", async (req, res) => {
  try {
    const a = await auth.verify((req.headers.authorization || "").replace(/^Bearer\s+/i, ""));
    if (!a) return res.status(401).json({ error: "Token tidak valid." });
    const st = studioGuard(a, req, res, "sessions"); if (!st) return;
    const r = registerSession(st.name, req.body || {});
    if (r.error) return res.status(r.status).json({ error: r.error });
    res.json(r.body);
  } catch (e) { console.error("[sessions]", e.message); res.status(e.status || 500).json({ error: e.message }); }
});

app.post("/api/v1/sessions/:token/done", async (req, res) => {
  try {
    const a = await auth.verify((req.headers.authorization || "").replace(/^Bearer\s+/i, ""));
    if (!a) return res.status(401).json({ error: "Token tidak valid." });
    const row = db.prepare("SELECT f.*, s.studio FROM files f JOIN sessions s ON s.token = f.token WHERE f.token = ? AND f.fid = ?").get(req.params.token, safe(req.body?.fid, 30));
    if (!row || skey(row.studio) !== skey(a.studio)) return res.status(404).json({ error: "File tidak ditemukan." });
    if (!studioGuard(a, req, res, "upload")) return;
    const b = bucketById(row.bucket_id);
    const r = await s3.call(b, "HEAD", row.key, { timeoutMs: 15000 }).catch(() => null);
    if (!r || !r.ok) return res.status(409).json({ error: `File belum ada di cloud (${r ? r.status : "tidak terjangkau"}).` });
    const len = Number(r.headers.get("content-length")) || row.size;
    db.prepare("UPDATE files SET state = 'ok', size = ?, uploaded_at = ? WHERE id = ?").run(len, now(), row.id);
    db.prepare("UPDATE sessions SET last_file_at = ? WHERE token = ?").run(now(), row.token);
    warmThumb(row);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Booth memperbarui izin foto sesi (admin mengubahnya di booth).
app.post("/api/v1/sessions/:token/social", async (req, res) => {
  try {
    const a = await auth.verify((req.headers.authorization || "").replace(/^Bearer\s+/i, ""));
    if (!a) return res.status(401).json({ error: "Token tidak valid." });
    const token = normToken(req.params.token);
    const s = TOKEN_RE.test(String(token)) ? db.prepare("SELECT studio FROM sessions WHERE token = ?").get(token) : null;
    if (!s || skey(s.studio) !== skey(a.studio)) return res.status(404).json({ error: "Sesi tidak ditemukan." });
    const v = req.body?.social === null ? null : normSocial(req.body?.social);
    if (v === undefined) return res.status(400).json({ error: "Nilai izin harus 0-3 atau null." });
    db.prepare("UPDATE sessions SET social = ? WHERE token = ?").run(v, token);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Status ringkas banyak sesi sekaligus (dipakai kasir untuk menandai "belum terupload" / "sudah terupload", termasuk unggah manual dari CS).
// Tanpa login: token sesi sudah rahasia; yang dikembalikan hanya jumlah file dan izin, bukan isi atau link file.
app.post("/api/v1/status", (req, res) => {
  const list = Array.isArray(req.body?.tokens) ? req.body.tokens.slice(0, 60) : [];
  const out = {};
  for (const raw of list) {
    const token = normToken(raw);
    if (!TOKEN_RE.test(String(token))) continue;
    const s = db.prepare("SELECT token, social, expires_at FROM sessions WHERE token = ?").get(token);
    const files = s ? db.prepare("SELECT COUNT(*) n FROM files WHERE token = ? AND state = 'ok'").get(token).n : 0;
    out[raw] = { exists: !!s, files, expired: !!s && s.expires_at < now(), social: s ? s.social : null };
  }
  res.set("Cache-Control", "no-store").json({ ok: true, sessions: out });
});

// Booth menghapus sesi (transaksi dihapus/diedit di kasir): halaman langsung tidak bisa dibuka, file dibersihkan dari bucket.
// Idempoten: sesi yang sudah tidak ada dianggap selesai. Sisa file (kalau bucket sedang bermasalah) dibereskan cleanup berkala.
app.delete("/api/v1/sessions/:token", async (req, res) => {
  try {
    const a = await auth.verify((req.headers.authorization || "").replace(/^Bearer\s+/i, ""));
    if (!a) return res.status(401).json({ error: "Token tidak valid." });
    const token = normToken(req.params.token);
    const s = TOKEN_RE.test(String(token)) ? db.prepare("SELECT studio FROM sessions WHERE token = ?").get(token) : null;
    if (!s || skey(s.studio) !== skey(a.studio)) return res.status(404).json({ error: "Sesi tidak ditemukan." });
    if (!studioGuard(a, req, res, "delete")) return;
    db.prepare("UPDATE sessions SET expires_at = ? WHERE token = ?").run(now() - 1000, token); // langsung kedaluwarsa
    const gone = await purgeSession(token);
    res.json({ ok: true, deleted: gone });
  } catch (e) { console.error("[sessions.delete]", e.message); res.status(e.status || 500).json({ error: e.message }); }
});

// ---------- halaman publik ----------
const noStore = (res) => res.set({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex" });
const load = (token) => {
  token = normToken(token);
  if (!TOKEN_RE.test(String(token))) return null;
  const s = db.prepare("SELECT * FROM sessions WHERE token = ?").get(token);
  if (!s || s.expires_at < now()) return null;
  return s;
};
// Waktu tanda tangan dibulatkan ke jam: URL sama dalam 1 jam => browser memakai cache (pindah tab/refresh tidak mengunduh ulang).
const stableNow = () => new Date(Math.floor(Date.now() / 3600000) * 3600000);
function listFiles(s, { presignUrls = true } = {}) {
  const T = stableNow();
  const rows = db.prepare("SELECT * FROM files WHERE token = ? AND state = 'ok'").all(s.token);
  return rows.map((r) => {
    const K = KINDS[r.kind], b = bucketById(r.bucket_id);
    const name = `${K.name(r.idx)}.${r.ext}`;
    return { ...r, group: K.group, rank: K.rank, label: K.label(r.idx), name, b,
      url: presignUrls && b ? s3.presign(b, "GET", r.key, { expires: 14400, now: T, query: { "response-content-type": EXTS[r.ext], "response-cache-control": "private, max-age=3600" } }) : null,
      thumb: THUMBABLE(r) ? `/s/${s.token}/t/${r.fid}` : null,
      dl: presignUrls && b ? s3.presign(b, "GET", r.key, { expires: 14400, now: T, query: { "response-content-disposition": `attachment; filename="${name}"` } }) : null };
  }).sort((a, b) => a.rank - b.rank || a.idx - b.idx);
}


// ---------- thumbnail (cepat tampil) ----------
// Foto asli dari kamera/template bisa beberapa MB. Halaman memakai versi ~1200px (progresif) yang dibuat sekali lalu disimpan di VPS;
// tombol unduh tetap file asli. Kalau sharp tidak ada / gagal, otomatis dialihkan ke file asli (tidak pernah merusak halaman).
let sharp = null;
try { sharp = require("sharp"); sharp.cache(false); sharp.concurrency(1); } catch { /* opsional */ }
const THUMB_DIR = path.join(DATA_DIR, "thumbs");
const thumbPath = (token, fid) => path.join(THUMB_DIR, token, `${fid}.jpg`);
const thumbJobs = new Map();
function makeThumb(row) {
  if (!sharp || !["jpg", "jpeg", "png"].includes(row.ext)) return Promise.resolve(null);
  const out = thumbPath(row.token, row.fid);
  if (fs.existsSync(out)) return Promise.resolve(out);
  if (thumbJobs.has(out)) return thumbJobs.get(out);
  const job = (async () => {
    const b = bucketById(row.bucket_id); if (!b) return null;
    const r = await s3.call(b, "GET", row.key, { timeoutMs: 60000 });
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    const img = await sharp(buf, { failOn: "none" }).rotate().resize({ width: 1200, withoutEnlargement: true }).flatten({ background: "#ffffff" }).jpeg({ quality: 85, progressive: true, mozjpeg: true }).toBuffer();
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const tmp = `${out}.${process.pid}.tmp`; fs.writeFileSync(tmp, img); fs.renameSync(tmp, out);
    return out;
  })().catch((e) => { console.error("[thumb]", e.message); return null; }).finally(() => thumbJobs.delete(out));
  thumbJobs.set(out, job);
  return job;
}
const warmThumb = (row) => { if (row) setImmediate(() => makeThumb(row).catch(() => {})); };
const THUMBABLE = (r) => !!sharp && ["jpg", "jpeg", "png"].includes(r.ext);
app.get("/s/:token/t/:fid", async (req, res) => {
  const s = load(req.params.token);
  if (!s) return res.status(404).end();
  const row = db.prepare("SELECT * FROM files WHERE token = ? AND fid = ? AND state = 'ok'").get(s.token, safe(req.params.fid, 30));
  if (!row) return res.status(404).end();
  const out = await makeThumb(row);
  if (out) return res.set({ "Cache-Control": "private, max-age=86400", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" }).type("image/jpeg").sendFile(out);
  const b = bucketById(row.bucket_id);
  if (!b) return res.status(404).end();
  res.set("Cache-Control", "no-store").redirect(302, s3.presign(b, "GET", row.key, { expires: 3600, query: { "response-content-type": EXTS[row.ext] } }));
});

app.get("/s/:token", (req, res) => {
  noStore(res);
  const s = load(req.params.token);
  if (!s) return res.status(404).type("html").send(messagePage("Link tidak ditemukan atau sudah kedaluwarsa", "Hasil foto disimpan sementara."));
  const files = listFiles(s);
  const preparing = now() - s.created_at < 3 * 60 * 1000 || db.prepare("SELECT COUNT(*) n FROM files WHERE token = ? AND state = 'pending'").get(s.token).n > 0;
  res.type("html").send(renderPage({ files, studio: s.studio, token: s.token, preparing, daysLeft: Math.ceil((s.expires_at - now()) / 86400000), zip: zipMode() === "2" ? "both" : zipEnabled() }));
});
app.get("/s/:token/files.json", (req, res) => {
  noStore(res);
  const s = load(req.params.token);
  if (!s) return res.status(404).json({ count: 0, pending: 0 });
  res.json({ count: db.prepare("SELECT COUNT(*) n FROM files WHERE token = ? AND state = 'ok'").get(s.token).n, pending: db.prepare("SELECT COUNT(*) n FROM files WHERE token = ? AND state = 'pending'").get(s.token).n });
});
app.get("/s/:token/all.zip", async (req, res) => {
  noStore(res);
  const s = load(req.params.token);
  if (!s) return res.status(404).type("html").send(messagePage("Link tidak ditemukan atau sudah kedaluwarsa"));
  if (!zipEnabled()) return res.status(404).type("html").send(messagePage("Unduhan ZIP dimatikan", "Unduh file satu per satu dari halaman sesi."));
  const cat = ["photo", "gif", "live"].includes(req.query.cat) ? req.query.cat : "";
  const files = cat ? catFiles(listFiles(s), cat) : listFiles(s);
  if (!files.length) return res.status(404).type("html").send(messagePage("File belum tersedia"));
  res.set({ "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="popsnap-${cat || "sesi"}.zip"` });
  let aborted = false; res.on("close", () => { aborted = true; });
  const items = files.map((f) => ({ f, name: f.group === "clips" ? `klip/${f.name}` : f.group === "raw" ? `foto-mentah/${f.name}` : f.name, size: Number(f.size) || 0 }));
  const exact = items.every((x) => x.size > 0);
  if (exact) res.set("Content-Length", String(zipSize(items)));
  try {
    const n = await streamZip(res, items.map((x) => ({ name: x.name, open: async () => (aborted ? null : s3.call(x.f.b, "GET", x.f.key, { timeoutMs: 120000 })) })));
    if (exact && n !== items.length) res.destroy(); // ada file gagal diambil: putuskan supaya unduhan ditandai gagal, bukan ZIP tidak lengkap
  } catch (e) { console.error("[zip]", e.message); try { res.destroy(); } catch { /* sudah putus */ } }
});

// ---------- admin ----------
// Login lewat halaman (src/login.html) + cookie sesi bertanda tangan (HttpOnly, SameSite=Strict, 7 hari).
// Mengganti ADMIN_PASSWORD otomatis mengeluarkan semua sesi lama.
const SESSION_MS = 7 * 24 * 3600 * 1000, COOKIE = "pg_admin";
const safeEq = (a, b) => { const x = crypto.createHash("sha256").update(String(a)).digest(), y = crypto.createHash("sha256").update(String(b)).digest(); return crypto.timingSafeEqual(x, y); };
const sessionSig = (exp) => crypto.createHmac("sha256", crypto.createHmac("sha256", "popsnap-gallery-admin-v1").update(String(process.env.ADMIN_PASSWORD || "")).digest()).update(String(exp)).digest("base64url");
const readCookie = (req, name) => { for (const part of String(req.headers.cookie || "").split(";")) { const i = part.indexOf("="); if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim(); } return ""; };
function hasSession(req) {
  const [exp, sig] = readCookie(req, COOKIE).split(".");
  if (!/^\d{10,16}$/.test(exp || "") || Number(exp) < Date.now()) return false;
  const a = Buffer.from(sig || ""), b = Buffer.from(sessionSig(exp));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
// Basic Auth DIMATIKAN secara bawaan: browser menyimpan login Basic dan mengirimnya otomatis, sehingga tombol "Keluar" tidak berefek.
// Nyalakan hanya untuk skrip/curl: ADMIN_ALLOW_BASIC=1 di .env.
function basicOk(req) {
  if (process.env.ADMIN_ALLOW_BASIC !== "1") return false;
  const m = /^Basic (.+)$/.exec(req.headers.authorization || "");
  if (!m) return false;
  const [u, p] = Buffer.from(m[1], "base64").toString().split(/:(.*)/s);
  return safeEq(u, process.env.ADMIN_USER || "admin") && safeEq(p ?? "", process.env.ADMIN_PASSWORD || "");
}
const cookieAttrs = (req) => `Path=/admin; HttpOnly; SameSite=Strict${req.secure ? "; Secure" : ""}`;
function adminAuth(req, res, next) {
  if (!process.env.ADMIN_PASSWORD) return res.status(503).send("Admin nonaktif: isi ADMIN_PASSWORD di .env");
  if (hasSession(req) || basicOk(req)) return next();
  res.set("Cache-Control", "no-store");
  if (req.originalUrl.startsWith("/admin/api/")) return res.status(401).json({ error: "Sesi habis. Masuk lagi." });
  res.status(401).type("html").send(fs.readFileSync(path.join(__dirname, "login.html"), "utf8"));
}
// Batas percobaan salah per IP: 5x salah -> dikunci 5 menit (memori saja; reset saat layanan restart).
const loginTries = new Map();
app.post("/admin/api/login", (req, res) => {
  res.set("Cache-Control", "no-store");
  if (!process.env.ADMIN_PASSWORD) return res.status(503).json({ error: "Admin nonaktif: isi ADMIN_PASSWORD di .env" });
  const ip = String(req.headers["x-real-ip"] || req.socket.remoteAddress || "?"); // X-Real-IP diisi nginx (tidak bisa dipalsukan klien); X-Forwarded-For bisa dipalsukan
  const t = now(), rec = loginTries.get(ip) || { n: 0, until: 0 };
  if (loginTries.size > 500) for (const [k, v] of loginTries) if (v.until < t && !v.n) loginTries.delete(k);
  if (rec.until > t) return res.status(429).json({ error: `Terlalu banyak percobaan. Coba lagi dalam ${Math.ceil((rec.until - t) / 60000)} menit.` });
  const { username, password } = req.body || {};
  if (safeEq(username ?? "", process.env.ADMIN_USER || "admin") && safeEq(password ?? "", process.env.ADMIN_PASSWORD)) {
    loginTries.delete(ip);
    const exp = t + SESSION_MS;
    res.set("Set-Cookie", `${COOKIE}=${exp}.${sessionSig(exp)}; Max-Age=${SESSION_MS / 1000}; ${cookieAttrs(req)}`);
    return res.json({ ok: true });
  }
  rec.n++; if (rec.n >= 5) { rec.until = t + 5 * 60000; rec.n = 0; }
  loginTries.set(ip, rec);
  setTimeout(() => res.status(401).json({ error: "Nama pengguna atau kata sandi salah." }), 400); // jeda kecil memperlambat tebakan
});
app.post("/admin/api/logout", (req, res) => { res.set("Set-Cookie", `${COOKIE}=; Max-Age=0; ${cookieAttrs(req)}`).json({ ok: true }); });
// ---- Unggah manual dari website (PC CS memilih folder hasil dari jaringan bersama; file masuk ke cloud, link langsung hidup) ----
app.post("/admin/api/upload/prepare", adminAuth, (req, res) => {
  const b = req.body || {};
  const studio = String(b.studio || "").trim().slice(0, 60);
  if (!studio) return res.status(400).json({ error: "Nama studio wajib diisi." });
  const r = registerSession(ensureStudio(studio).name, { token: b.token, mode: b.mode, studioCode: b.studioCode, files: b.files, retry: b.retry, manual: true, social: b.social });
  if (r.error) return res.status(r.status).json({ error: r.error });
  res.json({ ...r.body, uploads: r.body.uploads.map((u) => ({ fid: u.fid, path: `/admin/api/upload/${b.token}/${safe(u.fid, 30)}`, contentType: u.contentType })) });
});
// Isi file diteruskan (streaming) ke bucket: tidak disimpan di VPS & tidak perlu mengatur CORS bucket.
app.put("/admin/api/upload/:token/:fid", adminAuth, async (req, res) => {
  try {
    const row = db.prepare("SELECT * FROM files WHERE token = ? AND fid = ?").get(req.params.token, safe(req.params.fid, 30));
    if (!row) return res.status(404).json({ error: "File belum didaftarkan (prepare)." });
    const b = bucketById(row.bucket_id); const len = Number(req.headers["content-length"]) || 0;
    if (!b || !len || len > MAX_FILE) return res.status(400).json({ error: "Ukuran file tidak valid." });
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 15 * 60 * 1000);
    const put = await fetch(s3.presign(b, "PUT", row.key, { expires: 600 }), { method: "PUT", body: req, duplex: "half", headers: { "Content-Length": String(len), "Content-Type": EXTS[row.ext] }, signal: ctrl.signal });
    clearTimeout(t);
    if (!put.ok) return res.status(502).json({ error: `Cloud menolak unggahan (HTTP ${put.status}).` });
    db.prepare("UPDATE files SET state = 'ok', size = ?, uploaded_at = ? WHERE id = ?").run(len, now(), row.id);
    db.prepare("UPDATE sessions SET last_file_at = ? WHERE token = ?").run(now(), row.token);
    warmThumb(row);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.name === "AbortError" ? "Unggahan terlalu lama (timeout)." : e.message }); }
});
const maskB = (b, used) => ({ id: b.id, name: b.name, endpoint: b.endpoint, region: b.region, bucket: b.bucket, accessKey: b.access_key, secretSet: !!b.secret_key, enabled: !!b.enabled, priority: b.priority, quotaGB: b.quota_bytes ? Math.round(b.quota_bytes / 1e7) / 100 : 0, usedGB: Math.round((used.get(b.id) || 0) / 1e7) / 100 });
app.get("/admin", adminAuth, (_req, res) => res.type("html").send(fs.readFileSync(path.join(__dirname, "admin.html"), "utf8")));
app.get("/admin/api/state", adminAuth, (_req, res) => {
  const used = usedBytes();
  res.json({
    retentionDays: retentionDays(), zipEnabled: zipEnabled(), zipMode: zipMode(), publicUrl: PUBLIC_URL(),
    buckets: db.prepare("SELECT * FROM buckets ORDER BY priority, id").all().map((b) => maskB(b, used)),
    stats: { sessions: db.prepare("SELECT COUNT(*) n FROM sessions").get().n, files: db.prepare("SELECT COUNT(*) n FROM files WHERE state = 'ok'").get().n, pending: db.prepare("SELECT COUNT(*) n FROM files WHERE state = 'pending'").get().n },
    studios: db.prepare("SELECT st.name studio, (SELECT MAX(s.studio_code) FROM sessions s WHERE lower(trim(s.studio)) = st.skey) code, (SELECT COUNT(*) FROM sessions s WHERE lower(trim(s.studio)) = st.skey) sessions, COALESCE(st.last_seen_at, 0) last FROM studios st ORDER BY last DESC, st.name").all(),
  });
});
// ---- Kelola studio: pantau online/offline, edit, gabung, putuskan/sambungkan, hapus ----
const studioRow = (r) => ({
  key: r.skey, name: r.name, note: r.note, blocked: !!r.blocked, status: studioStatus(r), retentionDays: r.retention_days || null,
  firstSeenAt: r.first_seen_at || null, lastSeenAt: r.last_seen_at || null, lastEvent: r.last_event || "", lastIp: r.last_ip || "",
  sessions: r.sessions || 0, files: r.files || 0, bytes: r.bytes || 0, pending: r.pending || 0, lastUploadAt: r.last_upload || null, nameLocked: !!r.name_locked,
});
const studioList = () => db.prepare(`SELECT st.*,
  (SELECT COUNT(*) FROM sessions s WHERE lower(trim(s.studio)) = st.skey) sessions,
  (SELECT COUNT(*) FROM files f JOIN sessions s ON s.token = f.token WHERE lower(trim(s.studio)) = st.skey AND f.state = 'ok') files,
  (SELECT COUNT(*) FROM files f JOIN sessions s ON s.token = f.token WHERE lower(trim(s.studio)) = st.skey AND f.state = 'pending') pending,
  (SELECT COALESCE(SUM(f.size), 0) FROM files f JOIN sessions s ON s.token = f.token WHERE lower(trim(s.studio)) = st.skey AND f.state = 'ok') bytes,
  (SELECT MAX(f.uploaded_at) FROM files f JOIN sessions s ON s.token = f.token WHERE lower(trim(s.studio)) = st.skey) last_upload
  FROM studios st ORDER BY (st.last_seen_at IS NULL), st.last_seen_at DESC, st.name`).all();
app.get("/admin/api/studios", adminAuth, (_req, res) => {
  const list = studioList().map(studioRow);
  res.json({ now: now(), onlineMs: ONLINE_MS, studios: list, counts: { online: list.filter((x) => x.status === "online").length, total: list.length, blocked: list.filter((x) => x.blocked).length } });
});
const retOf = (v) => { if (v === "" || v == null) return null; const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.max(1, Math.min(365, n)) : null; };
app.post("/admin/api/studios", adminAuth, (req, res) => {
  const b = req.body || {}, name = String(b.name || "").replace(/[<>]/g, "").trim().slice(0, 60);
  if (!name) return res.status(400).json({ error: "Nama studio wajib diisi." });
  if (db.prepare("SELECT 1 FROM studios WHERE skey = ?").get(skey(name))) return res.status(409).json({ error: "Studio dengan nama itu sudah ada." });
  const row = ensureStudio(name);
  db.prepare("UPDATE studios SET note = ?, retention_days = ?, name_locked = 1 WHERE skey = ?").run(String(b.note || "").slice(0, 200), retOf(b.retentionDays), row.skey);
  res.json({ ok: true });
});
app.post("/admin/api/studios/:key", adminAuth, (req, res) => {
  const key = skey(req.params.key), b = req.body || {};
  let row = db.prepare("SELECT * FROM studios WHERE skey = ?").get(key);
  if (!row) return res.status(404).json({ error: "Studio tidak ditemukan." });
  let merged = false;
  if (b.name != null && String(b.name).trim() && String(b.name).trim() !== row.name) {
    const r = renameStudio(key, b.name, { lock: true }); if (!r) return res.status(400).json({ error: "Nama tidak valid." });
    merged = r.merged; row = r.row;
  }
  if (b.note != null) db.prepare("UPDATE studios SET note = ? WHERE skey = ?").run(String(b.note).slice(0, 200), row.skey);
  if (b.retentionDays !== undefined) db.prepare("UPDATE studios SET retention_days = ? WHERE skey = ?").run(retOf(b.retentionDays), row.skey);
  if (b.blocked != null) db.prepare("UPDATE studios SET blocked = ? WHERE skey = ?").run(b.blocked ? 1 : 0, row.skey);
  res.json({ ok: true, merged });
});
app.delete("/admin/api/studios/:key", adminAuth, async (req, res) => {
  const key = skey(req.params.key), row = db.prepare("SELECT * FROM studios WHERE skey = ?").get(key);
  if (!row) return res.json({ ok: true });
  if (row.blocked) return res.status(400).json({ error: "Studio sedang diputus. Sambungkan dulu, atau biarkan tetap terputus supaya booth-nya terblokir." });
  const toks = db.prepare("SELECT token FROM sessions WHERE lower(trim(studio)) = ?").all(key).map((x) => x.token);
  if (toks.length && !(req.query.purge === "1")) return res.status(409).json({ error: `Studio ini masih punya ${toks.length} link.`, sessions: toks.length });
  let left = 0;
  for (const t of toks) { db.prepare("UPDATE sessions SET expires_at = ? WHERE token = ?").run(now() - 1000, t); if (!(await purgeSession(t))) left++; }
  if (left) return res.json({ ok: true, deleted: false, left });
  db.prepare("DELETE FROM studios WHERE skey = ?").run(key);
  res.json({ ok: true, deleted: true, purged: toks.length });
});

// ---- Link pelanggan (sesi): lihat semua, cari, ubah masa berlaku / nama studio, hapus ----
const likeEsc = (x) => String(x).replace(/[\\%_]/g, (c) => "\\" + c);
const sessRow = (r) => ({ token: r.token, studio: r.studio, studioCode: r.studio_code || "", mode: r.mode || "", manual: !!r.manual, social: r.social == null ? null : r.social, createdAt: r.created_at, expiresAt: r.expires_at, files: r.files, pending: r.pending, bytes: r.bytes });
app.get("/admin/api/sessions", adminAuth, (req, res) => {
  const q = String(req.query.q || "").trim().slice(0, 60), studio = String(req.query.studio || "").slice(0, 80), source = String(req.query.source || "");
  const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 30)), offset = Math.max(0, Number(req.query.offset) || 0);
  const w = [], a = [];
  if (q) { const t = likeEsc(q.replace(/[\s-]/g, "")), n = likeEsc(q); w.push("(s.token LIKE ? ESCAPE '\\' COLLATE NOCASE OR s.studio LIKE ? ESCAPE '\\' OR s.studio_code LIKE ? ESCAPE '\\')"); a.push(`%${t}%`, `%${n}%`, `%${n}%`); }
  if (studio) { w.push("s.studio = ?"); a.push(studio); }
  if (source === "manual") w.push("s.manual = 1"); else if (source === "booth") w.push("s.manual = 0");
  const soc = String(req.query.social || "");
  const sc = { sosmed: "(s.social & 1) = 1", mading: "(s.social & 2) = 2", denied: "s.social = 0", unknown: "s.social IS NULL" }[soc];
  if (sc) w.push(sc);
  const where = w.length ? "WHERE " + w.join(" AND ") : "";
  const total = db.prepare(`SELECT COUNT(*) n FROM sessions s ${where}`).get(...a).n;
  const rows = db.prepare(`SELECT s.*, (SELECT COUNT(*) FROM files f WHERE f.token = s.token AND f.state = 'ok') files, (SELECT COUNT(*) FROM files f WHERE f.token = s.token AND f.state = 'pending') pending, (SELECT COALESCE(SUM(f.size), 0) FROM files f WHERE f.token = s.token AND f.state = 'ok') bytes FROM sessions s ${where} ORDER BY s.created_at DESC LIMIT ? OFFSET ?`).all(...a, limit, offset);
  res.json({ total, publicUrl: PUBLIC_URL(), sessions: rows.map(sessRow) });
});
const MAX_EXPIRY_MS = 730 * 86400000;
app.post("/admin/api/sessions/:token", adminAuth, (req, res) => {
  const s = db.prepare("SELECT * FROM sessions WHERE token = ?").get(req.params.token);
  if (!s) return res.status(404).json({ error: "Sesi tidak ditemukan." });
  const b = req.body || {};
  if (b.expiresAt != null) {
    const t = Number(b.expiresAt);
    if (!Number.isFinite(t) || t < now() + 60000) return res.status(400).json({ error: "Masa berlaku harus di masa depan. Untuk mematikan link sekarang, pakai Hapus." });
    if (t > now() + MAX_EXPIRY_MS) return res.status(400).json({ error: "Masa berlaku maksimal 2 tahun dari sekarang." });
    db.prepare("UPDATE sessions SET expires_at = ? WHERE token = ?").run(Math.round(t), s.token);
  }
  if (b.studio != null) {
    const name = String(b.studio).replace(/[<>]/g, "").trim().slice(0, 60);
    if (!name) return res.status(400).json({ error: "Nama studio tidak boleh kosong." });
    db.prepare("UPDATE sessions SET studio = ? WHERE token = ?").run(name, s.token);
  }
  res.json({ ok: true });
});
app.delete("/admin/api/sessions/:token", adminAuth, async (req, res) => {
  const s = db.prepare("SELECT token FROM sessions WHERE token = ?").get(req.params.token);
  if (!s) return res.json({ ok: true, deleted: true });
  db.prepare("UPDATE sessions SET expires_at = ? WHERE token = ?").run(now() - 1000, s.token); // link langsung mati
  const gone = await purgeSession(s.token);
  res.json({ ok: true, deleted: gone }); // false = sebagian file di cloud belum terhapus; dibereskan otomatis berkala
});
// Aksi massal: { action: "delete" | "extend", tokens: [...], days }  (extend = tambah N hari dari masa berlaku sekarang)
app.post("/admin/api/sessions-bulk", adminAuth, async (req, res) => {
  const b = req.body || {};
  const tokens = [...new Set((Array.isArray(b.tokens) ? b.tokens : []).map((x) => String(x)))].slice(0, 200);
  if (!tokens.length) return res.status(400).json({ error: "Tidak ada sesi dipilih." });
  let done = 0, pending = 0;
  if (b.action === "extend") {
    const days = Math.max(1, Math.min(365, Math.round(Number(b.days) || 0)));
    for (const t of tokens) { const r = db.prepare("UPDATE sessions SET expires_at = MIN(MAX(expires_at, ?) + ?, ?) WHERE token = ?").run(now(), days * 86400000, now() + MAX_EXPIRY_MS, t); done += Number(r.changes) || 0; }
  } else if (b.action === "delete") {
    for (const t of tokens) {
      if (!db.prepare("SELECT 1 FROM sessions WHERE token = ?").get(t)) continue;
      db.prepare("UPDATE sessions SET expires_at = ? WHERE token = ?").run(now() - 1000, t);
      if (await purgeSession(t)) done++; else pending++;
    }
  } else return res.status(400).json({ error: "Aksi tidak dikenal." });
  res.json({ ok: true, done, pending });
});
app.post("/admin/api/settings", adminAuth, (req, res) => {
  if (req.body?.retentionDays != null) setSetting("retention_days", Math.max(1, Math.min(365, Math.round(Number(req.body.retentionDays) || 7))));
  if (req.body?.zipEnabled != null) { const z = req.body.zipEnabled; setSetting("zip_enabled", z === false || z === "0" || z === 0 ? "0" : String(z) === "2" ? "2" : "1"); }
  res.json({ ok: true });
});
app.post("/admin/api/buckets", adminAuth, (req, res) => {
  const b = req.body || {};
  const endpoint = String(b.endpoint || "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\/[^\s/]+/.test(endpoint) || !b.bucket || !b.accessKey) return res.status(400).json({ error: "Endpoint, nama bucket, dan access key wajib diisi." });
  const quota = Math.max(0, Math.round((Number(b.quotaGB) || 0) * 1e9));
  if (b.id) {
    const cur = bucketById(Number(b.id)); if (!cur) return res.status(404).json({ error: "Bucket tidak ada." });
    db.prepare("UPDATE buckets SET name=?, endpoint=?, region=?, bucket=?, access_key=?, secret_key=?, enabled=?, priority=?, quota_bytes=? WHERE id=?")
      .run(String(b.name || b.bucket).slice(0, 60), endpoint, String(b.region || "auto").trim(), String(b.bucket), String(b.accessKey), b.secretKey ? String(b.secretKey) : cur.secret_key, b.enabled === false ? 0 : 1, Math.round(Number(b.priority) || 10), quota, cur.id);
    return res.json({ ok: true, id: cur.id });
  }
  if (!b.secretKey) return res.status(400).json({ error: "Secret key wajib diisi." });
  const r = db.prepare("INSERT INTO buckets (name, endpoint, region, bucket, access_key, secret_key, enabled, priority, quota_bytes) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(String(b.name || b.bucket).slice(0, 60), endpoint, String(b.region || "auto").trim(), String(b.bucket), String(b.accessKey), String(b.secretKey), b.enabled === false ? 0 : 1, Math.round(Number(b.priority) || 10), quota);
  res.json({ ok: true, id: Number(r.lastInsertRowid) });
});
app.delete("/admin/api/buckets/:id", adminAuth, (req, res) => {
  const id = Number(req.params.id);
  if (db.prepare("SELECT COUNT(*) n FROM files WHERE bucket_id = ?").get(id).n > 0) { db.prepare("UPDATE buckets SET enabled = 0 WHERE id = ?").run(id); return res.json({ ok: true, disabledOnly: true }); }
  db.prepare("DELETE FROM buckets WHERE id = ?").run(id); res.json({ ok: true });
});
app.post("/admin/api/buckets/:id/test", adminAuth, async (req, res) => {
  const b = bucketById(Number(req.params.id)); if (!b) return res.status(404).json({ ok: false, error: "Bucket tidak ada." });
  const key = `_test/${crypto.randomBytes(6).toString("hex")}.txt`, body = "popsnap-test";
  try {
    const put = await s3.call(b, "PUT", key, { body, headers: { "Content-Type": "text/plain" } });
    if (!put.ok) return res.json({ ok: false, step: "tulis", error: `Gagal menulis (HTTP ${put.status}). Cek access key / izin Object Read & Write.` });
    const get = await s3.call(b, "GET", key); const txt = await get.text();
    await s3.call(b, "DELETE", key);
    res.json({ ok: get.ok && txt === body, step: "baca", error: get.ok && txt === body ? null : `Gagal membaca (HTTP ${get.status})` });
  } catch (e) { res.json({ ok: false, error: e.name === "AbortError" ? "Timeout menghubungi endpoint." : `Tidak terhubung: ${e.message}` }); }
});

app.get("/", (_req, res) => res.type("html").send(landingPage()));
app.get("/healthz", (_req, res) => res.json({ ok: true }));

// ---------- hapus otomatis ----------
/** Hapus semua file sesi dari bucket, lalu barisnya. true = bersih semua. */
async function purgeSession(token) {
  let allGone = true;
  for (const f of db.prepare("SELECT * FROM files WHERE token = ?").all(token)) {
    const b = bucketById(f.bucket_id);
    if (!b) { db.prepare("DELETE FROM files WHERE id = ?").run(f.id); continue; }
    try { const r = await s3.call(b, "DELETE", f.key, { timeoutMs: 15000 }); if (r.ok || r.status === 404) db.prepare("DELETE FROM files WHERE id = ?").run(f.id); else allGone = false; }
    catch { allGone = false; }
  }
  if (allGone) { db.prepare("DELETE FROM sessions WHERE token = ?").run(token); try { fs.rmSync(path.join(THUMB_DIR, String(token)), { recursive: true, force: true }); } catch { /* sudah tidak ada */ } }
  return allGone;
}

async function cleanup() {
  const old = db.prepare("SELECT token FROM sessions WHERE expires_at < ? LIMIT 200").all(now());
  let removed = 0;
  for (const { token } of old) {
    if (await purgeSession(token)) removed++;
  }
  // file "pending" yang tidak pernah selesai (booth mati) > 2 hari: buang catatannya supaya kuota bucket tidak tertahan
  db.prepare("DELETE FROM files WHERE state = 'pending' AND created_at < ?").run(now() - 2 * 86400000);
  return removed;
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 8088;
  app.listen(port, () => console.log(`[galeri] jalan di port ${port} · simpan ${retentionDays()} hari`));
  setTimeout(() => cleanup().catch((e) => console.error("[cleanup]", e.message)), 20000);
  setInterval(() => cleanup().catch((e) => console.error("[cleanup]", e.message)), 30 * 60 * 1000);
}
module.exports = { app, cleanup, pickBucket, purgeSession };
