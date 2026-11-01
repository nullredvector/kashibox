'use strict';
// "For You picks": a queue of videos suggested for you to look at and like yourself. Nothing here likes anything.
//
// Three programs share the archive folder (see docs/scout/README.md):
//   the scout (in ttpull)   writes  data/.appdata/scout/candidates.jsonl, scout/covers/<id>.jpg and scout/status.json
//   kashibox (this file)    reads those, and writes your decisions to data/.appdata/scout_feedback.json
//   the scorer (autotagTT)  reads the decisions to learn from them
// The settings the scout obeys (scoutEnabled, scoutDaily, scoutMin, scoutFrom, scoutTo) live in settings.json.
const fs   = require('fs');
const path = require('path');

const ARCHIVE_DIR   = process.env.ARCHIVE_DIR || '/archive';
const SCOUT_DIR     = path.join(ARCHIVE_DIR, 'data', '.appdata', 'scout');
const CANDIDATES    = path.join(SCOUT_DIR, 'candidates.jsonl');
const STATUS_FILE   = path.join(SCOUT_DIR, 'status.json');
const FEEDBACK_FILE = path.join(ARCHIVE_DIR, 'data', '.appdata', 'scout_feedback.json');
const MAX_TAG_VOTES = 100000;

const ID_RE = /^\d{5,25}$/;                                  // video ids are digits
const DECISIONS = ['liked', 'skipped', 'opened'];            // 'pending' removes a decision
const MAX_CANDIDATES = 5000;                                 // the newest ones kept when reading
const MAX_DECISIONS = 100000;
const STATES = ['idle', 'running', 'off', 'paused', 'challenge', 'login', 'error'];

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch (_) { return null; }
}

function str(v, max) {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

// One candidate line -> a safe object, or null. The cover path is rebuilt from the id, never taken from the file.
function cleanCandidate(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id || '');
  if (!ID_RE.test(id)) return null;
  const author = str(raw.author, 80).replace(/^@+/, '');
  if (!/^[\w.\-]{0,64}$/.test(author)) return null;
  const score = Number(raw.score);
  const tags = Array.isArray(raw.tags)
    ? raw.tags.filter(t => Array.isArray(t) && typeof t[0] === 'string' && Number.isFinite(Number(t[1]))).slice(0, 3)
        .map(t => [t[0].slice(0, 60), Math.max(0, Math.min(1, Number(t[1])))])
    : [];
  return {
    id, author, desc: str(raw.desc, 300),
    score: Number.isFinite(score) ? Math.max(0, Math.min(1, score)) : 0,
    tags,
    cover: `scout/covers/${id}.jpg`,
    found: Number.isFinite(Number(raw.found)) ? Number(raw.found) : 0,
  };
}

// All candidates, one per id (the latest line wins), best score first. Bad lines are skipped.
function loadCandidates() {
  const text = readText(CANDIDATES);
  if (text === null) return { available: false, list: [] };
  const byId = new Map();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let c = null;
    try { c = cleanCandidate(JSON.parse(line)); } catch (_) { /* a half-written last line */ }
    if (c) byId.set(c.id, c);
  }
  let list = [...byId.values()];
  if (list.length > MAX_CANDIDATES) list = list.sort((a, b) => b.found - a.found).slice(0, MAX_CANDIDATES);
  list.sort((a, b) => b.score - a.score || b.found - a.found);
  return { available: true, list };
}

function readFeedback() {
  const text = readText(FEEDBACK_FILE);
  const out = { decisions: {}, tagFeedback: {} };
  if (!text) return out;
  try {
    const raw = JSON.parse(text);
    const dec = raw && typeof raw.decisions === 'object' && !Array.isArray(raw.decisions) ? raw.decisions : {};
    for (const [id, v] of Object.entries(dec)) {
      if (ID_RE.test(id) && v && DECISIONS.includes(v.d)) out.decisions[id] = { d: v.d, t: Number(v.t) || 0 };
    }
    const tf = raw && typeof raw.tagFeedback === 'object' && !Array.isArray(raw.tagFeedback) ? raw.tagFeedback : {};
    for (const [id, tags] of Object.entries(tf)) {
      if (!ID_RE.test(id) || !tags || typeof tags !== 'object' || Array.isArray(tags)) continue;
      const clean = {};
      for (const [name, v] of Object.entries(tags)) if (name.length <= 60 && (v === 1 || v === -1)) clean[name] = v;
      if (Object.keys(clean).length) out.tagFeedback[id] = clean;
    }
  } catch (_) {}
  return out;
}

function loadDecisions() { return readFeedback().decisions; }

function writeFeedback(all) {
  const dir = path.dirname(FEEDBACK_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(FEEDBACK_FILE)) { try { fs.copyFileSync(FEEDBACK_FILE, FEEDBACK_FILE + '.bak'); } catch (_) {} }
  const tmp = FEEDBACK_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ decisions: all.decisions, tagFeedback: all.tagFeedback }), 'utf8');
  fs.renameSync(tmp, FEEDBACK_FILE);
}

// What the scout last said about itself (it writes this file; kashibox only shows it)
function loadStatus() {
  const text = readText(STATUS_FILE);
  if (!text) return null;
  try {
    const s = JSON.parse(text);
    if (!s || typeof s !== 'object') return null;
    const today = s.today && typeof s.today === 'object' ? s.today : {};
    return {
      state: STATES.includes(s.state) ? s.state : 'idle',
      updated: Number(s.updated) || 0,
      message: str(s.message, 200),
      next: Number(s.next) > 0 ? Number(s.next) : 0,        // optional: when it will look again (after a rest or a stop)
      today: { date: str(today.date, 12), viewed: Number(today.viewed) || 0, collected: Number(today.collected) || 0 },
    };
  } catch (_) { return null; }
}

function loadScout() {
  const c = loadCandidates();
  const f = readFeedback();
  return { available: c.available, candidates: c.list, decisions: f.decisions, tagFeedback: f.tagFeedback, status: loadStatus() };
}

// Record one decision. decision: 'liked' | 'skipped' | 'opened' | 'pending' (forget it).
function recordDecision(id, decision) {
  if (!ID_RE.test(String(id))) return { code: 400, error: 'bad id' };
  if (decision !== 'pending' && !DECISIONS.includes(decision)) return { code: 400, error: 'bad decision' };
  const all = readFeedback();
  if (decision === 'pending') delete all.decisions[id];
  else {
    if (Object.keys(all.decisions).length >= MAX_DECISIONS && !all.decisions[id]) return { code: 507, error: 'too many decisions' };
    all.decisions[id] = { d: decision, t: Date.now() };
  }
  writeFeedback(all);
  return { code: 200, ok: true, decision: all.decisions[id] ? all.decisions[id].d : 'pending' };
}

// Was one of the tags the scorer gave this pick right (1) or wrong (-1)? 0 forgets the answer.
// Only a tag the scorer actually named for that candidate is accepted.
function recordTagFeedback(id, tag, value) {
  if (!ID_RE.test(String(id))) return { code: 400, error: 'bad id' };
  if (typeof tag !== 'string' || !tag || tag.length > 60) return { code: 400, error: 'bad tag' };
  if (value !== 1 && value !== -1 && value !== 0) return { code: 400, error: 'bad value' };
  const cand = loadCandidates().list.find(c => c.id === String(id));
  if (!cand || !cand.tags.some(t => t[0] === tag)) return { code: 404, error: 'that pick does not have that tag' };
  const all = readFeedback();
  const mine = all.tagFeedback[id] || (all.tagFeedback[id] = {});
  if (value === 0) delete mine[tag];
  else {
    if (Object.keys(all.tagFeedback).length >= MAX_TAG_VOTES && !Object.keys(mine).length) return { code: 507, error: 'too many answers' };
    mine[tag] = value;
  }
  if (!Object.keys(mine).length) delete all.tagFeedback[id];
  writeFeedback(all);
  return { code: 200, ok: true, tags: all.tagFeedback[id] || {} };
}

module.exports = { loadScout, loadCandidates, loadDecisions, loadStatus, recordDecision, recordTagFeedback, cleanCandidate, SCOUT_DIR };
