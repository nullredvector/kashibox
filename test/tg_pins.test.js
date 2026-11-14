'use strict';
// Run with: node --test test/*.test.js   (needs the sqlite3 command; skipped without it)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kashibox-tg-'));
process.env.ARCHIVE_DIR = path.join(root, 'archive');
fs.mkdirSync(path.join(process.env.ARCHIVE_DIR, 'data', '.appdata'), { recursive: true });
const dbStars = require('../db_stars');
const library = require('../library');
const tgPins = require('../tg_pins');

let haveSqlite = true;
try { execFileSync('sqlite3', ['--version'], { stdio: 'ignore' }); } catch (_) { haveSqlite = false; }
const opts = { skip: haveSqlite ? false : 'no sqlite3 command' };

const tg = path.join(root, 'tg');                      // the downloader's data folder: db.sqlite + downloads/
const dl = path.join(tg, 'downloads', 'chat one', 'videos');
fs.mkdirSync(dl, { recursive: true });
const DB = path.join(tg, 'db.sqlite');
const touch = f => { fs.writeFileSync(path.join(dl, f), 'x'); return `chat one/videos/${f}`; };
const sql = q => execFileSync('sqlite3', [DB, q]);
const setPins = rows => {
  sql('DROP TABLE IF EXISTS downloads; CREATE TABLE downloads (id INTEGER PRIMARY KEY, file_path TEXT, file_type TEXT, status TEXT, pinned INTEGER DEFAULT 0);');
  rows.forEach(r => sql(`INSERT INTO downloads (file_path, file_type, status, pinned) VALUES ('${r.p}', '${r.type || 'video'}', '${r.status || 'completed'}', ${r.pinned ? 1 : 0});`));
};
const names = () => library.list().map(x => x.title).sort();

test('settings: tgDb must be an absolute path to a .sqlite / .db file', () => {
  assert.equal(dbStars.saveSettings({ tgDb: '/x/db.sqlite' }).tgDb, '/x/db.sqlite');
  assert.throws(() => dbStars.saveSettings({ tgDb: 'relative/db.sqlite' }));
  assert.throws(() => dbStars.saveSettings({ tgDb: '/x/passwd' }));
  assert.equal(dbStars.saveSettings({ tgDb: '' }).tgDb, '');
});

test('not set up: nothing happens', opts, async () => {
  dbStars.saveSettings({ tgDb: '' });
  assert.equal((await tgPins.syncNow()).error, 'NOT_SET');
});

test('pinned completed videos appear in the Library; others do not', opts, async () => {
  setPins([{ p: touch('a.f4v'), pinned: 1 }, { p: touch('b.mp4'), pinned: 1 }, { p: touch('c.mp4') }, { p: touch('d.mp4'), pinned: 1, status: 'failed' },
           { p: touch('e.jpg'), pinned: 1, type: 'photo' }]);
  dbStars.saveSettings({ tgDb: DB });
  const r = await tgPins.syncNow();
  assert.equal(r.ok, true);
  assert.deepEqual([r.rows, r.found, r.added, r.removed], [2, 2, 2, 0]);
  assert.deepEqual(names(), ['a', 'b']);
  assert.equal(library.fileFor(library.list()[0].id).endsWith('.f4v') || library.fileFor(library.list()[1].id).endsWith('.f4v'), true, '.f4v is a Library format');
});

test('a second sync changes nothing; a new pin is added; an unpin leaves the Library but the file stays', opts, async () => {
  assert.deepEqual([(await tgPins.syncNow()).added, (await tgPins.syncNow()).removed], [0, 0]);
  setPins([{ p: 'chat one/videos/a.f4v', pinned: 1 }, { p: touch('f.mp4'), pinned: 1 }]);        // b unpinned, f pinned
  const r = await tgPins.syncNow();
  assert.deepEqual([r.added, r.removed], [1, 1]);
  assert.deepEqual(names(), ['a', 'f']);
  assert.ok(fs.existsSync(path.join(dl, 'b.mp4')), 'the file itself is never touched');
});

test('a pin you removed by hand stays removed while it is still pinned; a re-pin brings it back', opts, async () => {
  const f = library.list().find(x => x.title === 'f');
  library.removeItems([f.id]);
  assert.deepEqual(names(), ['a']);
  await tgPins.syncNow();
  assert.deepEqual(names(), ['a'], 'still pinned, still removed');
  setPins([{ p: 'chat one/videos/a.f4v', pinned: 1 }]);                                           // unpinned
  await tgPins.syncNow();
  setPins([{ p: 'chat one/videos/a.f4v', pinned: 1 }, { p: 'chat one/videos/f.mp4', pinned: 1 }]); // pinned again
  await tgPins.syncNow();
  assert.deepEqual(names(), ['a', 'f']);
});

test('pins whose files cannot be found leave the Library as it was', opts, async () => {
  setPins([{ p: 'chat one/videos/missing1.mp4', pinned: 1 }, { p: 'chat one/videos/missing2.mp4', pinned: 1 }]);
  const r = await tgPins.syncNow();
  assert.equal(r.ok, false);
  assert.equal(r.error, 'FILES_NOT_FOUND');
  assert.deepEqual(names(), ['a', 'f']);
});

test('paths that climb out of the downloads folder or are absolute are ignored', opts, () => {
  fs.writeFileSync(path.join(tg, 'secret.mp4'), 'x');
  const files = tgPins.resolveFiles(DB, [{ file_path: '../secret.mp4' }, { file_path: path.join(tg, 'secret.mp4') }, { file_path: 'chat one/videos/a.f4v' }, { file_path: null }]);
  assert.deepEqual(files.map(f => path.basename(f)), ['a.f4v']);
});

test('a database that is not there is an error code, not a crash', opts, async () => {
  fs.writeFileSync(path.join(root, 'junk.sqlite'), 'not a database');
  dbStars.saveSettings({ tgDb: path.join(root, 'junk.sqlite') });
  const r = await tgPins.syncNow();
  assert.equal(r.ok, false);
  assert.ok(['QUERY_FAILED', 'BAD_OUTPUT'].includes(r.error), r.error);
  dbStars.saveSettings({ tgDb: path.join(root, 'nope.sqlite') });
  assert.equal((await tgPins.syncNow()).error, 'NO_DATABASE');
});
