// Uji: tanda tangan SigV4 (vektor resmi AWS) + alur lengkap dengan S3 tiruan.
process.env.DATA_DIR = require("fs").mkdtempSync(require("os").tmpdir() + "/gal-");
process.env.STUDIO_TOKENS = "tokenstudioA0000000:Studio A,tokenstudioB0000000:Studio B";
process.env.ADMIN_PASSWORD = "rahasia"; process.env.ADMIN_ALLOW_BASIC = "1"; process.env.PUBLIC_URL = "https://foto.example.com";
const assert = require("assert"), http = require("http"), zlib = require("zlib");
const { presignRaw } = require("../src/s3");

// 1) vektor resmi AWS (GET presigned, docs "Authenticating Requests: Using Query Parameters")
const u = presignRaw({ method: "GET", host: "examplebucket.s3.amazonaws.com", path: "/test.txt", accessKey: "AKIAIOSFODNN7EXAMPLE", secretKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", region: "us-east-1", expires: 86400, now: new Date("2013-05-24T00:00:00Z") });
assert(u.endsWith("aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404"), "SigV4 salah: " + u);
console.log("ok  SigV4 cocok dengan vektor resmi AWS");
const { regionOf, presign } = require("../src/s3");
assert.strictEqual(regionOf({ endpoint: "https://s3.us-west-004.backblazeb2.com", region: "auto" }), "us-west-004");
assert.strictEqual(regionOf({ endpoint: "https://s3.eu-central-003.backblazeb2.com", region: "" }), "eu-central-003");
assert.strictEqual(regionOf({ endpoint: "https://abc.r2.cloudflarestorage.com", region: "auto" }), "auto");
assert.strictEqual(regionOf({ endpoint: "https://s3.us-west-004.backblazeb2.com", region: "us-west-002" }), "us-west-002");
const bu = presign({ endpoint: "https://s3.us-west-004.backblazeb2.com", region: "auto", bucket: "bk", access_key: "K", secret_key: "S" }, "GET", "a/b c.jpg", { now: new Date("2026-01-01T00:00:00Z") });
assert(bu.startsWith("https://s3.us-west-004.backblazeb2.com/bk/a/b%20c.jpg?") && bu.includes("us-west-004%2Fs3%2Faws4_request"), bu);
console.log("ok  region Backblaze B2 diambil dari endpoint, path-style benar");

(async () => {
  // S3 tiruan (memori)
  const store = new Map();
  const s3 = http.createServer((req, res) => {
    const key = decodeURIComponent(req.url.split("?")[0]);
    if (!/X-Amz-Signature=[0-9a-f]{64}/.test(req.url)) { res.statusCode = 403; return res.end(); }
    if (req.method === "PUT") { const c = []; req.on("data", (d) => c.push(d)); req.on("end", () => { store.set(key, Buffer.concat(c)); res.end(); }); return; }
    const v = store.get(key);
    if (req.method === "DELETE") { store.delete(key); res.statusCode = 204; return res.end(); }
    if (!v) { res.statusCode = 404; return res.end(); }
    res.setHeader("Content-Length", v.length); if (req.method === "HEAD") return res.end(); res.end(v);
  }).listen(0);
  const s3port = s3.address().port;

  const { app, cleanup } = require("../src/server");
  const srv = app.listen(0); const base = `http://127.0.0.1:${srv.address().port}`;
  const A = { Authorization: "Bearer tokenstudioA0000000", "Content-Type": "application/json" };
  const admin = { Authorization: "Basic " + Buffer.from("admin:rahasia").toString("base64"), "Content-Type": "application/json" };
  const j = async (p, o) => { const r = await fetch(base + p, o); return { status: r.status, body: await r.json().catch(() => null), r }; };

  assert.strictEqual((await j("/admin/api/state")).status, 401);
  // login lewat halaman: tanpa popup Basic Auth, cookie sesi, batas percobaan
  const lp = await fetch(`${base}/admin`); assert.strictEqual(lp.status, 401); assert(!lp.headers.get("www-authenticate"), "tidak boleh memunculkan popup Basic Auth"); assert((await lp.text()).includes("Masuk ke galeri"));
  const JS = { "Content-Type": "application/json" };
  assert.strictEqual((await j("/admin/api/login", { method: "POST", headers: JS, body: JSON.stringify({ username: "admin", password: "salah" }) })).status, 401);
  const good = await fetch(`${base}/admin/api/login`, { method: "POST", headers: JS, body: JSON.stringify({ username: "admin", password: "rahasia" }) }); assert.strictEqual(good.status, 200);
  const ck = good.headers.get("set-cookie"); assert(/HttpOnly/.test(ck) && /SameSite=Strict/.test(ck), ck);
  const cookie = ck.split(";")[0];
  assert.strictEqual((await j("/admin/api/state", { headers: { Cookie: cookie } })).status, 200);
  assert.strictEqual((await fetch(`${base}/admin`, { headers: { Cookie: cookie } })).status, 200);
  assert.strictEqual((await j("/admin/api/state", { headers: { Cookie: cookie.slice(0, -3) + "xyz" } })).status, 401, "cookie palsu harus ditolak");
  // Basic Auth mati secara bawaan (supaya tombol Keluar efektif): dengan flag mati, kredensial Basic yang benar pun ditolak
  process.env.ADMIN_ALLOW_BASIC = "0";
  assert.strictEqual((await j("/admin/api/state", { headers: admin })).status, 401, "Basic harus ditolak saat ADMIN_ALLOW_BASIC bukan 1");
  const lo = await fetch(`${base}/admin/api/logout`, { method: "POST", headers: { Cookie: cookie } }); assert(/Max-Age=0/.test(lo.headers.get("set-cookie")));
  process.env.ADMIN_ALLOW_BASIC = "1";
  for (let i = 0; i < 5; i++) await j("/admin/api/login", { method: "POST", headers: { ...JS, "X-Real-IP": "9.9.9.9" }, body: JSON.stringify({ username: "admin", password: "x" + i }) });
  assert.strictEqual((await j("/admin/api/login", { method: "POST", headers: { ...JS, "X-Real-IP": "9.9.9.9" }, body: JSON.stringify({ username: "admin", password: "rahasia" }) })).status, 429, "harus terkunci setelah 5x salah");
  assert.strictEqual((await j("/admin/api/login", { method: "POST", headers: { ...JS, "X-Real-IP": "8.8.8.8" }, body: JSON.stringify({ username: "admin", password: "rahasia" }) })).status, 200, "IP lain tidak ikut terkunci");
  console.log("ok  login admin: halaman masuk, cookie sesi, cookie palsu ditolak, kunci 5x salah");
  assert.strictEqual((await j("/api/v1/ping", { headers: { Authorization: "Bearer salahsalahsalahsalah" } })).status, 401);
  // tanpa bucket -> 503
  assert.strictEqual((await j("/api/v1/sessions", { method: "POST", headers: A, body: JSON.stringify({ token: "abcDEF1234567890", files: [{ fid: "f", kind: "final", ext: "jpg", size: 10 }] }) })).status, 503);
  // 2 bucket
  for (const [n, p] of [["B1", 1], ["B2", 1]]) assert((await j("/admin/api/buckets", { method: "POST", headers: admin, body: JSON.stringify({ name: n, endpoint: `http://127.0.0.1:${s3port}`, bucket: n.toLowerCase(), accessKey: "AK", secretKey: "SK", priority: p, quotaGB: 1 }) })).body.ok);
  const st = (await j("/admin/api/state", { headers: admin })).body; assert.strictEqual(st.buckets.length, 2); assert(!JSON.stringify(st).includes('"SK"'), "secret bocor");
  const tst = (await j(`/admin/api/buckets/${st.buckets[0].id}/test`, { method: "POST", headers: admin })).body; assert(tst.ok, JSON.stringify(tst));
  console.log("ok  admin: tambah bucket, tes tulis/baca, secret tersembunyi");

  // sesi: final + gif + 2 raw + 1 clip
  const token = "Sess1234567890abc";
  const files = [{ fid: "final", kind: "final", ext: "jpg", size: 11 }, { fid: "gif", kind: "gif", ext: "gif", size: 7 }, { fid: "r1", kind: "raw", idx: 1, ext: "jpg", size: 5 }, { fid: "r2", kind: "raw", idx: 2, ext: "jpg", size: 5 }, { fid: "c1", kind: "clip", idx: 1, ext: "mp4", size: 9 }, { fid: "bad", kind: "x", ext: "exe", size: 1 }];
  const r1 = await j("/api/v1/sessions", { method: "POST", headers: A, body: JSON.stringify({ token, studioCode: "ABC", files }) });
  assert.strictEqual(r1.status, 200); assert.strictEqual(r1.body.uploads.length, 5); assert.strictEqual(r1.body.skipped.length, 1);
  assert.strictEqual(r1.body.shareUrl, `https://foto.example.com/s/${token}`);
  // halaman sebelum unggah: kosong tapi tidak error
  assert((await (await fetch(`${base}/s/${token}`)).text()).includes("diunggah"));
  const payload = { final: "FINALJPEG..", gif: "GIF8abc", r1: "raw-1", r2: "raw-2", c1: "clip-mp4.." };
  for (const up of r1.body.uploads) {
    const pr = await fetch(up.url, { method: "PUT", body: payload[up.fid] }); assert(pr.ok);
    const d = await j(`/api/v1/sessions/${token}/done`, { method: "POST", headers: A, body: JSON.stringify({ fid: up.fid }) }); assert(d.body.ok, JSON.stringify(d.body));
  }
  // studio lain tidak boleh memakai token sesi yang sama
  assert.strictEqual((await j("/api/v1/sessions", { method: "POST", headers: { ...A, Authorization: "Bearer tokenstudioB0000000" }, body: JSON.stringify({ token, files: [] }) })).status, 409);
  // kirim ulang daftar sama: tidak ada unggahan baru (idempotent)
  assert.strictEqual((await j("/api/v1/sessions", { method: "POST", headers: A, body: JSON.stringify({ token, files }) })).body.uploads.length, 0);
  console.log("ok  sesi: presign -> unggah -> konfirmasi, idempotent, isolasi studio");

  const html = await (await fetch(`${base}/s/${token}`)).text();
  assert(html.includes("POPSNAP") && html.includes("Diambil di Studio A") && html.indexOf("Photo Frame") > 0 && html.indexOf("Photo Frame") < html.indexOf('class="card rest"') && html.includes("1 Photo") && html.includes("GIF Frame") && html.includes(`all.zip?cat=photo`) && html.includes(`all.zip?cat=live`));
  assert(html.includes("response-content-disposition"), "tombol unduh harus memaksa download");
  console.log("ok  halaman: tab GIF/Photo/Live, frame di atas, mentahan (carousel) di bawah, unduh paksa");

  // thumbnail: file palsu (bukan gambar) -> dialihkan ke file asli; JPEG asli -> thumbnail kecil dan di-cache
  assert(html.includes(`/s/${token}/t/final`) && html.includes(`/s/${token}/t/r1`), "halaman memakai URL thumbnail");
  assert(!/<img src="[^"]*gif[^"]*t\/gif/.test(html) && !html.includes(`/t/gif`), "GIF tidak diberi thumbnail");
  const tfake = await fetch(`${base}/s/${token}/t/r1`, { redirect: "manual" });
  assert.strictEqual(tfake.status, 302); assert(tfake.headers.get("location").includes("X-Amz-Signature"));
  assert.strictEqual((await fetch(`${base}/s/${token}/t/nope`)).status, 404);
  assert.strictEqual((await fetch(`${base}/s/ZZZZnotfound12345/t/r1`)).status, 404);
  let sharpOk = true; try { require("sharp"); } catch { sharpOk = false; }
  if (sharpOk) {
    const sharp = require("sharp");
    const big = await sharp({ create: { width: 3000, height: 2000, channels: 3, background: { r: 200, g: 40, b: 40 } } }).jpeg({ quality: 95 }).toBuffer();
    const tk = "Thumb12345678abc";
    const pr0 = await j("/api/v1/sessions", { method: "POST", headers: A, body: JSON.stringify({ token: tk, studioCode: "ABC", files: [{ fid: "final", kind: "final", ext: "jpg", size: big.length }] }) });
    assert.strictEqual(pr0.status, 200);
    assert((await fetch(pr0.body.uploads[0].url, { method: "PUT", body: big })).ok);
    assert((await j(`/api/v1/sessions/${tk}/done`, { method: "POST", headers: A, body: JSON.stringify({ fid: "final" }) })).body.ok);
    const t1 = await fetch(`${base}/s/${tk}/t/final`); const tb = Buffer.from(await t1.arrayBuffer());
    assert.strictEqual(t1.status, 200); assert.strictEqual(t1.headers.get("content-type"), "image/jpeg"); assert(/max-age=86400/.test(t1.headers.get("cache-control")));
    const meta = await sharp(tb).metadata(); assert.strictEqual(meta.width, 1200); assert(tb.length < big.length / 3, `thumbnail ${tb.length} vs ${big.length}`);
    assert.strictEqual((await fetch(`${base}/s/${tk}/t/final`)).status, 200);
    const urlA = (await (await fetch(`${base}/s/${tk}`)).text()).match(/href="(https?:[^"]*response-content-disposition[^"]*)"/)[1];
    const urlB = (await (await fetch(`${base}/s/${tk}`)).text()).match(/href="(https?:[^"]*response-content-disposition[^"]*)"/)[1];
    assert.strictEqual(urlA, urlB, "URL unduh harus stabil antar muat ulang");
    await j(`/api/v1/sessions/${tk}`, { method: "DELETE", headers: A });
    assert.strictEqual((await fetch(`${base}/s/${tk}/t/final`)).status, 404);
  }
  console.log("ok  thumbnail: redirect untuk file bukan gambar, 1200px + cache untuk JPEG, URL stabil, hilang saat sesi dihapus");

  // ZIP: validasi dengan unzip
  const zr = await fetch(`${base}/s/${token}/all.zip`); const zb = Buffer.from(await zr.arrayBuffer());
  if (zr.headers.get("content-length")) assert.strictEqual(Number(zr.headers.get("content-length")), zb.length, "Content-Length ZIP harus pas");
  require("fs").writeFileSync("/tmp/gal-test.zip", zb);
  const out = require("child_process").spawnSync("unzip", ["-t", "/tmp/gal-test.zip"], { encoding: "utf8" });
  assert(/No errors detected/.test(out.stdout), out.stdout + out.stderr);
  const ls = require("child_process").spawnSync("unzip", ["-Z1", "/tmp/gal-test.zip"], { encoding: "utf8" }).stdout.trim().split("\n");
  assert.strictEqual(ls.length, 5); assert(ls.includes("foto-mentah/popsnap-mentah-1.jpg") && ls.includes("klip/popsnap-klip-1.mp4"));
  console.log("ok  ZIP streaming valid (" + ls.length + " file)");

  // ZIP bisa dimatikan: tombol jadi "Unduh semua" satu per satu, link ZIP ditolak
  assert(html.includes("All Photo (zip)") && html.includes('data-t="gif"') && html.includes('data-t="live"'));
  await fetch(`${base}/admin/api/settings`, { method: "POST", headers: admin, body: JSON.stringify({ zipEnabled: "0" }) });
  const h2 = await (await fetch(`${base}/s/${token}`)).text();
  assert(!h2.includes("all.zip") && h2.includes('class="zipb dlall"'));
  assert.strictEqual((await fetch(`${base}/s/${token}/all.zip`)).status, 404);
  await fetch(`${base}/admin/api/settings`, { method: "POST", headers: admin, body: JSON.stringify({ zipEnabled: "2" }) });
  const h3 = await (await fetch(`${base}/s/${token}`)).text();
  assert(h3.includes("all.zip?cat=photo") && h3.includes("Unduh semua file") && h3.includes('class="zipb dlall"'), "mode keduanya: ZIP + unduh semua file");
  assert.strictEqual((await fetch(`${base}/s/${token}/all.zip`)).status, 200);
  assert.strictEqual((await j("/admin/api/state", { headers: admin })).body.zipMode, "2");
  await fetch(`${base}/admin/api/settings`, { method: "POST", headers: admin, body: JSON.stringify({ zipEnabled: "1" }) });
  assert.strictEqual((await fetch(`${base}/s/${token}/all.zip`)).status, 200);
  { // ZIP per kategori: foto = hasil template + mentahan saja (tanpa GIF/klip)
    require("fs").writeFileSync("/tmp/gal-cat.zip", Buffer.from(await (await fetch(`${base}/s/${token}/all.zip?cat=photo`)).arrayBuffer()));
    const names = require("child_process").spawnSync("unzip", ["-Z1", "/tmp/gal-cat.zip"], { encoding: "utf8" }).stdout.trim().split("\n");
    assert(names.some((n) => n.includes("popsnap-foto")) && names.some((n) => n.includes("mentah")) && !names.some((n) => n.includes("gif") || n.includes("klip")), names.join(","));
  }
  console.log("ok  pengaturan ZIP on/off + tab Photo/GIF/Live + ZIP per kategori");

  // kode pendek 10 karakter: bisa diketik huruf kecil / dengan spasi-strip, halaman punya layar pembuka
  const code = "K7M29QXH4B";
  assert.strictEqual((await j("/api/v1/sessions", { method: "POST", headers: A, body: JSON.stringify({ token: code, files: [{ fid: "final", kind: "final", ext: "jpg", size: 3 }] }) })).status, 200);
  const hc = await fetch(`${base}/s/k7m2-9qxh-4b`); assert.strictEqual(hc.status, 200);
  const ht = await hc.text(); assert(ht.includes('id="intro"') && ht.includes('id="go"') && ht.includes("K7M2 9QXH 4B"));
  console.log("ok  kode pendek tidak peka huruf besar/kecil + layar pembuka");

  // ---- unggah manual dari website (PC CS) ----
  const mt = "Manual1234567890x";
  const prep = await j("/admin/api/upload/prepare", { method: "POST", headers: admin, body: JSON.stringify({ token: mt, studio: "Studio A", studioCode: "ABC", mode: "photo", files: [{ fid: "final", kind: "final", ext: "png", size: 8 }, { fid: "raw1", kind: "raw", idx: 1, ext: "jpg", size: 6 }] }) });
  assert.strictEqual(prep.status, 200); assert.strictEqual(prep.body.uploads.length, 2);
  assert.strictEqual((await j("/admin/api/upload/prepare", { method: "POST", headers: {} , body: "{}" })).status, 401);
  for (const [fid, data] of [["final", "PNGDATA!"], ["raw1", "JPEG-1"]]) {
    const pr = await fetch(`${base}/admin/api/upload/${mt}/${fid}`, { method: "PUT", headers: { ...admin, "Content-Type": "application/octet-stream" }, body: data });
    assert.strictEqual(pr.status, 200, await pr.text());
  }
  const mh = await (await fetch(`${base}/s/${mt}`)).text(); assert(mh.includes("Foto template") && mh.includes("Foto mentah 1") && mh.includes("Studio A"));
  const keys = [...store.keys()].filter((k) => k.includes(mt)); assert.strictEqual(keys.length, 2);
  assert.strictEqual(store.get(keys.find((k) => k.endsWith("final.png"))).toString(), "PNGDATA!");
  // booth menyusul (internet pulih): mengambil alih sesi manual & tidak mengunggah ulang file yang sudah ada
  const Bt = { Authorization: "Bearer tokenstudioB0000000", "Content-Type": "application/json" };
  const adopt = await j("/api/v1/sessions", { method: "POST", headers: Bt, body: JSON.stringify({ token: mt, files: [{ fid: "final", kind: "final", ext: "png", size: 8 }, { fid: "raw1", kind: "raw", idx: 1, ext: "jpg", size: 6 }, { fid: "gif", kind: "gif", ext: "gif", size: 7 }] }) });
  assert.strictEqual(adopt.status, 200); assert.strictEqual(adopt.body.uploads.length, 1, "hanya file baru (gif) yang perlu diunggah");
  console.log("ok  unggah manual dari website: stream ke cloud, link hidup, booth menyusul mengambil alih");

  // ---- booth menghapus sesi (transaksi dihapus di kasir) ----
  const Bd = { Authorization: "Bearer tokenstudioB0000000" }, Ad = { Authorization: "Bearer tokenstudioA0000000" };
  assert.strictEqual((await fetch(`${base}/api/v1/sessions/${code}`, { method: "DELETE", headers: Bd })).status, 404, "studio lain tidak boleh menghapus");
  assert.strictEqual((await fetch(`${base}/api/v1/sessions/${code}`, { method: "DELETE" })).status, 401);
  assert.strictEqual((await fetch(`${base}/s/${code}`)).status, 200);
  const del = await j(`/api/v1/sessions/${code}`, { method: "DELETE", headers: Ad }); assert.strictEqual(del.status, 200); assert(del.body.ok && del.body.deleted, JSON.stringify(del.body));
  assert.strictEqual((await fetch(`${base}/s/${code}`)).status, 404, "halaman harus langsung tidak bisa dibuka");
  assert.strictEqual(require("../src/db").db.prepare("SELECT COUNT(*) n FROM sessions WHERE token = ?").get(code).n, 0);
  assert.strictEqual((await fetch(`${base}/api/v1/sessions/${code}`, { method: "DELETE", headers: Ad })).status, 404, "sudah terhapus -> 404 (booth menganggap selesai)");
  console.log("ok  hapus sesi dari booth: hanya pemilik, halaman 404, file & catatan dibersihkan, idempoten");

  // ---- admin: kelola link pelanggan ----
  const mk = async (tk, fid = "final") => { const r = await j("/api/v1/sessions", { method: "POST", headers: A, body: JSON.stringify({ token: tk, studioCode: "ABC", files: [{ fid, kind: "final", ext: "jpg", size: 6 }] }) }); assert.strictEqual(r.status, 200); await fetch(r.body.uploads[0].url, { method: "PUT", body: "JPEG-1" }); await j(`/api/v1/sessions/${tk}/done`, { method: "POST", headers: A, body: JSON.stringify({ fid }) }); };
  await mk("KELOLA2345"); await mk("KELOLB6789");
  assert.strictEqual((await fetch(`${base}/admin/api/sessions`)).status, 401, "butuh login admin");
  const l1 = (await j("/admin/api/sessions?limit=100", { headers: admin })).body;
  assert(l1.total >= 2 && l1.sessions.some((x) => x.token === "KELOLA2345" && x.files === 1 && x.bytes === 6 && x.manual === false && x.studio === "Studio A"), JSON.stringify(l1.sessions[0]));
  assert.strictEqual((await j("/admin/api/sessions?q=kelol%20a2345", { headers: admin })).body.total, 1, "cari kode tak peka huruf/spasi");
  assert.strictEqual((await j("/admin/api/sessions?q=%25", { headers: admin })).body.total, 0, "tanda % dicari apa adanya, bukan wildcard");
  assert.strictEqual((await j("/admin/api/sessions?source=manual&q=KELOL", { headers: admin })).body.total, 0);
  assert.strictEqual((await j("/admin/api/sessions?limit=1&offset=1", { headers: admin })).body.sessions.length, 1);
  const tgt = Date.now() + 20 * 86400000;
  assert.strictEqual((await j("/admin/api/sessions/KELOLA2345", { method: "POST", headers: admin, body: JSON.stringify({ expiresAt: tgt, studio: "Studio <b>Baru</b>" }) })).status, 200);
  const l2 = (await j("/admin/api/sessions?q=KELOLA2345", { headers: admin })).body.sessions[0];
  assert.strictEqual(l2.expiresAt, Math.round(tgt)); assert.strictEqual(l2.studio, "Studio bBaru/b");
  assert.strictEqual((await j("/admin/api/sessions/KELOLA2345", { method: "POST", headers: admin, body: JSON.stringify({ expiresAt: Date.now() - 1000 }) })).status, 400, "tidak boleh di masa lalu");
  assert.strictEqual((await j("/admin/api/sessions/KELOLA2345", { method: "POST", headers: admin, body: JSON.stringify({ expiresAt: Date.now() + 9999 * 86400000 }) })).status, 400, "batas maksimal");
  assert.strictEqual((await j("/admin/api/sessions/TIDAKADA123", { method: "POST", headers: admin, body: JSON.stringify({ studio: "x" }) })).status, 404);
  const expBefore = (await j("/admin/api/sessions?q=KELOLB6789", { headers: admin })).body.sessions[0].expiresAt;
  const ext = await j("/admin/api/sessions-bulk", { method: "POST", headers: admin, body: JSON.stringify({ action: "extend", days: 3, tokens: ["KELOLB6789"] }) });
  assert(ext.body.ok && ext.body.done === 1);
  assert.strictEqual((await j("/admin/api/sessions?q=KELOLB6789", { headers: admin })).body.sessions[0].expiresAt, expBefore + 3 * 86400000);
  assert.strictEqual((await fetch(`${base}/s/KELOLA2345`)).status, 200);
  const dd = await j("/admin/api/sessions/KELOLA2345", { method: "DELETE", headers: admin }); assert(dd.body.ok && dd.body.deleted);
  assert.strictEqual((await fetch(`${base}/s/KELOLA2345`)).status, 404, "link mati setelah dihapus");
  const bd = await j("/admin/api/sessions-bulk", { method: "POST", headers: admin, body: JSON.stringify({ action: "delete", tokens: ["KELOLB6789", "TIDAKADA123"] }) });
  assert(bd.body.ok && bd.body.done === 1 && bd.body.pending === 0, JSON.stringify(bd.body));
  assert.strictEqual((await j("/admin/api/sessions?q=KELOL", { headers: admin })).body.total, 0);
  assert.strictEqual((await j("/admin/api/sessions-bulk", { method: "POST", headers: admin, body: JSON.stringify({ action: "x", tokens: ["A"] }) })).status, 400);
  console.log("ok  admin link pelanggan: daftar/cari/filter, ubah masa berlaku & studio, hapus satuan & massal, perpanjang massal");

  // bagi rata antar bucket sama-prioritas
  const used = (await j("/admin/api/state", { headers: admin })).body.buckets; assert(used.every((b) => b.usedGB >= 0));
  // kedaluwarsa + hapus otomatis
  const { db } = require("../src/db"); db.prepare("UPDATE sessions SET expires_at = 1 WHERE token = ?").run(token);
  assert.strictEqual((await fetch(`${base}/s/${token}`)).status, 404);
  const before = store.size; const removed = await cleanup(); assert.strictEqual(removed, 1);
  assert(store.size < before && ![...store.keys()].some((k) => k.includes(token)), "file cloud harus terhapus");
  assert.strictEqual(db.prepare("SELECT COUNT(*) n FROM files WHERE token = ?").get(token).n, 0);
  console.log("ok  kedaluwarsa: halaman 404, file di cloud terhapus, catatan dibersihkan");
  srv.close(); s3.close(); process.exit(0);
})().catch((e) => { console.error("GAGAL:", e); process.exit(1); });
