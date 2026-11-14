'use strict';
// Keeps the videos you pinned in the Telegram downloader in step with the Library tab.
// It reads the downloader's database (read-only, with the sqlite3 command) for the downloads marked pinned, finds those files
// under the downloader's downloads folder (next to the database), and hands their paths to the Library. A pin that is
// removed in the downloader leaves the Library (the file itself is never touched). Nothing is written to the downloader's
// folder, and no file, chat or folder name is ever logged: only counts and error codes.
const fs   = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const library = require('./library');
const dbStars = require('./db_stars');

const SRC = 'tg';
const QUERY = "SELECT file_path FROM downloads WHERE pinned = 1 AND file_type = 'video' AND status = 'completed' ORDER BY id DESC";
const TICK_MS = 15 * 1000;            // how often to look at the clock; the check itself runs every tgSyncMin minutes
const TAG_NAME = 'tg';                // the group every imported video is put in
const STARS_FILE = path.join(process.env.ARCHIVE_DIR || '/archive', 'data', '.appdata', 'stars.json');

let last = null;          // { at, ok, rows, found, added, removed, error }
let running = null;

const real = p => { try { return fs.realpathSync(p); } catch (_) { return null; } };
const within = (p, base) => p === base || p.startsWith(base + path.sep);

// minutes between checks (Settings; default 1)
function intervalMs() {
  const m = dbStars.loadSettings().tgSyncMin;
  return (Number.isInteger(m) && m >= 1 && m <= 1440 ? m : 1) * 60 * 1000;
}

// Put the imported videos in the group named "tg" (made if it is not there). The first time it holds every imported video;
// after that only newly imported ones are added, so taking a video out of the group by hand sticks. Videos that leave the
// Library leave the group. Uses the same compare-and-swap save as the browser, so it can never overwrite a newer change.
function tagImported(r) {
  let rev = dbStars.currentRev();
  if (rev !== 'none') { try { JSON.parse(fs.readFileSync(STARS_FILE, 'utf8')); } catch (_) { return; } }     // unreadable: never write over it
  const d = dbStars.load();
  let g = d.groups.find(x => x && typeof x.name === 'string' && x.name.trim().toLowerCase() === TAG_NAME);
  let changed = false;
  if (!g) { g = { id: Date.now().toString(36) + Math.random().toString(36).slice(2), name: TAG_NAME, videoIds: [] }; d.groups.push(g); changed = true; r = { ...r, addedIds: r.allIds }; }
  const have = new Set(g.videoIds);
  r.addedIds.forEach(id => { if (!have.has(id)) { g.videoIds.push(id); have.add(id); changed = true; } });
  const gone = new Set(r.removedIds);
  if (gone.size && g.videoIds.some(id => gone.has(id))) { g.videoIds = g.videoIds.filter(id => !gone.has(id)); changed = true; }
  if (!changed) return;
  const res = dbStars.saveGuarded(d, rev);
  if (res.code !== 200) throw Object.assign(new Error('stale'), { code: 'TAG_RETRY' });
}

// the database file the user named in Settings, or null
function dbPath() {
  const p = dbStars.loadSettings().tgDb;
  return typeof p === 'string' && p ? p : null;
}

function query(db) {
  return new Promise((resolve, reject) => {
    execFile('sqlite3', ['-readonly', '-json', db, QUERY], { timeout: 30000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(Object.assign(new Error('query'), { code: err.code === 'ENOENT' ? 'NO_SQLITE3' : 'QUERY_FAILED' }));
      try { resolve(stdout.trim() ? JSON.parse(stdout) : []); } catch (_) { reject(Object.assign(new Error('parse'), { code: 'BAD_OUTPUT' })); }
    });
  });
}

// rows -> absolute paths of the files that exist below <database folder>/downloads (nothing that leaves that folder)
function resolveFiles(db, rows) {
  const base = real(path.join(path.dirname(db), 'downloads'));
  if (!base) return [];
  const out = [];
  for (const r of rows) {
    const rel = r && typeof r.file_path === 'string' ? r.file_path : '';
    if (!rel || rel.includes('\0') || path.isAbsolute(rel)) continue;
    const full = real(path.join(base, rel));
    if (full && within(full, base)) out.push(full);
  }
  return out;
}

async function run() {
  const at = Date.now();
  const db = dbPath();
  if (!db) { last = { at, ok: false, error: 'NOT_SET' }; return last; }
  try {
    const dbReal = real(db);
    if (!dbReal || !path.isAbsolute(db) || !/\.(sqlite3?|db)$/i.test(db) || !fs.statSync(dbReal).isFile()) throw Object.assign(new Error('db'), { code: 'NO_DATABASE' });
    const rows = await query(dbReal);
    const files = resolveFiles(dbReal, rows);
    // pins exist but none of their files can be found: the folder is not mounted or the layout differs. Keep what we have.
    if (rows.length && !files.length) { last = { at, ok: false, rows: rows.length, found: 0, error: 'FILES_NOT_FOUND' }; return last; }
    const r = library.syncManaged(SRC, files);
    let tagError;
    try { tagImported(r); } catch (e) { tagError = (e && e.code) || 'TAG_FAILED'; }       // the Library is already right; a busy stars.json is retried next time
    last = { at, ok: true, rows: rows.length, found: files.length, added: r.added, removed: r.removed, ...(tagError ? { tagError } : {}) };
  } catch (e) {
    last = { at, ok: false, error: (e && e.code) || 'UNKNOWN' };
  }
  return last;
}

// One sync at a time; a second call waits for the one running
function syncNow() {
  if (!running) running = run().finally(() => { running = null; });
  return running;
}

function status() { return { configured: !!dbPath(), last }; }

function start() {
  setTimeout(() => { syncNow().catch(() => {}); }, 15000);
  setInterval(() => { if (dbPath() && (!last || Date.now() - last.at >= intervalMs())) syncNow().catch(() => {}); }, TICK_MS).unref();
}

module.exports = { syncNow, status, start, resolveFiles, intervalMs, QUERY };
