// Halaman unduh publik. Branding POPSNAP; nama studio kecil di bawah. Atas = hasil template/GIF/video, bawah = foto mentah & klip.
const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const isVideo = (f) => f.ext === "mp4" || f.ext === "webm";

// Tema yang sama dengan app booth: biru bergradasi + tekstur grain, logo PopSnap, font Fredoka / Plus Jakarta Sans / Space Mono (file di /assets).
const THEME_CSS = `
@font-face{font-family:"Fredoka";font-weight:700;font-style:normal;font-display:swap;src:url(/assets/fredoka-700.woff2) format("woff2")}
@font-face{font-family:"Plus Jakarta Sans";font-weight:200 800;font-style:normal;font-display:swap;src:url(/assets/jakarta.woff2) format("woff2")}
@font-face{font-family:"Space Mono";font-weight:700;font-style:normal;font-display:swap;src:url(/assets/spacemono-700.woff2) format("woff2")}
:root{--bg:#4082AE;--ink:#181B23;--red:#E02843;--yellow:#FFD23F;--yellow-ink:#3A2E00}
html{background:#285068}
body::before{content:"";position:fixed;inset:0;z-index:-1;background:url(/assets/grain.png),linear-gradient(180deg,#6EA0C1 0%,#4082AE 45%,#285068 100%)}
body{background:transparent;font-family:"Plus Jakarta Sans",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.disp{font-family:Fredoka,"Plus Jakarta Sans",system-ui,sans-serif;font-weight:700;font-style:italic}
.logo{display:block;height:34px;width:auto;filter:drop-shadow(0 2px 4px rgba(0,0,0,.3))}
`;

const CATS = [
  {
    id: "photo",
    label: "Photo",
    top: (f) => f.kind === "final",
    rest: (f) => f.group === "raw",
    restTitle: "Foto mentah (belum masuk template)",
  },
  {
    id: "gif",
    label: "GIF",
    top: (f) => f.kind === "gif",
    rest: (f) => f.kind === "gifplain",
    restTitle: "GIF polos (tanpa template)",
  },
  {
    id: "live",
    label: "Live",
    top: (f) => ["live", "video", "boomerang"].includes(f.kind),
    rest: (f) => f.group === "clips",
    restTitle: "Klip mentah per foto",
  },
];

// zip = true: tombol "Unduh semua" mengunduh satu file ZIP. zip = false: semua file diunduh satu per satu (tanpa ZIP).
function renderPage({ files, studio, token, preparing, daysLeft, zip = true }) {
  const media = (f, big) =>
    isVideo(f)
      ? `<video src="${esc(f.url)}" ${big ? "autoplay muted loop" : ""} controls playsinline preload="metadata"></video>`
      : `<img src="${esc(f.url)}" alt="${esc(f.label)}" loading="lazy">`;
  const card = (f, big) => `<section class="card${big ? " big" : ""}">
  <div class="media">${media(f, big)}</div>
  <div class="row"><b>${esc(f.label)}</b><a class="btn" href="${esc(f.dl)}" download="${esc(f.name)}">Unduh</a></div>
</section>`;
  const cats = CATS.map((c) => ({
    ...c,
    tops: files.filter(c.top),
    rests: files.filter(c.rest),
  })).filter((c) => c.tops.length || c.rests.length);
  const allBtn = files.length
    ? zip
      ? `<a class="all" href="/s/${esc(token)}/all.zip">⬇ Unduh semua (ZIP)</a>`
      : `<button class="all" type="button" id="dlall">⬇ Unduh semua</button><p class="hint" id="dlmsg"></p>`
    : "";
  const panels = cats
    .map(
      (c) => `<div class="panel" id="p-${c.id}">
${c.tops.map((f, i) => card(f, true)).join("\n")}
${allBtn}
${c.rests.length ? `<h2>${esc(c.restTitle)}</h2><div class="grid">${c.rests.map((f) => card(f, false)).join("\n")}</div>` : ""}
</div>`,
    )
    .join("\n");
  const nav =
    cats.length > 1
      ? `<nav>${cats.map((c) => `<a href="#${c.id}" data-t="${c.id}">${esc(c.label)}</a>`).join("")}</nav>`
      : "";
  const codeShown = /^[A-Z0-9]{10}$/.test(token)
    ? `${token.slice(0, 4)} ${token.slice(4, 8)} ${token.slice(8)}`
    : token;
  const dl = JSON.stringify(files.map((f) => ({ u: f.dl, n: f.name }))).replace(
    /</g,
    "\\u003c",
  );
  return `<!doctype html>
<html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer">
<title>POPSNAP — File kamu</title><link rel="icon" href="/assets/icon-popsnap.ico">
<style>${THEME_CSS}
*{box-sizing:border-box}body{margin:0;color:var(--ink)}
header.bar{position:sticky;top:0;z-index:10;background:rgba(64,130,174,.28);-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px)}
header.bar .in{max-width:640px;margin:0 auto;padding:10px 16px;display:flex;align-items:center;justify-content:space-between;gap:12px}
nav{display:flex;gap:6px}nav a{font-family:Fredoka,sans-serif;font-style:italic;color:#fff;text-decoration:none;font-weight:700;font-size:15px;padding:7px 16px;border-radius:999px;border:2px solid rgba(255,255,255,.55);background:rgba(255,255,255,.12)}
nav a.on{background:#fff;color:var(--ink);border-color:#000}
main{max-width:640px;margin:0 auto;padding:12px 16px 40px}
.panel{display:grid;gap:14px}.js .panel{display:none}.js .panel.on{display:grid}
.card{background:#fff;border:2px solid #000;border-radius:18px;overflow:hidden}
.media{background:#f2f2f2;display:flex;justify-content:center}.media img,.media video{display:block;max-width:100%;max-height:70vh}
.row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 14px}
.btn{font-family:Fredoka,sans-serif;font-style:italic;background:var(--red);color:#fff;text-decoration:none;font-weight:700;padding:9px 18px;border-radius:999px;border:2px solid #000;white-space:nowrap}
.all{font-family:Fredoka,sans-serif;font-style:italic;display:block;width:100%;text-align:center;background:var(--yellow);color:var(--yellow-ink);font-weight:700;font-size:18px;text-decoration:none;padding:14px;border-radius:999px;border:2px solid #000;cursor:pointer;font-family:inherit}
.hint{margin:6px 0 0;color:#fff;font-size:13px;text-align:center}
h2{font-family:Fredoka,sans-serif;font-style:italic;font-weight:700;margin:8px 0 0;color:#fff;font-size:18px}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px}
.grid .card .row{padding:8px 10px;flex-direction:column;align-items:stretch;text-align:center}.grid .btn{text-align:center;padding:7px}
.note{color:#fff;text-align:center;font-size:13px;opacity:.95}
#intro{display:none}
.gate #intro{display:grid;place-items:center;position:fixed;inset:0;z-index:50;overflow:hidden;background:#4082AE url(/assets/welcome-noise.png) 0 0/402px 437px repeat;min-height:100vh;min-height:100dvh}
.gate header.bar,.gate main,.gate footer{display:none}
#intro .deco{position:absolute;pointer-events:none;height:auto}
#intro .tl{top:0;left:0;width:min(32.3vw,160px)}
#intro .tr{top:0;right:0;width:min(65vw,330px)}
#intro .bl{bottom:0;left:0;width:min(39.8vw,200px)}
#intro .br{bottom:0;right:0;width:min(78vw,390px)}
#intro .mid{position:relative;display:flex;flex-direction:column;align-items:center;gap:6px;padding:24px 20px}
#intro .mid .wl{width:min(45.8vw,240px);height:auto}
#go{display:block;padding:0;border:0;background:transparent;cursor:pointer;width:clamp(170px,44vw,240px);transition:transform .12s ease}
#go img{display:block;width:100%;height:auto;pointer-events:none}
#go:active{transform:scale(.96)}
#go:focus-visible{outline:4px solid var(--yellow);outline-offset:3px}
@media (prefers-reduced-motion:reduce){#go{display:block;padding:0;border:0;background:transparent;cursor:pointer;width:clamp(170px,44vw,240px);transition:transform .12s ease}
#go img{display:block;width:100%;height:auto;pointer-events:none}
.code{font-family:"Space Mono",monospace;font-weight:700;letter-spacing:.06em;background:rgba(255,255,255,.18);border-radius:8px;padding:2px 8px}
footer{text-align:center;color:#fff;opacity:.85;font-size:12px;padding-bottom:24px;line-height:1.6}
</style></head><body>
<section id="intro" aria-label="POPSNAP">
<img class="deco tl" src="/assets/welcome-tl.svg" alt="" width="130" height="302">
<img class="deco tr" src="/assets/welcome-tr.svg" alt="" width="262" height="209">
<img class="deco bl" src="/assets/welcome-bl.svg" alt="" width="160" height="189">
<img class="deco br" src="/assets/welcome-br.svg" alt="" width="313" height="371">
<div class="mid"><img class="wl" src="/assets/welcome-logo.svg" alt="POPSNAP" width="184" height="62"><button id="go" type="button" aria-label="Get your files"><img src="/assets/welcome-btn.svg" alt="Get your files" width="156" height="46"></button></div>
</section>
<header class="bar"><div class="in"><img class="logo" src="/assets/logo.png" alt="POPSNAP">${nav}</div></header>
<main>
${panels}
${preparing ? `<p class="note" id="prep">File masih diunggah — halaman ini memperbarui sendiri.</p>` : ""}
${!files.length ? `<p class="note">File belum tersedia, sedang diunggah dari booth. Halaman memuat ulang sendiri.</p>` : ""}
</main>
<footer>${studio ? `Diambil di ${esc(studio)}<br>` : ""}Kode: <span class="code">${esc(codeShown)}</span><br>Link berlaku ${daysLeft > 0 ? `sekitar ${daysLeft} hari lagi` : "sementara"}. Simpan filenya ke galeri kamu.</footer>
<script>
(function(){
var DL=${dl};
document.documentElement.className+=' js';
var K='ps-open-'+${JSON.stringify(token)},opened=false;try{opened=!!sessionStorage.getItem(K)}catch(x){}
if(!opened&&!/^#(photo|gif|live)$/.test(location.hash))document.documentElement.className+=' gate';
document.getElementById('go').addEventListener('click',function(){try{sessionStorage.setItem(K,'1')}catch(x){}document.documentElement.className=document.documentElement.className.replace(' gate','');window.scrollTo(0,0)});
var tabs=[].slice.call(document.querySelectorAll('nav a')),panels=[].slice.call(document.querySelectorAll('.panel'));
function show(id){var f=false;panels.forEach(function(p){var on=p.id==='p-'+id;if(on)f=true;p.className='panel'+(on?' on':'')});
 if(!f&&panels[0]){id=panels[0].id.slice(2);panels[0].className='panel on'}
 tabs.forEach(function(a){a.className=a.getAttribute('data-t')===id?'on':''});window.scrollTo(0,0)}
tabs.forEach(function(a){a.addEventListener('click',function(e){e.preventDefault();var id=a.getAttribute('data-t');try{history.replaceState(null,'','#'+id)}catch(x){}show(id)})});
show((location.hash||'').slice(1)||'photo');
var b=document.getElementById('dlall');
if(b)b.addEventListener('click',function(){var i=0,m=document.getElementById('dlmsg');b.disabled=true;
 (function next(){if(i>=DL.length){m.textContent='Selesai. Cek folder unduhan. Jika ada yang tidak terunduh, izinkan unduhan berganda lalu coba lagi.';b.disabled=false;return}
  m.textContent='Mengunduh '+(i+1)+' / '+DL.length+'…';var a=document.createElement('a');a.href=DL[i].u;a.download=DL[i].n;document.body.appendChild(a);a.click();a.remove();i++;setTimeout(next,900)})()});
var n=${files.length},tries=0,t=setInterval(function(){
 if(++tries>${preparing || !files.length ? 40 : 0}){clearInterval(t);var p=document.getElementById('prep');if(p)p.remove();return}
 fetch('/s/${esc(token)}/files.json',{cache:'no-store'}).then(function(r){return r.json()}).then(function(d){if(d.count!==n||d.pending===0&&${preparing ? "true" : "false"}){clearInterval(t);location.reload()}}).catch(function(){})},4000)})();
</script></body></html>`;
}

// Halaman depan (alamat tanpa kode): perkenalan POPSNAP + kolom untuk menempel link/kode dari QR. Tidak menampilkan foto siapa pun.
function landingPage() {
  return `<!doctype html>
<html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>POPSNAP — Unduh foto kamu</title><link rel="icon" href="/assets/icon-popsnap.ico">
<style>${THEME_CSS}
*{box-sizing:border-box}body{margin:0;color:#fff}
header{position:sticky;top:0;background:rgba(64,130,174,.28);-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px)}
header .in{max-width:760px;margin:0 auto;padding:12px 16px}
main{max-width:760px;margin:0 auto;padding:28px 16px 40px;text-align:center}
h1{font-family:Fredoka,sans-serif;font-style:italic;font-size:38px;line-height:1.08;margin:22px 0 10px;font-weight:700}p.sub{font-size:16px;opacity:.95;margin:0 auto 22px;max-width:520px}
form{display:flex;gap:8px;max-width:520px;margin:0 auto 6px}input{flex:1;min-width:0;padding:14px 16px;font-size:16px;border-radius:999px;border:2px solid #000;font-family:inherit}
button{font-family:Fredoka,sans-serif;font-style:italic;background:var(--yellow);color:var(--yellow-ink);font-weight:700;font-size:18px;padding:0 22px;border-radius:999px;border:2px solid #000;cursor:pointer;font-family:inherit}
.err{color:#FFD6DB;font-size:13px;min-height:18px;margin:6px 0 0}
.steps{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:14px;margin:34px 0 0;text-align:left}
.step{background:#fff;color:var(--ink);border:2px solid #000;border-radius:18px;padding:16px}.step b{display:inline-grid;place-items:center;width:30px;height:30px;border-radius:50%;background:var(--red);color:#fff;margin-bottom:8px}
.step h3{font-family:Fredoka,sans-serif;font-style:italic;margin:0 0 4px;font-size:18px}.step p{margin:0;font-size:14px;color:#44505E}
footer{text-align:center;opacity:.85;font-size:12px;padding:0 16px 28px;line-height:1.6}
</style></head><body>
<header><div class="in"><img class="logo" src="/assets/logo.png" alt="POPSNAP"></div></header>
<main>
<h1>Foto kamu sudah siap! 🎉</h1>
<p class="sub">Scan QR di booth untuk membuka halaman fotomu. Kalau QR-nya tidak terbaca, tempel link atau kode dari booth di bawah ini.</p>
<form id="f"><input id="c" placeholder="Ketik kode atau tempel link (mis. K7M2 9QXH 4B)" autocomplete="off" autocapitalize="off"><button type="submit">Buka</button></form>
<div class="err" id="e"></div>
<div class="steps">
<div class="step"><b>1</b><h3>Scan QR</h3><p>Arahkan kamera HP ke QR di layar booth.</p></div>
<div class="step"><b>2</b><h3>Lihat hasilnya</h3><p>Template, GIF, dan video Live tampil di satu halaman.</p></div>
<div class="step"><b>3</b><h3>Unduh</h3><p>Simpan semua sekaligus atau pilih per foto.</p></div>
</div>
</main>
<footer>Link bersifat pribadi dan hanya berlaku beberapa hari. Segera simpan filenya ke galeri kamu.</footer>
<script>
document.getElementById('f').addEventListener('submit',function(e){e.preventDefault();
 var v=document.getElementById('c').value.trim(),c=v.replace(/[\\s-]/g,'').toUpperCase(),m=v.match(/\\/s\\/([A-Za-z0-9_-]{10,40})/)||(/^[23456789A-HJ-NP-Z]{10}$/.test(c)?[0,c]:null)||v.match(/^([A-Za-z0-9_-]{16,40})$/);
 if(m)location.href='/s/'+m[1];else document.getElementById('e').textContent='Link atau kode tidak dikenali. Salin lagi dari booth.'});
</script></body></html>`;
}

const messagePage = (
  title,
  sub = "",
) => `<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>POPSNAP</title></head>
<style>${THEME_CSS}</style><body style="color:#fff;text-align:center;padding:48px 20px"><img class="logo" style="margin:0 auto 16px" src="/assets/logo.png" alt="POPSNAP"><h2>${esc(title)}</h2><p>${esc(sub)}</p></body></html>`;

module.exports = { renderPage, landingPage, messagePage, esc };
