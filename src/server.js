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
  const fits = (b) => b.id !== exclude && (!b.quota_bytes || (used.get(b.id) || 0) + size <= b.quota_bytes);
  const all = db.prepare("SELECT * FROM buckets WHERE enabled = 1 ORDER BY priority, id").all();
  let list = all.filter((b) => fits(b) && b.health !== "bad"); // bucket yang gagal tes dilewati...
  if (!list.length) list = all.filter(fits);                    // ...kecuali semuanya bermasalah: tetap coba
  if (!list.length) return null;
  const top = list[0].priority; // sama prioritas -> yang paling kosong dulu (bagi rata)
  return list.filter((b) => b.priority === top).sort((a, b) => (used.get(a.id) || 0) - (used.get(b.id) || 0))[0];
}
const bucketById = (id) => db.prepare("SELECT * FROM buckets WHERE id = ?").get(id);

// ---------- Kesehatan bucket: tes tulis/baca/hapus, ditandai sehat / bermasalah ----------
async function testBucket(b) {
  const t0 = Date.now(), key = `_test/${crypto.randomBytes(6).toString("hex")}.txt`, body = "popsnap-test";
  try {
    const put = await s3.call(b, "PUT", key, { body, headers: { "Content-Type": "text/plain" }, timeoutMs: 15000 });
    if (!put.ok) return { ok: false, step: "tulis", ms: Date.now() - t0, error: put.status === 403 ? "Access key / secret key salah atau tidak punya izin Object Read & Write (HTTP 403)." : put.status === 404 ? "Nama bucket atau endpoint tidak ditemukan (HTTP 404)." : `Gagal menulis (HTTP ${put.status}).` };
    const get = await s3.call(b, "GET", key, { timeoutMs: 15000 }); const txt = await get.text();
    await s3.call(b, "DELETE", key, { timeoutMs: 15000 }).catch(() => {});
    const ok = get.ok && txt === body;
    return { ok, step: "baca", ms: Date.now() - t0, error: ok ? null : `Gagal membaca (HTTP ${get.status})` };
  } catch (e) { return { ok: false, ms: Date.now() - t0, error: e.name === "AbortError" ? "Timeout menghubungi endpoint." : `Tidak terhubung: ${e.cause?.code || e.message}` }; }
}
const healthJobs = new Map();
/** Tes + simpan hasilnya di bucket. Satu tes per bucket pada satu waktu. */
function checkBucket(b) {
  if (healthJobs.has(b.id)) return healthJobs.get(b.id);
  const job = testBucket(b).then((r) => {
    db.prepare("UPDATE buckets SET health = ?, health_msg = ?, health_at = ?, fail_count = CASE WHEN ? THEN 0 ELSE fail_count END WHERE id = ?").run(r.ok ? "ok" : "bad", r.ok ? "" : String(r.error || "").slice(0, 200), now(), r.ok ? 1 : 0, b.id);
    return r;
  }).finally(() => healthJobs.delete(b.id));
  healthJobs.set(b.id, job); return job;
}
/** Booth melapor unggah ke bucket ini gagal (minta bucket lain): hitung, lalu tes cepat di latar belakang. */
function noteBucketFail(id) {
  const b = bucketById(id); if (!b) return;
  db.prepare("UPDATE buckets SET fail_count = fail_count + 1 WHERE id = ?").run(id);
  if (!b.health_at || now() - b.health_at > 20000) setImmediate(() => checkBucket(bucketById(id)).catch(() => {}));
}
const checkAllBuckets = async () => { for (const b of db.prepare("SELECT * FROM buckets WHERE enabled = 1").all()) await checkBucket(b).catch(() => {}); };

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

// Denyut booth: ±1 menit sekali + laporan singkat status sinkron (antrean / error) supaya admin bisa memantau.
const cut = (v, n) => String(v ?? "").slice(0, n);
app.post("/api/v1/heartbeat", async (req, res) => {
  try {
    const a = await auth.verify(bearerOf(req));
    if (!a) return res.status(401).json({ ok: false, error: "Token tidak valid." });
    const st = studioGuard(a, req, res, "heartbeat"); if (!st) return;
    const b = req.body || {}, k = b.kasir && typeof b.kasir === "object" ? b.kasir : null;
    const rep = { pending: Math.max(0, Math.round(Number(b.pendingSessions) || 0)), errors: Math.max(0, Math.round(Number(b.sessionsWithErrors) || 0)), lastError: cut(b.lastError, 200), lastOkAt: b.lastOkAt ? cut(b.lastOkAt, 40) : null, files: Math.max(0, Math.round(Number(b.filesUploaded) || 0)), app: cut(b.app, 40),
      kasir: k ? { ok: k.ok !== false, error: cut(k.error, 200) } : null };
    db.prepare("UPDATE studios SET sync_json = ?, sync_at = ? WHERE skey = ?").run(JSON.stringify(rep), now(), st.skey);
    res.json({ ok: true, studio: st.name });
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
    if (retry === fid && row) noteBucketFail(row.bucket_id);
    if (!bucket || !bucket.enabled || retry === fid) {
      bucket = pickBucket(size, retry === fid && row ? row.bucket_id : null) || pickBucket(size);
      if (!bucket) return { status: 503, error: "Tidak ada penyimpanan cloud yang aktif / masih muat. Atur di halaman admin galeri." };
    }
    const key = `${sess.studio_code}/${ym}/${token}/${fid}.${ext}`;
    // Pindah bucket / alamat (mis. retry): objek lama bisa saja sudah terunggah sebagian, jangan dibiarkan jadi yatim di cloud.
    if (row && (row.bucket_id !== bucket.id || row.key !== key)) db.prepare("INSERT OR IGNORE INTO trash (bucket_id, key, created_at) VALUES (?, ?, ?)").run(row.bucket_id, row.key, now());
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
const sigKey = () => crypto.createHmac("sha256", "popsnap-gallery-admin-v1").update(String(process.env.ADMIN_PASSWORD || "")).digest();
const sigOf = (str) => crypto.createHmac("sha256", sigKey()).update(str).digest("base64url");
const sessionSig = (exp) => sigOf(String(exp));
const sameSig = (x, y) => { const a = Buffer.from(String(x || "")), b = Buffer.from(String(y)); return a.length === b.length && crypto.timingSafeEqual(a, b); };
const readCookie = (req, name) => { for (const part of String(req.headers.cookie || "").split(";")) { const i = part.indexOf("="); if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim(); } return ""; };

// ---- Hak akses ----
// Akun ADMIN_USER/ADMIN_PASSWORD di .env = admin penuh (tidak bisa dihapus/dikunci dari web). Pengguna lain dibuat di menu Pengguna:
// role "admin" = akses penuh + kelola pengguna; role "staff" = hanya hak yang dicentang. Perubahan hak berlaku langsung (dibaca tiap permintaan).
const PERMS = {
  "studio.view": "Lihat daftar studio", "studio.edit": "Tambah/ubah/putuskan/hapus studio",
  "link.view": "Lihat link pelanggan", "link.edit": "Atur link: perpanjang, nonaktifkan, hapus", "upload": "Unggah manual foto",
  "storage.view": "Lihat penyimpanan cloud & cek koneksi", "storage.edit": "Tambah/ubah/hapus bucket",
  "settings.edit": "Ubah pengaturan umum",
};
const PRESETS = [
  { id: "cs", label: "Kasir / CS", perms: ["studio.view", "link.view", "upload"] },
  { id: "manajer", label: "Manajer", perms: ["studio.view", "studio.edit", "link.view", "link.edit", "upload", "storage.view"] },
  { id: "lihat", label: "Hanya lihat", perms: ["studio.view", "link.view", "storage.view"] },
];
const IMPLIES = { "studio.edit": "studio.view", "link.edit": "link.view", "upload": "link.view", "storage.edit": "storage.view" };
const normPerms = (list) => { const set = new Set((Array.isArray(list) ? list : []).map(String).filter((x) => x in PERMS)); for (const [k, v] of Object.entries(IMPLIES)) if (set.has(k)) set.add(v); return Object.keys(PERMS).filter((k) => set.has(k)); };
const parsePerms = (raw) => { try { const v = JSON.parse(raw || "[]"); return Array.isArray(v) ? v : []; } catch { return []; } }; // data hak akses rusak = tanpa hak (jangan sampai menjatuhkan daftar pengguna)
const hashPw = (pw) => { const salt = crypto.randomBytes(16); return `s1$${salt.toString("base64url")}$${crypto.scryptSync(String(pw), salt, 32).toString("base64url")}`; };
const checkPw = (pw, stored) => { const [v, sl, h] = String(stored || "").split("$"); if (v !== "s1" || !sl || !h) return false; return sameSig(crypto.scryptSync(String(pw), Buffer.from(sl, "base64url"), 32).toString("base64url"), h); };
const envAdmin = () => ({ id: 0, username: process.env.ADMIN_USER || "admin", name: "Admin", admin: true, env: true, perms: new Set(Object.keys(PERMS)) });
const principalOf = (row) => { const admin = row.role === "admin"; const list = parsePerms(row.perms); return { id: row.id, username: row.username, name: row.name || row.username, admin, env: false, perms: new Set(admin ? Object.keys(PERMS) : normPerms(list)) }; };
const userSig = (row, exp) => sigOf(`u${row.id}~${exp}~${String(row.pass_hash).slice(-16)}`); // ganti sandi / nonaktif = sesi lama otomatis mati
const userCookie = (row, req) => { const exp = Date.now() + SESSION_MS; return `${COOKIE}=${row.id}~${exp}.${userSig(row, exp)}; Max-Age=${SESSION_MS / 1000}; ${cookieAttrs(req)}`; };
function sessionUser(req) {
  const [body, sig] = readCookie(req, COOKIE).split(".");
  const m = /^(?:(\d{1,9})~)?(\d{10,16})$/.exec(body || "");
  if (!m || Number(m[2]) < Date.now()) return null;
  if (!m[1]) return sameSig(sig, sessionSig(m[2])) ? envAdmin() : null;
  const row = db.prepare("SELECT * FROM users WHERE id = ? AND active = 1").get(Number(m[1]));
  return row && sameSig(sig, userSig(row, m[2])) ? principalOf(row) : null;
}
const can = (req, perm) => !!req.user && (req.user.admin || req.user.perms.has(perm));
const need = (perm) => (req, res, next) => can(req, perm) ? next() : res.status(403).json({ error: "Akunmu tidak punya hak untuk tindakan ini." });
const needAdmin = (req, res, next) => req.user?.admin ? next() : res.status(403).json({ error: "Hanya admin yang boleh mengelola pengguna." });
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
  const who = sessionUser(req) || (basicOk(req) ? envAdmin() : null);
  if (who) { req.user = who; return next(); }
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
  const uname = String(username ?? "").trim().toLowerCase(), urow = uname ? db.prepare("SELECT * FROM users WHERE username = ? AND active = 1").get(uname) : null;
  if (urow && checkPw(password ?? "", urow.pass_hash)) {
    loginTries.delete(ip);
    db.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").run(t, urow.id);
    res.set("Set-Cookie", userCookie(urow, req));
    return res.json({ ok: true });
  }
  rec.n++; if (rec.n >= 5) { rec.until = t + 5 * 60000; rec.n = 0; }
  loginTries.set(ip, rec);
  setTimeout(() => res.status(401).json({ error: "Nama pengguna atau kata sandi salah." }), 400); // jeda kecil memperlambat tebakan
});
app.post("/admin/api/logout", (req, res) => { res.set("Set-Cookie", `${COOKIE}=; Max-Age=0; ${cookieAttrs(req)}`).json({ ok: true }); });
// ---- Unggah manual dari website (PC CS memilih folder hasil dari jaringan bersama; file masuk ke cloud, link langsung hidup) ----
app.post("/admin/api/upload/prepare", adminAuth, need("upload"), (req, res) => {
  const b = req.body || {};
  const studio = String(b.studio || "").trim().slice(0, 60);
  if (!studio) return res.status(400).json({ error: "Nama studio wajib diisi." });
  const r = registerSession(ensureStudio(studio).name, { token: b.token, mode: b.mode, studioCode: b.studioCode, files: b.files, retry: b.retry, manual: true, social: b.social });
  if (r.error) return res.status(r.status).json({ error: r.error });
  res.json({ ...r.body, uploads: r.body.uploads.map((u) => ({ fid: u.fid, path: `/admin/api/upload/${normToken(b.token)}/${safe(u.fid, 30)}`, contentType: u.contentType })) });
});
// Isi file diteruskan (streaming) ke bucket: tidak disimpan di VPS & tidak perlu mengatur CORS bucket.
app.put("/admin/api/upload/:token/:fid", adminAuth, need("upload"), async (req, res) => {
  try {
    const row = db.prepare("SELECT * FROM files WHERE token = ? AND fid = ?").get(normToken(req.params.token), safe(req.params.fid, 30));
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
const maskB = (b, used) => ({ id: b.id, name: b.name, endpoint: b.endpoint, region: b.region, bucket: b.bucket, accessKey: b.access_key, secretSet: !!b.secret_key, enabled: !!b.enabled, priority: b.priority, quotaGB: b.quota_bytes ? Math.round(b.quota_bytes / 1e7) / 100 : 0, usedGB: Math.round((used.get(b.id) || 0) / 1e7) / 100, health: b.health || "", healthMsg: b.health_msg || "", healthAt: b.health_at || null });
app.get("/admin", adminAuth, (_req, res) => res.type("html").send(fs.readFileSync(path.join(__dirname, "admin.html"), "utf8")));
app.get("/admin/api/state", adminAuth, (req, res) => {
  const used = usedBytes();
  res.json({
    retentionDays: retentionDays(), zipEnabled: zipEnabled(), zipMode: zipMode(), publicUrl: PUBLIC_URL(),
    buckets: db.prepare("SELECT * FROM buckets ORDER BY priority, id").all().map((b) => { const m = maskB(b, used); return can(req, "storage.view") ? m : { ...m, endpoint: "", bucket: "", accessKey: "", region: "", healthMsg: "" }; }),
    stats: { sessions: db.prepare("SELECT COUNT(*) n FROM sessions").get().n, files: db.prepare("SELECT COUNT(*) n FROM files WHERE state = 'ok'").get().n, pending: db.prepare("SELECT COUNT(*) n FROM files WHERE state = 'pending'").get().n },
    studios: db.prepare("SELECT st.name studio, (SELECT MAX(s.studio_code) FROM sessions s WHERE lower(trim(s.studio)) = st.skey) code, (SELECT COUNT(*) FROM sessions s WHERE lower(trim(s.studio)) = st.skey) sessions, COALESCE(st.last_seen_at, 0) last FROM studios st ORDER BY last DESC, st.name").all(),
  });
});
// ---- Pengguna & hak akses (hanya admin) ----
app.get("/admin/api/me", adminAuth, (req, res) => {
  const u = req.user;
  res.json({ username: u.username, name: u.name, admin: u.admin, env: u.env, perms: [...u.perms], catalog: PERMS, presets: PRESETS });
});
const userRow = (r) => ({ id: r.id, username: r.username, name: r.name, role: r.role, perms: r.role === "admin" ? Object.keys(PERMS) : normPerms(parsePerms(r.perms)), active: !!r.active, createdAt: r.created_at, lastLoginAt: r.last_login_at });
app.get("/admin/api/users", adminAuth, needAdmin, (_req, res) => {
  res.json({ envUser: process.env.ADMIN_USER || "admin", users: db.prepare("SELECT * FROM users ORDER BY id").all().map(userRow), catalog: PERMS, presets: PRESETS });
});
const cleanName = (v) => String(v || "").replace(/[<>]/g, "").trim().slice(0, 60);
app.post("/admin/api/users", adminAuth, needAdmin, (req, res) => {
  const b = req.body || {}, username = String(b.username || "").trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,30}$/.test(username)) return res.status(400).json({ error: "Username 3-30 karakter: huruf kecil, angka, titik, strip, garis bawah." });
  if (username === String(process.env.ADMIN_USER || "admin").toLowerCase()) return res.status(409).json({ error: "Username itu dipakai akun admin utama (.env)." });
  if (String(b.password || "").length < 8 || String(b.password).length > 200) return res.status(400).json({ error: "Kata sandi minimal 8 karakter." });
  if (db.prepare("SELECT 1 FROM users WHERE username = ?").get(username)) return res.status(409).json({ error: "Username sudah dipakai." });
  const role = b.role === "admin" ? "admin" : "staff", perms = role === "admin" ? [] : normPerms(b.perms);
  const r = db.prepare("INSERT INTO users (username, name, pass_hash, role, perms, active, created_at) VALUES (?,?,?,?,?,?,?)").run(username, cleanName(b.name) || username, hashPw(b.password), role, JSON.stringify(perms), b.active === false ? 0 : 1, now());
  res.json({ ok: true, id: Number(r.lastInsertRowid) });
});
app.post("/admin/api/users/:id", adminAuth, needAdmin, (req, res) => {
  const id = Number(req.params.id), row = db.prepare("SELECT * FROM users WHERE id = ?").get(id), b = req.body || {};
  if (!row) return res.status(404).json({ error: "Pengguna tidak ditemukan." });
  const role = b.role == null ? row.role : b.role === "admin" ? "admin" : "staff", active = b.active == null ? row.active : b.active ? 1 : 0;
  if (id === req.user.id && (role !== "admin" || !active)) return res.status(400).json({ error: "Kamu tidak bisa menurunkan atau menonaktifkan akunmu sendiri." });
  const perms = role === "admin" ? [] : b.perms == null ? normPerms(parsePerms(row.perms)) : normPerms(b.perms);
  let hash = row.pass_hash;
  if (b.password) { if (String(b.password).length < 8 || String(b.password).length > 200) return res.status(400).json({ error: "Kata sandi minimal 8 karakter." }); hash = hashPw(b.password); }
  db.prepare("UPDATE users SET name = ?, role = ?, perms = ?, active = ?, pass_hash = ? WHERE id = ?").run(b.name == null ? row.name : cleanName(b.name) || row.username, role, JSON.stringify(perms), active, hash, id);
  res.json({ ok: true });
});
app.delete("/admin/api/users/:id", adminAuth, needAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: "Kamu tidak bisa menghapus akunmu sendiri." });
  const r = db.prepare("DELETE FROM users WHERE id = ?").run(id);
  res.json({ ok: true, deleted: r.changes > 0 });
});
// Pengguna biasa mengganti sandinya sendiri (akun .env diganti lewat file .env).
app.post("/admin/api/me/password", adminAuth, (req, res) => {
  if (req.user.env) return res.status(400).json({ error: "Sandi akun admin utama diganti lewat file .env di server." });
  const b = req.body || {}, row = db.prepare("SELECT * FROM users WHERE id = ?").get(req.user.id);
  if (!row || !checkPw(b.current ?? "", row.pass_hash)) return setTimeout(() => res.status(400).json({ error: "Sandi saat ini salah." }), 400);
  if (String(b.password || "").length < 8 || String(b.password).length > 200) return res.status(400).json({ error: "Sandi baru minimal 8 karakter." });
  db.prepare("UPDATE users SET pass_hash = ? WHERE id = ?").run(hashPw(b.password), row.id);
  res.set("Set-Cookie", userCookie(db.prepare("SELECT * FROM users WHERE id = ?").get(row.id), req)).json({ ok: true });
});
// ---- Cek koneksi menyeluruh: bucket, kasir, dan laporan sinkron tiap booth ----
app.post("/admin/api/diagnostics", adminAuth, need("storage.view"), async (_req, res) => {
  const [buckets, kasir] = await Promise.all([
    Promise.all(db.prepare("SELECT * FROM buckets WHERE enabled = 1 ORDER BY priority, id").all().map(async (b) => { const r = await checkBucket(b).catch((e) => ({ ok: false, error: e.message })); return { id: b.id, name: b.name, ok: !!r.ok, ms: r.ms || null, error: r.error || null }; })),
    auth.checkKasir(),
  ]);
  const studios = studioList().map(studioRow).map((x) => {
    const fresh = x.syncAt && now() - x.syncAt < 3 * ONLINE_MS;
    let state = "unknown", note = "";
    if (x.blocked) { state = "blocked"; note = "Diputus oleh admin"; }
    else if (x.status === "never") note = "Belum pernah terhubung";
    else if (x.status === "offline") { state = "down"; note = `Tidak menghubungi galeri sejak ${new Date(x.lastSeenAt).toLocaleString("id-ID")}`; }
    else if (!fresh) note = "Terhubung, tapi belum melapor status sinkron (pasang denyut terbaru di photobox)";
    else {
      const r = x.sync || {};
      if (r.kasir && r.kasir.ok === false) { state = "warn"; note = "Booth tidak bisa menyambung ke kasir: " + (r.kasir.error || "gagal"); }
      else if (r.errors > 0) { state = "warn"; note = `${r.errors} sesi gagal diunggah${r.lastError ? ": " + r.lastError : ""}`; }
      else if (r.pending > 0) { state = "queue"; note = `${r.pending} sesi menunggu diunggah`; }
      else { state = "ok"; note = "Sinkron lancar, tidak ada antrean"; }
    }
    return { key: x.key, name: x.name, status: x.status, lastSeenAt: x.lastSeenAt, state, note };
  });
  res.json({ at: now(), buckets, kasir, studios });
});

// ---- Kelola studio: pantau online/offline, edit, gabung, putuskan/sambungkan, hapus ----
const studioRow = (r) => ({
  key: r.skey, name: r.name, note: r.note, blocked: !!r.blocked, status: studioStatus(r), retentionDays: r.retention_days || null,
  firstSeenAt: r.first_seen_at || null, lastSeenAt: r.last_seen_at || null, lastEvent: r.last_event || "", lastIp: r.last_ip || "",
  sync: (() => { try { return r.sync_json ? JSON.parse(r.sync_json) : null; } catch { return null; } })(), syncAt: r.sync_at || null, sessions: r.sessions || 0, files: r.files || 0, bytes: r.bytes || 0, pending: r.pending || 0, lastUploadAt: r.last_upload || null, nameLocked: !!r.name_locked,
});
const studioList = () => db.prepare(`SELECT st.*,
  (SELECT COUNT(*) FROM sessions s WHERE lower(trim(s.studio)) = st.skey) sessions,
  (SELECT COUNT(*) FROM files f JOIN sessions s ON s.token = f.token WHERE lower(trim(s.studio)) = st.skey AND f.state = 'ok') files,
  (SELECT COUNT(*) FROM files f JOIN sessions s ON s.token = f.token WHERE lower(trim(s.studio)) = st.skey AND f.state = 'pending') pending,
  (SELECT COALESCE(SUM(f.size), 0) FROM files f JOIN sessions s ON s.token = f.token WHERE lower(trim(s.studio)) = st.skey AND f.state = 'ok') bytes,
  (SELECT MAX(f.uploaded_at) FROM files f JOIN sessions s ON s.token = f.token WHERE lower(trim(s.studio)) = st.skey) last_upload
  FROM studios st ORDER BY (st.last_seen_at IS NULL), st.last_seen_at DESC, st.name`).all();
app.get("/admin/api/studios", adminAuth, need("studio.view"), (_req, res) => {
  const list = studioList().map(studioRow);
  res.json({ now: now(), onlineMs: ONLINE_MS, studios: list, counts: { online: list.filter((x) => x.status === "online").length, total: list.length, blocked: list.filter((x) => x.blocked).length } });
});
const retOf = (v) => { if (v === "" || v == null) return null; const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.max(1, Math.min(365, n)) : null; };
app.post("/admin/api/studios", adminAuth, need("studio.edit"), (req, res) => {
  const b = req.body || {}, name = String(b.name || "").replace(/[<>]/g, "").trim().slice(0, 60);
  if (!name) return res.status(400).json({ error: "Nama studio wajib diisi." });
  if (db.prepare("SELECT 1 FROM studios WHERE skey = ?").get(skey(name))) return res.status(409).json({ error: "Studio dengan nama itu sudah ada." });
  const row = ensureStudio(name);
  db.prepare("UPDATE studios SET note = ?, retention_days = ?, name_locked = 1 WHERE skey = ?").run(String(b.note || "").slice(0, 200), retOf(b.retentionDays), row.skey);
  res.json({ ok: true });
});
app.post("/admin/api/studios/:key", adminAuth, need("studio.edit"), (req, res) => {
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
app.delete("/admin/api/studios/:key", adminAuth, need("studio.edit"), async (req, res) => {
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
app.get("/admin/api/sessions", adminAuth, need("link.view"), (req, res) => {
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
app.post("/admin/api/sessions/:token", adminAuth, need("link.edit"), (req, res) => {
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
app.delete("/admin/api/sessions/:token", adminAuth, need("link.edit"), async (req, res) => {
  const s = db.prepare("SELECT token FROM sessions WHERE token = ?").get(req.params.token);
  if (!s) return res.json({ ok: true, deleted: true });
  db.prepare("UPDATE sessions SET expires_at = ? WHERE token = ?").run(now() - 1000, s.token); // link langsung mati
  const gone = await purgeSession(s.token);
  res.json({ ok: true, deleted: gone }); // false = sebagian file di cloud belum terhapus; dibereskan otomatis berkala
});
// Aksi massal: { action: "delete" | "extend", tokens: [...], days }  (extend = tambah N hari dari masa berlaku sekarang)
app.post("/admin/api/sessions-bulk", adminAuth, need("link.edit"), async (req, res) => {
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
app.post("/admin/api/settings", adminAuth, need("settings.edit"), (req, res) => {
  if (req.body?.retentionDays != null) setSetting("retention_days", Math.max(1, Math.min(365, Math.round(Number(req.body.retentionDays) || 7))));
  if (req.body?.zipEnabled != null) { const z = req.body.zipEnabled; setSetting("zip_enabled", z === false || z === "0" || z === 0 ? "0" : String(z) === "2" ? "2" : "1"); }
  res.json({ ok: true });
});
app.post("/admin/api/buckets", adminAuth, need("storage.edit"), async (req, res) => {
  const b = req.body || {};
  const endpoint = String(b.endpoint || "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\/[^\s/]+/.test(endpoint) || !b.bucket || !b.accessKey) return res.status(400).json({ error: "Endpoint, nama bucket, dan access key wajib diisi." });
  const quota = Math.max(0, Math.round((Number(b.quotaGB) || 0) * 1e9));
  if (b.id) {
    const cur = bucketById(Number(b.id)); if (!cur) return res.status(404).json({ error: "Bucket tidak ada." });
    db.prepare("UPDATE buckets SET name=?, endpoint=?, region=?, bucket=?, access_key=?, secret_key=?, enabled=?, priority=?, quota_bytes=? WHERE id=?")
      .run(String(b.name || b.bucket).slice(0, 60), endpoint, String(b.region || "auto").trim(), String(b.bucket), String(b.accessKey), b.secretKey ? String(b.secretKey) : cur.secret_key, b.enabled === false ? 0 : 1, Math.round(Number(b.priority) || 10), quota, cur.id);
    const test = await checkBucket(bucketById(cur.id)).catch((e) => ({ ok: false, error: e.message }));
    return res.json({ ok: true, id: cur.id, test });
  }
  if (!b.secretKey) return res.status(400).json({ error: "Secret key wajib diisi." });
  const r = db.prepare("INSERT INTO buckets (name, endpoint, region, bucket, access_key, secret_key, enabled, priority, quota_bytes) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(String(b.name || b.bucket).slice(0, 60), endpoint, String(b.region || "auto").trim(), String(b.bucket), String(b.accessKey), String(b.secretKey), b.enabled === false ? 0 : 1, Math.round(Number(b.priority) || 10), quota);
  const test = await checkBucket(bucketById(Number(r.lastInsertRowid))).catch((e) => ({ ok: false, error: e.message }));
  res.json({ ok: true, id: Number(r.lastInsertRowid), test });
});
app.delete("/admin/api/buckets/:id", adminAuth, need("storage.edit"), (req, res) => {
  const id = Number(req.params.id);
  if (db.prepare("SELECT COUNT(*) n FROM files WHERE bucket_id = ?").get(id).n > 0) { db.prepare("UPDATE buckets SET enabled = 0 WHERE id = ?").run(id); return res.json({ ok: true, disabledOnly: true }); }
  db.prepare("DELETE FROM buckets WHERE id = ?").run(id); res.json({ ok: true });
});
// Pindai isi bucket: bandingkan daftar objek di cloud dengan catatan galeri.
//  - yatim   = ada di cloud, tidak ada di catatan (sisa unggahan gagal / retry). delete:true menghapusnya, HANYA yang berpola alamat galeri dan berumur > 24 jam.
//  - hilang  = tercatat 'ok' tapi tidak ada di cloud (halaman akan menampilkan foto rusak).
const GALLERY_KEY = /^[A-Za-z0-9_-]{1,20}\/\d{6}\/[A-Za-z0-9_-]{10,40}\/[A-Za-z0-9_-]{1,30}\.(jpg|jpeg|png|gif|mp4|webm)$/;
app.post("/admin/api/buckets/:id/scan", adminAuth, need("storage.edit"), async (req, res) => {
  const b = bucketById(Number(req.params.id)); if (!b) return res.status(404).json({ ok: false, error: "Bucket tidak ada." });
  try {
    const rows = db.prepare("SELECT key, state FROM files WHERE bucket_id = ?").all(b.id);
    const known = new Set(rows.map((r) => r.key)), seen = new Set(), orphans = [];
    let listed = 0, other = 0, pages = 0, token = null, orphanBytes = 0;
    do {
      const p = await s3.listPage(b, { token }); token = p.next; pages++;
      for (const o of p.items) {
        listed++; seen.add(o.key);
        if (!GALLERY_KEY.test(o.key)) { other++; continue; } // bukan milik galeri (mis. _test/ atau file lain di bucket yang sama): jangan disentuh
        if (!known.has(o.key)) { orphans.push(o); orphanBytes += o.size; }
      }
    } while (token && pages < 300);
    const missing = rows.filter((r) => r.state === "ok" && !seen.has(r.key)).map((r) => r.key);
    let deleted = 0, failed = 0, young = 0;
    if (req.body?.delete === true) {
      for (const o of orphans) {
        if (now() - o.modified < 24 * 3600 * 1000) { young++; continue; } // mungkin unggahan yang sedang berjalan
        if (known.has(o.key) || db.prepare("SELECT 1 FROM files WHERE bucket_id = ? AND key = ?").get(b.id, o.key)) continue; // terdaftar selagi memindai
        if (await deleteObject(b.id, o.key)) deleted++; else failed++;
      }
    }
    res.json({ ok: true, truncated: !!token, listed, tracked: rows.length, otherObjects: other, orphans: { count: orphans.length, mb: Math.round(orphanBytes / 1e5) / 10, sample: orphans.slice(0, 15).map((o) => o.key) }, missing: { count: missing.length, sample: missing.slice(0, 15) }, deleted, failed, tooYoung: young });
  } catch (e) { res.status(502).json({ ok: false, error: `Gagal memindai bucket: ${e.message}` }); }
});
app.post("/admin/api/buckets/:id/test", adminAuth, need("storage.edit"), async (req, res) => {
  const b = bucketById(Number(req.params.id)); if (!b) return res.status(404).json({ ok: false, error: "Bucket tidak ada." });
  res.json(await checkBucket(b));
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

/** Hapus satu objek di cloud. true = sudah tidak ada (berhasil atau memang tidak ada / bucket sudah dihapus). */
async function deleteObject(bucketId, key) {
  const b = bucketById(bucketId); if (!b) return true;
  try { const r = await s3.call(b, "DELETE", key, { timeoutMs: 15000 }); return r.ok || r.status === 404; } catch { return false; }
}
/** Kosongkan "sampah": objek lama yang ditinggalkan. Dilewati bila alamat itu ternyata dipakai file aktif (mis. retry kembali ke bucket semula). */
async function emptyTrash() {
  for (const t of db.prepare("SELECT * FROM trash ORDER BY id LIMIT 200").all()) {
    const live = db.prepare("SELECT 1 FROM files WHERE bucket_id = ? AND key = ?").get(t.bucket_id, t.key);
    if (live || await deleteObject(t.bucket_id, t.key) || now() - t.created_at > 14 * 86400000) db.prepare("DELETE FROM trash WHERE id = ?").run(t.id);
    else db.prepare("UPDATE trash SET tries = tries + 1 WHERE id = ?").run(t.id);
  }
}

async function cleanup() {
  const old = db.prepare("SELECT token FROM sessions WHERE expires_at < ? LIMIT 200").all(now());
  let removed = 0;
  for (const { token } of old) {
    if (await purgeSession(token)) removed++;
  }
  // file "pending" yang tidak pernah selesai (booth mati) > 2 hari: hapus objeknya di cloud (bisa saja sudah terunggah tanpa konfirmasi),
  // baru buang catatannya supaya kuota bucket tidak tertahan. Gagal menghapus = catatan dipertahankan, dicoba lagi di putaran berikut.
  for (const f of db.prepare("SELECT * FROM files WHERE state = 'pending' AND created_at < ? LIMIT 200").all(now() - 2 * 86400000)) {
    if (await deleteObject(f.bucket_id, f.key)) db.prepare("DELETE FROM files WHERE id = ?").run(f.id);
  }
  await emptyTrash();
  return removed;
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 8088;
  app.listen(port, () => console.log(`[galeri] jalan di port ${port} · simpan ${retentionDays()} hari`));
  setTimeout(() => cleanup().catch((e) => console.error("[cleanup]", e.message)), 20000);
  setInterval(() => cleanup().catch((e) => console.error("[cleanup]", e.message)), 30 * 60 * 1000);
  setTimeout(() => checkAllBuckets().catch(() => {}), 30000);                       // tes kesehatan bucket saat mulai...
  setInterval(() => checkAllBuckets().catch(() => {}), 10 * 60 * 1000).unref?.();   // ...dan tiap 10 menit (bucket yang pulih otomatis kembali dipakai)
}
module.exports = { app, cleanup, pickBucket, purgeSession };
