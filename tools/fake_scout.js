#!/usr/bin/env node
'use strict';
// A pretend scout, for trying the For You picks screen without the real scout or any real data.
// It writes the files the real scout writes (see docs/scout/README.md): invented ids, authors and captions,
// plain generated cover images, and a status file.
//
//   node tools/fake_scout.js /path/to/archive [count] [state]
//   state: idle (default) | running | paused | challenge | login | error | off
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const root = process.argv[2];
const count = Math.max(1, parseInt(process.argv[3] || '24', 10));
const state = process.argv[4] || 'idle';
if (!root) { console.error('usage: node tools/fake_scout.js /path/to/archive [count] [state]'); process.exit(1); }

const dir = path.join(root, 'data', '.appdata', 'scout');
fs.mkdirSync(path.join(dir, 'covers'), { recursive: true });

// a plain PNG (the covers are only ever shown as images; the browser does not care about the extension)
const crcTable = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc = buf => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
function png(w, h, rgb) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; for (let x = 0; x < w; x++) { const [r, g, b] = rgb(x, y); const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; } }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const authors = ['sample_user_one', 'sample.user.two', 'fakecreator3', 'demo_account_4', 'placeholder5', 'nobody_real6'];
const lines = [];
for (let i = 0; i < count; i++) {
  const id = String(7700000000000000000n + BigInt(i * 7919 + 13));
  const hue = (i * 47) % 360;
  fs.writeFileSync(path.join(dir, 'covers', id + '.jpg'), png(72, 112, (x, y) => {
    const t = y / 112, a = hue / 60, f = a - Math.floor(a);
    const base = [[1, f, 0], [1 - f, 1, 0], [0, 1, f], [0, 1 - f, 1], [f, 0, 1], [1, 0, 1 - f]][Math.floor(a) % 6];
    return base.map(v => Math.round(40 + 160 * v * (1 - t * 0.6)));
  }));
  const score = Math.max(0.05, 0.97 - i * (0.9 / count));
  lines.push(JSON.stringify({
    id, author: authors[i % authors.length], desc: 'Invented caption number ' + (i + 1) + ' for the demo #sample',
    score: Math.round(score * 100) / 100, tags: [['tagA', Math.min(1, score + 0.03)], ['tagB', Math.max(0, score - 0.2)]],
    found: Date.now() - i * 60000,
  }));
}
fs.writeFileSync(path.join(dir, 'candidates.jsonl'), lines.join('\n') + '\n');
const today = new Date().toISOString().slice(0, 10);
fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify({ state, updated: Date.now() - 120000, message: state === 'error' ? 'the page did not load' : '', today: { date: today, viewed: count * 4, collected: count } }));
console.log('wrote ' + count + ' fake picks and a "' + state + '" status to ' + dir);
