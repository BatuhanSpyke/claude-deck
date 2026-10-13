// Packs PNGs into a Windows .ico (PNG-compressed entries): node ico.js out.ico a.png b.png …
const fs = require('fs');
const [out, ...files] = process.argv.slice(2);
const imgs = files.map((f) => fs.readFileSync(f));
const head = Buffer.alloc(6 + 16 * imgs.length);
head.writeUInt16LE(1, 2); head.writeUInt16LE(imgs.length, 4);
let off = head.length;
imgs.forEach((b, i) => {
  const w = b.readUInt32BE(16), e = 6 + 16 * i;
  head[e] = w >= 256 ? 0 : w; head[e + 1] = w >= 256 ? 0 : w;
  head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6);
  head.writeUInt32LE(b.length, e + 8); head.writeUInt32LE(off, e + 12);
  off += b.length;
});
fs.writeFileSync(out, Buffer.concat([head, ...imgs]));
