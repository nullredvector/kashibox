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
  const alone = { videos: [{ videoUrl: videoPath, coverUrl: coverFor(videoPath) }], index: 0 };
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
      return { videoUrl, coverUrl: coverFor(videoUrl) };
    }),
    index: start - from,
  };
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

module.exports = { authorFeed, labelFor, parseVideoPath };
