'use strict';
const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');

const ARCHIVE_DIR = process.env.ARCHIVE_DIR || '/archive';
const STARS_FILE  = path.join(ARCHIVE_DIR, 'data', '.appdata', 'stars.json');
const SESSIONS_FILE = path.join(ARCHIVE_DIR, 'data', '.appdata', 'sessions.json');
const SETTINGS_FILE = path.join(ARCHIVE_DIR, 'data', '.appdata', 'settings.json');

function load() {
  try {
    const raw = fs.readFileSync(STARS_FILE, 'utf8');
    const data = JSON.parse(raw);
    return { stars: data.stars || {}, groups: data.groups || [], levels: data.levels || {} };
  } catch (_) {
    return { stars: {}, groups: [], levels: {} };
  }
}

// Revision of stars.json = hash of its bytes. A save must name the revision it was based on, so a window holding an
// out-of-date copy can never silently overwrite newer changes (the server refuses, and the browser merges instead).
function currentRev() {
  try { return crypto.createHash('sha1').update(fs.readFileSync(STARS_FILE)).digest('hex').slice(0, 16); } catch (_) { return 'none'; }
}

function loadWithRev() {
  const rev = currentRev();
  return Object.assign(load(), { rev });
}

const HISTORY_DIR = path.join(ARCHIVE_DIR, 'data', '.appdata', 'stars-history');
const HISTORY_KEEP = 20;
const HISTORY_EVERY_S = 6 * 3600;
const SHRINK_RATIO = 0.9;

function memberTotal(d) {
  return (d.groups || []).reduce((n, g) => n + (Array.isArray(g.videoIds) ? g.videoIds.length : 0), 0);
}

// Snapshot the current file before overwriting it: at least every few hours, and always before a save that removes more
// than 10% of all group memberships. The newest HISTORY_KEEP snapshots are kept (owner-only).
function snapshotBeforeSave(incoming) {
  if (!fs.existsSync(STARS_FILE)) return;
  let old;
  try { old = JSON.parse(fs.readFileSync(STARS_FILE, 'utf8')); } catch (_) { return; }
  if (!fs.existsSync(HISTORY_DIR)) fs.mkdirSync(HISTORY_DIR, { recursive: true, mode: 0o700 });
  const files = fs.readdirSync(HISTORY_DIR).filter(f => /^stars-\d+(-shrink)?\.json$/.test(f)).sort();
  const last = files.length ? parseInt(files[files.length - 1].split('-')[1], 10) : 0;
  const shrinks = memberTotal(old) >= 50 && memberTotal(incoming) < memberTotal(old) * SHRINK_RATIO;
  if (!shrinks && Date.now() / 1000 - last / 1000 < HISTORY_EVERY_S) return;
  const dest = path.join(HISTORY_DIR, `stars-${Date.now()}${shrinks ? '-shrink' : ''}.json`);
  fs.copyFileSync(STARS_FILE, dest);
  fs.chmodSync(dest, 0o600);
  fs.readdirSync(HISTORY_DIR).filter(f => /^stars-\d+(-shrink)?\.json$/.test(f)).sort().slice(0, -HISTORY_KEEP)
    .forEach(f => { try { fs.unlinkSync(path.join(HISTORY_DIR, f)); } catch (_) {} });
}

// Compare-and-swap save. Node runs this synchronously, so nothing can change the file between the check and the write.
function saveGuarded(data, rev) {
  const cur = currentRev();
  if (typeof rev !== 'string') return { code: 428, error: 'revision required', rev: cur };
  if (rev !== cur) return { code: 409, error: 'stale', rev: cur };
  try { snapshotBeforeSave(data); } catch (_) { /* a failed snapshot must not block saving */ }
  save(data);
  return { code: 200, ok: true, rev: currentRev() };
}

function save(data) {
  const dir = path.dirname(STARS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const json = JSON.stringify(data, null, 2);
  const tmp  = STARS_FILE + '.tmp';
  fs.writeFileSync(tmp, json, 'utf8');
  fs.renameSync(tmp, STARS_FILE);
}

// ── Settings (settings.json): small, whitelisted, shared by every device ──
//   profileUrl  address opened when a username tab is double-clicked; {username} stands for the username ('' = off)
//   debugBanner true = show the status banner at startup (Capacitor / Cast diagnostics)
function cleanSettings(input) {
  const s = (input && typeof input === 'object' && !Array.isArray(input)) ? input : {};
  const out = {};
  if (typeof s.profileUrl === 'string') {
    const u = s.profileUrl.trim();
    if (u.length > 300) throw new Error('profileUrl too long');
    if (u && !(/^https?:\/\//i.test(u) && u.includes('{username}'))) throw new Error('profileUrl needs http(s):// and {username}');
    out.profileUrl = u;
  }
  if (typeof s.debugBanner === 'boolean') out.debugBanner = s.debugBanner;
  if (Number.isInteger(s.numericMin) && Number.isInteger(s.numericMax) && s.numericMin >= 0 && s.numericMax <= 999 && s.numericMin <= s.numericMax && s.numericMax - s.numericMin < 50) {
    out.numericMin = s.numericMin; out.numericMax = s.numericMax;
  }
  if (typeof s.numericName === 'string') out.numericName = s.numericName.trim().slice(0, 30);
  return out;
}

function loadSettings() {
  try { return cleanSettings(JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'))); } catch (_) { return {}; }
}

function saveSettings(patch) {
  const next = Object.assign(loadSettings(), cleanSettings(patch));
  const dir = path.dirname(SETTINGS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = SETTINGS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
  fs.renameSync(tmp, SETTINGS_FILE);
  return next;
}

function loadSessions() {
  try {
    const data = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
    return Array.isArray(data.sessions) ? data.sessions : [];
  } catch (_) {
    return [];
  }
}

function saveSessions(sessions) {
  const dir = path.dirname(SESSIONS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const tmp = SESSIONS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ sessions }, null, 2), 'utf8');
  fs.renameSync(tmp, SESSIONS_FILE);
}

// ── autotagTT review (suggestions are written by the autotagTT batch job; this file only
// reads them and records the user's explicit decisions). Group membership is never touched here:
// accepting adds the video to its group through the normal /api/stars flow in the browser. ──
const AUTOTAG_FILE  = path.join(ARCHIVE_DIR, 'data', '.appdata', 'autotag', 'autotag.json');
const FEEDBACK_FILE = path.join(ARCHIVE_DIR, 'data', '.appdata', 'autotag_feedback.json');
const AI_FILE   = path.join(ARCHIVE_DIR, 'data', '.appdata', 'autotag', 'ai_tags.json');
const TAGS_FILE = path.join(ARCHIVE_DIR, 'data', '.appdata', 'autotag_tags.json');
const TAG_RE = /^[^\x00-\x1f\\<>"]{1,60}$/;   // tags are group names (lowercased); never used as file paths
const ID_RE  = /^[A-Za-z0-9_-]{1,40}$/;
const isId   = x => typeof x === 'string' && ID_RE.test(x);

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

function loadFeedback() {
  const raw = readJson(FEEDBACK_FILE);
  const out = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [tag, v] of Object.entries(raw)) {
      if (!TAG_RE.test(tag) || !v) continue;
      out[tag] = {
        accepted: Array.isArray(v.accepted) ? v.accepted.filter(isId) : [],
        rejected: Array.isArray(v.rejected) ? v.rejected.filter(isId) : [],
        unsure:   Array.isArray(v.unsure)   ? v.unsure.filter(isId)   : [],
      };
    }
  }
  return out;
}

function loadAutotag(tag) {
  if (typeof tag !== 'string' || !TAG_RE.test(tag)) return { error: 'bad tag' };
  const sugg = readJson(AUTOTAG_FILE);
  const metrics = k => (sugg && sugg._meta && sugg._meta.metrics && sugg._meta.metrics[k]) || {};
  const weak = k => metrics(k).gate === 'weak';
  // A weak tag is listed only if it has a short low-confidence review list; hopeless ones are hidden
  const tags = sugg ? Object.keys(sugg).filter(k => k[0] !== '_' && Array.isArray(sugg[k]) && (!weak(k) || sugg[k].length > 0 || metrics(k).review_only === true)) : [];
  const lowConfidenceTags = tags.filter(weak);
  const fb = loadFeedback()[tag] || { accepted: [], rejected: [], unsure: [] };
  const decided = new Set([...fb.accepted, ...fb.rejected, ...fb.unsure]);
  const list = (sugg && Array.isArray(sugg[tag])) ? sugg[tag] : [];
  const pending = list
    .filter(x => x && isId(x.id) && !decided.has(x.id))
    .map(x => ({ id: x.id, score: Number(x.score) || 0 }));
  const score = new Map(list.map(x => [x && x.id, x && Number(x.score) || 0]));
  const withScore = ids => ids.map(id => ({ id, score: score.get(id) ?? null }));
  return {
    available: !!sugg, tags, lowConfidenceTags, lowConfidence: weak(tag), tag, pending,
    accepted: withScore(fb.accepted), rejected: withScore(fb.rejected), unsure: withScore(fb.unsure),
    generated: sugg && sugg._meta ? sugg._meta.generated || null : null,
  };
}

// decision: 'accepted' | 'rejected' | 'unsure' | 'pending' (undo a rejection / not-sure). 'unsure' is not a label: training ignores it. Repeating a decision is a no-op;
// switching an existing decision needs change=true so nothing is overwritten silently.
function recordFeedback(tag, id, decision, change) {
  if (typeof tag !== 'string' || !TAG_RE.test(tag)) return { code: 400, error: 'bad tag' };
  if (!isId(id)) return { code: 400, error: 'bad id' };
  if (!['accepted', 'rejected', 'unsure', 'pending'].includes(decision)) return { code: 400, error: 'bad decision' };
  const all = loadFeedback();
  const fb = all[tag] || { accepted: [], rejected: [], unsure: [] };
  fb.unsure = fb.unsure || [];
  const known = (readJson(AUTOTAG_FILE) || {})[tag];
  const ai = readJson(AI_FILE);
  const isSuggested = (Array.isArray(known) && known.some(x => x && x.id === id))
    || !!(ai && ai.videos && Array.isArray(ai.videos[id]) && ai.videos[id].some(t => Array.isArray(t) && t[0] === tag));
  const cur = fb.accepted.includes(id) ? 'accepted' : fb.rejected.includes(id) ? 'rejected' : fb.unsure.includes(id) ? 'unsure' : 'pending';
  if (!isSuggested && cur === 'pending') return { code: 404, error: 'unknown suggestion' };
  if (cur === decision) return { code: 200, ok: true, unchanged: true, status: cur };
  if (cur !== 'pending' && !change) return { code: 409, error: 'already ' + cur, status: cur };
  if (cur === 'accepted') return { code: 409, error: 'accepted videos are managed through their group', status: cur };
  fb.rejected = fb.rejected.filter(x => x !== id);
  fb.unsure = fb.unsure.filter(x => x !== id);
  if (decision === 'accepted') fb.accepted.push(id);
  if (decision === 'rejected') fb.rejected.push(id);
  if (decision === 'unsure') fb.unsure.push(id);
  all[tag] = fb;
  const dir = path.dirname(FEEDBACK_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(FEEDBACK_FILE)) fs.copyFileSync(FEEDBACK_FILE, FEEDBACK_FILE + '.bak');
  const tmp = FEEDBACK_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(all), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, FEEDBACK_FILE);
  return { code: 200, ok: true, status: decision };
}

function writeOwnerOnly(file, obj) {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(file)) fs.copyFileSync(file, file + '.bak');
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
}

// ── Which groups the user opted in to for training ("tag picker") ──
function loadTagsConfig() {
  const raw = readJson(TAGS_FILE);
  const enabled = raw && Array.isArray(raw.enabled) ? raw.enabled.filter(t => typeof t === 'string' && TAG_RE.test(t)) : ['braces'];
  return { enabled };
}

function saveTagsConfig(list) {
  if (!Array.isArray(list) || list.length > 100) return { code: 400, error: 'bad list' };
  const names = new Set(load().groups.map(g => String(g.name).trim().toLowerCase()));
  const out = [];
  for (const t of list) {
    if (typeof t !== 'string') return { code: 400, error: 'bad tag' };
    const n = t.trim().toLowerCase();
    if (!TAG_RE.test(n)) return { code: 400, error: 'bad tag' };
    if (!names.has(n)) return { code: 404, error: 'unknown group' };
    if (!out.includes(n)) out.push(n);
  }
  try { writeOwnerOnly(TAGS_FILE, { enabled: out }); } catch (_) { return { code: 500, error: 'could not save' }; }
  return { code: 200, ok: true, enabled: out };
}

// ── AI tags: model labels kept apart from human groups. Anything already reviewed (or already in a
// human group of the same name) is dropped so a decision always wins over the model. ──
function loadAiTags() {
  const ai = readJson(AI_FILE);
  if (!ai || typeof ai.videos !== 'object' || !ai.videos) return { available: false, videos: {} };
  const fb = loadFeedback();
  const decided = {};
  for (const [tag, v] of Object.entries(fb)) decided[tag] = new Set([...v.accepted, ...v.rejected, ...v.unsure]);
  const members = {};
  for (const g of load().groups) members[String(g.name).trim().toLowerCase()] = new Set(g.videoIds);
  const videos = {};
  for (const [id, list] of Object.entries(ai.videos)) {
    if (!isId(id) || !Array.isArray(list)) continue;
    const keep = list.filter(t => Array.isArray(t) && typeof t[0] === 'string' && TAG_RE.test(t[0])
      && !(decided[t[0]] && decided[t[0]].has(id)) && !(members[t[0]] && members[t[0]].has(id)))
      .map(t => [t[0], Number(t[1]) || 0]);
    if (keep.length) videos[id] = keep;
  }
  return { available: true, generated: ai._meta ? ai._meta.generated || null : null, videos };
}

// ── Watch statistics: how the user watches videos in the feed (video ids and counters only).
// Fields per video: s = times shown, m = milliseconds watched, k = quick skips, e = times it played
// to the end (a replay counts again), t = last time shown (ms since epoch). Clients send deltas,
// so several devices can report without overwriting each other. ──
const WATCH_FILE = path.join(ARCHIVE_DIR, 'data', '.appdata', 'watch.json');
const num = (x, max) => { x = Number(x); return Number.isFinite(x) && x > 0 ? Math.min(Math.round(x), max) : 0; };

function loadWatch() {
  const raw = readJson(WATCH_FILE);
  return raw && raw.watch && typeof raw.watch === 'object' && !Array.isArray(raw.watch) ? raw.watch : {};
}

// delta: { videoId: { s, m, k, e, t } } to add. Returns how many videos were updated.
function mergeWatch(delta) {
  if (!delta || typeof delta !== 'object' || Array.isArray(delta)) return 0;
  const ids = Object.keys(delta).filter(isId).slice(0, 5000);
  if (!ids.length) return 0;
  const cur = loadWatch();
  for (const id of ids) {
    const d = delta[id] || {};
    const c = cur[id] || { s: 0, m: 0, k: 0, e: 0, t: 0 };
    c.s += num(d.s, 1000); c.m += num(d.m, 3600000); c.k += num(d.k, 1000); c.e += num(d.e, 1000);
    c.t = Math.max(c.t || 0, num(d.t, 8.64e15));
    cur[id] = c;
  }
  const dir = path.dirname(WATCH_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = WATCH_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ watch: cur }), 'utf8');
  fs.renameSync(tmp, WATCH_FILE);
  return ids.length;
}

// ── Run control. Starplayer only drops a request file and reads a status file; the autotagTT worker
// container (which has the GPU) picks the request up and runs its own fixed job. Nothing here starts a process. ──
const AT_DIR       = path.join(ARCHIVE_DIR, 'data', '.appdata', 'autotag');
const REQUEST_FILE = path.join(AT_DIR, 'run_request.json');
const STATUS_FILE  = path.join(AT_DIR, 'status.json');
const SCHEDULE_FILE = path.join(AT_DIR, 'schedule.json');
const HEARTBEAT_FILE = path.join(AT_DIR, 'heartbeat.json');
const NOTIFY_TEST_FILE = path.join(AT_DIR, 'notify_test.json');
const FRAMES_FILE = path.join(AT_DIR, 'frames.json');
const FRAMES_PROGRESS_FILE = path.join(AT_DIR, 'frames_progress.json');
const PROGRESS_STALE_S = 120;          // a scan that stopped reporting this long ago is not running any more
const FRAMES_THRESHOLD = 0.95;
const WORKER_ALIVE_S = 45;
const MIN_REQUEST_GAP_S = 30;

function framesConfig() {
  const c = readJson(FRAMES_FILE) || {};
  return {
    mode: ['off', 'trial', 'full'].includes(c.mode) ? c.mode : 'off',
    mouth: c.mouth === true,
    text: c.text !== false,
    budget_min: Number.isInteger(c.budget_min) && c.budget_min >= 10 && c.budget_min <= 600 ? c.budget_min : 120,
  };
}

// Live scan progress, written by the worker after every batch. Read from a file (not kept in the browser), so every
// device and every page reload shows the same bar.
function framesProgress() {
  const p = readJson(FRAMES_PROGRESS_FILE);
  const num = x => (typeof x === 'number' && isFinite(x) && x >= 0 ? x : 0);
  if (!p || typeof p !== 'object') return null;
  const total = num(p.total), covered = Math.min(num(p.covered), total);
  const fresh = typeof p.ts === 'number' && Date.now() / 1000 - p.ts < PROGRESS_STALE_S;
  return {
    mode: ['off', 'trial', 'full'].includes(p.mode) ? p.mode : 'off',
    total, covered, sessionDone: num(p.session_done), sessionTarget: num(p.session_target), rate: num(p.rate),
    running: p.running === true && fresh, updated: num(p.ts), threshold: FRAMES_THRESHOLD,
  };
}

function framesStatus(st) {
  const f = st && typeof st.frames === 'object' && st.frames ? st.frames : {};
  return { config: framesConfig(), stats: f.stats || null, trial: f.trial || null, progress: framesProgress() };
}

function saveFramesConfig(d) {
  if (!d || !['off', 'trial', 'full'].includes(d.mode) || typeof d.mouth !== 'boolean') return { code: 400, error: 'bad settings' };
  if (d.text !== undefined && typeof d.text !== 'boolean') return { code: 400, error: 'bad settings' };
  const b = d.budget_min === undefined ? 120 : d.budget_min;
  if (!Number.isInteger(b) || b < 10 || b > 600) return { code: 400, error: 'bad budget' };
  try { writeOwnerOnly(FRAMES_FILE, { mode: d.mode, mouth: d.mouth, text: d.text !== false, budget_min: b }); } catch (_) { return { code: 500, error: 'could not save' }; }
  return { code: 200, ok: true };
}

function runStatus() {
  const st = readJson(STATUS_FILE) || {};
  const req = readJson(REQUEST_FILE);
  const now = Date.now() / 1000;
  const queued = !!(req && typeof req.id === 'string' && req.id !== st.last_request_id);
  const sc = readJson(SCHEDULE_FILE) || {};
  return {
    workerOnline: Math.max(typeof st.heartbeat === 'number' ? st.heartbeat : 0, typeof (readJson(HEARTBEAT_FILE) || {}).t === 'number' ? readJson(HEARTBEAT_FILE).t : 0) > now - WORKER_ALIVE_S,
    state: st.state === 'running' ? 'running' : (queued ? 'queued' : 'idle'),
    phase: st.phase || null, detail: st.detail || '', error: st.error || null,
    reason: st.reason || null, started: st.started || null, finished: st.finished || null, lastOk: st.last_ok || null,
    result: st.result || null,
    frames: framesStatus(st),
    runSummary: st.run_summary && typeof st.run_summary === 'object' ? st.run_summary : null,
    notifications: st.notifications === true,
    notifyTest: st.notify_test && typeof st.notify_test === 'object' ? { ok: st.notify_test.ok === true, ts: st.notify_test.ts || null, id: st.notify_test.id || null } : null,
    schedule: { enabled: sc.enabled === true, hour: Number.isInteger(sc.hour) && sc.hour >= 0 && sc.hour <= 23 ? sc.hour : 3 },
  };
}

function requestRun() {
  const s = runStatus();
  if (!s.workerOnline) return { code: 503, error: 'worker offline' };
  if (s.state !== 'idle') return { code: 409, error: 'already ' + s.state };
  const prev = readJson(REQUEST_FILE);
  if (prev && typeof prev.ts === 'number' && Date.now() / 1000 - prev.ts < MIN_REQUEST_GAP_S) return { code: 429, error: 'too soon' };
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  try { writeOwnerOnly(REQUEST_FILE, { id, ts: Date.now() / 1000 }); } catch (_) { return { code: 500, error: 'could not save' }; }
  return { code: 200, ok: true };
}

function requestNotifyTest() {
  const s = runStatus();
  if (!s.workerOnline) return { code: 503, error: 'worker offline' };
  if (!s.notifications) return { code: 409, error: 'notifications are off' };
  const prev = readJson(NOTIFY_TEST_FILE);
  if (prev && typeof prev.ts === 'number' && Date.now() / 1000 - prev.ts < 10) return { code: 429, error: 'too soon' };
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  try { writeOwnerOnly(NOTIFY_TEST_FILE, { id, ts: Date.now() / 1000 }); } catch (_) { return { code: 500, error: 'could not save' }; }
  return { code: 200, ok: true, id };
}

function saveSchedule(d) {
  if (!d || typeof d.enabled !== 'boolean' || !Number.isInteger(d.hour) || d.hour < 0 || d.hour > 23) return { code: 400, error: 'bad schedule' };
  try { writeOwnerOnly(SCHEDULE_FILE, { enabled: d.enabled, hour: d.hour }); } catch (_) { return { code: 500, error: 'could not save' }; }
  return { code: 200, ok: true };
}

module.exports = { loadSettings, saveSettings, load, loadWithRev, saveGuarded, currentRev, save, loadSessions, saveSessions, loadAutotag, recordFeedback, loadAiTags, loadTagsConfig, saveTagsConfig, loadWatch, mergeWatch, runStatus, requestRun, saveSchedule, requestNotifyTest, saveFramesConfig };
