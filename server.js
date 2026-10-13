'use strict';
const http     = require('http');
const fs       = require('fs');
const path     = require('path');
const url      = require('url');
const zlib     = require('zlib');
const crypto   = require('crypto');
const dbStars  = require('./db_stars');

const ARCHIVE_DIR = process.env.ARCHIVE_DIR || '/archive';
const PORT        = parseInt(process.env.PORT || '8080', 10);
const TTPULL_URL  =(process.env.TTPULL_URL || 'http://ttpull:3847').replace(/\/$/, '');

// ── MIME types ──────────────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.mp4':  'video/mp4',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png':  'image/png',
  '.json': 'application/json',
};

// ── Disk counts ──────────────────────────────────────────────────────────────
// How many videos are really in each folder (a count of .mp4 files, nothing else), cached for a minute.
let diskMemo = null;
async function countMp4(dir) {
  try { return (await fs.promises.readdir(dir)).filter(f => f.endsWith('.mp4')).length; } catch (_) { return 0; }
}
async function diskCounts() {
  if (diskMemo && Date.now() - diskMemo.at < 60000) return diskMemo.out;
  const base = path.join(ARCHIVE_DIR, 'data');
  const out = { likes: await countMp4(path.join(base, 'Likes', 'videos')), favorites: await countMp4(path.join(base, 'Favorites', 'videos')), following: 0 };
  try {
    for (const e of await fs.promises.readdir(path.join(base, 'Following'), { withFileTypes: true })) {
      if (e.isDirectory() && e.name !== 'Avatars') out.following += await countMp4(path.join(base, 'Following', e.name, 'videos'));
    }
  } catch (_) {}
  diskMemo = { at: Date.now(), out };
  return out;
}

// ── Account check ───────────────────────────────────────────────────────────
// Asks the address from the "profile link" setting whether a username still exists. A page that was
// removed answers 404/410, redirects to a /404 page or serves a page whose own data says the account doesn't exist; anything else that goes wrong (blocked, rate
// limited, offline) is "unknown", never "gone". Answers are cached so a tab is checked rarely.
const profileCache = new Map();    // name -> { state, at }
const profileBusy  = new Map();    // name -> Promise
const PROFILE_TTL  = { ok: 12 * 3600e3, gone: 12 * 3600e3, unknown: 30 * 60e3 };

function fetchStatus(target, hops) {
  return new Promise(resolve => {
    let u; try { u = new URL(target); } catch (_) { return resolve('unknown'); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return resolve('unknown');
    if (/(^|\/)404\/?$/.test(u.pathname)) return resolve('gone');
    const mod = u.protocol === 'https:' ? require('https') : http;
    const req = mod.get(u, { timeout: 8000, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; kashibox)', 'Accept': 'text/html' } }, r => {
      const code = r.statusCode || 0;
      if (code === 404 || code === 410) { r.resume(); return resolve('gone'); }
      if (code >= 300 && code < 400 && r.headers.location) {
        r.resume();
        if (hops >= 5) return resolve('unknown');
        return fetchStatus(new URL(r.headers.location, u).toString(), hops + 1).then(resolve);
      }
      if (code < 200 || code >= 300) { r.resume(); return resolve('unknown'); }
      // A missing account can still answer 200 with a "couldn't find this account" page. That sentence also sits in
      // the script text of normal pages, so look at the page's own status for the profile instead (10202 / 10221 = no such account).
      let body = '', done = false;
      const finish = state => { if (!done) { done = true; r.destroy(); resolve(state); } };
      r.setEncoding('utf8');
      r.on('data', c => {
        body += c;
        const m = /"webapp\.user-detail":\{"statusCode":(\d+)/.exec(body);
        if (m) return finish(m[1] === '10202' || m[1] === '10221' ? 'gone' : 'ok');
        if (body.length > 3e6) finish('ok');
      });
      r.on('end', () => finish('ok'));
      r.on('error', () => finish('unknown'));
    });
    req.on('timeout', () => { req.destroy(); resolve('unknown'); });
    req.on('error', () => resolve('unknown'));
  });
}

function checkProfile(name) {
  const hit = profileCache.get(name);
  if (hit && Date.now() - hit.at < PROFILE_TTL[hit.state]) return Promise.resolve(hit.state);
  if (profileBusy.has(name)) return profileBusy.get(name);
  const tpl = String(dbStars.loadSettings().profileUrl || '');
  const p = (tpl && /^https?:\/\//i.test(tpl) && tpl.includes('{username}')
    ? fetchStatus(tpl.split('{username}').join(encodeURIComponent(name)), 0) : Promise.resolve('unknown'))
    .then(state => { profileCache.set(name, { state, at: Date.now() }); profileBusy.delete(name); return state; });
  profileBusy.set(name, p);
  return p;
}

// ── Compression and caching for text responses ─────────────────────────────
// The page, its script and the bigger JSON replies are sent gzipped when the browser accepts it, and files that
// do not change between loads (the page, the script, the db files) carry an ETag so a repeat visit is a tiny 304.
const wantsGzip = req => /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));
const MIN_GZIP = 1024;

// A whole body at once (JSON replies). Never cached: only compressed.
function sendBody(req, res, code, headers, body) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  if (buf.length >= MIN_GZIP && wantsGzip(req)) {
    zlib.gzip(buf, { level: 5 }, (err, gz) => {
      if (err) { res.writeHead(code, Object.assign({}, headers, { 'Content-Length': buf.length })); res.end(buf); return; }
      res.writeHead(code, Object.assign({}, headers, { 'Content-Encoding': 'gzip', 'Vary': 'Accept-Encoding', 'Content-Length': gz.length }));
      res.end(gz);
    });
    return;
  }
  res.writeHead(code, Object.assign({}, headers, { 'Content-Length': buf.length }));
  res.end(buf);
}

// A file from the image (page, script): read and compressed once per change, answered from memory afterwards
const gzMemo = new Map();      // archive text file + version -> gzipped bytes
const staticMemo = new Map();   // file -> { mtimeMs, buf, gz, etag }
function sendStatic(req, res, file, type) {
  fs.stat(file, (err, st) => {
    if (err) { res.writeHead(500); res.end(path.basename(file) + ' missing'); return; }
    let m = staticMemo.get(file);
    const reply = () => {
      const headers = { 'Content-Type': type, 'Cache-Control': 'no-cache', 'ETag': m.etag, 'Vary': 'Accept-Encoding' };
      if (req.headers['if-none-match'] === m.etag) { res.writeHead(304, headers); res.end(); return; }
      const gz = wantsGzip(req);
      if (gz) headers['Content-Encoding'] = 'gzip';
      const body = gz ? m.gz : m.buf;
      headers['Content-Length'] = body.length;
      res.writeHead(200, headers);
      res.end(req.method === 'HEAD' ? undefined : body);
    };
    if (m && m.mtimeMs === st.mtimeMs) return reply();
    fs.readFile(file, (e2, buf) => {
      if (e2) { res.writeHead(500); res.end(path.basename(file) + ' missing'); return; }
      m = { mtimeMs: st.mtimeMs, buf, gz: zlib.gzipSync(buf, { level: 9 }), etag: 'W/"' + crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16) + '"' };
      staticMemo.set(file, m);
      reply();
    });
  });
}

// ── Server ──────────────────────────────────────────────────────────────────
// App icons (Home Screen shortcut), baked into the image next to server.js
const ICONS = {
  '/apple-touch-icon.png': ['kashibox-180.png', 'image/png'],
  '/kashibox-icon-512.png': ['kashibox-512.png', 'image/png'],
  '/kashibox-icon.svg': ['kashibox-icon.svg', 'image/svg+xml'],
  '/kashibox-logo.svg': ['kashibox-logo.svg', 'image/svg+xml'],
};

// kashibox's own page (shell.html) and its script, both served from the image rather than from the archive folder
const SHELL_FILE    = path.join(__dirname, 'shell.html');
const SCRIPT_FILE   = path.join(__dirname, 'starplayer.js');
const CAST_RCV_FILE = path.join(__dirname, 'cast-receiver.html');

http.createServer((req, res) => {
  const pathname = url.parse(req.url).pathname;

  if (ICONS[pathname] && (req.method === 'GET' || req.method === 'HEAD')) {
    try {
      const body = fs.readFileSync(path.join(__dirname, 'assets', ICONS[pathname][0]));
      res.writeHead(200, { 'Content-Type': ICONS[pathname][1], 'Cache-Control': 'public, max-age=86400', 'Content-Length': body.length });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch (_) { res.writeHead(404); res.end('Not found'); }
    return;
  }

  // ── Stars API ──────────────────────────────────────────────────────────────
  if (pathname === '/api/stars') {
    if (req.method === 'GET') {
      const data = dbStars.loadWithRev();
      sendBody(req, res, 200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, JSON.stringify(data));
      return;
    }
    if (req.method === 'PUT') {
      let chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString());
          let r;
          try {
            // Compare-and-swap: a save must name the revision it was based on (see db_stars.saveGuarded)
            r = dbStars.saveGuarded({ stars: data.stars || {}, groups: data.groups || [], levels: data.levels || {} }, data.rev);
          } catch (e) {
            // e.g. the file is not writable: say so instead of pretending the save worked (no paths in the response)
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end('{"error":"could not write stars.json"}');
            return;
          }
          const { code, ...rest } = r;
          res.writeHead(code, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(rest));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end('{"error":"Invalid JSON"}');
        }
      });
      return;
    }
    res.writeHead(405); res.end('Method not allowed'); return;
  }

  // ── Account check (does this username still exist?) ───────────────────────
  if (pathname === '/api/profile-check' && req.method === 'GET') {
    const name = String(new URLSearchParams(url.parse(req.url).query || '').get('name') || '');
    const send = (code, obj) => { const b = JSON.stringify(obj); res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(b) }); res.end(b); };
    if (!/^[\w.\-]{1,64}$/.test(name)) return send(400, { error: 'bad name' });
    checkProfile(name).then(state => send(200, { state }));
    return;
  }

  // ── Files on disk (counts only), to compare with what the database lists ──
  if (pathname === '/api/archive/disk' && req.method === 'GET') {
    diskCounts().then(out => {
      const b = JSON.stringify(out);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(b) });
      res.end(b);
    });
    return;
  }

  // ── ttpull live log (proxy) ────────────────────────────────────────────────
  // ttpull keeps its last log lines in memory (GET /logs) and exposes /status. The browser can't
  // reach it directly (other port, possibly HTTPS here), so the log tab polls this proxy.
  if (pathname === '/api/ttpull/logs' && req.method === 'GET') {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 4000);
    Promise.all([
      fetch(TTPULL_URL + '/logs',   { signal: ctl.signal }).then(r => { if (!r.ok) throw new Error('logs ' + r.status); return r.text(); }),
      fetch(TTPULL_URL + '/status', { signal: ctl.signal }).then(r => r.ok ? r.json() : null).catch(() => null),
    ]).then(([text, status]) => {
      const lines = text.split('\n').filter(Boolean);
      const body = JSON.stringify({
        ok: true, lines,
        status: status && { running: !!status.running, phase: status.phase || null, hasSession: !!status.hasSession },
      });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(body);
    }).catch(e => {
      const reason = e.name === 'AbortError' ? 'timed out' : (e.cause && e.cause.code) || e.message;
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ok: false, error: `ttpull unreachable at ${TTPULL_URL} (${reason})` }));
    }).finally(() => clearTimeout(timer));
    return;
  }

  // ttpull's view of the archive (counts only): used for the empty-archive message and the "last updated" line
  if (pathname === '/api/ttpull/archive-status' && req.method === 'GET') {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 4000);
    fetch(TTPULL_URL + '/archive/status', { signal: ctl.signal })
      .then(r => { if (!r.ok) throw new Error('status ' + r.status); return r.json(); })
      .then(st => {
        const body = JSON.stringify({ ok: true, status: {
          initialized: Boolean(st && st.initialized),
          lastWrite: (st && typeof st.lastWrite === 'string') ? st.lastWrite : null,
        } });
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(body);
      })
      .catch(() => {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ ok: false }));
      })
      .finally(() => clearTimeout(timer));
    return;
  }

  // ── autotagTT review API ───────────────────────────────────────────────────
  // GET  /api/autotag?tag=braces                      → pending suggestions + recorded decisions
  // POST /api/autotag/feedback {tag,id,decision,change?} → records one explicit decision
  // Never edits groups. Like every other endpoint here it has no login of its own (the server is
  // meant to sit behind the LAN/reverse proxy); state-changing calls additionally have to be
  // same-origin JSON so another website can't drive them from the user's browser.
  if (pathname === '/api/autotag' && req.method === 'GET') {
    const tag = String(new URLSearchParams(url.parse(req.url).query || '').get('tag') || 'braces').toLowerCase();
    const out = dbStars.loadAutotag(tag);
    sendBody(req, res, out.error ? 400 : 200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, JSON.stringify(out));
    return;
  }
  if (pathname === '/api/autotag/ai' && req.method === 'GET') {
    sendBody(req, res, 200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, JSON.stringify(dbStars.loadAiTags()));
    return;
  }
  if (pathname === '/api/autotag/run' && req.method === 'GET') {
    const body = JSON.stringify(dbStars.runStatus());
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
    return;
  }
  if (pathname === '/api/autotag/tags' && req.method === 'GET') {
    const body = JSON.stringify(dbStars.loadTagsConfig());
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
    return;
  }
  if (pathname === '/api/autotag/feedback' || pathname === '/api/autotag/tags' || pathname === '/api/autotag/run' || pathname === '/api/autotag/schedule' || pathname === '/api/autotag/notify-test' || pathname === '/api/autotag/frames') {
    if (req.method !== 'POST') { res.writeHead(405); res.end('Method not allowed'); return; }
    const sendJson = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    const origin = req.headers['origin'];
    let sameOrigin = true;
    if (origin) { try { sameOrigin = new URL(origin).host === req.headers['host']; } catch (_) { sameOrigin = false; } }
    if (!sameOrigin) return sendJson(403, { error: 'cross-origin request refused' });
    if (!/^application\/json/i.test(req.headers['content-type'] || '')) return sendJson(415, { error: 'JSON required' });
    const isTags = pathname === '/api/autotag/tags';
    const max = isTags ? 16384 : 4096;
    const which = pathname.slice('/api/autotag/'.length);
    let size = 0, chunks = [], tooBig = false;
    req.on('data', c => { size += c.length; if (size > max) tooBig = true; else chunks.push(c); });
    req.on('end', () => {
      if (tooBig) return sendJson(413, { error: 'body too large' });
      let d;
      try { d = JSON.parse(Buffer.concat(chunks).toString()); } catch (_) { return sendJson(400, { error: 'Invalid JSON' }); }
      if (!d || typeof d !== 'object' || Array.isArray(d)) return sendJson(400, { error: 'Invalid JSON' });
      let r;
      try {
        r = which === 'run' ? dbStars.requestRun()
          : which === 'notify-test' ? dbStars.requestNotifyTest()
          : which === 'frames' ? dbStars.saveFramesConfig(d)
          : which === 'schedule' ? dbStars.saveSchedule(d)
          : isTags
          ? dbStars.saveTagsConfig(d.enabled)
          : dbStars.recordFeedback(
              typeof d.tag === 'string' ? d.tag.toLowerCase() : '',
              typeof d.id === 'string' ? d.id : '',
              d.decision, d.change === true);
      } catch (_) { r = { code: 500, error: 'could not save' }; }  // no paths or details in the response
      const { code, ...rest } = r;
      sendJson(code, rest);
    });
    return;
  }

  // ── Watch statistics (feed ranking) ────────────────────────────────────────
  if (pathname === '/api/watch') {
    if (req.method === 'GET') {
      const body = JSON.stringify({ watch: dbStars.loadWatch() });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) });
      res.end(body);
      return;
    }
    if (req.method === 'POST' || req.method === 'PUT') {   // POST is what navigator.sendBeacon uses
      let chunks = [], size = 0;
      req.on('data', c => { size += c.length; if (size <= 2e6) chunks.push(c); });
      req.on('end', () => {
        try {
          if (size > 2e6) throw new Error('too large');
          const data = JSON.parse(Buffer.concat(chunks).toString());
          const n = dbStars.mergeWatch(data.delta);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, updated: n }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end('{"error":"Invalid request"}');
        }
      });
      return;
    }
    res.writeHead(405); res.end('Method not allowed'); return;
  }

  // ── Tab sessions API ───────────────────────────────────────────────────────
  if (pathname === '/api/sessions') {
    if (req.method === 'GET') {
      const body = JSON.stringify({ sessions: dbStars.loadSessions() });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
      res.end(body);
      return;
    }
    if (req.method === 'PUT') {
      let chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString());
          dbStars.saveSessions(Array.isArray(data.sessions) ? data.sessions : []);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{"ok":true}');
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end('{"error":"Invalid JSON"}');
        }
      });
      return;
    }
    res.writeHead(405); res.end('Method not allowed'); return;
  }

  // ── Settings API ───────────────────────────────────────────────────────────
  if (pathname === '/api/settings') {
    if (req.method === 'GET') {
      const body = JSON.stringify({ settings: dbStars.loadSettings() });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) });
      res.end(body);
      return;
    }
    if (req.method === 'PUT') {
      let chunks = [], size = 0;
      req.on('data', c => { size += c.length; if (size < 20000) chunks.push(c); });
      req.on('end', () => {
        try {
          if (size >= 20000) throw new Error('too large');
          const data = JSON.parse(Buffer.concat(chunks).toString());
          const saved = dbStars.saveSettings(data.settings);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, settings: saved }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid settings' }));
        }
      });
      return;
    }
    res.writeHead(405); res.end('Method not allowed'); return;
  }

  if (pathname === '/' || pathname === '/index.html' || pathname === '/shell') {
    sendStatic(req, res, SHELL_FILE, 'text/html; charset=utf-8');
    return;
  }

  if (pathname === '/cast') {
    sendStatic(req, res, CAST_RCV_FILE, 'text/html; charset=utf-8');
    return;
  }

  if (pathname === '/starplayer.js') {
    sendStatic(req, res, SCRIPT_FILE, 'application/javascript');
    return;
  }

  const filePath = path.join(ARCHIVE_DIR, pathname);

  // Basic path traversal guard
  if (!filePath.startsWith(path.resolve(ARCHIVE_DIR))) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  const ext  = path.extname(filePath).toLowerCase();
  const mime = MIME[ext] || 'application/octet-stream';

  // Archive files: stream with range request support (required for video)
  fs.stat(filePath, (err, stat) => {
    if (err) {
      res.writeHead(err.code === 'ENOENT' ? 404 : 500);
      res.end(err.code === 'ENOENT' ? 'Not found' : 'Server error');
      return;
    }

    const total = stat.size;
    // Videos and covers never change once downloaded, so let the phone keep them: a looping video then does not
    // go back to the server on every round. Everything else (the db files, scripts) is revalidated each time.
    const cacheable = /\.(mp4|jpe?g|png|webp|gif)$/i.test(filePath) && !filePath.includes('.appdata');
    const etag = `W/"${total}-${Math.floor(stat.mtimeMs)}"`;
    const base = {
      'Accept-Ranges': 'bytes',
      'Content-Type':  mime,
      'Last-Modified': stat.mtime.toUTCString(),
      'ETag':          etag,
      'Cache-Control': cacheable ? 'public, max-age=604800' : 'no-cache',
    };
    const range = req.headers['range'];

    if (!range && req.headers['if-none-match'] === etag) { res.writeHead(304, base); res.end(); return; }

    // Stream a file section; when the client drops the request (a phone seeks, a video loops) close the file too
    const send = (opts) => {
      if (req.method === 'HEAD') { res.end(); return; }
      const stream = fs.createReadStream(filePath, opts);
      stream.on('error', () => res.destroy());
      res.on('close', () => stream.destroy());
      stream.pipe(res);
    };

    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      let start = 0, end = total - 1, ok = Boolean(m) && total > 0;
      if (ok) {
        if (m[1] === '') { start = Math.max(0, total - parseInt(m[2] || '0', 10)); }
        else { start = parseInt(m[1], 10); if (m[2]) end = Math.min(parseInt(m[2], 10), total - 1); }
        ok = start <= end && start < total;
      }
      if (!ok) { res.writeHead(416, { 'Content-Range': `bytes */${total}` }); res.end(); return; }
      res.writeHead(206, Object.assign({}, base, { 'Content-Range': `bytes ${start}-${end}/${total}`, 'Content-Length': end - start + 1 }));
      send({ start, end });
    } else if (/\.(js|json|html)$/i.test(filePath) && total >= MIN_GZIP && wantsGzip(req) && req.method !== 'HEAD') {
      // text from the archive (the db files): compress once per change and keep it, up to a few files
      const key = filePath + '|' + etag;
      let gz = gzMemo.get(key);
      const out = body => {
        res.writeHead(200, Object.assign({}, base, { 'Content-Encoding': 'gzip', 'Vary': 'Accept-Encoding', 'Content-Length': body.length }));
        res.end(body);
      };
      if (gz) return out(gz);
      fs.readFile(filePath, (e2, buf) => {
        if (e2) { res.writeHead(500); res.end('Server error'); return; }
        zlib.gzip(buf, { level: 6 }, (e3, z) => {
          if (e3) { res.writeHead(200, Object.assign({}, base, { 'Content-Length': buf.length })); res.end(buf); return; }
          if (gzMemo.size >= 12) gzMemo.delete(gzMemo.keys().next().value);
          gzMemo.set(key, z);
          out(z);
        });
      });
    } else {
      res.writeHead(200, Object.assign({}, base, { 'Content-Length': total }));
      send(undefined);
    }
  });
}).listen(PORT, () => console.log(`[starplayer] listening on http://localhost:${PORT}`));
