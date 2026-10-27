const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { db, getSetting, setSetting, retentionDays } = require("./db");
const zipEnabled = () => getSetting("zip_enabled", "1") !== "0";
const s3 = require("./s3");
const auth = require("./auth");
const { streamZip } = require("./zip");
const { renderPage, landingPage, messagePage } = require("./page");

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

// ---------- API booth ----------
app.use("/assets", express.static(path.join(__dirname, "..", "public"), { maxAge: "7d", index: false }));
app.use(["/api", "/admin/api"], express.json({ limit: "1mb" }));
app.get("/api/v1/ping", async (req, res) => {
  try {
    const a = await auth.verify((req.headers.authorization || "").replace(/^Bearer\s+/i, ""));
    if (!a) return res.status(401).json({ ok: false, error: "Token tidak valid." });
    const buckets = db.prepare("SELECT COUNT(*) n FROM buckets WHERE enabled = 1").get().n;
    res.json({ ok: true, studio: a.studio, buckets, retentionDays: retentionDays() });
  } catch (e) { res.status(e.status || 500).json({ ok: false, error: e.message }); }
});

/** Daftarkan sesi + file, kembalikan daftar yang perlu diunggah. Dipakai booth (token studio) dan unggah manual dari website (login admin). */
function registerSession(studio, { token, mode, studioCode, files, retry, manual }) {
  token = normToken(token);
  if (!TOKEN_RE.test(String(token))) return { status: 400, error: "Token sesi tidak valid." };
  if (!Array.isArray(files) || files.length > MAX_FILES) return { status: 400, error: "Daftar file tidak valid." };
  let sess = db.prepare("SELECT * FROM sessions WHERE token = ?").get(token);
  if (sess && sess.studio !== studio) {
    if (sess.manual && !manual) { db.prepare("UPDATE sessions SET studio = ?, manual = 0 WHERE token = ?").run(studio, token); sess.studio = studio; } // booth menyusul: ambil alih sesi yang diunggah manual
    else if (!manual) return { status: 409, error: "Token sesi sudah dipakai studio lain." };
    else studio = sess.studio; // unggah manual untuk sesi yang sudah ada: ikut studio yang tercatat
  }
  if (!sess) {
    const t = now();
    db.prepare("INSERT INTO sessions (token, studio, studio_code, mode, created_at, expires_at, manual) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(token, studio, safe(studioCode, 20), String(mode || "photo").slice(0, 12), t, t + retentionDays() * 86400000, manual ? 1 : 0);
    sess = db.prepare("SELECT * FROM sessions WHERE token = ?").get(token);
  }
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
    const r = registerSession(a.studio, req.body || {});
    if (r.error) return res.status(r.status).json({ error: r.error });
    res.json(r.body);
  } catch (e) { console.error("[sessions]", e.message); res.status(e.status || 500).json({ error: e.message }); }
});

app.post("/api/v1/sessions/:token/done", async (req, res) => {
  try {
    const a = await auth.verify((req.headers.authorization || "").replace(/^Bearer\s+/i, ""));
    if (!a) return res.status(401).json({ error: "Token tidak valid." });
    const row = db.prepare("SELECT f.*, s.studio FROM files f JOIN sessions s ON s.token = f.token WHERE f.token = ? AND f.fid = ?").get(req.params.token, safe(req.body?.fid, 30));
    if (!row || row.studio !== a.studio) return res.status(404).json({ error: "File tidak ditemukan." });
    const b = bucketById(row.bucket_id);
    const r = await s3.call(b, "HEAD", row.key, { timeoutMs: 15000 }).catch(() => null);
    if (!r || !r.ok) return res.status(409).json({ error: `File belum ada di cloud (${r ? r.status : "tidak terjangkau"}).` });
    const len = Number(r.headers.get("content-length")) || row.size;
    db.prepare("UPDATE files SET state = 'ok', size = ?, uploaded_at = ? WHERE id = ?").run(len, now(), row.id);
    db.prepare("UPDATE sessions SET last_file_at = ? WHERE token = ?").run(now(), row.token);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Booth menghapus sesi (transaksi dihapus/diedit di kasir): halaman langsung tidak bisa dibuka, file dibersihkan dari bucket.
// Idempoten: sesi yang sudah tidak ada dianggap selesai. Sisa file (kalau bucket sedang bermasalah) dibereskan cleanup berkala.
app.delete("/api/v1/sessions/:token", async (req, res) => {
  try {
    const a = await auth.verify((req.headers.authorization || "").replace(/^Bearer\s+/i, ""));
    if (!a) return res.status(401).json({ error: "Token tidak valid." });
    const token = normToken(req.params.token);
    const s = TOKEN_RE.test(String(token)) ? db.prepare("SELECT studio FROM sessions WHERE token = ?").get(token) : null;
    if (!s || s.studio !== a.studio) return res.status(404).json({ error: "Sesi tidak ditemukan." });
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
function listFiles(s, { presignUrls = true } = {}) {
  const rows = db.prepare("SELECT * FROM files WHERE token = ? AND state = 'ok'").all(s.token);
  return rows.map((r) => {
    const K = KINDS[r.kind], b = bucketById(r.bucket_id);
    const name = `${K.name(r.idx)}.${r.ext}`;
    return { ...r, group: K.group, rank: K.rank, label: K.label(r.idx), name, b,
      url: presignUrls && b ? s3.presign(b, "GET", r.key, { expires: 7200, query: { "response-content-type": EXTS[r.ext] } }) : null,
      dl: presignUrls && b ? s3.presign(b, "GET", r.key, { expires: 7200, query: { "response-content-disposition": `attachment; filename="${name}"` } }) : null };
  }).sort((a, b) => a.rank - b.rank || a.idx - b.idx);
}

app.get("/s/:token", (req, res) => {
  noStore(res);
  const s = load(req.params.token);
  if (!s) return res.status(404).type("html").send(messagePage("Link tidak ditemukan atau sudah kedaluwarsa", "Hasil foto disimpan sementara."));
  const files = listFiles(s);
  const preparing = now() - s.created_at < 3 * 60 * 1000 || db.prepare("SELECT COUNT(*) n FROM files WHERE token = ? AND state = 'pending'").get(s.token).n > 0;
  res.type("html").send(renderPage({ files, studio: s.studio, token: s.token, preparing, daysLeft: Math.ceil((s.expires_at - now()) / 86400000), zip: zipEnabled() }));
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
  const files = listFiles(s);
  if (!files.length) return res.status(404).type("html").send(messagePage("File belum tersedia"));
  res.set({ "Content-Type": "application/zip", "Content-Disposition": 'attachment; filename="popsnap-sesi.zip"' });
  let aborted = false; res.on("close", () => { aborted = true; });
  try {
    await streamZip(res, files.map((f) => ({
      name: f.group === "clips" ? `klip/${f.name}` : f.group === "raw" ? `foto-mentah/${f.name}` : f.name,
      open: async () => (aborted ? null : s3.call(f.b, "GET", f.key, { timeoutMs: 120000 })),
    })));
  } catch (e) { console.error("[zip]", e.message); try { res.destroy(); } catch { /* sudah putus */ } }
});

// ---------- admin ----------
function adminAuth(req, res, next) {
  const pass = process.env.ADMIN_PASSWORD;
  if (!pass) return res.status(503).send("Admin nonaktif: isi ADMIN_PASSWORD di .env");
  const m = /^Basic (.+)$/.exec(req.headers.authorization || "");
  const [u, p] = m ? Buffer.from(m[1], "base64").toString().split(/:(.*)/s) : ["", ""];
  const ok = (a, b) => { const x = crypto.createHash("sha256").update(String(a)).digest(), y = crypto.createHash("sha256").update(String(b)).digest(); return crypto.timingSafeEqual(x, y); };
  if (ok(u, process.env.ADMIN_USER || "admin") && ok(p ?? "", pass)) return next();
  res.set("WWW-Authenticate", 'Basic realm="POPSNAP Galeri"').status(401).send("Login diperlukan");
}
// ---- Unggah manual dari website (PC CS memilih folder hasil dari jaringan bersama; file masuk ke cloud, link langsung hidup) ----
app.post("/admin/api/upload/prepare", adminAuth, (req, res) => {
  const b = req.body || {};
  const studio = String(b.studio || "").trim().slice(0, 60);
  if (!studio) return res.status(400).json({ error: "Nama studio wajib diisi." });
  const r = registerSession(studio, { token: b.token, mode: b.mode, studioCode: b.studioCode, files: b.files, retry: b.retry, manual: true });
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
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.name === "AbortError" ? "Unggahan terlalu lama (timeout)." : e.message }); }
});
const maskB = (b, used) => ({ id: b.id, name: b.name, endpoint: b.endpoint, region: b.region, bucket: b.bucket, accessKey: b.access_key, secretSet: !!b.secret_key, enabled: !!b.enabled, priority: b.priority, quotaGB: b.quota_bytes ? Math.round(b.quota_bytes / 1e7) / 100 : 0, usedGB: Math.round((used.get(b.id) || 0) / 1e7) / 100 });
app.get("/admin", adminAuth, (_req, res) => res.type("html").send(fs.readFileSync(path.join(__dirname, "admin.html"), "utf8")));
app.get("/admin/api/state", adminAuth, (_req, res) => {
  const used = usedBytes();
  res.json({
    retentionDays: retentionDays(), zipEnabled: zipEnabled(), publicUrl: PUBLIC_URL(),
    buckets: db.prepare("SELECT * FROM buckets ORDER BY priority, id").all().map((b) => maskB(b, used)),
    stats: { sessions: db.prepare("SELECT COUNT(*) n FROM sessions").get().n, files: db.prepare("SELECT COUNT(*) n FROM files WHERE state = 'ok'").get().n, pending: db.prepare("SELECT COUNT(*) n FROM files WHERE state = 'pending'").get().n },
    studios: db.prepare("SELECT studio, MAX(studio_code) code, COUNT(*) sessions, MAX(created_at) last FROM sessions GROUP BY studio ORDER BY last DESC").all(),
  });
});
app.post("/admin/api/settings", adminAuth, (req, res) => {
  if (req.body?.retentionDays != null) setSetting("retention_days", Math.max(1, Math.min(365, Math.round(Number(req.body.retentionDays) || 7))));
  if (req.body?.zipEnabled != null) setSetting("zip_enabled", req.body.zipEnabled === false || req.body.zipEnabled === "0" || req.body.zipEnabled === 0 ? "0" : "1");
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
  if (allGone) db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
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
