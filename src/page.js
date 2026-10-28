// Halaman unduh publik. Branding POPSNAP; nama studio kecil di bawah. Atas = hasil template/GIF/video, bawah = foto mentah & klip.
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const isVideo = (f) => f.ext === "mp4" || f.ext === "webm";

// Tema yang sama dengan app booth: biru bergradasi + tekstur grain, logo PopSnap, font Fredoka / Plus Jakarta Sans / Space Mono (file di /assets).
const THEME_CSS = `
@font-face{font-family:"Fredoka";font-weight:700;font-style:normal;font-display:swap;src:url(/assets/fredoka-700.woff2) format("woff2")}
@font-face{font-family:"Plus Jakarta Sans";font-weight:200 800;font-style:normal;font-display:swap;src:url(/assets/jakarta.woff2) format("woff2")}
@font-face{font-family:"Space Mono";font-weight:700;font-style:normal;font-display:swap;src:url(/assets/spacemono-700.woff2) format("woff2")}
:root{--bg:#4082AE;--ink:#181B23;--red:#E02843;--yellow:#FFD23F;--yellow-ink:#3A2E00}
html{background:#4082AE url(/assets/welcome-noise.webp) 0 0/402px 437px}
body{background:transparent;font-family:"Plus Jakarta Sans",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.disp{font-family:Fredoka,"Plus Jakarta Sans",system-ui,sans-serif;font-weight:700;font-style:italic}
.logo{display:block;height:34px;width:auto;filter:drop-shadow(0 2px 4px rgba(0,0,0,.3))}
`;

// Layar pembuka "Get your files" (desain Welcome_screen).
const introCss = `#intro{display:none}
.gate #intro{display:grid;place-items:center;position:fixed;inset:0;z-index:50;overflow:hidden;background:#4082AE url(/assets/welcome-noise.webp) 0 0/402px 437px repeat;min-height:100vh;min-height:100dvh}
.gate header.bar,.gate main,.gate footer{display:none}
#intro{container-type:size}
#intro>*{--ud:calc(min(100cqw, 100cqh * .575) / 402);--uc:calc(min(100cqw, 100cqh * .8, 700px) / 402)}
#intro .deco{position:absolute;pointer-events:none;height:auto}
#intro .tl{top:0;left:0;width:calc(var(--ud) * 130)}
#intro .tr{top:0;right:0;width:calc(var(--ud) * 262)}
#intro .bl{bottom:0;left:0;width:calc(var(--ud) * 160)}
#intro .br{bottom:0;right:0;width:calc(var(--ud) * 313)}
#intro .mid{position:relative;display:flex;flex-direction:column;align-items:center;gap:calc(var(--uc) * 6);padding:calc(var(--uc) * 24) calc(var(--uc) * 20)}
#intro .mid .wl{width:calc(var(--uc) * 184);height:auto}
#go{display:block;padding:0;border:0;background:transparent;cursor:pointer;width:calc(var(--uc) * 176);transition:transform .12s ease}
#go img{display:block;width:100%;height:auto;pointer-events:none}
#go:active{transform:scale(.96)}
#go:focus-visible{outline:4px solid var(--yellow);outline-offset:3px}
@media (prefers-reduced-motion:reduce){#go{transition:none}}
`;
const introHtml = `<section id="intro" aria-label="POPSNAP">
<img class="deco tl" src="/assets/welcome-tl.svg" alt="" width="130" height="302">
<img class="deco tr" src="/assets/welcome-tr.svg" alt="" width="262" height="209">
<img class="deco bl" src="/assets/welcome-bl.svg" alt="" width="160" height="189">
<img class="deco br" src="/assets/welcome-br.svg" alt="" width="313" height="371">
<div class="mid"><img class="wl" src="/assets/welcome-logo.svg" alt="POPSNAP" width="184" height="62"><button id="go" type="button" aria-label="Get your files"><img src="/assets/welcome-btn.svg" alt="Get your files" width="156" height="46"></button></div>
</section>`;

// Urutan tab mengikuti desain: GIF, Photo, Live.
const CATS = [
  { id: "gif", label: "GIF", frame: "GIF Frame", raw: "GIF", all: "All Gif", one: "1 Gif", top: (f) => f.kind === "gif", rest: (f) => f.kind === "gifplain" },
  { id: "photo", label: "Photo", frame: "Photo Frame", raw: "Photo", all: "All Photo", one: "1 Photo", top: (f) => f.kind === "final", rest: (f) => f.group === "raw" },
  { id: "live", label: "Live", frame: "Live frame", raw: "Live", all: "All Live", one: "1 Live", top: (f) => ["live", "video", "boomerang"].includes(f.kind), rest: (f) => f.group === "clips" },
];
/** File satu kategori (hasil template + mentahannya) — dipakai tombol "All ... (zip)" dan ?cat= di all.zip. */
const catFiles = (files, id) => { const c = CATS.find((x) => x.id === id); return c ? files.filter((f) => c.top(f) || c.rest(f)) : files; };

const DL_ICON = `<img src="/assets/dl.svg" alt="" width="20" height="22">`;
const PAGE_CSS = `
*{box-sizing:border-box}body{margin:0;color:#000}
.wrap{container-type:inline-size;max-width:560px;margin:0 auto;overflow-x:clip}
@media (min-width:561px){.wrap{min-height:100vh;min-height:100dvh}}
.pg{--u:calc(100cqw / 402);min-height:100vh;min-height:100dvh;display:flex;flex-direction:column}
.pg main{flex:1 0 auto}
header.bar{position:sticky;top:0;z-index:10;height:calc(var(--u) * 43);background:rgba(255,255,255,.1);-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);border-radius:0 0 calc(var(--u) * 25) calc(var(--u) * 25)}
nav{display:grid;grid-auto-flow:column;grid-auto-columns:1fr;height:100%}
nav a{position:relative;display:flex;align-items:center;justify-content:center;color:#fff;text-decoration:none;font-weight:800;font-style:italic;font-size:calc(var(--u) * 20);letter-spacing:.01em}
nav a+a::before{content:"";position:absolute;left:0;top:calc(var(--u) * 10);height:calc(var(--u) * 26);border-left:.5px solid #8DBFE8}
nav a img{display:none;position:absolute;z-index:-1;left:calc(-5 / 134 * 100% * 3 / var(--n,3));top:calc(var(--u) * 2);width:calc(147 / 134 * 100% * 3 / var(--n,3));height:calc(var(--u) * 51);pointer-events:none}
nav a.on img{display:block}
nav a img.flip{transform:scaleX(-1)}
nav a span{position:relative}
.mlogo{display:block;width:calc(var(--u) * 70);height:auto;margin:calc(var(--u) * 23) auto calc(var(--u) * 25);filter:drop-shadow(0 1px 2px rgba(0,0,0,.25))}
.panel{display:block}.js .panel{display:none}.js .panel.on{display:block}
.card{position:relative;margin:0 calc(var(--u) * 14);padding:calc(var(--u) * 43) calc(var(--u) * 14) calc(var(--u) * 16.5);background:#FDB939;border:1px solid #000;border-radius:calc(var(--u) * 41);box-shadow:3px 4px 4px rgba(0,0,0,.2)}
.card+.card{margin-top:calc(var(--u) * 40)}
.lab{position:absolute;left:50%;top:calc(var(--u) * 9);transform:translateX(-50%);height:calc(var(--u) * 28);padding:0 calc(var(--u) * 19);display:flex;align-items:center;background:#FFEAC5;border:1px solid #000;border-radius:999px;font-weight:800;font-style:italic;font-size:calc(var(--u) * 17);white-space:nowrap;line-height:1}
.cnt{position:absolute;right:calc(var(--u) * 24);top:calc(var(--u) * 9);height:calc(var(--u) * 28);min-width:calc(var(--u) * 46);padding:0 calc(var(--u) * 12);display:flex;align-items:center;justify-content:center;background:#fff;border:1px solid #000;border-radius:999px;font-weight:800;font-style:italic;font-size:calc(var(--u) * 15);line-height:1;white-space:nowrap;font-variant-numeric:tabular-nums}
.cnt b{font-weight:800}
.frame{position:relative;overflow:hidden;background:#fff;border:1px solid #000;border-radius:calc(var(--u) * 19)}
.frame::after{content:"";position:absolute;inset:0;border-radius:inherit;box-shadow:inset 2px 1px 6.5px rgba(88,88,88,.44);pointer-events:none}
.frame img,.frame video{display:block;width:100%;height:auto}
.frame{min-height:calc(var(--u) * 180);background:linear-gradient(100deg,#fff 30%,#f1f1f1 50%,#fff 70%) 0 0/200% 100%;animation:shim 1.3s linear infinite}
.frame:has(img.ok),.frame:has(video){animation:none;background:#fff}
.frame img{opacity:0;transition:opacity .25s}.frame img.ok,.nojs .frame img{opacity:1}
@keyframes shim{to{background-position:-200% 0}}
@media (prefers-reduced-motion:reduce){.frame{animation:none}}
.frz{position:absolute;left:0;top:0;width:100%;height:100%;display:block}
.pp{position:absolute;left:calc(var(--u) * 10);bottom:calc(var(--u) * 10);z-index:3;width:calc(var(--u) * 36);height:calc(var(--u) * 36);min-width:32px;min-height:32px;padding:0;display:grid;place-items:center;border:1px solid #000;border-radius:50%;background:rgba(255,255,255,.92);color:#000;cursor:pointer;box-shadow:0 2px 5px rgba(0,0,0,.3)}
.pp[hidden]{display:none}.pp svg{width:55%;height:55%;fill:none;stroke:currentColor;stroke-width:2.8;stroke-linecap:round;stroke-linejoin:round}
.pp:active{transform:scale(.94)}.pp:focus-visible{outline:3px solid var(--yellow);outline-offset:2px}
.slide{display:none}.slide.on,.nojs .slide:first-child{display:block}
.act{display:flex;justify-content:center;align-items:center;gap:calc(var(--u) * 16.5);margin-top:calc(var(--u) * 14.5)}
.dlp{display:inline-flex;align-items:center;justify-content:center;gap:calc(var(--u) * 21);height:calc(var(--u) * 33);min-width:calc(var(--u) * 51);padding:0 calc(var(--u) * 15);background:#fff;border:1px solid #000;border-radius:999px;color:#000;text-decoration:none;font-weight:800;font-size:calc(var(--u) * 19);line-height:1;white-space:nowrap;cursor:pointer;transition:transform .12s ease}
.dlp.wide{min-width:calc(var(--u) * 127)}
.dlp img{display:block;width:calc(var(--u) * 20);height:auto}
.dlp:active,.arr:active,.zipb:active{transform:scale(.96)}
.arr{position:relative;flex:none;width:calc(var(--u) * 33);height:calc(var(--u) * 33);padding:0;border:0;background:none;cursor:pointer;transition:transform .12s ease}
.arr img{position:absolute;left:calc(var(--u) * -6.3);top:calc(var(--u) * -2.3);width:calc(var(--u) * 47.6);height:auto;pointer-events:none}
.arr.prev{transform:scaleX(-1)}.arr.prev:active{transform:scaleX(-1) scale(.96)}
.zipb{display:flex;align-items:center;justify-content:center;gap:calc(var(--u) * 6);min-width:calc(var(--u) * 111);width:max-content;height:calc(var(--u) * 23);margin:calc(var(--u) * 12.5) auto 0;padding:0 calc(var(--u) * 14);background:#fff;border:1px solid #000;border-radius:999px;color:#000;text-decoration:none;font-family:inherit;font-weight:800;font-size:calc(var(--u) * 12.5);line-height:1;white-space:nowrap;cursor:pointer;transition:transform .12s ease}
.zipb img{width:calc(var(--u) * 11);height:auto}
.zipb[disabled]{opacity:.6}
.hint{margin:6px 0 0;color:#fff;font-size:13px;text-align:center}
.note{color:#fff;text-align:center;font-size:13px;margin:16px 14px 0}
.code{font-family:"Space Mono",monospace;font-weight:700;letter-spacing:.06em;background:rgba(255,255,255,.18);border-radius:8px;padding:2px 8px}
footer{text-align:center;color:#fff;opacity:.9;font-size:max(12px,calc(var(--u) * 12));padding:calc(var(--u) * 20) 16px 0;line-height:1.6;position:relative;z-index:1}
.mascot{position:relative;width:100%;aspect-ratio:1080/750;margin-top:calc(var(--u) * -34);overflow:hidden;pointer-events:none;user-select:none;-webkit-user-select:none}
.mascot video,.mascot img{display:block;width:100%;height:100%;object-fit:contain}
.gate .mascot{display:none}
@media (prefers-reduced-motion:reduce){.mascot{display:none}}
`;

// zip = true: tombol "All ... (zip)" mengunduh ZIP kategori itu. zip = false: file diunduh satu per satu (tanpa ZIP).
function renderPage({ files, studio, token, preparing, daysLeft, zip = true }) {
  const media = (f, big) => isVideo(f)
    ? `<video src="${esc(f.url)}" data-m="v" muted loop playsinline disablepictureinpicture preload="${big ? "auto" : "metadata"}"></video>`
    : `<img src="${esc(f.ext === "gif" ? f.url : f.thumb || f.url)}" alt="${esc(f.label)}"${f.ext === "gif" ? ' data-m="g"' : ""} decoding="async" ${big || f.thumb ? "" : 'loading="lazy"'} onload="this.classList.add('ok')" onerror="this.classList.add('ok')">`;
  const topCard = (c, f) => `<section class="card"><span class="lab">${esc(c.frame)}</span>
  <div class="frame">${media(f, true)}</div>
  <div class="act"><a class="dlp" href="${esc(f.dl)}" download="${esc(f.name)}" aria-label="Unduh ${esc(c.frame)}">${DL_ICON}</a></div>
</section>`;
  const restCard = (c, rs) => {
    const many = rs.length > 1, f0 = rs[0];
    return `<section class="card rest" data-n="${rs.length}"><span class="lab">${esc(c.raw)}</span>${many ? `<span class="cnt" aria-live="polite"><b>1</b>/${rs.length}</span>` : ""}
  <div class="frame">${rs.map((f, i) => `<div class="slide${i ? "" : " on"}" data-dl="${esc(f.dl)}" data-name="${esc(f.name)}">${media(f, false)}</div>`).join("")}</div>
  <div class="act">${many ? `<button class="arr prev" type="button" aria-label="Sebelumnya"><img src="/assets/arrow.svg" alt=""></button>` : ""}<a class="dlp${many ? " wide" : ""}" href="${esc(f0.dl)}" download="${esc(f0.name)}" aria-label="Unduh ${esc(c.one)}">${DL_ICON}${many ? `<span>${esc(c.one)}</span>` : ""}</a>${many ? `<button class="arr next" type="button" aria-label="Berikutnya"><img src="/assets/arrow.svg" alt=""></button>` : ""}</div>
</section>`;
  };
  const cats = CATS.map((c) => ({ ...c, tops: files.filter(c.top), rests: files.filter(c.rest) })).filter((c) => c.tops.length || c.rests.length);
  const panels = cats.map((c) => {
    const all = catFiles(files, c.id);
    const zipLink = `<a class="zipb" href="/s/${esc(token)}/all.zip?cat=${c.id}">${DL_ICON}<span>${esc(c.all)} (zip)</span></a>`;
    const filesBtn = (label) => `<button class="zipb dlall" type="button">${DL_ICON}<span>${esc(label)}</span></button><p class="hint"></p>`;
    const zipBtn = zip === "both" ? zipLink + filesBtn("Unduh semua file") : zip ? zipLink : filesBtn(c.all);
    return `<div class="panel" id="p-${c.id}" data-all='${esc(JSON.stringify(all.map((f) => ({ u: f.dl, n: f.name }))))}'>
${c.tops.map((f) => topCard(c, f)).join("\n")}
${c.rests.length ? restCard(c, c.rests) : ""}
${all.length ? zipBtn : ""}
</div>`;
  }).join("\n");
  const nav = cats.length > 1 ? `<nav style="--n:${cats.length}">${cats.map((c, i) => `<a href="#${c.id}" data-t="${c.id}"><img src="/assets/${i === 0 || i === cats.length - 1 ? "tab-pill" : "tab-pill-mid"}.svg" alt=""${i > 0 && i === cats.length - 1 ? ' class="flip"' : ""}><span>${esc(c.label)}</span></a>`).join("")}</nav>` : "";
  const codeShown = /^[A-Z0-9]{10}$/.test(token) ? `${token.slice(0, 4)} ${token.slice(4, 8)} ${token.slice(8)}` : token;
  let origin = ""; try { origin = new URL(files.find((f) => f.url)?.url || "").origin; } catch { /* tanpa file */ }
  const firstCat = cats.find((c) => c.id === "photo") ? "photo" : cats[0]?.id || "photo";
  return `<!doctype html>
<html lang="id" class="nojs"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer">
<title>POPSNAP — File kamu</title><link rel="preload" as="image" href="/assets/welcome-noise.webp">${origin ? `<link rel="preconnect" href="${esc(origin)}" crossorigin>` : ""}<link rel="icon" href="/assets/icon-popsnap.ico">
<style>${THEME_CSS}
${PAGE_CSS}
${introCss}</style></head><body>
${introHtml}
<div class="wrap"><div class="pg">
<header class="bar">${nav}</header>
<img class="mlogo" src="/assets/logo.png" alt="POPSNAP">
<main>
${panels}
${preparing ? `<p class="note" id="prep">File masih diunggah — halaman ini memperbarui sendiri.</p>` : ""}
${!files.length ? `<p class="note">File belum tersedia, sedang diunggah dari booth. Halaman memuat ulang sendiri.</p>` : ""}
</main>
<footer>${studio ? `Diambil di ${esc(studio)}<br>` : ""}Kode: <span class="code">${esc(codeShown)}</span><br>Link berlaku ${daysLeft > 0 ? `sekitar ${daysLeft} hari lagi` : "sementara"}. Simpan filenya ke galeri kamu.</footer>
<div class="mascot" id="mascot" aria-hidden="true"></div>
</div></div>
<script>
(function(){
var de=document.documentElement;de.className=de.className.replace('nojs','js');setTimeout(function(){[].forEach.call(document.querySelectorAll('.frame img'),function(m){m.classList.add('ok')})},6000);addEventListener('DOMContentLoaded',function(){[].forEach.call(document.querySelectorAll('.frame img'),function(m){if(m.complete)m.classList.add('ok')})});
var K='ps-open-'+${JSON.stringify(token)},opened=false;try{opened=!!sessionStorage.getItem(K)}catch(x){}
if(!opened&&!/^#(photo|gif|live)$/.test(location.hash))de.className+=' gate';
document.getElementById('go').addEventListener('click',function(){try{sessionStorage.setItem(K,'1')}catch(x){}de.className=de.className.replace(' gate','');window.scrollTo(0,0)});
var tabs=[].slice.call(document.querySelectorAll('nav a')),panels=[].slice.call(document.querySelectorAll('.panel'));
function show(id){var f=false;panels.forEach(function(p){var on=p.id==='p-'+id;if(on)f=true;p.className='panel'+(on?' on':'')});
 if(!f&&panels[0]){id=panels[0].id.slice(2);panels[0].className='panel on'}
 tabs.forEach(function(a){a.className=a.getAttribute('data-t')===id?'on':''});window.scrollTo(0,0)}
tabs.forEach(function(a){a.addEventListener('click',function(e){e.preventDefault();var id=a.getAttribute('data-t');try{history.replaceState(null,'','#'+id)}catch(x){}show(id)})});
show((location.hash||'').slice(1)||${JSON.stringify(firstCat)});
(function(){
 var PA='<svg viewBox="0 0 24 24"><path d="M8 5v14M16 5v14"/></svg>',PL='<svg viewBox="0 0 24 24"><path d="M8 5l11 7-11 7z" style="fill:currentColor"/></svg>';
 function cur(fr){var s=fr.querySelector('.slide.on');return (s||fr).querySelector('[data-m]')}
 function paused(m){return m.getAttribute('data-m')==='v'?m.dataset.up==='1':!!m._cv}
 function playV(v){var p=v.play();if(p&&p.catch)p.catch(function(){})}
 function setPaused(m,x){
  if(m.getAttribute('data-m')==='v'){m.dataset.up=x?'1':'';if(x)m.pause();else playV(m);return}
  if(x&&!m._cv){var w=m.naturalWidth,h=m.naturalHeight;if(!w||!h)return;var cv=document.createElement('canvas');cv.width=w;cv.height=h;cv.className='frz';
   try{cv.getContext('2d').drawImage(m,0,0,w,h)}catch(e){return}m.parentNode.appendChild(cv);m._cv=cv}
  else if(!x&&m._cv){m._cv.remove();m._cv=null}}
 function sync(fr){var b=fr.querySelector('.pp'),m=cur(fr);if(!b)return;if(!m){b.hidden=true;return}b.hidden=false;var x=paused(m);b.innerHTML=x?PL:PA;b.setAttribute('aria-label',x?'Putar':'Jeda')}
 window.__pp=sync;
 function toggle(fr){var m=cur(fr);if(!m)return;setPaused(m,!paused(m));sync(fr)}
 [].forEach.call(document.querySelectorAll('.frame'),function(fr){
  if(!fr.querySelector('[data-m]'))return;
  var b=document.createElement('button');b.type='button';b.className='pp';fr.appendChild(b);sync(fr);
  b.addEventListener('click',function(e){e.stopPropagation();toggle(fr)});
  fr.addEventListener('click',function(){toggle(fr)})});
 var vids=[].slice.call(document.querySelectorAll('video[data-m]'));
 if('IntersectionObserver' in window){var io=new IntersectionObserver(function(es){es.forEach(function(e){var v=e.target;if(e.isIntersecting&&v.dataset.up!=='1')playV(v);else v.pause()})},{threshold:.35});vids.forEach(function(v){io.observe(v)})}
 else vids.forEach(playV);
})();
[].forEach.call(document.querySelectorAll('.rest'),function(c){
 var s=[].slice.call(c.querySelectorAll('.slide')),dl=c.querySelector('.dlp'),cn=c.querySelector('.cnt'),i=0;
 function warm(k){var x=s[(k+s.length)%s.length],m=x&&x.querySelector('img');if(m&&m.loading==='lazy')m.loading='eager'}
 warm(1);warm(-1);
 function go(d){s[i].className='slide';i=(i+d+s.length)%s.length;var e=s[i];e.className='slide on';if(cn)cn.textContent=(i+1)+'/'+s.length;dl.href=e.getAttribute('data-dl');dl.setAttribute('download',e.getAttribute('data-name'));
  [].forEach.call(s,function(x){var v=x.querySelector('video');if(v&&x!==e)v.pause()});if(window.__pp)window.__pp(c.querySelector('.frame'));warm(i+1);warm(i-1)}
 var p=c.querySelector('.prev'),n=c.querySelector('.next');if(p)p.addEventListener('click',function(){go(-1)});if(n)n.addEventListener('click',function(){go(1)})});
[].forEach.call(document.querySelectorAll('.dlall'),function(b){b.addEventListener('click',function(){
 var DL=JSON.parse(b.closest('.panel').getAttribute('data-all')),m=b.parentNode.querySelector('.hint'),i=0;b.disabled=true;
 (function next(){if(i>=DL.length){m.textContent='Selesai. Cek folder unduhan. Jika ada yang tidak terunduh, izinkan unduhan berganda lalu coba lagi.';b.disabled=false;return}
  m.textContent='Mengunduh '+(i+1)+' / '+DL.length+'…';var a=document.createElement('a');a.href=DL[i].u;a.download=DL[i].n;document.body.appendChild(a);a.click();a.remove();i++;setTimeout(next,450)})()})});
(function(){var box=document.getElementById('mascot');if(!box||(window.matchMedia&&matchMedia('(prefers-reduced-motion:reduce)').matches))return;
 var ua=navigator.userAgent,webkit=/iPhone|iPad|iPod/.test(ua)||(/Safari/.test(ua)&&!/Chrome|Chromium|Android|Edg|OPR/.test(ua)),el=null;
 function asImg(){box.innerHTML='';el=document.createElement('img');el.alt='';el.decoding='async';el.src='/assets/animasi-maskot.webp';box.appendChild(el)}
 function asVideo(){el=document.createElement('video');el.muted=true;el.loop=true;el.playsInline=true;el.setAttribute('playsinline','');el.setAttribute('muted','');el.disablePictureInPicture=true;el.preload='auto';
  el.addEventListener('error',asImg);el.src='/assets/animasi-maskot.webm';box.appendChild(el)}
 var started=false;function start(){if(started)return;started=true;webkit?asImg():asVideo()}
 if(!('IntersectionObserver' in window)){start();return}
 new IntersectionObserver(function(es){es.forEach(function(e){start();if(el&&el.tagName==='VIDEO'){if(e.isIntersecting){var p=el.play();if(p&&p.catch)p.catch(function(){})}else el.pause()}})},{rootMargin:'200px 0px',threshold:0.15}).observe(box)})();
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
header{position:sticky;top:0;z-index:10;background:none;pointer-events:none}
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
@media (min-width:700px){header .in{max-width:1000px}.logo{height:44px}main{max-width:920px;padding-top:56px}h1{font-size:54px}p.sub{font-size:19px;max-width:620px}form{max-width:640px}input{height:58px;font-size:18px}button{font-size:21px;padding:0 30px}.step h3{font-size:21px}.step p{font-size:16px}footer{font-size:14px}}
@media (max-height:480px) and (orientation:landscape){main{padding-top:12px}h1{font-size:30px;margin-top:6px}}
</style></head><body>
<header><div class="in"><img class="logo" src="/assets/logo.png" alt="POPSNAP"></div></header>
<main>
<h1>Foto kamu sudah siap!</h1>
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

const messagePage = (title, sub = "") => `<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>POPSNAP</title><link rel="icon" href="/assets/icon-popsnap.ico">
<style>${THEME_CSS}
*{box-sizing:border-box}body{margin:0;min-height:100vh;min-height:100dvh;display:grid;place-items:center;padding:24px 20px;color:#fff;text-align:center}
.msg{width:min(100%,520px)}.msg .logo{height:clamp(34px,9vw,52px);margin:0 auto 18px}
h2{font-family:Fredoka,"Plus Jakarta Sans",sans-serif;font-style:italic;font-weight:700;font-size:clamp(24px,6vw,36px);line-height:1.2;margin:0 0 8px}
p{margin:0;font-size:clamp(15px,3.6vw,18px);opacity:.95}
</style></head><body><div class="msg"><img class="logo" src="/assets/logo.png" alt="POPSNAP"><h2>${esc(title)}</h2><p>${esc(sub)}</p></div></body></html>`;

module.exports = { renderPage, landingPage, messagePage, esc, catFiles };
