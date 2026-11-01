'use strict';
// The Library: video files from folders mounted into the container (chosen in Settings by browsing the container's filesystem).
// Settings picks which folders may be used as sources, the Library tab adds individual files to the library, and
// the library's videos are served through /api/library/videos/<id>.mp4 so they play and cast like the archive's.
// Nothing here ever deletes or changes a media file; "remove" only forgets it. Folder and file names are shown to
// the user in the page and are never logged.
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ARCHIVE_DIR = process.env.ARCHIVE_DIR || '/archive';
// The picker browses the whole container filesystem (the mounts are wherever compose puts them); it opens at START
// when that folder exists. The system's own pseudo folders are never offered.
const ROOT        = path.sep;
const START       = process.env.LIBRARY_START || '/library';
const PSEUDO      = ['/proc', '/sys', '/dev'];
const APPDATA     = path.join(ARCHIVE_DIR, 'data', '.appdata');
const FILE        = path.join(APPDATA, 'library.json');
const COVER_DIR   = path.join(APPDATA, 'library-covers');

const VIDEO_EXT   = /\.(mp4|m4v|mov|webm)$/i;
const MAX_FILES   = 20000;
const MAX_DEPTH   = 8;

const within = (p, base) => base === path.sep || p === base || p.startsWith(base + path.sep);
const real = p => { try { return fs.realpathSync(p); } catch (_) { return null; } };

// A folder or file the user may use: it resolves (links followed) to a real place that is not a pseudo folder
function safe(p) {
  if (typeof p !== 'string' || !p || p.includes('\0') || !path.isAbsolute(p)) return null;
  const r = real(p);
  return r && !PSEUDO.some(x => within(r, x)) ? r : null;
}

function load() {
  try {
    const d = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return { dirs: Array.isArray(d.dirs) ? d.dirs.filter(x => typeof x === 'string') : [], items: d.items && typeof d.items === 'object' ? d.items : {} };
  } catch (_) { return { dirs: [], items: {} }; }
}

function save(d) {
  fs.mkdirSync(APPDATA, { recursive: true });
  const tmp = FILE + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(d), { mode: 0o600 });
  fs.renameSync(tmp, FILE);
}

const idFor = file => 'l' + crypto.createHash('sha1').update(file).digest('hex').slice(0, 12);

// Folders directly below a folder (the settings picker). Hidden folders are left out.
function browse(p) {
  const dir = p ? safe(p) : (safe(START) || ROOT);
  if (!dir) return null;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return null; }
  const dirs = [];
  let videos = 0;
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    let isDir = e.isDirectory();
    if (e.isSymbolicLink()) { try { isDir = fs.statSync(full).isDirectory(); } catch (_) { isDir = false; } }
    if (isDir) { const r = safe(full); if (r && r !== ROOT) dirs.push({ name: e.name, path: r }); }
    else if (VIDEO_EXT.test(e.name)) videos++;
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  return { root: ROOT, path: dir, parent: dir === ROOT ? null : path.dirname(dir), dirs, videos };
}

// Every video below a source folder (limited depth and count). Asynchronous, so a big folder never blocks the server;
// a file is trusted by its place in the walk (links to folders are not followed), only a linked file is resolved.
async function walk(dir) {
  const out = [];
  const seen = new Set();
  const pending = [];
  const go = async (d, depth) => {
    if (out.length >= MAX_FILES || depth > MAX_DEPTH || seen.has(d)) return;
    seen.add(d);
    let entries = [];
    try { entries = await fs.promises.readdir(d, { withFileTypes: true }); } catch (e) { if (depth === 0) throw e; return; }
    for (const e of entries) {
      if (e.name.startsWith('.') || out.length >= MAX_FILES) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) { await go(full, depth + 1); continue; }
      if (!VIDEO_EXT.test(e.name) || !(e.isFile() || e.isSymbolicLink())) continue;
      pending.push(full);
      out.push(null);
    }
  };
  await go(dir, 0);
  out.length = 0;
  // sizes, a few hundred at a time
  for (let i = 0; i < pending.length; i += 200) {
    await Promise.all(pending.slice(i, i + 200).map(async full => {
      try {
        const r = await fs.promises.realpath(full);
        if (PSEUDO.some(x => within(r, x))) return;
        const st = await fs.promises.stat(r);
        if (st.isFile()) out.push({ path: r, rel: path.relative(dir, full), size: st.size });
      } catch (_) {}
    }));
  }
  return out;
}

function sourceDirs() { return load().dirs.filter(d => safe(d)); }

// -> { files } | { error: <system error code> }   (codes only; never a name)
async function listFiles(dir) {
  const d = safe(dir);
  if (!d || !load().dirs.includes(d)) return { error: 'NOT_A_LIBRARY_FOLDER' };
  const inLib = new Set(Object.values(load().items).map(x => x.path));
  let files;
  try { files = await walk(d); } catch (e) { return { error: (e && e.code) || 'UNKNOWN' }; }
  return { files: files.map(f => ({ path: f.path, rel: f.rel, size: f.size, added: inLib.has(f.path) })) };
}

function addDir(dir) {
  const d = safe(dir);
  if (!d) return null;
  const cur = load();
  if (!cur.dirs.includes(d)) cur.dirs.push(d);
  save(cur);
  return cur.dirs;
}

function removeDir(dir) {
  const cur = load();
  cur.dirs = cur.dirs.filter(x => x !== dir);
  save(cur);
  return cur.dirs;
}

// Add files; only files below a chosen source folder are accepted. Returns how many were new.
function addFiles(files) {
  const cur = load();
  const dirs = cur.dirs.filter(d => safe(d));
  let added = 0;
  const now = Date.now();
  files.slice(0, MAX_FILES).forEach((f, i) => {
    const r = safe(f);
    if (!r || !VIDEO_EXT.test(r) || !dirs.some(d => within(r, d))) return;
    const id = idFor(r);
    if (cur.items[id]) return;
    cur.items[id] = { path: r, added: now - i };   // keeps the order the files were picked in
    added++;
  });
  if (added) save(cur);
  return added;
}

function removeItems(ids) {
  const cur = load();
  let n = 0;
  ids.forEach(id => { if (cur.items[id]) { delete cur.items[id]; n++; } });
  if (n) save(cur);
  return n;
}

// The library, newest added first
function list() {
  const cur = load();
  return Object.entries(cur.items).map(([id, x]) => {
    let size = 0, missing = false;
    try { size = fs.statSync(x.path).size; } catch (_) { missing = true; }
    return { id, title: path.basename(x.path).replace(/\.[^.]+$/, ''), added: x.added || 0, size, missing };
  }).sort((a, b) => b.added - a.added);
}

// The file behind an id (null unless it is in the library and still under the root)
function fileFor(id) {
  if (!/^l[0-9a-f]{12}$/.test(id)) return null;
  const x = load().items[id];
  const r = x && safe(x.path);
  return r && VIDEO_EXT.test(r) ? r : null;
}

// ── Covers: one frame per video, made by ffmpeg once and kept in the appdata folder ──
const coverBusy = new Map();   // id -> Promise<string|null>
const coverFailed = new Set();
let running = 0;
const waiting = [];
function slot() { return new Promise(res => { const go = () => { running++; res(); }; running < 2 ? go() : waiting.push(go); }); }
function release() { running--; const n = waiting.shift(); if (n) n(); }

function ffmpegFrame(src, out, at) {
  return new Promise(resolve => {
    let p;
    try { p = spawn('ffmpeg', ['-v', 'error', '-y', '-ss', String(at), '-i', src, '-frames:v', '1', '-vf', 'scale=400:-2', '-q:v', '5', out], { stdio: 'ignore' }); }
    catch (_) { return resolve(false); }
    const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch (_) {} }, 30000);
    p.on('error', () => { clearTimeout(t); resolve(false); });
    p.on('close', code => { clearTimeout(t); resolve(code === 0 && fs.existsSync(out)); });
  });
}

function coverFor(id) {
  const src = fileFor(id);
  if (!src) return Promise.resolve(null);
  const out = path.join(COVER_DIR, id + '.jpg');
  if (fs.existsSync(out)) return Promise.resolve(out);
  if (coverFailed.has(id)) return Promise.resolve(null);
  if (coverBusy.has(id)) return coverBusy.get(id);
  const p = (async () => {
    await slot();
    try {
      fs.mkdirSync(COVER_DIR, { recursive: true });
      // a frame from a second in; a very short clip falls back to its first frame
      const ok = (await ffmpegFrame(src, out, 1)) || (await ffmpegFrame(src, out, 0));
      if (!ok) { coverFailed.add(id); return null; }
      return out;
    } finally { release(); coverBusy.delete(id); }
  })();
  coverBusy.set(id, p);
  return p;
}

module.exports = { ROOT, browse, listFiles, addDir, removeDir, addFiles, removeItems, list, fileFor, coverFor, sourceDirs };
