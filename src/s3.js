// Tanda tangan AWS SigV4 (query string / presigned URL) untuk S3-kompatibel: Cloudflare R2, AWS S3, Backblaze B2, MinIO, Wasabi, dll.
// Tanpa dependensi. Path-style: https://<endpoint>/<bucket>/<key>.
const crypto = require("crypto");
const hmac = (k, d) => crypto.createHmac("sha256", k).update(d).digest();
const hex = (d) => crypto.createHash("sha256").update(d).digest("hex");
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
const encPath = (p) => p.split("/").map(enc).join("/");

/** Mengembalikan URL bertanda tangan. `query` tambahan (mis. response-content-disposition) ikut ditandatangani. */
function presignRaw({ method, protocol = "https:", host, path, accessKey, secretKey, region, expires = 3600, query = {}, now = new Date(), service = "s3" }) {
  const amz = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const date = amz.slice(0, 8);
  const scope = `${date}/${region}/${service}/aws4_request`;
  const q = { ...query, "X-Amz-Algorithm": "AWS4-HMAC-SHA256", "X-Amz-Credential": `${accessKey}/${scope}`, "X-Amz-Date": amz, "X-Amz-Expires": String(expires), "X-Amz-SignedHeaders": "host" };
  const cq = Object.keys(q).sort().map((k) => `${enc(k)}=${enc(q[k])}`).join("&");
  const canonical = [method, encPath(path), cq, `host:${host}\n`, "host", "UNSIGNED-PAYLOAD"].join("\n");
  const sts = ["AWS4-HMAC-SHA256", amz, scope, hex(canonical)].join("\n");
  const kSigning = hmac(hmac(hmac(hmac("AWS4" + secretKey, date), region), service), "aws4_request");
  const sig = crypto.createHmac("sha256", kSigning).update(sts).digest("hex");
  return `${protocol}//${host}${encPath(path)}?${cq}&X-Amz-Signature=${sig}`;
}

function target(b) {
  const u = new URL(b.endpoint);
  return { protocol: u.protocol, host: u.host, basePath: u.pathname.replace(/\/+$/, "") };
}

/** Region untuk tanda tangan. R2 = "auto". Backblaze B2 wajib memakai region dari alamatnya (s3.<region>.backblazeb2.com), mis. us-west-004. */
function regionOf(b) {
  const r = String(b.region || "").trim();
  if (r && r !== "auto") return r;
  const m = /^s3\.([a-z0-9-]+)\.backblazeb2\.com$/i.exec(target(b).host);
  return m ? m[1] : "auto";
}

function presign(b, method, key, { expires = 3600, query = {}, now } = {}) {
  const t = target(b);
  return presignRaw({ method, protocol: t.protocol, host: t.host, path: `${t.basePath}/${b.bucket}/${key}`, accessKey: b.access_key, secretKey: b.secret_key, region: regionOf(b), expires, query, now });
}

async function call(b, method, key, { body, headers, timeoutMs = 30000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try { return await fetch(presign(b, method, key, { expires: 300 }), { method, body, headers, signal: ctrl.signal }); }
  finally { clearTimeout(timer); }
}

module.exports = { presignRaw, presign, call, regionOf };
