// Token studio = token yang sama dengan yang dipakai booth untuk sinkron ke kasir. Diverifikasi ke kasir (GET /api/photobox/ping),
// hasilnya di-cache supaya tidak membebani kasir. Cadangan: STUDIO_TOKENS="token:Nama Studio,token2:Studio 2" (tanpa kasir / untuk uji).
const crypto = require("crypto");
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const cache = new Map(); // sha(token) -> { ok, studio, at }
const OK_TTL = 10 * 60 * 1000, BAD_TTL = 30 * 1000;

function staticTokens() {
  const m = new Map();
  for (const part of String(process.env.STUDIO_TOKENS || "").split(",")) {
    const i = part.indexOf(":"); if (i < 1) continue;
    m.set(part.slice(0, i).trim(), part.slice(i + 1).trim() || "Studio");
  }
  return m;
}

async function verify(token) {
  token = String(token || "");
  if (token.length < 16 || token.length > 200) return null;
  const st = staticTokens();
  if (st.has(token)) return { studio: st.get(token) };
  const base = String(process.env.KASIR_URL || "").trim().replace(/\/+$/, "").replace(/\/api\/photobox$/i, "");
  if (!base) return null;
  const k = sha(token), hit = cache.get(k), now = Date.now();
  if (hit && now - hit.at < (hit.ok ? OK_TTL : BAD_TTL)) return hit.ok ? { studio: hit.studio } : null;
  try {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 8000);
    const r = await fetch(`${base}/api/photobox/ping`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }, signal: ctrl.signal });
    clearTimeout(t);
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.ok) { cache.set(k, { ok: true, studio: j.studio || "Studio", at: now }); return { studio: j.studio || "Studio" }; }
    if (r.status === 401 || r.status === 403) { cache.set(k, { ok: false, at: now }); return null; }
  } catch { /* kasir tidak terjangkau */ }
  if (hit && hit.ok) return { studio: hit.studio }; // kasir mati sementara: pakai hasil lama
  const err = new Error("Kasir tidak terjangkau untuk memeriksa token."); err.status = 503; throw err;
}

/** Cek kasir terjangkau (tanpa token studio): 401/403 = kasir hidup & menolak token kosong = SEHAT. */
async function checkKasir() {
  const base = String(process.env.KASIR_URL || "").trim().replace(/\/+$/, "").replace(/\/api\/photobox$/i, "");
  if (!base) return { configured: false, ok: staticTokens().size > 0, error: staticTokens().size ? null : "KASIR_URL belum diisi di .env galeri", note: staticTokens().size ? "Memakai STUDIO_TOKENS (tanpa kasir)" : "" };
  const t0 = Date.now();
  try {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 8000);
    const r = await fetch(`${base}/api/photobox/ping`, { headers: { Accept: "application/json" }, signal: ctrl.signal });
    clearTimeout(t);
    const ok = r.status === 401 || r.status === 403 || r.ok;
    return { configured: true, ok, ms: Date.now() - t0, status: r.status, url: base, error: ok ? null : `Kasir membalas HTTP ${r.status}` };
  } catch (e) { return { configured: true, ok: false, ms: Date.now() - t0, url: base, error: e.name === "AbortError" ? "Kasir tidak menjawab (timeout)" : `Kasir tidak terjangkau: ${e.cause?.code || e.message}` }; }
}

module.exports = { verify, checkKasir };
