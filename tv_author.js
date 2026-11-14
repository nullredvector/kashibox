'use strict';
// "More from this author" for the TV app: given one video's path, the downloaded videos of the same author, newest first.
// Reads the archive database (db_*.js) once and keeps only a small index; nothing but file paths leaves this module.
const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');

const MAX_LIST = 300;
const FILES = ['db_videos.js', 'db_likes.js', 'db_bookmarked.js', 'db_following.js', 'db_authors.js'];

let built = null;   // { stamp, byAuthor: Map(authorId -> [{id, dir, t}]), authorOf: Map(videoId -> authorId), nameOf: Map(authorId -> username) }

function readDb(appdata, name) {
  let text;
  try { text = fs.readFileSync(path.join(appdata, name), 'utf8'); } catch (_) { return null; }
  const b64 = text.match(/_base64\s*=\s*"([^"]+)"/);
  let json;
  if (b64) {
    json = zlib.gunzipSync(Buffer.from(b64[1], 'base64')).toString('utf8');
  } else {
    const raw = text.match(/String\.raw`([\s\S]*)`/);
    if (!raw) return null;
    json = raw[1].replace(/背𓄹剃/g, '`').replace(/⑀⦃/g, '${');
  }
  return JSON.parse(json);
}

function stampOf(appdata) {
  return FILES.map(f => { try { return fs.statSync(path.join(appdata, f)).mtimeMs; } catch (_) { return 0; } }).join('|');
}

function build(archiveDir) {
  const appdata = path.join(archiveDir, 'data', '.appdata');
  const stamp = stampOf(appdata);
  if (built && built.stamp === stamp) return built;

  const videos = readDb(appdata, 'db_videos.js');
  if (!videos) return (built = { stamp, byAuthor: new Map(), authorOf: new Map(), nameOf: new Map() });
  let likes = readDb(appdata, 'db_likes.js');
  if (likes && likes.likes) likes = likes.likes;
  const marks = readDb(appdata, 'db_bookmarked.js');
  const following = readDb(appdata, 'db_following.js');

  const likeSet = new Set(((likes && likes.downloaded) || []).map(String));
  const markSet = new Set(((marks && marks.downloaded) || []).map(String));
  const folSets = new Map();   // authorId -> Set of video ids kept in that author's folder
  Object.entries((following && following.authorItems) || {}).forEach(([aid, it]) => {
    folSets.set(String(aid), new Set([...(it.inFolder || []), ...(it.disappeared || [])].map(String)));
  });

  const byAuthor = new Map(), authorOf = new Map();
  for (const [id, v] of Object.entries(videos)) {
    const aid = String(v.authorId);
    authorOf.set(id, aid);
    const dir = likeSet.has(id) ? 'Likes' : markSet.has(id) ? 'Favorites'
      : (folSets.get(aid) && folSets.get(aid).has(id)) ? 'Following/' + aid : null;
    if (!dir) continue;
    if (!byAuthor.has(aid)) byAuthor.set(aid, []);
    byAuthor.get(aid).push({ id, dir, t: Number(v.createTime) || 0 });
  }
  byAuthor.forEach(list => list.sort((a, b) => b.t - a.t));
  const nameOf = new Map();
  const authors = readDb(appdata, 'db_authors.js') || {};
  Object.entries(authors).forEach(([aid, a]) => { if (a.uniqueIds && a.uniqueIds[0]) nameOf.set(String(aid), String(a.uniqueIds[0])); });
  return (built = { stamp, byAuthor, authorOf, nameOf });
}

const VIDEO_PATH = /^\/data\/(Likes|Favorites|Following\/[^/]+)\/videos\/([^/]+)\.mp4$/;

function coverFor(videoUrl) { return videoUrl.replace('/videos/', '/covers/').replace(/\.mp4$/, '.jpg'); }

// -> { videos: [{ videoUrl, coverUrl }], index }  (null when the path is not a video path)
function authorFeed(archiveDir, videoPath, hidden) {
  const m = VIDEO_PATH.exec(videoPath || '');
  if (!m) return null;
  const alone = { videos: [{ videoUrl: videoPath, coverUrl: coverFor(videoPath), wide: wideCached(videoPath) }], index: 0 };
  let idx;
  try { idx = build(archiveDir); } catch (_) { return alone; }
  const aid = idx.authorOf.get(m[2]);
  // hidden videos are left out, except the one that was asked for
  const all = aid && idx.byAuthor.get(aid);
  const list = all && (hidden && hidden.size ? all.filter(e => e.id === m[2] || !hidden.has(e.id)) : all);
  if (!list || !list.length) return alone;

  let start = list.findIndex(e => e.id === m[2]);
  if (start < 0) return alone;
  const from = Math.max(0, Math.min(start - Math.floor(MAX_LIST / 2), list.length - MAX_LIST));
  const slice = list.slice(from, from + MAX_LIST);
  return {
    videos: slice.map(e => {
      const videoUrl = `/data/${e.dir}/videos/${e.id}.mp4`;
      return { videoUrl, coverUrl: coverFor(videoUrl), wide: wideCached(videoUrl) };
    }),
    index: start - from,
  };
}

// n random downloaded videos from any account -> [{ videoUrl, coverUrl, wide }] (the TV's feed when no phone has published
// one). The shuffle is made once per database state, so the same videos come back and their covers are remembered.
let deck = { idx: null, list: [] };
function shuffled(archiveDir, n) {
  let idx;
  try { idx = build(archiveDir); } catch (_) { return []; }
  if (deck.idx !== idx) {
    const all = [];
    idx.byAuthor.forEach(list => list.forEach(e => all.push(e)));
    for (let i = all.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [all[i], all[j]] = [all[j], all[i]];
    }
    deck = { idx, list: all };
  }
  return deck.list.slice(0, n).map(e => {
    const videoUrl = `/data/${e.dir}/videos/${e.id}.mp4`;
    return { videoUrl, coverUrl: coverFor(videoUrl), wide: wideCached(videoUrl) };
  });
}

// Is this video landscape? The cover is the video's first frame, so its size says it; a JPEG states its size in the first
// bytes, so only those are read. Unknown (no file, not a JPEG, a path outside the archive) counts as portrait.
function jpegSize(buf) {
  if (buf.length < 4 || buf[0] !== 0xFF || buf[1] !== 0xD8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xFF) { i++; continue; }
    const marker = buf[i + 1];
    if (marker === 0xFF) { i++; continue; }
    if (marker === 0xD8 || (marker >= 0xD0 && marker <= 0xD7) || marker === 0x01) { i += 2; continue; }
    if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}
// The covers sit on a slow disk, so reading them must never block the server (Node does everything on one thread) or crowd
// out video streaming: reads are asynchronous, a few at a time, and each answer is remembered. A request never waits on
// more than a short time budget; what is not known yet counts as portrait and fills in from the background reads.
const WIDE_PARALLEL = 3;
const HEAD_BYTES = 32768;
const wideCache = new Map();    // video path -> boolean
const wideBusy = new Map();     // video path -> Promise of a queued or running read
const wideQueue = [];           // { archiveDir, videoPath, done }
let wideRunning = 0;

const wideCached = videoPath => wideCache.get(videoPath) === true;

async function readWide(archiveDir, videoPath) {
  let fh;
  try {
    fh = await fs.promises.open(path.join(archiveDir, coverFor(videoPath)), 'r');
    const buf = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await fh.read(buf, 0, HEAD_BYTES, 0);
    const size = jpegSize(buf.subarray(0, bytesRead));
    return !!size && size.width > size.height;
  } catch (_) {
    return false;               // no cover, unreadable: portrait
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

function pumpWide() {
  while (wideRunning < WIDE_PARALLEL && wideQueue.length) {
    const job = wideQueue.shift();
    wideRunning++;
    readWide(job.archiveDir, job.videoPath).then(wide => {
      wideCache.set(job.videoPath, wide);
      wideRunning--;
      wideBusy.delete(job.videoPath);
      job.done(wide);
      pumpWide();
    });
  }
}

// urgent = the answer is needed now: it goes to the front of the queue
function ensureWide(archiveDir, videoPath, urgent) {
  if (!VIDEO_PATH.test(videoPath || '')) return Promise.resolve(false);
  if (wideCache.has(videoPath)) return Promise.resolve(wideCache.get(videoPath));
  if (wideBusy.has(videoPath)) {
    if (urgent) {
      const at = wideQueue.findIndex(j => j.videoPath === videoPath);
      if (at > 0) wideQueue.unshift(wideQueue.splice(at, 1)[0]);
    }
    return wideBusy.get(videoPath);
  }
  const promise = new Promise(done => { wideQueue[urgent ? 'unshift' : 'push']({ archiveDir, videoPath, done }); });
  wideBusy.set(videoPath, promise);
  pumpWide();
  return promise;
}

// Start reading these covers in the background (nothing waits for it)
function warmWide(archiveDir, videoPaths) {
  videoPaths.slice(0, 400).forEach(v => { ensureWide(archiveDir, v, false); });
}

// Wait for these (in this order of importance) for at most `ms`; whatever is still being read carries on in the background
function wideWithin(archiveDir, videoPaths, ms) {
  const reads = videoPaths.map((v, i) => ensureWide(archiveDir, v, i === 0));
  return Promise.race([Promise.all(reads), new Promise(r => setTimeout(r, ms))]);
}

// A short label for a set of videos: the accounts they belong to, e.g. '@one, @two, @three +2' ('' if none are known)
function labelFor(archiveDir, videoPaths) {
  let idx;
  try { idx = build(archiveDir); } catch (_) { return ''; }
  const names = [];
  for (const v of videoPaths) {
    const m = VIDEO_PATH.exec(v || '');
    const name = m && idx.nameOf.get(idx.authorOf.get(m[2]));
    if (name && !names.includes(name)) names.push(name);
  }
  if (!names.length) return '';
  return names.slice(0, 3).map(n => '@' + n).join(', ') + (names.length > 3 ? ' +' + (names.length - 3) : '');
}

// '/data/Likes/videos/123.mp4' -> { id: '123', coverSrc: 'data/Likes/covers/123.jpg' } (null for anything else)
function parseVideoPath(videoPath) {
  const m = VIDEO_PATH.exec(videoPath || '');
  return m ? { id: m[2], coverSrc: coverFor(videoPath).replace(/^\//, '') } : null;
}

module.exports = { authorFeed, labelFor, parseVideoPath, shuffled, jpegSize, wideCached, wideWithin, warmWide };
