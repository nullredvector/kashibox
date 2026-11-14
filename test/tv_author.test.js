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

// Library videos have no cover file: their size comes from ffprobe (a video stored rotated counts as shown)
const { spawnSync } = require('node:child_process');
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

test('Library videos are measured with ffprobe, rotation included', { skip: !hasFfmpeg && 'ffmpeg is not installed' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kashi-lib-'));
  try {
    const lib = fs.realpathSync(dir);
    fs.mkdirSync(path.join(lib, 'files'));
    fs.mkdirSync(path.join(lib, 'arch', 'data', '.appdata'), { recursive: true });
    process.env.ARCHIVE_DIR = path.join(lib, 'arch');           // read by library.js when it is first loaded
    const make = (name, size, rotate) => {
      const f = path.join(lib, 'files', name);
      const base = path.join(lib, 'files', 'base-' + name);
      spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `testsrc=size=${size}:rate=5`, '-t', '1', '-pix_fmt', 'yuv420p', rotate ? base : f]);
      if (rotate) spawnSync('ffmpeg', ['-v', 'error', '-display_rotation', '90', '-i', base, '-c', 'copy', f]);
      return f;
    };
    const files = {
      wide: make('wide.mp4', '640x360'),
      portrait: make('portrait.mp4', '360x640'),
      shownWide: make('shownwide.mp4', '360x640', true),      // stored portrait, rotated: shown landscape
      shownPortrait: make('shownportrait.mp4', '640x360', true),
    };
    const items = {}, ids = {};
    Object.entries(files).forEach(([k, f], n) => {
      const id = 'l' + require('node:crypto').createHash('sha1').update(fs.realpathSync(f)).digest('hex').slice(0, 12);
      items[id] = { path: fs.realpathSync(f), added: n };
      ids[k] = `/api/library/videos/${id}.mp4`;
    });
    fs.writeFileSync(path.join(lib, 'arch', 'data', '.appdata', 'library.json'), JSON.stringify({ dirs: [path.join(lib, 'files')], items, skipped: {} }));
    await wideWithin(lib, Object.values(ids), 20000);
    assert.strictEqual(wideCached(ids.wide), true);
    assert.strictEqual(wideCached(ids.portrait), false);
    assert.strictEqual(wideCached(ids.shownWide), true);
    assert.strictEqual(wideCached(ids.shownPortrait), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an unknown Library id counts as portrait', async () => {
  await wideWithin('/nonexistent', ['/api/library/videos/l000000000000.mp4'], 5000);
  assert.strictEqual(wideCached('/api/library/videos/l000000000000.mp4'), false);
});
