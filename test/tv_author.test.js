'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { jpegSize, wideWithin, wideCached } = require('../tv_author.js');

// a minimal JPEG header: SOI, an APP0 segment, then the start-of-frame segment that states the size
function jpeg(width, height, sof = 0xC0) {
  const app0 = Buffer.from([0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const frame = Buffer.alloc(19);
  frame.writeUInt16BE(0xFF00 | sof, 0);
  frame.writeUInt16BE(17, 2);
  frame[4] = 8;
  frame.writeUInt16BE(height, 5);
  frame.writeUInt16BE(width, 7);
  frame[9] = 3;
  return Buffer.concat([Buffer.from([0xFF, 0xD8]), app0, frame]);
}

test('reads the size of a baseline JPEG', () => {
  assert.deepStrictEqual(jpegSize(jpeg(480, 270)), { width: 480, height: 270 });
  assert.deepStrictEqual(jpegSize(jpeg(270, 480)), { width: 270, height: 480 });
});

test('reads the size of a progressive JPEG', () => {
  assert.deepStrictEqual(jpegSize(jpeg(1920, 1080, 0xC2)), { width: 1920, height: 1080 });
});

test('skips segments that carry no size (like the tables)', () => {
  const dht = Buffer.from([0xFF, 0xC4, 0x00, 0x04, 0x00, 0x00]);
  const b = jpeg(640, 360);
  const withTable = Buffer.concat([b.subarray(0, 20), dht, b.subarray(20)]);
  assert.deepStrictEqual(jpegSize(withTable), { width: 640, height: 360 });
});

test('anything that is not a JPEG gives null', () => {
  assert.strictEqual(jpegSize(Buffer.from('not a jpeg at all')), null);
  assert.strictEqual(jpegSize(Buffer.alloc(0)), null);
  assert.strictEqual(jpegSize(Buffer.from([0xFF, 0xD8])), null);
});

// an archive folder with a few covers: a landscape one, a portrait one, one that is not a JPEG, one missing
function archiveWithCovers() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kashi-wide-'));
  const covers = path.join(dir, 'data', 'Likes', 'covers');
  fs.mkdirSync(covers, { recursive: true });
  fs.writeFileSync(path.join(covers, '1.jpg'), jpeg(480, 270));
  fs.writeFileSync(path.join(covers, '2.jpg'), jpeg(270, 480));
  fs.writeFileSync(path.join(covers, '3.jpg'), 'not a jpeg');
  return dir;
}
const vid = n => `/data/Likes/videos/${n}.mp4`;

test('wideWithin learns the shape of covers without blocking, and remembers it', async () => {
  const dir = archiveWithCovers();
  try {
    assert.strictEqual(wideCached(vid(1)), false);          // not read yet: counts as portrait
    await wideWithin(dir, [vid(1), vid(2), vid(3), vid(4)], 2000);
    assert.strictEqual(wideCached(vid(1)), true);           // landscape
    assert.strictEqual(wideCached(vid(2)), false);          // portrait
    assert.strictEqual(wideCached(vid(3)), false);          // not a JPEG
    assert.strictEqual(wideCached(vid(4)), false);          // no cover
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('wideWithin ignores paths that are not video paths', async () => {
  await wideWithin('/nonexistent', ['/etc/passwd', '', null, '/data/x/videos/../../1.mp4'], 500);
  assert.strictEqual(wideCached('/etc/passwd'), false);
});
