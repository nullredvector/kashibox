'use strict';
// Run with: node --test test/
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kashibox-scout-'));
process.env.ARCHIVE_DIR = root;                    // before the modules read it
const scout = require('../scout_store');
const dbStars = require('../db_stars');
const dir = path.join(root, 'data', '.appdata', 'scout');
fs.mkdirSync(dir, { recursive: true });
const write = (name, text) => fs.writeFileSync(path.join(dir, name), text);

test('no candidates file means not available', () => {
  const r = scout.loadScout();
  assert.equal(r.available, false);
  assert.deepEqual(r.candidates, []);
  assert.equal(r.status, null);
});

test('candidates: latest line per id wins, best score first, bad lines skipped', () => {
  write('candidates.jsonl', [
    JSON.stringify({ id: '1000000000000000001', author: 'alice', desc: 'first', score: 0.5, found: 1 }),
    JSON.stringify({ id: '1000000000000000002', author: 'bob', desc: 'b', score: 0.9, found: 2, tags: [['t1', 0.8], ['t2', 0.7], ['t3', 0.6], ['t4', 0.5]] }),
    'this is not json',
    JSON.stringify({ id: '1000000000000000001', author: 'alice', desc: 'second', score: 0.7, found: 3 }),
    JSON.stringify({ id: 'abc', author: 'x', score: 1 }),                                  // id is not digits
    JSON.stringify({ id: '1000000000000000003', author: '../etc', score: 1 }),             // unsafe author
    '{"id":"1000000000000000004","author":"half',                                           // a half-written last line
  ].join('\n'));
  const r = scout.loadScout();
  assert.equal(r.available, true);
  assert.deepEqual(r.candidates.map(c => c.id), ['1000000000000000002', '1000000000000000001']);
  assert.equal(r.candidates[1].desc, 'second');
  assert.equal(r.candidates[0].tags.length, 3);                                              // at most three reasons
});

test('the cover path is rebuilt from the id, never taken from the file', () => {
  const c = scout.cleanCandidate({ id: '1000000000000000009', author: 'a', cover: '../../../etc/passwd', score: 2 });
  assert.equal(c.cover, 'scout/covers/1000000000000000009.jpg');
  assert.equal(c.score, 1);                                                                   // clamped to 0..1
});

test('decisions: validated, saved, forgotten with pending', () => {
  assert.equal(scout.recordDecision('nope', 'liked').code, 400);
  assert.equal(scout.recordDecision('1000000000000000001', 'bogus').code, 400);
  assert.equal(scout.recordDecision('1000000000000000001', 'skipped').code, 200);
  assert.equal(scout.recordDecision('1000000000000000002', 'liked').code, 200);
  let d = scout.loadDecisions();
  assert.equal(d['1000000000000000001'].d, 'skipped');
  assert.equal(d['1000000000000000002'].d, 'liked');
  assert.equal(scout.recordDecision('1000000000000000001', 'pending').code, 200);
  d = scout.loadDecisions();
  assert.equal(d['1000000000000000001'], undefined);
  assert.ok(fs.existsSync(path.join(root, 'data', '.appdata', 'scout_feedback.json.bak')));  // the previous version is kept
});

test('a damaged feedback file reads as empty instead of throwing', () => {
  fs.writeFileSync(path.join(root, 'data', '.appdata', 'scout_feedback.json'), '{ broken');
  assert.deepEqual(scout.loadDecisions(), {});
});

test('status: unknown states fall back to idle and numbers are sanitised', () => {
  write('status.json', JSON.stringify({ state: 'weird', updated: 5, message: 'x'.repeat(500), today: { date: '2026-10-24', viewed: 12, collected: '3' } }));
  const s = scout.loadStatus();
  assert.equal(s.state, 'idle');
  assert.equal(s.message.length, 200);
  assert.deepEqual(s.today, { date: '2026-10-24', viewed: 12, collected: 3 });
  write('status.json', JSON.stringify({ state: 'challenge', updated: 1 }));
  assert.equal(scout.loadStatus().state, 'challenge');
});

test('settings: the scout limits are whitelisted and range-checked', () => {
  dbStars.saveSettings({ scoutEnabled: true, scoutDaily: 80, scoutMin: 65, scoutFrom: 9, scoutTo: 23 });
  assert.deepEqual(pick(dbStars.loadSettings()), { scoutEnabled: true, scoutDaily: 80, scoutMin: 65, scoutFrom: 9, scoutTo: 23 });
  dbStars.saveSettings({ scoutEnabled: 'yes', scoutDaily: 5000, scoutMin: -1, scoutFrom: 30, scoutTo: 2 });   // all invalid: nothing changes
  assert.deepEqual(pick(dbStars.loadSettings()), { scoutEnabled: true, scoutDaily: 80, scoutMin: 65, scoutFrom: 9, scoutTo: 23 });
  function pick(s) { const o = {}; for (const k of ['scoutEnabled', 'scoutDaily', 'scoutMin', 'scoutFrom', 'scoutTo']) if (k in s) o[k] = s[k]; return o; }
});

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('tag answers: only tags the scorer named, right/wrong/forget, kept beside the decisions', () => {
  const id = '1000000000000000002';                                   // has tags t1..t3 from the test above
  assert.equal(scout.recordTagFeedback(id, 'nope', 1).code, 404);
  assert.equal(scout.recordTagFeedback('1000000000000000099', 't1', 1).code, 404);
  assert.equal(scout.recordTagFeedback(id, 't1', 2).code, 400);
  assert.equal(scout.recordTagFeedback(id, 't1', 1).code, 200);
  assert.equal(scout.recordTagFeedback(id, 't2', -1).code, 200);
  assert.equal(scout.recordDecision(id, 'liked').code, 200);          // a decision does not wipe the tag answers
  let r = scout.loadScout();
  assert.deepEqual(r.tagFeedback[id], { t1: 1, t2: -1 });
  assert.equal(r.decisions[id].d, 'liked');
  scout.recordTagFeedback(id, 't1', 0);
  scout.recordTagFeedback(id, 't2', 0);
  assert.equal(scout.loadScout().tagFeedback[id], undefined);
  scout.recordDecision(id, 'pending');
});
