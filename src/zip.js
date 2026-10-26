// ZIP streaming tanpa kompresi (STORE, dengan data descriptor): file besar dari cloud diteruskan langsung, memori tetap kecil.
const zlib = require("zlib");

function dosTimeDate(d = new Date()) {
  return { t: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), d: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() };
}

/** entries: [{ name, open: async () => fetch Response }]. out: http.ServerResponse. Mengembalikan jumlah file yang masuk. */
async function streamZip(out, entries) {
  const { t, d } = dosTimeDate();
  const central = [];
  let offset = 0, count = 0;
  const write = async (buf) => { offset += buf.length; if (!out.write(buf)) await new Promise((r) => out.once("drain", r)); };
  for (const e of entries) {
    let resp;
    try { resp = await e.open(); } catch { continue; }
    if (!resp || !resp.ok || !resp.body) continue;
    const name = Buffer.from(e.name, "utf8");
    const start = offset;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0808, 6); lh.writeUInt16LE(0, 8);
    lh.writeUInt16LE(t, 10); lh.writeUInt16LE(d, 12); lh.writeUInt16LE(name.length, 26);
    await write(lh); await write(name);
    let crc = 0, size = 0;
    for await (const chunk of resp.body) { const b = Buffer.from(chunk); crc = zlib.crc32(b, crc) >>> 0; size += b.length; await write(b); }
    const dd = Buffer.alloc(16);
    dd.writeUInt32LE(0x08074b50, 0); dd.writeUInt32LE(crc, 4); dd.writeUInt32LE(size, 8); dd.writeUInt32LE(size, 12);
    await write(dd);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0808, 8);
    ch.writeUInt16LE(t, 12); ch.writeUInt16LE(d, 14); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(size, 20); ch.writeUInt32LE(size, 24);
    ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(start, 42);
    central.push(ch, name); count++;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(count, 8); end.writeUInt16LE(count, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  out.write(cd); out.end(end);
  return count;
}

module.exports = { streamZip };
