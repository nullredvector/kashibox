'use strict';
// TV sessions: the grid on the TV, saved by itself so it can be brought back later (tv_sessions.json, paths only).
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const MAX_SESSIONS = 30;

const fileOf = archiveDir => path.join(archiveDir, 'data', '.appdata', 'tv_sessions.json');

function load(archiveDir) {
  try {
    const d = JSON.parse(fs.readFileSync(fileOf(archiveDir), 'utf8'));
    return Array.isArray(d.sessions) ? d.sessions.filter(s => s && s.id && Array.isArray(s.items)) : [];
  } catch (_) { return []; }
}

function save(archiveDir, sessions) {
  const file = fileOf(archiveDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ sessions }, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

const sameSet = (a, b) => a.length === b.length && a.every(x => b.includes(x));

// Saves the grid as the session being worked on. currentId is that session (null = none yet: reuse a saved session with
// exactly these videos, else start a new one). Returns the session id. An empty grid saves nothing.
function record(archiveDir, currentId, grid) {
  if (!grid.length) return currentId;
  const list = load(archiveDir);
  const urls = grid.map(i => i.videoUrl);
  let s = list.find(x => x.id === currentId) || list.find(x => sameSet(x.items.map(i => i.videoUrl), urls));
  if (!s) { s = { id: crypto.randomBytes(6).toString('hex'), createdAt: Date.now(), items: [] }; list.push(s); }
  s.items = grid.map(({ videoUrl, coverUrl }) => ({ videoUrl, coverUrl }));
  s.updatedAt = Date.now();
  // A session built up video by video can end up identical to an older one: keep only the one just worked on
  const kept = list.filter(x => x === s || !sameSet(x.items.map(i => i.videoUrl), urls));
  kept.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  save(archiveDir, kept.slice(0, MAX_SESSIONS));
  return s.id;
}

module.exports = { load, record };
