(function () {
  'use strict';


  // ═══════════════════════════════════════════════════════════════════════════
  // PERSISTENCE  (server-first with localStorage fallback)
  // ═══════════════════════════════════════════════════════════════════════════

  const STARS_KEY  = 'kashibox_stars_v1';
  const GROUPS_KEY = 'kashibox_groups_v1';
  const LEVELS_KEY = 'kashibox_levels_v1';
  const OLD_KEY    = 'kashibox_favorites_v1';

  // Browsers that saved data under the earlier names keep it: move it over once, then drop the old names
  (function migrateStorageNames() {
    try {
      [['myfavett_stars_v1', STARS_KEY], ['myfavett_groups_v1', GROUPS_KEY], ['myfavett_levels_v1', LEVELS_KEY], ['myfavett_favorites_v1', OLD_KEY]].forEach(([from, to]) => {
        const v = localStorage.getItem(from);
        if (v === null) return;
        if (localStorage.getItem(to) === null) localStorage.setItem(to, v);
        localStorage.removeItem(from);
      });
    } catch (_) {}
  })();

  let serverAvailable = false;
  let _syncTimer      = null;

  function loadStarsLocal() {
    try {
      const v = localStorage.getItem(STARS_KEY);
      if (v) return JSON.parse(v);
      const old = localStorage.getItem(OLD_KEY);
      if (old) {
        const d = JSON.parse(old);
        localStorage.setItem(STARS_KEY, JSON.stringify(d));
        localStorage.removeItem(OLD_KEY);
        return d;
      }
    } catch (_) {}
    return {};
  }

  function loadGroupsLocal()  {
    try { return JSON.parse(localStorage.getItem(GROUPS_KEY) || '[]'); }
    catch (_) { return []; }
  }

  function loadLevelsLocal() {
    try { return JSON.parse(localStorage.getItem(LEVELS_KEY) || '{}'); }
    catch (_) { return {}; }
  }

  function saveStarsLocal()  { try { localStorage.setItem(STARS_KEY,  JSON.stringify(stars));  } catch (_) {} }
  function saveGroupsLocal() { try { localStorage.setItem(GROUPS_KEY, JSON.stringify(groups)); } catch (_) {} }
  function saveLevelsLocal() { try { localStorage.setItem(LEVELS_KEY, JSON.stringify(levels)); } catch (_) {} }

  // ── Saving to the server without ever overwriting newer changes ─────────────────────────────────────
  // The server gives every version of stars.json a revision and refuses a save that was based on an older one. When that
  // happens the browser fetches the latest, merges (three-way: what this window last saw, what it has now, what the
  // server has now) and saves the merge. Additions made in any window survive; removals made here stay removed.
  let serverRev = null;      // revision this window's data is based on
  let baseSnap  = null;      // JSON of {stars, groups, levels} as last known to be on the server
  let _pushing  = false;
  let _pushAgain = false;
  let _dirty    = false;     // local changes not yet confirmed saved

  function stateSnap() { return JSON.stringify({ stars, groups, levels }); }

  // Pure function (also embedded into pop-out windows via toString, so it must not use anything outside itself).
  function merge3(base, local, theirs) {
    function jstr(x) { return JSON.stringify(x); }
    function mergeIds(b, l, t) {
      var bs = new Set(b || []), ls = new Set(l || []), out = (t || []).slice(), seen = new Set(out);
      (l || []).forEach(function (x) { if (!bs.has(x) && !seen.has(x)) { out.push(x); seen.add(x); } });   // added here
      return out.filter(function (x) { return !(bs.has(x) && !ls.has(x)); });                            // removed here
    }
    function mergeMap(b, l, t) {
      var out = {}, k;
      b = b || {}; l = l || {}; t = t || {};
      for (k in t) out[k] = t[k];
      for (k in l) { if (!(k in b) || jstr(l[k]) !== jstr(b[k])) out[k] = l[k]; }   // added or changed here
      for (k in b) { if (!(k in l)) delete out[k]; }                                  // removed here
      return out;
    }
    function byId(arr) { var m = {}; (arr || []).forEach(function (g) { m[g.id] = g; }); return m; }
    var bg = byId(base.groups), lg = byId(local.groups), tg = byId(theirs.groups), groups = [];
    (theirs.groups || []).forEach(function (t) {
      var l = lg[t.id], b = bg[t.id];
      if (!l) { if (!b) groups.push(t); return; }                  // not here: created elsewhere (keep) or deleted here (drop)
      groups.push({ id: t.id, name: b && l.name !== b.name ? l.name : t.name, videoIds: mergeIds(b && b.videoIds, l.videoIds, t.videoIds) });
    });
    (local.groups || []).forEach(function (l) { if (!tg[l.id] && !bg[l.id]) groups.push(l); });   // created here
    return { stars: mergeMap(base.stars, local.stars, theirs.stars), groups: groups, levels: mergeMap(base.levels, local.levels, theirs.levels) };
  }

  let _noteEl = null;
  function showSyncNote(text, warn) {
    if (!document.body) return;
    if (!_noteEl) {
      _noteEl = document.createElement('div');
      _noteEl.id = 'sp-sync-note';
      _noteEl.addEventListener('click', () => { _noteEl.style.display = 'none'; });
      document.body.appendChild(_noteEl);
    }
    _noteEl.textContent = text;
    _noteEl.className = warn ? 'warn' : '';
    _noteEl.style.display = 'block';
    clearTimeout(_noteEl._t);
    if (!warn) _noteEl._t = setTimeout(() => { _noteEl.style.display = 'none'; }, 5000);
  }
  function clearSaveWarning() { if (_noteEl && _noteEl.className === 'warn') _noteEl.style.display = 'none'; }

  function applyServerState(m, rev, serverData) {
    stars = m.stars; groups = m.groups; levels = m.levels;
    saveStarsLocal(); saveGroupsLocal(); saveLevelsLocal();
    serverRev = rev;
    baseSnap = JSON.stringify({ stars: serverData.stars || {}, groups: serverData.groups || [], levels: serverData.levels || {} });
    if (starsTabActive) renderStarsView();
    if (typeof autotagTabActive !== 'undefined' && autotagTabActive) renderAutotagView();
  }

  async function reconcile() {
    try {
      const r = await fetch('/api/stars', { cache: 'no-store' });
      if (!r.ok) return false;
      const d = await r.json();
      const base = baseSnap ? JSON.parse(baseSnap) : { stars: {}, groups: [], levels: {} };
      const m = merge3(base, { stars, groups, levels }, { stars: d.stars || {}, groups: d.groups || [], levels: d.levels || {} });
      applyServerState(m, d.rev, d);
      showSyncNote('Your tags were updated in another window. Merged, nothing lost.');
      return true;
    } catch (_) { return false; }
  }

  async function pushState() {
    if (!serverAvailable) return;
    if (_pushing) { _pushAgain = true; return; }
    _pushing = true;
    try {
      for (let attempt = 0; attempt < 4; attempt++) {
        let r;
        try {
          r = await fetch('/api/stars', {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ stars, groups, levels, rev: serverRev }),
          });
        } catch (_) { showSyncNote('Cannot reach the server. Your changes are kept in this tab and will be retried.', true); return; }
        if (r.ok) {
          const d = await r.json();
          serverRev = d.rev; baseSnap = stateSnap(); _dirty = false; clearSaveWarning();
          return;
        }
        if (r.status === 409 || r.status === 428) { if (!(await reconcile())) break; continue; }   // out of date: merge, then save the merge
        showSyncNote('The server could not save your changes (error ' + r.status + '). They are kept in this tab only: check the server\'s file permissions.', true);
        return;
      }
      showSyncNote('Could not save: the server keeps changing. Reload this page.', true);
    } finally {
      _pushing = false;
      if (_pushAgain) { _pushAgain = false; syncToServer(); }
    }
  }

  function syncToServer() {
    if (!serverAvailable) return;
    _dirty = true;
    clearTimeout(_syncTimer);
    _syncTimer = setTimeout(pushState, 300);
  }

  // Coming back to this window: pick up changes made elsewhere before the user acts on a stale view
  async function refreshFromServer() {
    if (!serverAvailable || _pushing || _dirty || document.hidden) return;
    try {
      const r = await fetch('/api/stars', { cache: 'no-store' });
      if (!r.ok) return;
      const d = await r.json();
      if (d.rev === serverRev || _dirty || _pushing) return;
      const base = baseSnap ? JSON.parse(baseSnap) : { stars: {}, groups: [], levels: {} };
      applyServerState(merge3(base, { stars, groups, levels }, { stars: d.stars || {}, groups: d.groups || [], levels: d.levels || {} }), d.rev, d);
    } catch (_) {}
  }
  window.addEventListener('focus', refreshFromServer);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshFromServer(); });

  function saveStars()  { saveStarsLocal();  syncToServer(); refreshToolButtons(); }
  function saveGroups() { saveGroupsLocal(); syncToServer(); refreshToolButtons(); }
  function saveLevels() { saveLevelsLocal(); syncToServer(); refreshToolButtons(); }

  let stars  = loadStarsLocal();
  let groups = loadGroupsLocal();
  let levels = loadLevelsLocal();

  // Migrate levels that were stored inside star objects (old format)
  Object.entries(stars).forEach(([id, s]) => {
    if (s.level != null && levels[id] == null) { levels[id] = s.level; }
  });
  saveLevelsLocal();

  // Attempt to load from server (async, upgrades data on success)
  (function initServerSync() {
    fetch('/api/stars').then(r => {
      if (!r.ok) throw new Error(r.status);
      return r.json();
    }).then(data => {
      serverAvailable = true;
      serverRev = data.rev || null;
      baseSnap = JSON.stringify({ stars: data.stars || {}, groups: data.groups || [], levels: data.levels || {} });
      stars  = data.stars  || {};
      groups = data.groups || [];
      levels = data.levels || {};
      Object.entries(stars).forEach(([id, s]) => {
        if (s.level != null && levels[id] == null) { levels[id] = s.level; }
      });
      saveStarsLocal();
      saveGroupsLocal();
      saveLevelsLocal();
      if (starsTabActive) renderStarsView();
    }).catch(() => { /* no server — localStorage is fine */ });
  })();

  // Listen for changes broadcast from pop-out windows
  (() => {
    try {
      const ch = new BroadcastChannel('kashibox_popout');
      ch.onmessage = e => {
        const { s, g, l, base, openAuthor } = e.data || {};
        if (openAuthor) { openAuthorByName(openAuthor); try { window.focus(); } catch (_) {} }
        // A pop-out window sends its whole copy plus the copy it started from: merge only what it changed.
        // (Messages without a base come from an old pop-out and are ignored, so they cannot overwrite anything.)
        if (base && (s || g || l)) {
          const m = merge3(base, { stars: s || base.stars, groups: g || base.groups, levels: l || base.levels }, { stars, groups, levels });
          stars = m.stars; groups = m.groups; levels = m.levels;
          saveStarsLocal(); saveGroupsLocal(); saveLevelsLocal();
          refreshToolButtons();
          syncToServer();
        }
        if (starsTabActive) renderStarsView();
      };
    } catch (_) {}
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  // HELPERS
  // ═══════════════════════════════════════════════════════════════════════════

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2);
  }

  // Toggle a video in/out of a named group (creates the group if it doesn't exist).
  // Returns true if the video is now IN the group.
  function toggleQuickGroup(videoId, groupName) {
    let g = groups.find(x => x.name === groupName);
    if (!g) { g = { id: uid(), name: groupName, videoIds: [] }; groups.push(g); }
    const idx = g.videoIds.indexOf(videoId);
    if (idx === -1) { g.videoIds.push(videoId); } else { g.videoIds.splice(idx, 1); }
    saveGroups();
    if (starsTabActive) renderStarsView();
    return g.videoIds.includes(videoId);
  }

  function inQuickGroup(videoId, groupName) {
    const g = groups.find(x => x.name === groupName);
    return g ? g.videoIds.includes(videoId) : false;
  }

  // ── "braces" tag: membership in the user's existing group named "braces" ──
  const BRACES_SVG = size =>
    `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round">` +
    '<rect x="2" y="6" width="20" height="12" rx="5"/><path d="M7 6v12M12 6v12M17 6v12"/><path d="M2 12h20" stroke-width="1.3"/>' +
    '<g fill="currentColor" stroke="none"><rect x="3.4" y="10.9" width="2.2" height="2.2" rx=".5"/><rect x="8.4" y="10.9" width="2.2" height="2.2" rx=".5"/>' +
    '<rect x="13.4" y="10.9" width="2.2" height="2.2" rx=".5"/><rect x="18.4" y="10.9" width="2.2" height="2.2" rx=".5"/></g></svg>';

  function findBracesGroup() {
    return groups.find(g => String(g.name).trim().toLowerCase() === 'braces');
  }

  function inBraces(videoId) {
    const g = findBracesGroup();
    return g ? g.videoIds.includes(videoId) : false;
  }

  // Toggles the video in the braces group (the group is created only if it doesn't exist yet)
  function toggleBraces(videoId) {
    const g = findBracesGroup();
    return toggleQuickGroup(videoId, g ? g.name : 'braces');
  }

  // A braces button. Its video id lives in data-vid so one button can follow a changing video.
  function makeBracesBtn(className, videoId, iconSize) {
    const b = document.createElement('button');
    b.className = className + ' braces-btn';
    b.innerHTML = BRACES_SVG(iconSize);
    if (videoId) b.dataset.vid = videoId;
    b._refresh = () => {
      const on = inBraces(b.dataset.vid);
      b.classList.toggle('braces-on', on);
      b.title = on ? 'Remove from braces' : 'Add to braces';
    };
    b._refresh();
    b.addEventListener('click', e => {
      e.stopPropagation();
      e.preventDefault();
      if (b.dataset.vid) toggleBraces(b.dataset.vid);
    });
    return b;
  }

  function refreshToolButtons() {
    document.querySelectorAll('.braces-btn, .thumb-tool').forEach(b => b._refresh && b._refresh());
  }

  // Right-center tool stack on a thumbnail (username page + stars grid): star, braces, group picker, level
  function buildThumbTools(videoId, coverSrc, authorName, desc) {
    const wrap = document.createElement('div');
    wrap.className = 'thumb-tools';
    const mk = cls => {
      const b = document.createElement('button');
      b.className = 'thumb-tool ' + cls;
      return b;
    };

    const star = mk('thumb-star');
    star._refresh = () => paintStarBtn(star, videoId, true);
    star._refresh();
    starGesture(star,
      () => { toggleStar(videoId, coverSrc, authorName, desc); star._refresh(); },
      () => { toggleSuperStar(videoId, coverSrc, authorName, desc); star._refresh(); });

    const braces = makeBracesBtn('thumb-tool', videoId, 16);

    const grp = mk('thumb-grp');
    grp.textContent = '⊕';
    grp.title = 'Add to group';
    grp.addEventListener('click', e => { e.stopPropagation(); showGroupPicker(grp, videoId); });

    const lvl = mk('thumb-lvl');
    lvl._refresh = () => {
      const n = levels[videoId];
      lvl.textContent = n != null ? String(n) : 'lvl';
      lvl.title = n != null ? 'Level ' + n : 'Set level';
      lvl.classList.toggle('on', n != null);
    };
    lvl._refresh();
    lvl.addEventListener('click', e => {
      e.stopPropagation();
      showLevelPicker(lvl, videoId, () => {
        lvl._refresh();
        if (starsTabActive) renderStarsView();
      });
    });

    wrap.append(star, braces, grp, lvl);
    return wrap;
  }

  function getVideoIdFromSrc(src) {
    const m = src && src.match(/covers\/(\d+)\.jpg/);
    return m ? m[1] : null;
  }

  function getVideoPath(coverSrc) {
    return coverSrc.replace('/covers/', '/videos/').replace(/\.jpg$/, '.mp4');
  }

  // The archive database (db_*.js) is read straight from the files, once, and kept here.
  let _dbCache = null, _dbLoading = false, _dbFailed = false;

  async function loadArchiveDb() {
    // required: needed for names/descriptions; optional: only used to locate an author's files
    const files = [
      ['videos', 'db_videos.js', true], ['authors', 'db_authors.js', true],
      ['videoDescriptions', 'db_texts.js', true],
      ['likes', 'db_likes.js', false], ['bookmarked', 'db_bookmarked.js', false],
      ['following', 'db_following.js', false],
    ];
    const out = {};
    for (const [key, file, required] of files) {
      try {
        out[key] = await readDbFile(file);
      } catch (e) {
        if (required) throw e;
        console.warn('[starplayer] optional db file unavailable:', file, e);
      }
    }
    if (out.likes && out.likes.likes) out.likes = out.likes.likes;
    return out;
  }

  async function readDbFile(file) {
    const text = await (await fetch('data/.appdata/' + file)).text();
    const b64 = text.match(/_base64\s*=\s*"([^"]+)"/);
    let json;
    if (b64) {
      const bin = Uint8Array.from(atob(b64[1]), c => c.charCodeAt(0));
      const stream = new Blob([bin]).stream().pipeThrough(new DecompressionStream('gzip'));
      json = await new Response(stream).text();
    } else {
      const raw = text.match(/String\.raw`([\s\S]*)`/);
      if (!raw) throw new Error('unrecognised format: ' + file);
      json = raw[1].replace(/背𓄹剃/g, '`').replace(/⑀⦃/g, '${');
    }
    return JSON.parse(json);
  }

  let _dbPromise = null;
  function archiveDbPromise() {
    if (!_dbPromise) {
      _dbLoading = true;
      _dbPromise = loadArchiveDb()
        .then(d => {
          _dbCache = d;
          if (starsTabActive) renderStarsView();
          if (autotagTabActive) renderAutotagView();
          return d;
        })
        .catch(e => { _dbFailed = true; console.warn('[starplayer] archive db load failed', e); throw e; })
        .finally(() => { _dbLoading = false; });
    }
    return _dbPromise;
  }

  function ensureArchiveDb() {
    if (_dbCache || _dbLoading || _dbFailed) return;
    archiveDbPromise().catch(() => {});
  }

  function getVideoInfo(videoId) {
    const id = String(videoId);
    const data = _dbCache;
    if (!data) { ensureArchiveDb(); return { desc: '', authorName: '' }; }

    const desc = (data.videoDescriptions[id] || data.videoDescriptions[videoId]) || '';
    const v    = data.videos[id] || data.videos[videoId];
    const a    = v && data.authors && data.authors[v.authorId];
    const authorName = (a && a.uniqueIds && a.uniqueIds[0]) || '';
    return { desc, authorName };
  }

  // Resolve a username to its author id (authors can have several past usernames)
  function authorIdForName(name) {
    const d = _dbCache;
    if (!d || !name) return null;
    const n = String(name).toLowerCase();
    for (const [id, a] of Object.entries(d.authors)) {
      if ((a.uniqueIds || []).some(u => String(u).toLowerCase() === n)) return id;
    }
    return null;
  }

  // Which folder holds a video's files: Likes, Favorites or Following/<author>? Falls back to Likes.
  let _dirIndex = null;
  function videoDirFor(id) {
    const d = _dbCache;
    if (!d) return 'Likes';
    if (!_dirIndex || _dirIndex.src !== d) {
      const idx = {
        src: d,
        likes: new Set((d.likes && d.likes.downloaded) || []),
        marks: new Set((d.bookmarked && d.bookmarked.downloaded) || []),
        following: new Map(),
      };
      Object.entries((d.following && d.following.authorItems) || {}).forEach(([aid, it]) => {
        [...(it.inFolder || []), ...(it.disappeared || [])].forEach(v => idx.following.set(v, aid));
      });
      _dirIndex = idx;
    }
    if (_dirIndex.likes.has(id)) return 'Likes';
    if (_dirIndex.marks.has(id)) return 'Favorites';
    if (_dirIndex.following.has(id)) return 'Following/' + _dirIndex.following.get(id);
    return 'Likes';
  }

  function coverSrcFor(id) { return `data/${videoDirFor(id)}/covers/${id}.jpg`; }

  // Videos that are in the archive but gone from the official lists, newest download first.
  // A video counts as disappeared when it is downloaded but not in the official list.
  let _disappearedCache = null;
  function disappearedIds() {
    const d = _dbCache;
    if (!d) return [];
    if (_disappearedCache && _disappearedCache.src === d) return _disappearedCache.ids;
    const known = id => { const v = d.videos[id]; return Boolean(v && d.authors[v.authorId]); };
    const out = [];
    const seen = new Set();
    const add = id => { if (!seen.has(id) && known(id)) { seen.add(id); out.push(id); } };
    // Without an official list every download would look "disappeared", so skip a missing or empty one
    const gone = src => {
      const official = src && src.officialList;
      if (!Array.isArray(official) || !official.length) return [];
      const set = new Set(official);
      return [...(src.downloaded || [])].filter(id => !set.has(id)).reverse();
    };
    gone(d.likes).forEach(add);
    gone(d.bookmarked).forEach(add);
    Object.values((d.following && d.following.authorItems) || {}).forEach(it => (it.disappeared || []).forEach(add));
    _disappearedCache = { src: d, ids: out };
    return out;
  }

  // Every downloaded video by this author, newest first, with the folder it lives in
  function authorVideos(authorId) {
    const d = _dbCache;
    if (!d) return [];
    const likes = new Set((d.likes && d.likes.downloaded) || []);
    const marks = new Set((d.bookmarked && d.bookmarked.downloaded) || []);
    const fi    = d.following && d.following.authorItems && d.following.authorItems[authorId];
    const fol   = new Set([...((fi && fi.inFolder) || []), ...((fi && fi.disappeared) || [])]);
    const a     = d.authors[authorId];
    const name  = (a && a.uniqueIds && a.uniqueIds[0]) || '';
    const out = [];
    for (const [id, v] of Object.entries(d.videos)) {
      if (v.authorId !== authorId) continue;
      const dir = likes.has(id) ? 'Likes' : marks.has(id) ? 'Favorites' : fol.has(id) ? `Following/${authorId}` : null;
      if (!dir) continue;
      out.push({
        id, authorName: name, desc: d.videoDescriptions[id] || '', createTime: v.createTime || 0,
        coverSrc: `data/${dir}/covers/${id}.jpg`, videoPath: `data/${dir}/videos/${id}.mp4`,
      });
    }
    return out.sort((x, y) => y.createTime - x.createTime);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // TOGGLE STAR
  // ═══════════════════════════════════════════════════════════════════════════

  // ── Super stars ────────────────────────────────────────────────────────────
  // A star can be upgraded to a super star (stars[id].super = true): shown as a blue sparkle star, collected in its own
  // Stars category, and its creator is lifted to the top of the Following page. Long-press a star to flip it.
  const SUPER_STAR_SVG = (size) =>
    '<svg viewBox="0 0 24 24"' + (size ? ' width="' + size + '" height="' + size + '"' : '') + ' aria-hidden="true">' +
    '<path fill="#4fc3f7" d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>' +
    '<path fill="#e6f7ff" d="M20 .6l.8 2L22.8 3.4l-2 .8L20 6.2l-.8-2-2-.8 2-.8z"/>' +
    '<path fill="#e6f7ff" d="M4.3 14.8l.6 1.5 1.5.6-1.5.6-.6 1.5-.6-1.5-1.5-.6 1.5-.6z"/></svg>';
  const isSuperStar = id => Boolean(stars[id] && stars[id].super);

  // Tap and long-press on a star button: the tap does onTap, holding for about half a second does onHold
  function starGesture(btn, onTap, onHold) {
    let timer = null, held = false, sx = 0, sy = 0;
    // Touch and pointer events both start the hold (whichever arrives first wins). A pointercancel does not end it:
    // iOS can send one in the middle of a long press even though the finger is still down; touchend/touchcancel end it.
    const start = (x, y) => {
      if (timer) return;
      held = false; sx = x; sy = y;
      timer = setTimeout(() => { timer = null; held = true; try { navigator.vibrate && navigator.vibrate(15); } catch (_) {} onHold(); }, 450);
    };
    const cancel = () => { clearTimeout(timer); timer = null; };
    btn.addEventListener('pointerdown', e => start(e.clientX, e.clientY));
    btn.addEventListener('touchstart', e => { const t = e.touches[0]; start(t.clientX, t.clientY); }, { passive: true });
    btn.addEventListener('touchmove', e => { const t = e.touches[0]; if (Math.hypot(t.clientX - sx, t.clientY - sy) > 16) cancel(); }, { passive: true });
    ['pointerup', 'touchend', 'touchcancel', 'mouseleave'].forEach(t => btn.addEventListener(t, cancel, { passive: true }));
    btn.addEventListener('click', e => { e.stopPropagation(); if (held) { held = false; return; } onTap(e); });
    btn.addEventListener('contextmenu', e => e.preventDefault());
  }

  function toggleSuperStar(videoId, coverSrc, authorName, desc) {
    if (!stars[videoId]) toggleStar(videoId, coverSrc, authorName, desc);   // a super star is always a star too
    const st = stars[videoId];
    if (!st) return false;
    if (st.super) delete st.super; else st.super = true;
    saveStars();
    afterStarChange();
    return Boolean(st.super);
  }

  function afterStarChange() {
    refreshToolButtons();
    if (starsTabActive) renderStarsView();
    if (listTabKind === 'following') renderListView();   // the highlighted accounts may have changed
  }

  // Show the right glyph and colour on a star button: plain (hollow/filled), gold when starred, blue sparkle when super
  function paintStarBtn(btn, id, hollowWhenOff) {
    const st = stars[id], sup = Boolean(st && st.super);
    btn.classList.toggle('active', Boolean(st));
    btn.classList.toggle('on', Boolean(st));
    btn.classList.toggle('super', sup);
    if (sup) { if (!btn._sparkle) { btn.innerHTML = SUPER_STAR_SVG(); btn._sparkle = true; } }
    else { btn._sparkle = false; btn.textContent = st ? '★' : (hollowWhenOff ? '☆' : '★'); }
    btn.title = sup ? 'Super star (tap to remove, hold to make it a normal star)'
      : st ? 'Remove from Stars (hold for a super star)' : 'Add to Stars (hold for a super star)';
  }

  function toggleStar(videoId, coverSrc, authorName, desc) {
    if (stars[videoId]) {
      delete stars[videoId];
    } else {
      if (!authorName || !desc) {
        const info = getVideoInfo(videoId);
        authorName = authorName || info.authorName;
        desc       = desc       || info.desc;
      }
      stars[videoId] = { id: videoId, coverSrc, authorName: authorName || '', desc: desc || '' };
    }
    saveStars();
    afterStarChange();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STAR BUTTONS ON MAIN-LIST CARDS
  // ═══════════════════════════════════════════════════════════════════════════


  // ═══════════════════════════════════════════════════════════════════════════
  // OPEN VIDEO (from panel or Stars tab)
  // ═══════════════════════════════════════════════════════════════════════════

  function starItemToCtx(s) {
    const info = getVideoInfo(s.id);
    return {
      id: s.id,
      coverSrc: s.coverSrc,
      videoPath: getVideoPath(s.coverSrc),
      authorName: info.authorName || s.authorName || '',
      desc:       info.desc       || s.desc       || '',
    };
  }

  function openVideo(coverSrc) {
    const videoId = getVideoIdFromSrc(coverSrc);
    if (!videoId) return;
    // In stars view, use the exact rendered list so order and lvl-only entries match
    if (starsTabActive && starsContextItems.length > 0) {
      const ctx = getStarsContext();
      const idx = ctx.findIndex(v => v.id === videoId);
      openVideoOverlay(idx >= 0 ? idx : 0, ctx);
      return;
    }
    const s0 = stars[videoId];
    const contextList = [starItemToCtx(s0 || { id: videoId, coverSrc })];
    openVideoOverlay(0, contextList);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // VIDEO OVERLAY PLAYER
  // ═══════════════════════════════════════════════════════════════════════════

  let overlayEl      = null;
  let overlayCtx     = [];    // context list of { id, coverSrc, videoPath }
  let overlayIdx     = 0;
  let overlayVideo   = null;
  let overlayMuted   = true;

  function openVideoOverlay(startIdx, contextList) {
    // On mobile route to the scroll-snap feed instead of the small overlay
    if (isMobilePlayer()) {
      const fromAuthor = authorViewOpen();
      if (activeMobileTab === 'home' && playerOpen && !playerReturnTab && playerViewEl && !homeStash) stashHomeFeed();
      playerReturnTab = fromAuthor ? '__author__'
                     : activeMobileTab === 'stars' ? 'stars'
                     : activeMobileTab === 'recents' ? 'recents'
                     : activeMobileTab === 'review' ? 'review'
                     : activeMobileTab === 'favs' ? 'favs'
                     : null;
      playerOpen = true;
      playerVideoList = contextList;
      playerColumnOffsets = [startIdx];
      document.querySelector('nav .player-tab')?.classList.add('active');
      if (!playerViewEl) {
        playerViewEl = document.createElement('div');
        playerViewEl.id = 'player-view';
        document.body.appendChild(playerViewEl);
      }
      playerViewEl.style.display = 'flex';
      playerViewEl.style.zIndex = fromAuthor ? '3600' : '';
      setPreviewsSuspended(true);
      renderMobilePlayerContent();
      if (playerReturnTab) navPush('player');
      return;
    }

    closeVideoOverlay();
    overlayCtx = contextList;
    overlayIdx = startIdx;
    overlayMuted = true;

    overlayEl = document.createElement('div');
    overlayEl.id = 'video-overlay';
    overlayEl.setAttribute('tabindex', '0');

    // Backdrop click closes
    overlayEl.addEventListener('click', e => {
      if (e.target === overlayEl) closeVideoOverlay();
    });

    // Close button
    const closeBtn = document.createElement('button');
    closeBtn.className = 'overlay-close';
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('click', closeVideoOverlay);
    overlayEl.appendChild(closeBtn);

    // Content container
    const content = document.createElement('div');
    content.id = 'video-overlay-content';
    overlayEl.appendChild(content);

    // Keyboard
    overlayEl.addEventListener('keydown', e => {
      if (e.key === 'Escape') { closeVideoOverlay(); return; }
      if (e.key === 'ArrowDown' || e.key === 'ArrowRight') { navigateOverlay(1); return; }
      if (e.key === 'ArrowUp'   || e.key === 'ArrowLeft')  { navigateOverlay(-1); return; }
    });

    // Swipe / tap (mobile)
    let _sy = 0;
    overlayEl.addEventListener('touchstart', e => { _sy = e.touches[0].clientY; }, { passive: true });
    overlayEl.addEventListener('touchend', e => {
      const dy = _sy - e.changedTouches[0].clientY;
      if (Math.abs(dy) < 50) {
        // tap — toggle play/pause
        if (overlayVideo) overlayVideo.paused ? overlayVideo.play().catch(() => {}) : overlayVideo.pause();
        return;
      }
      navigateOverlay(dy > 0 ? 1 : -1);
    }, { passive: true });

    document.body.appendChild(overlayEl);
    setPreviewsSuspended(true);
    renderOverlayContent();
    overlayEl.focus();
  }

  function closeVideoOverlay() {
    if (!overlayEl) return;
    if (overlayVideo) { overlayVideo.pause(); overlayVideo.src = ''; }
    overlayEl.remove();
    overlayEl = null;
    overlayVideo = null;
    overlayCtx = [];
    setPreviewsSuspended(false);
    // If player tab was active, deactivate it
    if (playerOpen) {
      playerOpen = false;
      document.querySelector('nav .player-tab')?.classList.remove('active');
    }
  }

  function navigateOverlay(dir) {
    const next = overlayIdx + dir;
    if (next < 0 || next >= overlayCtx.length) return;
    overlayIdx = next;
    renderOverlayContent();
  }

  function renderOverlayContent() {
    if (!overlayEl) return;
    const content = overlayEl.querySelector('#video-overlay-content');
    if (!content) return;

    // Pause old video
    if (overlayVideo) { overlayVideo.pause(); overlayVideo.src = ''; }
    content.innerHTML = '';

    const item = overlayCtx[overlayIdx];
    if (!item) return;

    const info = getVideoInfo(item.id);
    const authorName = info.authorName || item.authorName || '';
    const desc = info.desc || item.desc || '';

    // Video
    const video = document.createElement('video');
    video.src = item.videoPath;
    video.muted = overlayMuted;
    video.autoplay = true;
    video.playsInline = true;
    video.poster = item.coverSrc;
    video.className = 'overlay-video';
    video.addEventListener('playing', () => { video.poster = ''; }, { once: true });
    video.addEventListener('ended', () => { video.currentTime = 0; video.play().catch(() => {}); });
    video.addEventListener('contextmenu', e => { e.preventDefault(); video.paused ? video.play().catch(() => {}) : video.pause(); });
    content.appendChild(video);
    overlayVideo = video;

    // Controls layer
    const controls = document.createElement('div');
    controls.className = 'overlay-controls-layer';

    // Right center: star + group
    const rightCenter = document.createElement('div');
    rightCenter.className = 'overlay-right-center';

    const starBtn = document.createElement('button');
    starBtn.className = 'overlay-ctrl-btn overlay-star-btn';
    paintStarBtn(starBtn, item.id, false);
    starGesture(starBtn,
      () => { toggleStar(item.id, item.coverSrc, authorName, desc); paintStarBtn(starBtn, item.id, false); },
      () => { toggleSuperStar(item.id, item.coverSrc, authorName, desc); paintStarBtn(starBtn, item.id, false); });
    rightCenter.appendChild(starBtn);
    rightCenter.appendChild(makeBracesBtn('overlay-ctrl-btn overlay-braces-btn', item.id, 24));

    const lvlBtn = document.createElement('button');
    lvlBtn.className = 'overlay-ctrl-btn overlay-lvl-btn';
    lvlBtn.textContent = levels[item.id] != null ? String(levels[item.id]) : 'lvl';
    lvlBtn.addEventListener('click', e => {
      e.stopPropagation();
      showLevelPicker(lvlBtn, item.id, newLvl => {
        lvlBtn.textContent = newLvl != null ? String(newLvl) : 'lvl';
        if (starsTabActive) renderStarsView();
      });
    });
    rightCenter.appendChild(lvlBtn);

    const groupBtn = document.createElement('button');
    groupBtn.className = 'overlay-ctrl-btn overlay-group-btn';
    groupBtn.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="9"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>';
    groupBtn.addEventListener('click', e => { e.stopPropagation(); showGroupPicker(groupBtn, item.id); });
    rightCenter.appendChild(groupBtn);
    controls.appendChild(rightCenter);

    // Bottom-left: author + caption
    const meta = document.createElement('div');
    meta.className = 'overlay-meta';
    if (authorName) {
      const authEl = document.createElement('div');
      authEl.className = 'overlay-author';
      setAuthorLink(authEl, authorName);
      meta.appendChild(authEl);
    }
    if (desc) {
      const capEl = document.createElement('div');
      capEl.className = 'overlay-caption';
      capEl.textContent = desc.length > 150 ? desc.slice(0, 150) + '…' : desc;
      meta.appendChild(capEl);
    }
    controls.appendChild(meta);

    // Bottom-right: mute
    const muteBtn = document.createElement('button');
    muteBtn.className = 'overlay-ctrl-btn overlay-mute-btn';
    muteBtn.innerHTML = muteIcon(overlayMuted);
    muteBtn.addEventListener('click', e => {
      e.stopPropagation();
      overlayMuted = !overlayMuted;
      video.muted = overlayMuted;
      muteBtn.innerHTML = muteIcon(overlayMuted);
    });
    controls.appendChild(muteBtn);

    // Counter (subtle)
    if (overlayCtx.length > 1) {
      const counter = document.createElement('div');
      counter.className = 'overlay-counter';
      counter.textContent = `${overlayIdx + 1} / ${overlayCtx.length}`;
      controls.appendChild(counter);
    }

    // Bottom-center: prev / next nav buttons
    if (overlayCtx.length > 1) {
      const navDiv = document.createElement('div');
      navDiv.className = 'overlay-nav-btns';
      const prevNavBtn = document.createElement('button');
      prevNavBtn.className = 'overlay-ctrl-btn overlay-nav-btn';
      prevNavBtn.innerHTML = '&#8679;';
      prevNavBtn.title = 'Previous';
      prevNavBtn.disabled = overlayIdx <= 0;
      prevNavBtn.addEventListener('click', e => { e.stopPropagation(); navigateOverlay(-1); });
      const nextNavBtn = document.createElement('button');
      nextNavBtn.className = 'overlay-ctrl-btn overlay-nav-btn';
      nextNavBtn.innerHTML = '&#8681;';
      nextNavBtn.title = 'Next';
      nextNavBtn.disabled = overlayIdx >= overlayCtx.length - 1;
      nextNavBtn.addEventListener('click', e => { e.stopPropagation(); navigateOverlay(1); });
      navDiv.appendChild(prevNavBtn);
      navDiv.appendChild(nextNavBtn);
      controls.appendChild(navDiv);
    }

    content.appendChild(controls);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // GRID PREVIEWS — hover/play-all thumbnails and a size slider (stars + author pages)
  // ═══════════════════════════════════════════════════════════════════════════

  let gridPlayAll = false;        // play every thumbnail near the viewport
  let previewsSuspended = false;  // paused while a full-screen player is open
  const canHover = typeof matchMedia === 'function' && matchMedia('(hover: hover)').matches;
  const THUMB_DEFAULTS = { stars: 110, 'stars-m': 85, author: 220, 'author-m': 160, autotag: 150, 'autotag-m': 150, likes: 220, 'likes-m': 160, favs: 220, 'favs-m': 160 };

  function thumbKey(page) { return isMobilePlayer() ? page + '-m' : page; }

  function loadThumbSize(key) {
    try {
      const v = parseInt(localStorage.getItem('sp_thumb_' + key), 10);
      if (v >= 60 && v <= 420) return v;
    } catch (_) {}
    return THUMB_DEFAULTS[key];
  }

  function saveThumbSize(key, px) {
    try { localStorage.setItem('sp_thumb_' + key, String(px)); } catch (_) {}
  }

  function applyThumbSize(grid, px) {
    grid.style.gridTemplateColumns = `repeat(auto-fill, minmax(${px}px, 1fr))`;
    grid.style.setProperty('--tool', Math.max(20, Math.min(32, Math.round(px * 0.15))) + 'px');
    // How many label bubbles fit under a thumbnail of this width
    grid.dataset.cap = String(px < 80 ? 1 : px < 120 ? 2 : px < 170 ? 3 : px < 230 ? 4 : 5);
  }

  // ── Sort order for the stars, username and review grids ──────────────────
  // Latest/Oldest use the video's post date, Popular its like count. The review page also offers
  // "Best match", which keeps the order the model ranked its suggestions in.
  // The Stars grid in AI mode has its own remembered sort (default: best match)
  function sortPage(page) { return page === 'stars' && labelMode === 'ai' ? 'stars-ai' : page; }

  function sortOptions(page) {
    page = sortPage(page);
    const opts = [['latest', 'Latest'], ['popular', 'Popular'], ['oldest', 'Oldest']];
    if (page === 'likes' || page === 'favs') return [['recent', 'Added'], ...opts];
    return page === 'autotag' || page === 'stars-ai' ? [['score', 'Best match'], ...opts] : opts;
  }

  function getSort(page) {
    page = sortPage(page);
    const fallback = page === 'autotag' || page === 'stars-ai' ? 'score' : (page === 'likes' || page === 'favs') ? 'recent' : 'latest';
    try {
      const v = localStorage.getItem('sp_sort_' + page);
      if (sortOptions(page).some(([k]) => k === v)) return v;
    } catch (_) {}
    return fallback;
  }

  function saveSort(page, mode) {
    page = sortPage(page);
    try { localStorage.setItem('sp_sort_' + page, mode); } catch (_) {}
  }

  // Returns a sorted copy of items ({ id, ... }). Videos with no data in the archive database go last.
  function sortVideos(items, page) {
    const mode = getSort(page);
    const d = _dbCache;
    if (mode === 'score' || mode === 'recent' || !d) return items;
    const keyed = items.map((item, i) => {
      const v = d.videos[item.id];
      return { item, i, known: Boolean(v), t: v ? (v.createTime || 0) : 0, likes: v ? (v.diggCount || 0) : 0, plays: v ? (v.playCount || 0) : 0 };
    });
    keyed.sort((a, b) => {
      if (a.known !== b.known) return a.known ? -1 : 1;
      let r;
      if (mode === 'oldest') r = a.t - b.t;
      else if (mode === 'popular') r = (b.likes - a.likes) || (b.plays - a.plays) || (b.t - a.t);
      else r = b.t - a.t;
      return r || a.i - b.i;
    });
    return keyed.map(k => k.item);
  }

  // Mark a thumbnail as previewable and add mouse-over playback
  function attachPreview(cover, videoPath) {
    if (!videoPath || !/\/videos\/.+\.mp4$/.test(videoPath)) return;
    cover.classList.add('preview-cover');
    cover.dataset.video = videoPath;
    if (!canHover) return;
    cover.addEventListener('mouseenter', () => { cover._spHover = true;  syncCoverPlayback(cover); });
    cover.addEventListener('mouseleave', () => { cover._spHover = false; syncCoverPlayback(cover); });
  }

  // Attach or release the preview <video> of one thumbnail
  function syncCoverPlayback(cover) {
    let vid = cover.querySelector('video.preview-video');
    const want = !previewsSuspended && (cover._spHover || (gridPlayAll && cover._spVisible));
    if (want) {
      if (vid) { vid.play().catch(() => {}); return; }
      const img = cover.querySelector('img');
      vid = document.createElement('video');
      vid.className = 'preview-video';
      vid.src = cover.dataset.video;
      vid.muted = true; vid.loop = true; vid.playsInline = true; vid.preload = 'auto';
      cover.insertBefore(vid, img ? img.nextSibling : cover.firstChild);
      cover.classList.add('is-playing');
      vid.play().catch(() => {});
    } else if (vid) {
      vid.pause(); vid.removeAttribute('src'); vid.load(); vid.remove();
      cover.classList.remove('is-playing');
    }
  }

  // Only thumbnails near the grid's viewport may hold a <video>, so a long list can't exhaust memory
  function observeGridPreviews(grid) {
    if (grid._spIO) grid._spIO.disconnect();
    grid._spIO = new IntersectionObserver(entries => {
      entries.forEach(e => { e.target._spVisible = e.isIntersecting; syncCoverPlayback(e.target); });
    }, { root: grid, rootMargin: '200px' });
    grid.querySelectorAll('.preview-cover').forEach(c => grid._spIO.observe(c));
  }

  function refreshPreviews(container) {
    if (container) container.querySelectorAll('.preview-cover').forEach(c => syncCoverPlayback(c));
  }

  // Drop every preview <video> under a container (before it is hidden or re-rendered)
  function releaseGridPreviews(container) {
    if (!container) return;
    container.querySelectorAll('.preview-grid').forEach(g => {
      if (g._spIO) { g._spIO.disconnect(); g._spIO = null; }
      if (g._fillIO) { g._fillIO.disconnect(); g._fillIO = null; }
    });
    container.querySelectorAll('.preview-cover').forEach(c => {
      c._spVisible = false; c._spHover = false; syncCoverPlayback(c);
    });
  }

  // Fill a grid in chunks as the user scrolls instead of building every card at once.
  // A category can hold tens of thousands of videos; makeCard(item, index) is only called for
  // the ones that get near the viewport.
  const GRID_CHUNK = window.innerWidth < 768 ? 24 : 60;   // phones: fewer decoded covers at a time
  function fillGrid(grid, items, makeCard) {
    let next = 0;
    const sentinel = document.createElement('div');
    sentinel.className = 'grid-sentinel';

    function addChunk() {
      const end = Math.min(next + GRID_CHUNK, items.length);
      const frag = document.createDocumentFragment();
      const cards = [];
      for (; next < end; next++) {
        const card = makeCard(items[next], next);
        cards.push(card);
        frag.appendChild(card);
      }
      grid.insertBefore(frag, sentinel.parentNode === grid ? sentinel : null);
      if (grid._spIO) cards.forEach(c => c.querySelectorAll('.preview-cover').forEach(cv => grid._spIO.observe(cv)));
      if (next >= items.length) {
        sentinel.remove();
        if (grid._fillIO) { grid._fillIO.disconnect(); grid._fillIO = null; }
      }
    }

    function pump() {
      while (next < items.length) {
        const g = grid.getBoundingClientRect(), s = sentinel.getBoundingClientRect();
        if (s.top > g.bottom + 800) break;
        addChunk();
      }
    }

    if (items.length > GRID_CHUNK) grid.appendChild(sentinel);
    addChunk();
    if (items.length <= GRID_CHUNK) return;
    grid._fillTo = target => { while (next < items.length && next < target) addChunk(); };
    grid._fillIO = new IntersectionObserver(entries => {
      if (entries.some(e => e.isIntersecting)) pump();
    }, { root: grid, rootMargin: '800px' });
    grid._fillIO.observe(sentinel);
  }

  function setPreviewsSuspended(v) {
    if (previewsSuspended === v) return;
    previewsSuspended = v;
    refreshPreviews(starsViewEl);
    refreshPreviews(authorViewEl);
  }

  // Play-all button + thumbnail size slider shown in a page header
  function buildGridControls(page, grid, container) {
    const key = thumbKey(page);
    const wrap = document.createElement('div');
    wrap.className = 'grid-controls';

    const play = document.createElement('button');
    play.className = 'grid-playall';
    const refresh = () => {
      play.textContent = gridPlayAll ? '⏸' : '▶';
      play.title = gridPlayAll ? 'Stop playing thumbnails' : 'Play all thumbnails';
      play.classList.toggle('on', gridPlayAll);
    };
    refresh();
    play.addEventListener('click', e => {
      e.stopPropagation();
      gridPlayAll = !gridPlayAll;
      refresh();
      refreshPreviews(container);
    });

    const size = document.createElement('input');
    size.type = 'range';
    size.className = 'grid-size';
    size.min = '60'; size.max = '420'; size.step = '10';
    size.title = 'Thumbnail size';
    const start = loadThumbSize(key);
    size.value = String(start);
    applyThumbSize(grid, start);
    size.addEventListener('input', () => {
      const px = parseInt(size.value, 10);
      applyThumbSize(grid, px);
      saveThumbSize(key, px);
    });

    // One button per sort order, the selected one highlighted
    const sort = document.createElement('div');
    sort.className = 'grid-sort';
    sort.setAttribute('role', 'group');
    sort.title = 'Sort order';
    const current = getSort(page);
    sortOptions(page).forEach(([value, label]) => {
      const b = document.createElement('button');
      b.className = 'grid-sort-btn' + (value === current ? ' on' : '');
      b.textContent = label;
      b.setAttribute('aria-pressed', value === current ? 'true' : 'false');
      b.addEventListener('click', e => {
        e.stopPropagation();
        if (getSort(page) === value) return;
        saveSort(page, value);
        sort.querySelectorAll('.grid-sort-btn').forEach(x => {
          x.classList.toggle('on', x === b);
          x.setAttribute('aria-pressed', x === b ? 'true' : 'false');
        });
        if (page === 'stars') renderStarsView();
        else if (page === 'author') renderAuthorView();
        else if (page === 'autotag') renderAutotagView();
        else if (page === 'likes' || page === 'favs') renderListView();
      });
      sort.appendChild(b);
    });

    wrap.append(play, size, sort);
    return wrap;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STARS TAB — NAV + CONTENT
  // ═══════════════════════════════════════════════════════════════════════════


  // ═══════════════════════════════════════════════════════════════════════════
  // LIBRARY PAGES — Likes, Favorites and Following, built from the archive database
  // ═══════════════════════════════════════════════════════════════════════════

  let listTabKind = null;      // 'likes' | 'bookmarked' | 'following' while one of the pages is showing
  let listViewEl  = null;
  let listQuery   = '';
  const listScope = { likes: 'official', bookmarked: 'official', following: 'with' };   // official | gone | all  (Following: with | everyone)
  const LIST_PAGES = {
    likes:      { title: 'Likes',     sort: 'likes' },
    bookmarked: { title: 'Favorites', sort: 'favs' },
    following:  { title: 'Following', sort: 'following' },
  };

  // Downloaded videos of a collection, newest first.
  //   'official'  what the platform still lists (the default Likes / Favorites view)
  //   'gone'      downloaded, but no longer in the official list
  //   'all'       the official ones first, then the gone ones
  function collectionItems(kind, mode) {
    const d = _dbCache;
    if (!d) return [];
    const src = kind === 'likes' ? d.likes : d.bookmarked;
    const dir = kind === 'likes' ? 'Likes' : 'Favorites';
    const have = new Set((src && src.downloaded) || []);
    const official = (src && src.officialList) || [];
    const inOfficial = new Set(official);
    mode = mode || 'all';
    if (mode === 'official' && !official.length) mode = 'all';   // no official list yet: show everything downloaded
    const order = [], seen = new Set();
    if (mode !== 'gone') official.forEach(id => { if (have.has(id) && !seen.has(id)) { seen.add(id); order.push(id); } });
    if (mode !== 'official') [...have].reverse().forEach(id => {
      if (seen.has(id) || (mode === 'gone' && (inOfficial.has(id) || !official.length))) return;
      seen.add(id); order.push(id);
    });
    const out = [];
    for (const id of order) {
      const v = d.videos[id];
      if (!v) continue;
      const a = d.authors[v.authorId];
      out.push({
        id, authorName: (a && a.uniqueIds && a.uniqueIds[0]) || '', desc: d.videoDescriptions[id] || '', createTime: v.createTime || 0,
        coverSrc: `data/${dir}/covers/${id}.jpg`, videoPath: `data/${dir}/videos/${id}.mp4`,
      });
    }
    return out;
  }

  // Downloaded videos per author, counted once per database load
  let _followCounts = null;
  function followCounts() {
    const d = _dbCache;
    if (_followCounts && _followCounts.src === d) return _followCounts.map;
    const have = new Set([...((d.likes && d.likes.downloaded) || []), ...((d.bookmarked && d.bookmarked.downloaded) || [])]);
    Object.values((d.following && d.following.authorItems) || {}).forEach(it => [...(it.inFolder || []), ...(it.disappeared || [])].forEach(id => have.add(id)));
    const map = new Map();
    have.forEach(id => { const v = d.videos[id]; if (v) map.set(v.authorId, (map.get(v.authorId) || 0) + 1); });
    _followCounts = { src: d, map };
    return map;
  }

  // Accounts that have at least one super-starred video
  function superAuthorIds() {
    const d = _dbCache, out = new Set();
    if (!d) return out;
    Object.keys(stars).forEach(id => {
      if (!stars[id].super) return;
      const v = d.videos[id];
      if (v) out.add(String(v.authorId));
    });
    return out;
  }

  function followedAuthors() {
    const d = _dbCache;
    if (!d || !d.following) return [];
    const f = d.following;
    const counts = followCounts();
    const ids = new Set((f.officialAuthorList || []).map(x => (x && typeof x === 'object') ? (x.id || x.authorId || x.uid) : x).filter(Boolean).map(String));
    Object.keys(f.authorItems || {}).forEach(id => ids.add(id));
    const supers = superAuthorIds();
    return [...ids].map(id => {
      const a = d.authors[id] || {};
      return { id, name: (a.uniqueIds && a.uniqueIds[0]) || '', nick: (a.nicknames && a.nicknames[0]) || '', followers: a.followerCount || 0, videos: counts.get(id) || 0, super: supers.has(id) };
    });
  }

  function fmtCount(n) {
    if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1).replace(/\.0$/, '') + 'K';
    return String(n);
  }

  function showListTab(kind) {
    if (!LIST_PAGES[kind]) return;
    const mobile = isMobilePlayer();
    if (settingsTabActive) hideSettingsView();
    // Already showing this page (e.g. coming back from a video): leave the scroll position alone
    if (listTabKind === kind && listViewEl && listViewEl.style.display !== 'none') { syncNavActive(); return; }
    if (autotagTabActive) hideAutotagView();
    if (logTabActive) hideLogView();
    if (activeAuthorId) hideAuthorView(false);
    if (starsTabActive) {
      starsTabActive = false;
      if (starsViewEl) { releaseGridPreviews(starsViewEl); starsViewEl.style.display = 'none'; }
    }
    if (!mobile) closePlayer();
    closeVideoOverlay();
    const main = document.querySelector('main');
    main?.style.setProperty('display', 'none');
    if (listTabKind !== kind) { listQuery = ''; }
    listTabKind = kind;
    if (!listViewEl) {
      listViewEl = document.createElement('div');
      listViewEl.id = 'list-view';
      if (main) main.parentNode.insertBefore(listViewEl, main); else document.body.appendChild(listViewEl);
    }
    listViewEl.style.display = 'flex';
    document.body.classList.add('sp-list-open');
    if (mobile) { activeMobileTab = 'favs'; updateMobileNavActive(); }
    archiveDbPromise().then(() => { if (listTabKind === kind) renderListView(); }).catch(() => {
      if (!listViewEl) return;
      listViewEl.innerHTML = '<div class="author-empty" style="padding:24px">No archive found yet. Once ttpull has downloaded something into this folder, it shows up here.</div>';
      ttpullStatus().then(st => {
        if (st && st.initialized === false && listViewEl && listTabKind === kind) {
          listViewEl.innerHTML = '<div class="author-empty" style="padding:24px">ttpull has not created the archive yet. Set DB_UPDATE=write on the ttpull container so it can create and update it.</div>';
        }
      });
    });
    renderListView();
    syncNavActive();
  }

  function hideListView() {
    if (listViewEl) { releaseGridPreviews(listViewEl); listViewEl.style.display = 'none'; }
    listTabKind = null;
    document.body.classList.remove('sp-list-open');
    syncNavActive();
  }

  // Which nav tab is highlighted
  function syncNavActive() {
    const nav = document.querySelector('nav');
    if (!nav) return;
    const sel = activeAuthorId ? null
      : settingsTabActive ? '.settings-tab'
      : listTabKind ? ({ likes: '.likes', bookmarked: '.bookmarked', following: '.following' })[listTabKind]
      : starsTabActive ? '.stars-tab' : logTabActive ? '.log-tab' : autotagTabActive ? '.autotag-tab' : null;
    ['.likes', '.bookmarked', '.following', '.stars-tab', '.log-tab', '.autotag-tab', '.settings-tab'].forEach(x => {
      nav.querySelector(x)?.classList.toggle('active', x === sel);
    });
  }

  function renderListView() {
    if (!listViewEl || !listTabKind) return;
    const kind = listTabKind, meta = LIST_PAGES[kind];
    const following = kind === 'following';
    releaseGridPreviews(listViewEl);
    listViewEl.innerHTML = '';

    const grid = document.createElement('div');
    grid.id = 'list-grid';
    grid.classList.add('preview-grid');
    if (following) grid.classList.add('follow-grid');

    const header = document.createElement('div');
    header.id = 'list-view-header';
    const title = document.createElement('span');
    title.className = 'stars-main-title';
    title.textContent = meta.title;
    const count = document.createElement('span');
    count.className = 'stars-main-count';

    // phones reach all three pages from the one Library tab
    const seg = document.createElement('div');
    seg.className = 'list-seg';
    Object.entries(LIST_PAGES).forEach(([k, m]) => {
      const b = document.createElement('button');
      b.className = 'list-seg-btn' + (k === kind ? ' on' : '');
      b.textContent = m.title;
      b.addEventListener('click', () => { if (k !== listTabKind) { listTabKind = null; showListTab(k); } });
      seg.appendChild(b);
    });

    // scope: all / disappeared (Likes, Favorites); with videos / everyone (Following)
    const scope = document.createElement('div');
    scope.className = 'list-scope';
    const scopes = following ? [['with', 'With videos'], ['everyone', 'Everyone']] : [['official', 'Current'], ['gone', 'Disappeared'], ['all', 'All']];
    scopes.forEach(([v, label]) => {
      const b = document.createElement('button');
      b.className = 'list-scope-btn' + (listScope[kind] === v ? ' on' : '');
      b.textContent = label;
      b.addEventListener('click', () => { listScope[kind] = v; scope.querySelectorAll('.list-scope-btn').forEach(x => x.classList.toggle('on', x === b)); body(); });
      scope.appendChild(b);
    });

    const search = document.createElement('input');
    search.className = 'list-search';
    search.type = 'search';
    search.placeholder = following ? 'Search accounts' : 'Search captions and usernames';
    search.value = listQuery;
    let searchTimer = null;
    search.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { listQuery = search.value; body(); }, 200); });

    const gear = document.createElement('button');
    gear.className = 'list-gear';
    gear.title = 'Settings';
    gear.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor">' + GEAR_PATH + '</svg>';
    gear.addEventListener('click', () => showSettingsTab());
    header.append(title, count, gear, seg, scope, search);
    if (!following) header.appendChild(buildGridControls(meta.sort, grid, listViewEl));
    listViewEl.appendChild(header);
    listViewEl.appendChild(grid);

    function body() {
      releaseGridPreviews(listViewEl);
      grid.innerHTML = '';
      const q = listQuery.trim().toLowerCase();
      if (!_dbCache) { grid.textContent = 'Loading…'; return; }
      if (following && !_dbCache.following) {
        count.textContent = '0 accounts';
        grid.appendChild(Object.assign(document.createElement('div'), { className: 'author-empty', textContent: 'This archive has no Following data. ttpull does not download the accounts you follow; this page fills in when the archive has a db_following.js file.' }));
        return;
      }
      if (following) {
        let list = followedAuthors();
        if (listScope.following === 'with') list = list.filter(a => a.videos > 0 || a.super);
        if (q) list = list.filter(a => (a.name + ' ' + a.nick).toLowerCase().includes(q));
        list.sort((a, b) => (Number(b.super) - Number(a.super)) || (b.videos - a.videos) || (b.followers - a.followers) || a.name.localeCompare(b.name));
        count.textContent = `${list.length} account${list.length !== 1 ? 's' : ''}`;
        if (!list.length) grid.appendChild(Object.assign(document.createElement('div'), { className: 'author-empty', textContent: 'Nothing here.' }));
        fillGrid(grid, list, a => buildFollowCard(a));
        return;
      }
      let items = collectionItems(kind, listScope[kind]);
      if (q) items = items.filter(v => (v.desc + ' ' + v.authorName).toLowerCase().includes(q));
      items = sortVideos(items, meta.sort);
      count.textContent = `${items.length} video${items.length !== 1 ? 's' : ''}`;
      if (!items.length) grid.appendChild(Object.assign(document.createElement('div'), { className: 'author-empty', textContent: q ? 'No matches.' : listScope[kind] === 'gone' ? 'No disappeared videos.' : 'Nothing downloaded yet.' }));
      fillGrid(grid, items, (v, idx) => buildListCard(v, idx, items));
      observeGridPreviews(grid);
    }
    body();
  }

  function buildListCard(v, idx, list) {
    const card = document.createElement('div');
    card.className = 'stars-grid-card';
    const cover = document.createElement('div');
    cover.className = 'stars-grid-cover';
    attachPreview(cover, v.videoPath);
    cover.addEventListener('click', () => openVideoOverlay(idx, list));
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.src = v.coverSrc;
    img.onerror = () => { img.style.display = 'none'; };
    cover.appendChild(img);
    cover.appendChild(buildThumbTools(v.id, v.coverSrc, v.authorName, v.desc));
    card.appendChild(cover);
    if (v.authorName) {
      const a = document.createElement('div');
      a.className = 'stars-grid-author';
      setAuthorLink(a, v.authorName);
      card.appendChild(a);
    }
    if (v.desc) {
      const dsc = document.createElement('div');
      dsc.className = 'stars-grid-desc';
      dsc.textContent = v.desc.length > 80 ? v.desc.slice(0, 80) + '…' : v.desc;
      card.appendChild(dsc);
    }
    return card;
  }

  function buildFollowCard(a) {
    const card = document.createElement('div');
    card.className = 'follow-card';
    const label = a.name || a.nick || a.id;
    const av = document.createElement('div');
    av.className = 'follow-avatar';
    av.textContent = (a.nick || a.name || '?').trim().charAt(0).toUpperCase();
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.src = `data/Following/Avatars/small_${a.id}.jpg`;
    img.onerror = () => img.remove();
    av.appendChild(img);
    const name = document.createElement('div');
    name.className = 'follow-name';
    name.textContent = a.nick || ('@' + label);
    const sub = document.createElement('div');
    sub.className = 'follow-sub';
    sub.textContent = a.name ? '@' + a.name : a.id;
    const stats = document.createElement('div');
    stats.className = 'follow-stats';
    stats.textContent = `${a.videos} video${a.videos !== 1 ? 's' : ''}` + (a.followers ? ` · ${fmtCount(a.followers)} followers` : '');
    card.append(av, name, sub, stats);
    card.classList.toggle('no-videos', !a.videos && !a.super);
    if (a.super) {
      card.classList.add('is-super');
      const badge = document.createElement('span');
      badge.className = 'follow-super';
      badge.title = 'Has a super star';
      badge.innerHTML = SUPER_STAR_SVG(22);
      card.appendChild(badge);
    }
    card.addEventListener('click', () => showAuthorTab(a.id, label));
    return card;
  }


  // ═══════════════════════════════════════════════════════════════════════════
  // SETTINGS — the gear page. Stored on the server (settings.json) so every device shares them.
  // ═══════════════════════════════════════════════════════════════════════════

  const GEAR_PATH = '<path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/>';
  const SETTINGS_KEY = 'sp_settings';
  let settings = { profileUrl: '' };
  let settingsTabActive = false;
  let settingsViewEl = null;

  (function loadSettingsInit() {
    try { Object.assign(settings, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')); } catch (_) {}
    fetch('/api/settings').then(r => (r.ok ? r.json() : null)).then(d => {
      if (!d || !d.settings) return;
      Object.assign(settings, d.settings);
      try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (_) {}
      if (typeof syncAuthorTabs === 'function') syncAuthorTabs();
      if (settingsTabActive) renderSettingsView();
    }).catch(() => {});
  })();

  // Save changes; resolves to an error message, or '' when it was saved
  function saveSettings(patch) {
    Object.assign(settings, patch);
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (_) {}
    return fetch('/api/settings', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ settings: patch }),
    }).then(r => (r.ok ? '' : 'The server did not accept that value.')).catch(() => 'Saved on this device only (the server could not be reached).');
  }

  // ttpull's own view of the archive (counts only), or null when ttpull is not reachable
  function ttpullStatus() {
    return fetch('/api/ttpull/archive-status').then(r => (r.ok ? r.json() : null)).then(d => (d && d.ok ? d.status : null)).catch(() => null);
  }

  // Address template -> address for one username ('' when no valid template is set)
  function profileUrlTemplateOk(t) { return /^https?:\/\//i.test(t) && t.includes('{username}'); }
  function profileUrlFor(name) {
    const t = String(settings.profileUrl || '').trim();
    return profileUrlTemplateOk(t) ? t.split('{username}').join(encodeURIComponent(name)) : '';
  }

  function showSettingsTab() {
    const mobile = isMobilePlayer();
    if (settingsTabActive && settingsViewEl && settingsViewEl.style.display !== 'none') return;
    if (!mobile) {
      if (listTabKind) hideListView();
      if (autotagTabActive) hideAutotagView();
      if (logTabActive) hideLogView();
      if (activeAuthorId) hideAuthorView(false);
      if (starsTabActive) {
        starsTabActive = false;
        if (starsViewEl) { releaseGridPreviews(starsViewEl); starsViewEl.style.display = 'none'; }
      }
      closePlayer();
      document.querySelector('main')?.style.setProperty('display', 'none');
    }
    closeVideoOverlay();
    settingsTabActive = true;
    if (!settingsViewEl) {
      settingsViewEl = document.createElement('div');
      settingsViewEl.id = 'settings-view';
      const main = document.querySelector('main');
      if (main && !mobile) main.parentNode.insertBefore(settingsViewEl, main); else document.body.appendChild(settingsViewEl);
    }
    settingsViewEl.style.display = 'flex';
    renderSettingsView();
    syncNavActive();
    archiveDbPromise().then(() => { if (settingsTabActive) renderSettingsView(); }).catch(() => {});
  }

  function hideSettingsView() {
    settingsTabActive = false;
    if (settingsViewEl) settingsViewEl.style.display = 'none';
    syncNavActive();
  }

  function renderSettingsView() {
    if (!settingsViewEl || !settingsTabActive) return;
    const keepFocus = settingsViewEl.contains(document.activeElement) && document.activeElement.tagName === 'INPUT';
    if (keepFocus) return;   // do not rebuild the page under someone who is typing
    settingsViewEl.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'set-wrap';

    const head = document.createElement('div');
    head.className = 'set-head';
    const back = document.createElement('button');
    back.className = 'set-back';
    back.textContent = '‹ Back';
    back.addEventListener('click', () => hideSettingsView());
    const h = document.createElement('h2');
    h.textContent = 'Settings';
    head.append(back, h);
    wrap.appendChild(head);

    const section = (title, note) => {
      const sec = document.createElement('section');
      sec.className = 'set-section';
      const t = document.createElement('h3'); t.textContent = title; sec.appendChild(t);
      if (note) { const n = document.createElement('p'); n.className = 'set-note'; n.textContent = note; sec.appendChild(n); }
      wrap.appendChild(sec);
      return sec;
    };

    // ── profile link ──
    const prof = section('Profile link', 'Double-click a username tab to open that account’s profile. Enter the web address of a profile page and put {username} where the username goes. Keep any characters the site needs around it, for example an @ before {username}. Use \u201cTry it\u201d below to check the result. Leave it empty to turn this off.');
    const input = document.createElement('input');
    input.className = 'set-input';
    input.type = 'url';
    input.placeholder = 'https://example.com/@{username}';
    input.value = settings.profileUrl || '';
    input.autocomplete = 'off'; input.autocapitalize = 'off'; input.spellcheck = false;
    const status = document.createElement('div');
    status.className = 'set-status';
    const preview = document.createElement('div');
    preview.className = 'set-preview';
    const paint = () => {
      const v = input.value.trim();
      const ok = !v || profileUrlTemplateOk(v);
      input.classList.toggle('bad', !ok);
      if (!v) { status.textContent = 'Off: double-clicking a username tab does nothing.'; preview.textContent = ''; return; }
      if (!ok) { status.textContent = 'Needs to start with http:// or https:// and contain {username}.'; preview.textContent = ''; return; }
      preview.textContent = 'Example: ' + v.split('{username}').join('example');
    };
    let timer = null;
    input.addEventListener('input', () => {
      paint();
      clearTimeout(timer);
      const v = input.value.trim();
      if (v && !profileUrlTemplateOk(v)) return;
      timer = setTimeout(() => {
        saveSettings({ profileUrl: v }).then(msg => {
          status.textContent = msg || (v ? 'Saved.' : 'Off: double-clicking a username tab does nothing.');
          syncAuthorTabs();
        });
      }, 450);
    });
    // Try it: type a real username and open the address this setting produces
    const tryRow = document.createElement('div');
    tryRow.className = 'set-try';
    const tryIn = document.createElement('input');
    tryIn.className = 'set-input set-try-input';
    tryIn.type = 'text';
    tryIn.placeholder = 'Try a username';
    tryIn.autocomplete = 'off'; tryIn.autocapitalize = 'off'; tryIn.spellcheck = false;
    const tryBtn = document.createElement('button');
    tryBtn.className = 'set-btn';
    tryBtn.textContent = 'Open';
    const tryNow = () => {
      const name = tryIn.value.trim().replace(/^@/, '');
      // use what is typed above even if it has not finished saving
      const t = input.value.trim();
      const url = name && profileUrlTemplateOk(t) ? t.split('{username}').join(encodeURIComponent(name)) : '';
      if (!url) { status.textContent = !name ? 'Type a username to try.' : 'Fix the address above first.'; return; }
      status.textContent = 'Opened: ' + url;
      window.open(url, '_blank', 'noopener');
    };
    tryBtn.addEventListener('click', tryNow);
    tryIn.addEventListener('keydown', e => { if (e.key === 'Enter') tryNow(); });
    tryRow.append(tryIn, tryBtn);
    prof.append(input, status, preview, tryRow);
    paint();
    if (settings.profileUrl) status.textContent = 'Saved.';

    // ── archive summary ──
    const d = _dbCache;
    const arch = section('Archive');
    const list = document.createElement('div');
    list.className = 'set-facts';
    const fact = (label, value) => {
      const row = document.createElement('div');
      const a = document.createElement('span'); a.textContent = label;
      const b = document.createElement('b'); b.textContent = value;
      row.append(a, b); list.appendChild(row);
    };
    if (d) {
      fact('Videos in the database', Object.keys(d.videos).length.toLocaleString());
      fact('Likes downloaded', (((d.likes && d.likes.downloaded) || []).length).toLocaleString());
      fact('Favorites downloaded', (((d.bookmarked && d.bookmarked.downloaded) || []).length).toLocaleString());
      fact('Accounts followed', followedAuthors().length.toLocaleString());
      fact('Stars / groups', `${Object.keys(stars).length.toLocaleString()} / ${groups.length.toLocaleString()}`);
    } else {
      fact('Archive', _dbFailed ? 'not available yet' : 'loading…');
    }
    arch.appendChild(list);
    ttpullStatus().then(st => {
      if (!st || !settingsTabActive || !list.isConnected) return;
      fact('ttpull', st.initialized ? 'connected' : 'connected, archive not created yet');
      if (st.lastWrite) {
        const when = new Date(st.lastWrite);
        if (!isNaN(when)) fact('Archive last updated', when.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }));
      }
    });

    // ── this device ──
    const dev = section('This device');
    const info = document.createElement('button');
    info.className = 'set-btn';
    info.textContent = 'Show device info';
    info.addEventListener('click', () => showDeviceInfo());
    dev.appendChild(info);

    settingsViewEl.appendChild(wrap);
  }

  let starsTabActive = false;
  let starsViewEl    = null;
  let activeView       = '__tagged__'; // null (All Stars / selected groups) | '__tagged__' | '__super__' | '__lvl_groups__' | '__ungrouped__' (Untagged) | '__disappeared__'
  let activeGroupIds   = new Set();   // empty = all stars; non-empty = union of selected groups
  let activeLvl        = new Set();   // empty = no filter; set of numbers = multi-select
  let mobileStarsLvlOpen = false;     // mobile: whether inline lvl strip is visible
  let mobileStarsGroupsOpen = false;  // mobile: whether group picker panel is expanded
  let groupSortOrder   = 'alpha';     // 'alpha' | 'count'
  let starsViewKey = '';            // which view/filters the stars grid last showed
  let starsContextItems = [];       // items of the rendered grid, in order
  let starsContextCache = null;     // player contexts built from them when a video is opened (lists can be huge)
  function setStarsContext(items) { starsContextItems = items; starsContextCache = null; }
  function getStarsContext() {
    // Light entries on purpose: the players look up the author and caption themselves, and the
    // list can hold tens of thousands of videos
    if (!starsContextCache) {
      starsContextCache = starsContextItems.map(item => {
        const s = item.lvlOnly ? item : (stars[item.id] || item);
        return { id: s.id, coverSrc: s.coverSrc, videoPath: getVideoPath(s.coverSrc), authorName: s.authorName || '', desc: s.desc || '' };
      });
    }
    return starsContextCache;
  }

  function showStarsTab() {
    if (settingsTabActive) hideSettingsView();
    if (listTabKind) hideListView();
    if (autotagTabActive) hideAutotagView();
    if (logTabActive) hideLogView();
    if (activeAuthorId) hideAuthorView();
    starsTabActive = true;
    if (!isMobilePlayer()) closePlayer();
    document.querySelector('main')?.style.setProperty('display', 'none');

    if (isMobilePlayer()) { activeMobileTab = 'stars'; updateMobileNavActive(); }
    else {
      document.querySelectorAll('nav .author-tab.active, nav .log-tab.active, nav .autotag-tab.active').forEach(el => el.classList.remove('active'));
      document.querySelector('nav .stars-tab')?.classList.add('active');
    }

    const main = document.querySelector('main');
    if (!starsViewEl) {
      starsViewEl = document.createElement('div');
      starsViewEl.id = 'stars-view';
      main?.parentNode.insertBefore(starsViewEl, main);
    }
    starsViewEl.style.display = 'flex';
    renderStarsView();
  }

  function showMainContent() {
    if (settingsTabActive) hideSettingsView();
    if (listTabKind) hideListView();
    if (autotagTabActive) hideAutotagView();
    if (logTabActive) hideLogView();
    if (activeAuthorId) hideAuthorView();
    starsTabActive = false;
    document.querySelector('main')?.style.removeProperty('display');
    if (starsViewEl) { releaseGridPreviews(starsViewEl); starsViewEl.style.display = 'none'; }
    if (!isMobilePlayer()) document.querySelector('nav .stars-tab')?.classList.remove('active');
  }

  function renderStarsView() {
    if (!starsViewEl) return;
    // Re-rendering after a tag/star/level change must not throw you back to the top of a long list:
    // remember how far the same view was loaded and scrolled
    const viewKey = [activeView, [...activeGroupIds].sort().join(','), [...activeLvl].sort().join(','), getSort('stars'), labelMode, activeAiTag].join('|');
    const prevGrid = starsViewEl.querySelector('#stars-grid');
    const keep = (prevGrid && starsViewKey === viewKey)
      ? { loaded: prevGrid.querySelectorAll('.stars-grid-card').length, scroll: prevGrid.scrollTop }
      : null;
    starsViewKey = viewKey;
    releaseGridPreviews(starsViewEl);
    starsViewEl.innerHTML = '';
    if (labelMode === 'ai') { renderAiStarsView(keep); return; }

    // ── Sidebar ──────────────────────────────────────────────────────────────
    const sidebar = document.createElement('div');
    sidebar.id = 'stars-sidebar';

    function makeSidebarItem(id, label, count) {
      let isActive;
      if      (id === '__lvl_groups__') isActive = activeView === '__lvl_groups__';
      else if (id === '__ungrouped__')  isActive = activeView === '__ungrouped__';
      else if (id === '__tagged__')     isActive = activeView === '__tagged__';
      else if (id === '__disappeared__') isActive = activeView === '__disappeared__';
      else if (id === '__super__')      isActive = activeView === '__super__';
      else if (id === 'all')            isActive = activeView === null && activeGroupIds.size === 0;
      else                              isActive = activeGroupIds.has(id);
      const item = document.createElement('div');
      item.className = 'stars-group-item' + (isActive ? ' active' : '');
      const nameSpan = document.createElement('span');
      nameSpan.className = 'stars-group-name';
      nameSpan.textContent = label;
      const countSpan = document.createElement('span');
      countSpan.className = 'stars-group-count';
      countSpan.textContent = count;
      item.appendChild(nameSpan);
      item.appendChild(countSpan);
      return item;
    }

    sidebar.appendChild(buildLabelToggle());

    // ── Lvl nav item + numbered filter buttons ────────────────────────────────
    const lvlNavItem = makeSidebarItem('__lvl_groups__', 'lvl', '');
    lvlNavItem.addEventListener('click', () => { activeView = '__lvl_groups__'; activeGroupIds.clear(); renderStarsView(); });
    sidebar.appendChild(lvlNavItem);

    const lvlGrid = document.createElement('div');
    lvlGrid.id = 'stars-lvl-grid';
    for (let n = 10; n <= 23; n++) {
      const count = Object.keys(levels).filter(id => levels[id] === n).length;
      const btn = document.createElement('button');
      btn.className = 'stars-lvl-btn' + (activeLvl.has(n) ? ' active' : '');
      btn.textContent = n;
      btn.title = count + ' video' + (count !== 1 ? 's' : '');
      btn.addEventListener('click', () => {
        if (activeLvl.has(n)) activeLvl.delete(n); else activeLvl.add(n);
        if (activeView === '__lvl_groups__') { activeView = null; activeGroupIds.clear(); }
        renderStarsView();
      });
      lvlGrid.appendChild(btn);
    }
    sidebar.appendChild(lvlGrid);

    const lvlDivider = document.createElement('hr');
    lvlDivider.className = 'stars-sidebar-divider';
    sidebar.appendChild(lvlDivider);

    // ── All tagged (every video that is in at least one group) ───────────────
    const taggedIds = new Set(groups.flatMap(g => g.videoIds));
    const taggedItem = makeSidebarItem('__tagged__', 'All tagged', taggedIds.size);
    taggedItem.addEventListener('click', () => { activeView = '__tagged__'; activeGroupIds.clear(); renderStarsView(); });
    sidebar.appendChild(taggedItem);

    // ── All Stars ─────────────────────────────────────────────────────────────
    const allItem = makeSidebarItem('all', 'All Stars', Object.keys(stars).length);
    allItem.addEventListener('click', () => { activeView = null; activeGroupIds.clear(); renderStarsView(); });
    sidebar.appendChild(allItem);

    // ── Super stars (a star you long-pressed) ───────────────────────────────
    const superCount = Object.values(stars).filter(x => x.super).length;
    const superItem = makeSidebarItem('__super__', '\u2726 Super stars', superCount);
    superItem.classList.add('stars-super-item');
    superItem.addEventListener('click', () => { activeView = '__super__'; activeGroupIds.clear(); renderStarsView(); });
    sidebar.appendChild(superItem);

    // ── Untagged ──────────────────────────────────────────────────────────────
    const groupedIds = new Set(groups.flatMap(g => g.videoIds));
    const ungroupedStarCount  = Object.keys(stars).filter(id => !groupedIds.has(id)).length;
    const ungroupedLvlCount   = Object.keys(levels).filter(id => !stars[id] && !groupedIds.has(id)).length;
    const ungroupedTotal      = ungroupedStarCount + ungroupedLvlCount;
    const ungroupedItem = makeSidebarItem('__ungrouped__', 'Untagged', ungroupedTotal);
    ungroupedItem.addEventListener('click', () => { activeView = '__ungrouped__'; activeGroupIds.clear(); renderStarsView(); });
    sidebar.appendChild(ungroupedItem);

    // Disappeared: every archived video removed from the official lists, tagged or not
    const disappearedItem = makeSidebarItem('__disappeared__', 'Disappeared', _dbCache ? disappearedIds().length.toLocaleString() : '');
    disappearedItem.title = 'Videos removed from the official lists';
    disappearedItem.addEventListener('click', () => { activeView = '__disappeared__'; activeGroupIds.clear(); renderStarsView(); });
    sidebar.appendChild(disappearedItem);
    if (!_dbCache) ensureArchiveDb();

    const divider = document.createElement('hr');
    divider.className = 'stars-sidebar-divider';
    sidebar.appendChild(divider);

    // sort before rendering
    const sortedGroups = [...groups].sort((a, b) => {
      if (groupSortOrder === 'count') return b.videoIds.length - a.videoIds.length;
      return a.name.localeCompare(b.name);
    });

    sortedGroups.forEach(g => {
      const count = g.videoIds.length;
      const row = document.createElement('div');
      row.className = 'stars-group-row';

      const item = makeSidebarItem(g.id, g.name, count);
      item.addEventListener('click', () => {
        activeView = null;
        if (activeGroupIds.has(g.id)) activeGroupIds.delete(g.id); else activeGroupIds.add(g.id);
        renderStarsView();
      });

      const renameBtn = document.createElement('button');
      renameBtn.className = 'stars-group-action';
      renameBtn.title = 'Rename';
      renameBtn.textContent = '✎';
      renameBtn.addEventListener('click', e => {
        e.stopPropagation();
        startRenameGroup(g.id, row);
      });

      const delBtn = document.createElement('button');
      delBtn.className = 'stars-group-action stars-group-delete';
      delBtn.title = 'Delete group';
      delBtn.textContent = '🗑';
      delBtn.addEventListener('click', e => {
        e.stopPropagation();
        if (!confirm(`Delete group "${g.name}"?`)) return;
        groups = groups.filter(x => x.id !== g.id);
        saveGroups();
        activeGroupIds.delete(g.id);
        renderStarsView();
      });

      row.appendChild(item);
      row.appendChild(renameBtn);
      row.appendChild(delBtn);
      sidebar.appendChild(row);
    });

    const newBtn = document.createElement('button');
    newBtn.id = 'stars-new-group-btn';
    newBtn.textContent = '+ New Group';
    newBtn.addEventListener('click', () => startNewGroup(sidebar));
    sidebar.appendChild(newBtn);

    const sortSel = document.createElement('select');
    sortSel.id = 'stars-group-sort';
    sortSel.title = 'Sort groups';
    [['alpha','A – Z'],['count','By count']].forEach(([val, label]) => {
      const opt = document.createElement('option');
      opt.value = val; opt.textContent = label;
      if (val === groupSortOrder) opt.selected = true;
      sortSel.appendChild(opt);
    });
    sortSel.addEventListener('change', () => { groupSortOrder = sortSel.value; renderStarsView(); });
    sidebar.appendChild(sortSel);

    starsViewEl.appendChild(sidebar);

    // ── Main area ─────────────────────────────────────────────────────────────
    const mainArea = document.createElement('div');
    mainArea.id = 'stars-main';

    // ── Build level groups map (used by both lvl view and filter) ─────────────
    const levelGroupMap = {};
    Object.entries(levels).forEach(([id, n]) => {
      if (n != null) { if (!levelGroupMap[n]) levelGroupMap[n] = []; levelGroupMap[n].push(id); }
    });

    const mainHeader = document.createElement('div');
    mainHeader.id = 'stars-main-header';
    mainArea.appendChild(mainHeader);

    // ── Mobile compact header (replaces sidebar on small screens) ─────────────
    const mobileHdr = document.createElement('div');
    mobileHdr.id = 'stars-mobile-header';

    // Top row: title (left) + filter buttons (right) — all in one line
    const mobileTopRow = document.createElement('div');
    mobileHdr.appendChild(mobileTopRow);

    const mobileTitle = document.createElement('div');
    mobileTitle.id = 'stars-mobile-title';
    mobileTopRow.appendChild(mobileTitle);

    const mobileFilters = document.createElement('div');
    mobileFilters.id = 'stars-mobile-filters';
    mobileTopRow.appendChild(mobileFilters);

    function makeFilterBtn(cls, html, title, isActive, onClick) {
      const btn = document.createElement('button');
      btn.className = 'stars-filter-btn ' + cls + (isActive ? ' active' : '');
      btn.innerHTML = html;
      btn.title = title;
      btn.addEventListener('click', e => { e.stopPropagation(); onClick(); });
      return btn;
    }

    // tag — All tagged (the default view)
    const tagSvg = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M21.41 11.58l-9-9A2 2 0 0 0 11 2H4a2 2 0 0 0-2 2v7c0 .55.22 1.05.59 1.42l9 9c.36.36.86.58 1.41.58s1.05-.22 1.41-.59l7-7c.37-.36.59-.86.59-1.41s-.23-1.06-.59-1.42zM5.5 7C4.67 7 4 6.33 4 5.5S4.67 4 5.5 4 7 4.67 7 5.5 6.33 7 5.5 7z"/></svg>';
    mobileFilters.appendChild(makeFilterBtn('stars-filter-tagged', tagSvg, 'All tagged', activeView === '__tagged__', () => {
      activeView = '__tagged__'; activeGroupIds.clear(); activeLvl.clear(); mobileStarsLvlOpen = false; mobileStarsGroupsOpen = false; renderStarsView();
    }));

    // ★ All Stars
    const isAll = activeView === null && activeGroupIds.size === 0 && activeLvl.size === 0 && !mobileStarsLvlOpen;
    mobileFilters.appendChild(makeFilterBtn('stars-filter-all', '★', 'All Stars', isAll, () => {
      activeView = null; activeGroupIds.clear(); activeLvl.clear(); mobileStarsLvlOpen = false; mobileStarsGroupsOpen = false; renderStarsView();
    }));

    // ✦ Super stars
    mobileFilters.appendChild(makeFilterBtn('stars-filter-super', SUPER_STAR_SVG(18), 'Super stars', activeView === '__super__', () => {
      activeView = '__super__'; activeGroupIds.clear(); activeLvl.clear(); mobileStarsLvlOpen = false; mobileStarsGroupsOpen = false; renderStarsView();
    }));

    // 👍 Liked group
    const likedG   = groups.find(g => g.name === 'liked');
    const likedActive = likedG ? activeGroupIds.has(likedG.id) : false;
    const thumbUpSvg  = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M1 21h4V9H1v12zm22-11c0-1.1-.9-2-2-2h-6.31l.95-4.57.03-.32c0-.41-.17-.79-.44-1.06L14.17 1 7.59 7.59C7.22 7.95 7 8.45 7 9v10c0 1.1.9 2 2 2h9c.83 0 1.54-.5 1.84-1.22l3.02-7.05c.09-.23.14-.47.14-.73v-2z"/></svg>';
    mobileFilters.appendChild(makeFilterBtn('stars-filter-thumb-up', thumbUpSvg, 'Liked', likedActive, () => {
      const g = groups.find(x => x.name === 'liked');
      if (!g) return;
      activeView = null; activeLvl.clear(); mobileStarsLvlOpen = false;
      if (activeGroupIds.has(g.id)) activeGroupIds.delete(g.id); else { activeGroupIds.clear(); activeGroupIds.add(g.id); }
      renderStarsView();
    }));

    // 👎 Disliked group
    const dislikedG   = groups.find(g => g.name === 'disliked');
    const dislikedActive = dislikedG ? activeGroupIds.has(dislikedG.id) : false;
    const thumbDownSvg   = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M15 3H6c-.83 0-1.54.5-1.84 1.22l-3.02 7.05c-.09.23-.14.47-.14.73v2c0 1.1.9 2 2 2h6.31l-.95 4.57-.03.32c0 .41.17.79.44 1.06L9.83 23l6.59-6.59c.36-.36.58-.86.58-1.41V5c0-1.1-.9-2-2-2zm4 0v12h4V3h-4z"/></svg>';
    mobileFilters.appendChild(makeFilterBtn('stars-filter-thumb-down', thumbDownSvg, 'Disliked', dislikedActive, () => {
      const g = groups.find(x => x.name === 'disliked');
      if (!g) return;
      activeView = null; activeLvl.clear(); mobileStarsLvlOpen = false;
      if (activeGroupIds.has(g.id)) activeGroupIds.delete(g.id); else { activeGroupIds.clear(); activeGroupIds.add(g.id); }
      renderStarsView();
    }));

    // lvl filter button — tap: toggle inline lvl number strip / long-press: lvl groups view
    const lvlBtnActive = activeLvl.size > 0 || mobileStarsLvlOpen || activeView === '__lvl_groups__';
    const lvlFilterBtn = makeFilterBtn('stars-filter-lvl', 'lvl', 'Level filter (hold for groups)', lvlBtnActive, () => {});
    let _lvlTimer = null;
    lvlFilterBtn.addEventListener('pointerdown', () => {
      _lvlTimer = setTimeout(() => {
        _lvlTimer = null;
        mobileStarsLvlOpen = false;
        activeView = '__lvl_groups__'; activeGroupIds.clear(); activeLvl.clear(); renderStarsView();
      }, 500);
    });
    lvlFilterBtn.addEventListener('pointerup', () => {
      if (_lvlTimer) {
        clearTimeout(_lvlTimer); _lvlTimer = null;
        if (mobileStarsLvlOpen || activeLvl.size > 0) {
          mobileStarsLvlOpen = false; activeLvl.clear();
        } else {
          mobileStarsLvlOpen = true;
        }
        if (activeView === '__lvl_groups__') { activeView = null; activeGroupIds.clear(); }
        renderStarsView();
      }
    });
    lvlFilterBtn.addEventListener('pointercancel', () => { clearTimeout(_lvlTimer); _lvlTimer = null; });
    mobileFilters.appendChild(lvlFilterBtn);

    // "grp" toggle button — opens/closes the group picker panel
    const nonSystemGroups = groups.filter(g => g.name !== 'liked' && g.name !== 'disliked');
    if (nonSystemGroups.length) {
      const grpActiveCount = [...activeGroupIds].filter(id => nonSystemGroups.some(g => g.id === id)).length;
      const grpLabel = grpActiveCount > 0 ? `grp ${grpActiveCount}` : 'grp';
      const grpBtnActive = grpActiveCount > 0 || mobileStarsGroupsOpen;
      const grpBtn = makeFilterBtn('stars-filter-grp', grpLabel, 'Groups', grpBtnActive, () => {
        mobileStarsGroupsOpen = !mobileStarsGroupsOpen;
        renderStarsView();
      });
      mobileFilters.appendChild(grpBtn);

      // Expandable group picker panel (shown when open)
      if (mobileStarsGroupsOpen) {
        const groupWrap = document.createElement('div');
        groupWrap.id = 'stars-mobile-groups-wrap';
        const groupPanel = document.createElement('div');
        groupPanel.id = 'stars-mobile-groups';
        const sortedNS = [...nonSystemGroups].sort((a, b) => {
          if (groupSortOrder === 'count') return b.videoIds.length - a.videoIds.length;
          return a.name.localeCompare(b.name);
        });
        sortedNS.forEach(g => {
          const pill = document.createElement('button');
          pill.className = 'stars-mobile-group-pill' + (activeGroupIds.has(g.id) ? ' active' : '');
          pill.textContent = g.name + (g.videoIds.length ? ` ${g.videoIds.length}` : '');
          pill.addEventListener('click', () => {
            activeView = null; activeLvl.clear();
            if (activeGroupIds.has(g.id)) activeGroupIds.delete(g.id); else activeGroupIds.add(g.id);
            renderStarsView();
          });
          groupPanel.appendChild(pill);
        });
        groupWrap.appendChild(groupPanel);
        mobileHdr.appendChild(groupWrap);
      }
    }

    // Lvl number strip (visible when strip open or a lvl is already selected)
    if (mobileStarsLvlOpen || activeLvl.size > 0) {
      const lvlStrip = document.createElement('div');
      lvlStrip.id = 'stars-mobile-lvl-strip';
      for (let n = 10; n <= 23; n++) {
        const count = Object.keys(levels).filter(id => levels[id] === n).length;
        if (!count) continue;
        const btn = document.createElement('button');
        btn.className = 'stars-filter-btn stars-filter-lvl-num' + (activeLvl.has(n) ? ' active' : '');
        btn.textContent = n;
        btn.title = count + ' video' + (count !== 1 ? 's' : '');
        btn.addEventListener('click', e => {
          e.stopPropagation();
          activeView = null;
          if (activeLvl.has(n)) activeLvl.delete(n); else activeLvl.add(n);
          renderStarsView();
        });
        lvlStrip.appendChild(btn);
      }
      mobileHdr.appendChild(lvlStrip);
    }

    mainArea.insertBefore(mobileHdr, mainHeader);

    const grid = document.createElement('div');
    grid.id = 'stars-grid';

    if (activeView === '__lvl_groups__') {
      // ── Lvl groups view ─────────────────────────────────────────────────────
      const occupiedLvls = Object.keys(levelGroupMap).map(Number).sort((a, b) => a - b);
      mainHeader.innerHTML =
        `<span class="stars-main-title">lvl</span>` +
        `<span class="stars-main-count">${occupiedLvls.length} group${occupiedLvls.length !== 1 ? 's' : ''}</span>`;
      mobileTitle.innerHTML =
        `<span class="stars-main-title">lvl</span><span class="stars-main-count">${occupiedLvls.length} group${occupiedLvls.length !== 1 ? 's' : ''}</span>`;

      if (!occupiedLvls.length) {
        const empty = document.createElement('div');
        empty.id = 'stars-empty';
        empty.textContent = 'No levels assigned yet.';
        grid.appendChild(empty);
      } else {
        occupiedLvls.forEach(n => {
          const ids = levelGroupMap[n];
          // prefer starred video for cover, fall back to guessed local path
          const coverId = ids.find(id => stars[id]) || ids[ids.length - 1];
          const coverSrc = stars[coverId]?.coverSrc || `data/Likes/covers/${coverId}.jpg`;
          const card = document.createElement('div');
          card.className = 'stars-lvl-group-card';
          const img = document.createElement('img');
          img.src = coverSrc; img.className = 'stars-lvl-group-img';
          img.onerror = () => { img.style.display = 'none'; };
          card.appendChild(img);
          const badge = document.createElement('div');
          badge.className = 'stars-lvl-group-badge';
          badge.textContent = n;
          card.appendChild(badge);
          const countEl = document.createElement('div');
          countEl.className = 'stars-lvl-group-count';
          countEl.textContent = ids.length + ' video' + (ids.length !== 1 ? 's' : '');
          card.appendChild(countEl);
          card.addEventListener('click', () => {
            activeView = null; activeGroupIds.clear(); activeLvl.clear(); activeLvl.add(n); renderStarsView();
          });
          grid.appendChild(card);
        });
      }
    } else if (activeView === '__tagged__') {
      // ── All tagged: every video that belongs to at least one group ───────────
      const seen = new Set();
      const baseVideos = [];
      groups.forEach(g => g.videoIds.forEach(id => {
        if (seen.has(id)) return;
        seen.add(id);
        baseVideos.push(stars[id]
          ? { ...stars[id], id }
          : { id, coverSrc: coverSrcFor(id), authorName: '', desc: '', lvlOnly: true });
      }));
      const videosToShow = sortVideos(activeLvl.size > 0
        ? baseVideos.filter(s => activeLvl.has(levels[s.id]))
        : baseVideos, 'stars');

      const countText = `${videosToShow.length} video${videosToShow.length !== 1 ? 's' : ''}`;
      mainHeader.innerHTML =
        `<span class="stars-main-title">All tagged</span><span class="stars-main-count">${countText}</span>`;
      mobileTitle.innerHTML =
        `<span class="stars-main-title">All tagged</span><span class="stars-main-count">${countText}</span>`;

      setStarsContext(videosToShow);
      if (!videosToShow.length) {
        const empty = document.createElement('div');
        empty.id = 'stars-empty';
        empty.innerHTML = activeLvl.size > 0
          ? 'No tagged videos at this level.'
          : 'No tagged videos yet.<br>Use ⊕ or the braces button on a video to add it to a group.';
        grid.appendChild(empty);
      } else {
        fillGrid(grid, videosToShow, star => {
          const info = getVideoInfo(star.id);
          const authorName = info.authorName || star.authorName || '';
          const desc       = info.desc       || star.desc       || '';
          return buildStarsGridCard(star, authorName, desc, null);
        });
      }
    } else if (activeView === '__super__') {
      // ── Super stars: every starred video that was long-pressed into a super star ─────────
      const baseVideos = Object.entries(stars).filter(([, x]) => x.super).map(([key, x]) => ({ ...x, id: key }));
      const videosToShow = sortVideos(activeLvl.size > 0 ? baseVideos.filter(x => activeLvl.has(levels[x.id])) : baseVideos, 'stars');
      const countText = `${videosToShow.length} video${videosToShow.length !== 1 ? 's' : ''}`;
      mainHeader.innerHTML = `<span class="stars-main-title">Super stars</span><span class="stars-main-count">${countText}</span>`;
      mobileTitle.innerHTML = `<span class="stars-main-title">Super stars</span><span class="stars-main-count">${countText}</span>`;
      setStarsContext(videosToShow);
      if (!videosToShow.length) {
        const empty = document.createElement('div');
        empty.id = 'stars-empty';
        empty.textContent = 'No super stars yet. Press and hold a star to make one.';
        grid.appendChild(empty);
      } else {
        fillGrid(grid, videosToShow, star => {
          const info = getVideoInfo(star.id);
          return buildStarsGridCard(star, info.authorName || star.authorName || '', info.desc || star.desc || '', null);
        });
      }
    } else if (activeView === '__disappeared__') {
      // ── Disappeared: every archived video removed from the official lists (tagging does not hide it) ──
      const baseVideos = disappearedIds()
        .map(id => stars[id]
          ? { ...stars[id], id }
          : { id, coverSrc: coverSrcFor(id), authorName: '', desc: '', lvlOnly: true });
      const videosToShow = sortVideos(activeLvl.size > 0
        ? baseVideos.filter(s => activeLvl.has(levels[s.id]))
        : baseVideos, 'stars');

      const countText = `${videosToShow.length.toLocaleString()} video${videosToShow.length !== 1 ? 's' : ''}`;
      mainHeader.innerHTML =
        `<span class="stars-main-title">Disappeared</span><span class="stars-main-count">${countText}</span>`;
      mobileTitle.innerHTML =
        `<span class="stars-main-title">Disappeared</span><span class="stars-main-count">${countText}</span>`;

      setStarsContext(videosToShow);
      if (!videosToShow.length) {
        const empty = document.createElement('div');
        empty.id = 'stars-empty';
        empty.textContent = _dbCache
          ? (activeLvl.size > 0 ? 'No disappeared videos at this level.' : 'No disappeared videos.')
          : 'Loading the archive database…';
        grid.appendChild(empty);
      } else {
        fillGrid(grid, videosToShow, star => {
          const info = getVideoInfo(star.id);
          const authorName = info.authorName || star.authorName || '';
          const desc       = info.desc       || star.desc       || '';
          return buildStarsGridCard(star, authorName, desc, null);
        });
      }
    } else if (activeView === '__ungrouped__') {
      // ── Untagged view (stars and level-only videos that are in no group) ─────
      const groupedIdsSet = new Set(groups.flatMap(g => g.videoIds));
      const ungroupedStars = Object.entries(stars)
        .filter(([id]) => !groupedIdsSet.has(id))
        .map(([key, s]) => ({ ...s, id: key }));
      const lvlOnlyVideos = Object.entries(levels)
        .filter(([id]) => !stars[id] && levels[id] != null && !groupedIdsSet.has(id))
        .map(([id, n]) => ({
          id,
          coverSrc: coverSrcFor(id),
          authorName: '', desc: '', lvlOnly: true
        }));
      const baseVideos = [...ungroupedStars, ...lvlOnlyVideos];
      const videosToShow = sortVideos(activeLvl.size > 0
        ? baseVideos.filter(s => activeLvl.has(levels[s.id]))
        : baseVideos, 'stars');

      mainHeader.innerHTML =
        `<span class="stars-main-title">Untagged</span>` +
        `<span class="stars-main-count">${videosToShow.length} video${videosToShow.length !== 1 ? 's' : ''}</span>`;
      mobileTitle.innerHTML =
        `<span class="stars-main-title">Untagged</span><span class="stars-main-count">${videosToShow.length} video${videosToShow.length !== 1 ? 's' : ''}</span>`;

      setStarsContext(videosToShow);
      if (!videosToShow.length) {
        const empty = document.createElement('div');
        empty.id = 'stars-empty';
        empty.textContent = 'No untagged videos.';
        grid.appendChild(empty);
      } else {
        fillGrid(grid, videosToShow, star => {
          const info = getVideoInfo(star.id);
          const authorName = info.authorName || star.authorName || '';
          const desc       = info.desc       || star.desc       || '';
          const onRemove = star.lvlOnly
            ? () => { delete levels[star.id]; saveLevels(); renderStarsView(); }
            : null;
          return buildStarsGridCard(star, authorName, desc, onRemove);
        });
      }
    } else {
      // ── Normal video grid (all stars or multi-select groups) ─────────────────
      const isAll = activeGroupIds.size === 0;

      let baseVideos;
      if (isAll) {
        // all starred videos + all lvl-only unstarred (when lvl filter active)
        baseVideos = Object.entries(stars).map(([key, s]) => ({ ...s, id: key }));
        if (activeLvl.size > 0) {
          const starredIds = new Set(baseVideos.map(s => s.id));
          const lvlOnly = Object.entries(levels)
            .filter(([id, n]) => !starredIds.has(id) && activeLvl.has(n))
            .map(([id]) => ({ id, coverSrc: coverSrcFor(id), authorName: '', desc: '', lvlOnly: true }));
          baseVideos = [...baseVideos, ...lvlOnly];
        }
      } else {
        // union of all selected groups (starred + lvl-only)
        const seen = new Set();
        baseVideos = [];
        activeGroupIds.forEach(gid => {
          const g = groups.find(x => x.id === gid);
          if (!g) return;
          g.videoIds.forEach(id => {
            if (seen.has(id)) return; seen.add(id);
            if (stars[id]) {
              baseVideos.push({ ...stars[id], id });
            } else {
              baseVideos.push({ id, coverSrc: coverSrcFor(id), authorName: '', desc: '', lvlOnly: true });
            }
          });
        });
      }

      const videosToShow = sortVideos(activeLvl.size > 0
        ? baseVideos.filter(s => activeLvl.has(levels[s.id]))
        : baseVideos, 'stars');

      let titleText;
      if (isAll) titleText = 'All Stars';
      else if (activeGroupIds.size === 1) {
        const gid = [...activeGroupIds][0];
        titleText = groups.find(g => g.id === gid)?.name || 'Group';
      } else titleText = `${activeGroupIds.size} Groups`;

      mainHeader.innerHTML =
        `<span class="stars-main-title">${titleText}</span>` +
        `<span class="stars-main-count">${videosToShow.length} video${videosToShow.length !== 1 ? 's' : ''}</span>`;
      mobileTitle.innerHTML =
        `<span class="stars-main-title">${titleText}</span><span class="stars-main-count">${videosToShow.length} video${videosToShow.length !== 1 ? 's' : ''}</span>`;

      setStarsContext(videosToShow);
      if (!videosToShow.length) {
        const empty = document.createElement('div');
        empty.id = 'stars-empty';
        empty.innerHTML = isAll
          ? 'No starred videos yet.<br>Click ★ on any video in Likes, Favorites, or Following.'
          : 'No videos in this group yet.<br>Star videos and use ⊕ to add them here.';
        grid.appendChild(empty);
      } else {
        fillGrid(grid, videosToShow, star => {
          const info = getVideoInfo(star.id);
          const authorName = info.authorName || star.authorName || '';
          const desc       = info.desc       || star.desc       || '';
          // For unstarred cards in group view: ✕ removes from the selected groups (not the level)
          const onRemove = (star.lvlOnly && !isAll)
            ? () => {
                activeGroupIds.forEach(gid => {
                  const g = groups.find(x => x.id === gid);
                  if (g) g.videoIds = g.videoIds.filter(id => id !== star.id);
                });
                saveGroups(); renderStarsView();
              }
            : null;
          return buildStarsGridCard(star, authorName, desc, onRemove);
        });
      }
    }

    const isVideoGrid = activeView !== '__lvl_groups__';
    if (isVideoGrid) {
      grid.classList.add('preview-grid');
      mainHeader.appendChild(buildGridControls('stars', grid, starsViewEl));
      mobileTopRow.appendChild(buildGridControls('stars', grid, starsViewEl));
      mobileTopRow.appendChild(buildLabelToggle());
    }

    mainArea.appendChild(grid);
    starsViewEl.appendChild(mainArea);
    if (keep) {
      if (grid._fillTo) grid._fillTo(keep.loaded);
      grid.scrollTop = keep.scroll;
    }
    if (isVideoGrid) observeGridPreviews(grid);
  }

  function buildStarsGridCard(star, authorName, desc, onRemoveOverride, noRemove) {
    const card = document.createElement('div');
    card.className = 'stars-grid-card';

    const cover = document.createElement('div');
    cover.className = 'stars-grid-cover';
    attachPreview(cover, star.coverSrc ? getVideoPath(star.coverSrc) : null);
    cover.addEventListener('click', () => openVideo(star.coverSrc));

    const img = document.createElement('img');
    img.src = star.coverSrc;
    img.loading = 'lazy';
    img.onerror = () => { img.style.display = 'none'; };
    cover.appendChild(img);

    const rmBtn = document.createElement('button');
    rmBtn.className = 'stars-grid-remove stars-grid-x';
    const isGlobalView = activeView === null && activeGroupIds.size === 0;
    const isInGroup    = activeView === null && activeGroupIds.size > 0;
    rmBtn.title = onRemoveOverride ? 'Remove level'
      : (isGlobalView || activeView === '__ungrouped__' || activeView === '__super__') ? 'Remove from Stars'
      : 'Remove from group';
    rmBtn.textContent = '✕';
    rmBtn.addEventListener('click', e => {
      e.stopPropagation();
      if (onRemoveOverride) { onRemoveOverride(); return; }
      if (isGlobalView || activeView === '__ungrouped__' || activeView === '__super__') {
        toggleStar(star.id, star.coverSrc);
      } else if (isInGroup) {
        activeGroupIds.forEach(gid => {
          const g = groups.find(x => x.id === gid);
          if (g) { g.videoIds = g.videoIds.filter(id => id !== star.id); }
        });
        saveGroups(); renderStarsView();
      }
    });
    if (!noRemove && activeView !== '__tagged__' && activeView !== '__disappeared__') cover.appendChild(rmBtn);
    cover.appendChild(buildThumbTools(star.id, star.coverSrc, authorName, desc));
    appendLabelBubbles(cover, star.id);

    card.appendChild(cover);
    if (authorName) {
      const a = document.createElement('div');
      a.className = 'stars-grid-author';
      setAuthorLink(a, authorName);
      card.appendChild(a);
    }
    if (desc) {
      const d = document.createElement('div');
      d.className = 'stars-grid-desc';
      d.textContent = desc.length > 80 ? desc.slice(0, 80) + '…' : desc;
      card.appendChild(d);
    }
    return card;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // GROUP PICKER
  // ═══════════════════════════════════════════════════════════════════════════

  function showGroupPicker(anchorBtn, videoId) {
    const targetDoc = anchorBtn.ownerDocument || document;
    targetDoc.getElementById('stars-group-picker')?.remove();

    const picker = document.createElement('div');
    picker.id = 'stars-group-picker';

    const list = document.createElement('div');
    list.className = 'grp-picker-list';

    const buildRows = () => {
      list.innerHTML = '';
      const sorted = [...groups].sort((a, b) => b.videoIds.length - a.videoIds.length);
      if (!sorted.length) {
        const empty = document.createElement('div');
        empty.className = 'grp-picker-empty';
        empty.textContent = 'No groups yet';
        list.appendChild(empty);
      }
      sorted.forEach(g => {
        const row = document.createElement('label');
        row.className = 'grp-picker-row';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = g.videoIds.includes(videoId);
        cb.addEventListener('change', () => {
          if (cb.checked) { if (!g.videoIds.includes(videoId)) g.videoIds.push(videoId); }
          else g.videoIds = g.videoIds.filter(id => id !== videoId);
          saveGroups();
          if (starsTabActive) renderStarsView();
        });
        const nameSpan = document.createElement('span');
        nameSpan.className = 'grp-picker-name';
        nameSpan.textContent = g.name;
        const countSpan = document.createElement('span');
        countSpan.className = 'grp-picker-count';
        countSpan.textContent = g.videoIds.length;
        row.appendChild(cb); row.appendChild(nameSpan); row.appendChild(countSpan);
        list.appendChild(row);
      });
    };
    buildRows();
    picker.appendChild(list);

    // ＋ New group inline form
    const newRow = document.createElement('div');
    newRow.className = 'grp-picker-new-row';
    const addBtn = document.createElement('button');
    addBtn.className = 'grp-picker-add-btn';
    addBtn.textContent = '＋ New group';
    addBtn.addEventListener('click', e => {
      e.stopPropagation();
      addBtn.style.display = 'none';
      inp.style.display = 'flex';
      inp.querySelector('input').focus();
    });
    const inp = document.createElement('div');
    inp.className = 'grp-picker-inp';
    inp.style.display = 'none';
    const field = document.createElement('input');
    field.type = 'text'; field.placeholder = 'Group name'; field.maxLength = 40;
    const ok = document.createElement('button');
    ok.textContent = '✓'; ok.className = 'grp-picker-ok';
    const commit = () => {
      const name = field.value.trim();
      if (name) {
        const newG = { id: (Math.random().toString(36).slice(2)), name, videoIds: [videoId] };
        groups.push(newG);
        saveGroups();
        if (starsTabActive) renderStarsView();
        buildRows();
      }
      field.value = '';
      inp.style.display = 'none';
      addBtn.style.display = '';
    };
    ok.addEventListener('click', commit);
    field.addEventListener('keydown', e => { if (e.key === 'Enter') commit(); e.stopPropagation(); });
    inp.appendChild(field); inp.appendChild(ok);
    newRow.appendChild(addBtn); newRow.appendChild(inp);
    picker.appendChild(newRow);

    targetDoc.body.appendChild(picker);
    const rect = anchorBtn.getBoundingClientRect();
    const pw = picker.offsetWidth || 180;
    const ph = picker.offsetHeight || 120;
    picker.style.top  = Math.max(4, Math.min(rect.top + rect.height / 2 - ph / 2, window.innerHeight - ph - 8)) + 'px';
    picker.style.left = Math.max(4, rect.left - pw - 6) + 'px';

    setTimeout(() => {
      targetDoc.addEventListener('click', function h(e) {
        if (!picker.contains(e.target)) { picker.remove(); targetDoc.removeEventListener('click', h); }
      });
    }, 0);
  }

  function showLevelPicker(anchorBtn, videoId, onUpdate) {
    const targetDoc = anchorBtn.ownerDocument || document;
    targetDoc.getElementById('level-picker')?.remove();

    const picker = document.createElement('div');
    picker.id = 'level-picker';

    const currentLvl = levels[videoId] ?? null;

    for (let n = 10; n <= 23; n++) {
      const btn = document.createElement('button');
      btn.className = 'lvl-picker-btn' + (currentLvl === n ? ' cur' : '');
      btn.textContent = n;
      btn.addEventListener('click', () => {
        if (currentLvl === n) { delete levels[videoId]; saveLevels(); onUpdate(null); }
        else { levels[videoId] = n; saveLevels(); onUpdate(n); }
        picker.remove();
      });
      picker.appendChild(btn);
    }

    targetDoc.body.appendChild(picker);
    const rect = anchorBtn.getBoundingClientRect();
    const pw = picker.offsetWidth || 120;
    const ph = picker.offsetHeight || 120;
    picker.style.top  = Math.max(4, rect.top + rect.height / 2 - ph / 2) + 'px';
    picker.style.left = Math.max(4, rect.left - pw - 6) + 'px';

    setTimeout(() => {
      targetDoc.addEventListener('click', function h(e) {
        if (!picker.contains(e.target) && e.target !== anchorBtn) {
          picker.remove(); targetDoc.removeEventListener('click', h);
        }
      });
    }, 0);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // GROUP CRUD
  // ═══════════════════════════════════════════════════════════════════════════

  function startNewGroup(sidebar) {
    const existing = sidebar.querySelector('#stars-new-group-btn');
    if (!existing) return;
    const form = document.createElement('div');
    form.className = 'stars-inline-form';
    const input = document.createElement('input');
    input.type = 'text'; input.placeholder = 'Group name';
    input.className = 'stars-inline-input'; input.maxLength = 40;
    const ok = document.createElement('button'); ok.textContent = '✓'; ok.className = 'stars-inline-confirm';
    const cancel = document.createElement('button'); cancel.textContent = '✕'; cancel.className = 'stars-inline-cancel';
    function commit() {
      const name = input.value.trim();
      if (name) { groups.push({ id: uid(), name, videoIds: [] }); saveGroups(); }
      renderStarsView();
    }
    ok.addEventListener('click', commit);
    cancel.addEventListener('click', () => renderStarsView());
    input.addEventListener('keydown', e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') renderStarsView(); });
    form.appendChild(input); form.appendChild(ok); form.appendChild(cancel);
    existing.replaceWith(form);
    input.focus();
  }

  function startRenameGroup(groupId, rowEl) {
    const nameSpan = rowEl.querySelector('.stars-group-name');
    const g = groups.find(x => x.id === groupId);
    if (!nameSpan || !g) return;
    const input = document.createElement('input');
    input.type = 'text'; input.value = g.name;
    input.className = 'stars-inline-input'; input.maxLength = 40; input.style.width = '100%';
    function commit() { const name = input.value.trim(); if (name) { g.name = name; saveGroups(); } renderStarsView(); }
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') input.blur(); if (e.key === 'Escape') renderStarsView(); });
    nameSpan.replaceWith(input);
    input.select();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PLAYER — VIDEO LIST
  // ═══════════════════════════════════════════════════════════════════════════

  let playerOpen           = false;
  let playerVideoList      = [];
  let playerWinStart       = 0;     // index in playerVideoList of the first rendered phone-feed slide
  let playerColumnOffsets  = [];   // one index per column, independently navigable
  let playerViewEl         = null;  // mobile tab-view element (like starsViewEl)
  let playerReturnTab      = null;  // tab to return to when player is closed via X button
  let playerStartId        = null;  // if set, player will start at this video ID
  let recentsGridEl        = null;  // custom recents grid element
  let recentsGridBuilt     = false; // true once grid has been populated

  // ── Mobile tab state ───────────────────────────────────────────────────────
  const MOBILE_TABS = ['home', 'stars', 'recents', 'favs', 'review'];
  let activeMobileTab = 'home';    // the phone app opens on the Home feed (see showDefaultStarsView)

  function updateMobileNavActive() {
    document.querySelectorAll('#sp-mobile-nav .sp-nav-btn').forEach(btn => {
      btn.classList.toggle('sp-active', btn.dataset.tab === activeMobileTab);
    });
  }

  function setMobileTab(tab, skipAnim) {
    if (settingsTabActive) hideSettingsView();
    if (listTabKind && tab !== 'favs') hideListView();
    // Leaving the Home feed: remember the list and the video the user was on, so coming back resumes there
    if (tab !== 'home' && activeMobileTab === 'home' && playerOpen && !playerReturnTab && !homeStash && playerVideoList.length) {
      homeResume = { list: playerVideoList, pos: playerColumnOffsets[0] || 0, pool: homeFeedPool };
      spTrace('home: left at ' + homeResume.pos);
    }
    if (homeStash) {
      if (playerOpen) closePlayer();
      if (tab === 'home') restoreHomeStash(); else dropHomeStash();
    }
    if (activeAuthorId) hideAuthorView(false);
    if (autotagTabActive && tab !== 'review') hideAutotagView();
    if (tab !== 'stars') releaseGridPreviews(starsViewEl);
    const oldIdx = MOBILE_TABS.indexOf(activeMobileTab);
    const newIdx = MOBILE_TABS.indexOf(tab);
    activeMobileTab = tab;
    updateMobileNavActive();
    if (tab === 'home') {
      hideRecentsView();
      showMainContent();
      if (!playerOpen) {
        openPlayer();
      } else {
        if (playerViewEl) playerViewEl.style.display = '';
      }
    } else if (tab === 'stars') {
      if (playerOpen) closePlayer();
      hideRecentsView();
      showStarsTab();
    } else if (tab === 'recents') {
      if (playerOpen) closePlayer();
      showRecentsView();
    } else if (tab === 'review') {
      if (playerOpen) closePlayer();
      hideRecentsView();
      showAutotagTab();
    } else {
      // favs: the Library (Likes, Favorites, Following)
      if (playerOpen) closePlayer();
      hideRecentsView();
      showListTab(listTabKind || 'bookmarked');
    }
    if (!skipAnim) {
      requestAnimationFrame(() => applySwipeEnter(getSwipeViewEl(), newIdx > oldIdx ? 'left' : 'right'));
    }
  }

  // ── Crash breadcrumbs ─────────────────────────────────────────────────────
  // A page iOS kills for memory leaves no error. The last steps are kept in localStorage, and if the
  // previous visit never said goodbye (hidden/unloaded) a banner shows them on the next load.
  function spTrace(msg) {
    try {
      const t = JSON.parse(localStorage.getItem('sp_trace') || '[]');
      t.push(new Date().toISOString().slice(11, 23) + ' ' + msg);
      while (t.length > 40) t.shift();
      localStorage.setItem('sp_trace', JSON.stringify(t));
    } catch (_) {}
  }
  function setupCrashWatch() {
    let was = false;
    try { was = localStorage.getItem('sp_alive') === '1'; localStorage.setItem('sp_alive', '1'); } catch (_) {}
    const alive = v => { try { localStorage.setItem('sp_alive', v ? '1' : '0'); } catch (_) {} };
    document.addEventListener('visibilitychange', () => { alive(document.visibilityState === 'visible'); spTrace('vis ' + document.visibilityState); });
    window.addEventListener('pagehide', () => { alive(false); spTrace('pagehide'); });
    window.addEventListener('error', e => spTrace('ERR ' + e.message + ' @' + (e.lineno || '')));
    window.addEventListener('unhandledrejection', e => spTrace('REJ ' + String(e.reason).slice(0, 120)));
    if (!was) return;
    let t = [];
    try { t = JSON.parse(localStorage.getItem('sp_trace') || '[]'); } catch (_) {}
    const box = document.createElement('div');
    box.id = 'sp-crash';
    box.innerHTML = '<b>The page reloaded unexpectedly.</b> Last steps:<pre></pre><button>Dismiss</button>';
    box.querySelector('pre').textContent = t.slice(-14).join('\n') || '(nothing recorded)';
    box.querySelector('button').addEventListener('click', () => box.remove());
    document.body.appendChild(box);
  }

  // Let the page draw under the notch/status bar (viewport-fit=cover) and, when added to the Home Screen,
  // use a translucent status bar so the video runs edge to edge.
  function setupPhoneChrome() {
    const meta = (name, content) => {
      let m = document.querySelector(`meta[name="${name}"]`);
      if (!m) { m = document.createElement('meta'); m.name = name; document.head.appendChild(m); }
      m.content = content;
      return m;
    };
    let vp = document.querySelector('meta[name="viewport"]');
    if (!vp) vp = meta('viewport', 'width=device-width, initial-scale=1');
    if (!/viewport-fit/.test(vp.content)) vp.content += ', viewport-fit=cover';
    meta('apple-mobile-web-app-capable', 'yes');
    meta('mobile-web-app-capable', 'yes');
    meta('apple-mobile-web-app-status-bar-style', 'black-translucent');
    meta('theme-color', '#000000');
    setupCrashWatch();
  }

  // Hidden diagnostics (long-press the Home tab): is the page full screen, and how big is the notch inset?
  function showDeviceInfo() {
    document.getElementById('sp-devinfo')?.remove();
    const probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;left:0;top:0;visibility:hidden;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)';
    document.body.appendChild(probe);
    const cs = getComputedStyle(probe);
    const ins = [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft].join(' / ');
    probe.remove();
    const meta = n => (document.querySelector(`meta[name="${n}"]`) || {}).content || '(none)';
    const rect = sel => { const e = document.querySelector(sel); if (!e) return 'n/a'; const r = e.getBoundingClientRect(); return `top ${Math.round(r.top)} h ${Math.round(r.height)}`; };
    const vv = window.visualViewport;
    const lines = [
      'standalone: ' + (navigator.standalone === true) + ' | display-mode standalone: ' + (window.matchMedia && matchMedia('(display-mode: standalone)').matches),
      'viewport: ' + meta('viewport'),
      'status bar: ' + meta('apple-mobile-web-app-status-bar-style') + ' | capable: ' + meta('apple-mobile-web-app-capable'),
      'safe inset t/r/b/l: ' + ins,
      'inner: ' + innerWidth + 'x' + innerHeight + ' | screen: ' + screen.width + 'x' + screen.height + (vv ? ' | visual: ' + Math.round(vv.width) + 'x' + Math.round(vv.height) : ''),
      'player-view: ' + rect('#player-view') + ' | nav: ' + rect('#sp-mobile-nav'),
      'events: ' + ((() => { try { return JSON.parse(localStorage.getItem('sp_trace') || '[]').slice(-6).join(' | ') || '(none)'; } catch (_) { return '?'; } })()),
      'loops: ' + ((() => { try { return JSON.parse(localStorage.getItem('sp_looplog') || '[]').slice(-5).join(' | ') || '(none yet)'; } catch (_) { return '?'; } })()),
      'ua: ' + (navigator.userAgent.match(/OS [\d_]+|Version\/[\d.]+/g) || []).join(' ')
    ];
    const box = document.createElement('div');
    box.id = 'sp-devinfo';
    box.innerHTML = '<b>Device info</b><pre></pre><button>Close</button>';
    box.querySelector('pre').textContent = lines.join('\n');
    box.querySelector('button').addEventListener('click', () => box.remove());
    document.body.appendChild(box);
  }

  function createMobileNav() {
    if (document.getElementById('sp-mobile-nav')) return;
    const nav = document.createElement('div');
    nav.id = 'sp-mobile-nav';
    const tabs = [
      { id: 'home',    label: 'Home',    svg: '<path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z"/>' },
      { id: 'stars',   label: 'Stars',   svg: '<path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>' },
      { id: 'recents', label: 'Recents', svg: '<path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zm4.24 16L11 13.5V7h1.5v5.87l4.75 2.82-1.01 1.74z"/>' },
      { id: 'favs',    label: 'Library',    svg: '<path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/>' },
      { id: 'review',  label: 'Review',  svg: '<path d="M9 16.2L4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2z"/>' },
    ];
    tabs.forEach(({ id, label, svg }) => {
      const btn = document.createElement('button');
      btn.className = 'sp-nav-btn' + (id === activeMobileTab ? ' sp-active' : '');
      btn.dataset.tab = id;
      btn.innerHTML = `<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor">${svg}</svg><span>${label}</span>`;
      let held = false, holdTimer = null;
      if (id === 'home') {
        // Press and hold the Home tab: a small fan with the feed orders; slide onto one and let go to pick it
        let fan = null, fanItems = [], hover = -1;
        const closeFan = () => { if (fan) fan.remove(); fan = null; fanItems = []; hover = -1; };
        const openFan = () => {
          const r = btn.getBoundingClientRect();
          const cur = feedMode();
          fan = document.createElement('div');
          fan.className = 'sp-fan';
          const opts = [['ranked', '★ Ranked'], ['shuffle', '⤨ Shuffle']];
          fanItems = opts.map(([value, label], i) => {
            const el = document.createElement('div');
            el.className = 'sp-fan-item' + (value === cur ? ' on' : '');
            el.textContent = (value === cur ? '✓ ' : '') + label;
            el.style.left = Math.max(10, r.left + r.width / 2 - 24) + 'px';
            el.style.top = (r.top - 26 - 46 * i) + 'px';
            el.addEventListener('click', () => { closeFan(); if (value !== feedMode()) setFeedMode(value); });
            fan.appendChild(el);
            return { value, el };
          });
          fan.addEventListener('click', e => { if (e.target === fan) closeFan(); });   // tap outside the options
          document.body.appendChild(fan);
          try { navigator.vibrate && navigator.vibrate(12); } catch (_) {}
        };
        const track = (x, y) => {
          let h = -1;
          fanItems.forEach((it, i) => {
            const b = it.el.getBoundingClientRect();
            if (x >= b.left - 8 && x <= b.right + 8 && y >= b.top - 10 && y <= b.bottom + 10) h = i;
          });
          if (h !== hover) { hover = h; fanItems.forEach((it, i) => it.el.classList.toggle('hot', i === h)); }
        };
        btn.addEventListener('pointerdown', e => {
          held = false; clearTimeout(holdTimer);
          try { btn.setPointerCapture(e.pointerId); } catch (_) {}
          holdTimer = setTimeout(() => { held = true; openFan(); }, 420);
        });
        btn.addEventListener('pointermove', e => { if (fan) track(e.clientX, e.clientY); });
        btn.addEventListener('pointerup', () => {
          clearTimeout(holdTimer);
          if (!fan) return;
          const pick = fanItems[hover];
          if (pick) { closeFan(); if (pick.value !== feedMode()) setFeedMode(pick.value); return; }
          // let go without sliding onto an option (the tab bar is too low to drag up from): keep the menu open to tap
          fan.classList.add('sticky');
        });
        ['pointercancel'].forEach(t => btn.addEventListener(t, () => { clearTimeout(holdTimer); closeFan(); }));
        btn.addEventListener('contextmenu', e => e.preventDefault());
      }
      btn.addEventListener('click', () => { if (held) { held = false; return; } setMobileTab(id); });
      nav.appendChild(btn);
    });
    document.body.appendChild(nav);
  }

  const TAB_LABELS = { home: 'Home', stars: 'Stars', recents: 'Recents', favs: 'Library', review: 'Review' };

  function getSwipeViewEl() {
    if (activeMobileTab === 'home')    return playerViewEl;
    if (activeMobileTab === 'stars')   return document.getElementById('stars-view');
    if (activeMobileTab === 'recents') return recentsGridEl;
    if (activeMobileTab === 'review')  return autotagViewEl;
    if (activeMobileTab === 'favs') return listViewEl;
    return document.querySelector('main');
  }

  function applySwipeEnter(el, dir) {
    if (!el) return;
    const cls = dir === 'left' ? 'sp-enter-from-right' : 'sp-enter-from-left';
    el.classList.remove('sp-enter-from-right', 'sp-enter-from-left');
    void el.offsetWidth;
    el.classList.add(cls);
    el.addEventListener('animationend', () => el.classList.remove(cls), { once: true });
  }

  function doSwipe(newTab, dir, outEl) {
    if (outEl) {
      outEl.style.transition = 'transform 0.22s ease';
      outEl.style.transform = `translateX(${dir === 'left' ? -110 : 110}vw)`;
      setTimeout(() => {
        outEl.style.transition = '';
        outEl.style.transform = '';
        setMobileTab(newTab, true);
        requestAnimationFrame(() => applySwipeEnter(getSwipeViewEl(), dir));
      }, 220);
    } else {
      setMobileTab(newTab, true);
      requestAnimationFrame(() => applySwipeEnter(getSwipeViewEl(), dir));
    }
  }

  function showSwipeHint(dx, fromIdx) {
    let hint = document.getElementById('sp-swipe-hint');
    if (!hint) return;
    const isNext = dx < 0;
    const targetIdx = fromIdx + (isNext ? 1 : -1);
    if (targetIdx < 0 || targetIdx >= MOBILE_TABS.length) {
      hint.style.opacity = '0'; return;
    }
    hint.querySelector('.sp-sh-label').textContent = TAB_LABELS[MOBILE_TABS[targetIdx]];
    hint.querySelector('.sp-sh-arrow').textContent = isNext ? '›' : '‹';
    hint.style.left   = isNext ? 'auto' : '0';
    hint.style.right  = isNext ? '0'    : 'auto';
    hint.style.borderRadius = isNext ? '10px 0 0 10px' : '0 10px 10px 0';
    hint.style.opacity = String(Math.min(1, Math.abs(dx) / 80));
  }

  function hideSwipeHint() {
    const hint = document.getElementById('sp-swipe-hint');
    if (hint) { hint.style.opacity = '0'; }
  }

  function initSwipeHint() {
    if (document.getElementById('sp-swipe-hint')) return;
    const hint = document.createElement('div');
    hint.id = 'sp-swipe-hint';
    hint.innerHTML = '<span class="sp-sh-arrow"></span><span class="sp-sh-label"></span>';
    document.body.appendChild(hint);
  }

  // The video in the phone feed that is currently showing, and who posted it
  function feedAuthorName() {
    const item = playerVideoList[playerColumnOffsets[0] || 0];
    if (!item) return '';
    const info = getVideoInfo(item.id);
    return (info && info.authorName) || item.authorName || '';
  }

  // ── Browser history ↔ phone overlays ──────────────────────────────────────
  // iOS treats a swipe right from the screen edge as "back". Every overlay (a username page, a video opened
  // from a grid) therefore owns a history entry, so that gesture closes the overlay instead of leaving the page.
  const navStack = [];
  let navIgnorePop = 0;
  function navPush(kind) {
    if (!isMobilePlayer() || navStack.includes(kind)) return;
    try { history.pushState({ sp: kind }, ''); navStack.push(kind); } catch (_) {}
  }
  // The overlay was closed by our own UI: take its history entry away again (quietly)
  function navPopQuiet(kind) {
    const i = navStack.lastIndexOf(kind);
    if (i < 0) return;
    const top = i === navStack.length - 1;
    navStack.splice(i, 1);
    if (top) { navIgnorePop++; try { history.back(); } catch (_) { navIgnorePop--; } }
  }
  window.addEventListener('popstate', () => {
    if (navIgnorePop > 0) { navIgnorePop--; return; }
    const kind = navStack.pop();
    if (kind === 'author' && authorViewOpen()) closeAuthorTab(activeAuthorId);
    else if (kind === 'player' && playerReturnTab) closeReturnPlayer();
  });

  // Slide a top view (and the view under it, with a little parallax) to x px from the left edge.
  // x = innerWidth: top view fully off to the right; x = 0: fully covering the screen.
  function dragPair(top, under, x) {
    const W = window.innerWidth || 1;
    if (top) { top._spx = x; top.style.transition = 'none'; top.style.transform = `translateX(${x}px)`; }
    if (under) { under.style.transition = 'none'; under.style.transform = `translateX(${-(W - x) * 0.3}px)`; }
  }

  // Finish a drag: glide to x with per-frame transforms (the same thing the drag itself does; a CSS transition
  // on these two full-screen layers made some phones drop the page), then tidy up and call done
  function settlePair(top, under, x, done) {
    const W = window.innerWidth || 1;
    const x0 = top && top._spx != null ? top._spx : (x === 0 ? W : 0);
    const t0 = performance.now(), dur = 240;
    let over = false;
    const finish = () => {
      if (over) return;
      over = true;
      [top, under].forEach(n => { if (n) { n.style.transition = ''; n.style.transform = ''; } });
      if (top) top._spx = null;
      if (done) done();
    };
    const frame = now => {
      if (over) return;
      const k = Math.min(1, (now - t0) / dur);
      dragPair(top, under, x0 + (x - x0) * (1 - Math.pow(1 - k, 3)));
      if (k < 1) requestAnimationFrame(frame); else finish();
    };
    requestAnimationFrame(frame);
    setTimeout(finish, dur + 150);   // frames can stall (hidden tab); never leave the page half-way
  }

  function dragAuthorTo(x) { dragPair(authorViewEl, getSwipeViewEl(), x); }
  function settleAuthorTo(x, done) { settlePair(authorViewEl, getSwipeViewEl(), x, done); }

  // A video opened from a grid (username page, Stars, Recents, Review) sits on top of that view
  function returnPlayerUnder() { return playerReturnTab === '__author__' ? authorViewEl : getSwipeViewEl(); }
  // A video opened from a grid reuses the player container; park the Home feed so it comes back as it was
  // (same videos, same place) instead of being rebuilt from the top.
  let homeStash = null;
  function stashHomeFeed() {
    const el = playerViewEl;
    if (!el) return;
    const feedEl = el.querySelector('#player-feed');
    if (endFeedVisit) endFeedVisit();
    el.querySelectorAll('video').forEach(v => v.pause());
    homeStash = { el, list: playerVideoList, offsets: playerColumnOffsets, win: playerWinStart, endVisit: endFeedVisit, feedEl };
    el.style.visibility = 'hidden';
    el.style.pointerEvents = 'none';
    playerViewEl = null;
  }
  function restoreHomeStash() {
    const h = homeStash;
    if (!h) return;
    homeStash = null;
    if (playerViewEl && playerViewEl !== h.el) playerViewEl.remove();
    playerViewEl = h.el;
    h.el.style.visibility = '';
    h.el.style.pointerEvents = '';
    h.el.style.zIndex = '';
    h.el.style.display = 'flex';
    playerVideoList = h.list; playerColumnOffsets = h.offsets; playerWinStart = h.win; endFeedVisit = h.endVisit;
    playerOpen = true;
    if (!authorViewOpen()) h.el.querySelectorAll('video')[(h.offsets[0] || 0) - h.win]?.play().catch(() => {});
  }
  function dropHomeStash() {
    if (!homeStash) return;
    homeStash.el.remove();
    homeStash = null;
  }

  function closeReturnPlayer() {
    const rt = playerReturnTab;
    closePlayer();
    playerReturnTab = null;
    restoreHomeStash();
    if (rt && rt !== '__author__') setMobileTab(rt, true);
  }

  // While a sideways pull is under way the feed must not scroll up or down
  function lockFeed(on) {
    const f = playerViewEl && playerViewEl.querySelector('#player-feed');   // the visible player, not a parked one
    if (f) f.style.overflowY = on ? 'hidden' : '';
  }

  // Swipe right on a username page: slide it away and go back to what was underneath
  function swipeBackFromAuthor() {
    const id = activeAuthorId;
    if (!authorViewEl || !id) return;
    spTrace('swipe back');
    settleAuthorTo(window.innerWidth || 1, () => { spTrace('settled'); closeAuthorTab(id); spTrace('closed'); });
  }

  function setupMobileSwipe() {
    initSwipeHint();
    // _ctx: where the touch started. 'author' = a username page (drag right = pull it off),
    // 'feed' = the video feed (drag left = pull that user's page over), 'tabs' = the usual tab swipes,
    // 'none' = controls such as the size slider or the seek bar, which must not be mistaken for a swipe.
    let _tsx = 0, _tsy = 0, _tt = 0, _swipeDir = null, _swiping = false, _outEl = null, _ctx = 'tabs', _pull = null, _under = null;

    document.addEventListener('touchstart', e => {
      _tsx = e.touches[0].clientX;
      _tsy = e.touches[0].clientY;
      _tt = Date.now();
      _swipeDir = null; _swiping = false; _pull = null; _under = null;
      const t = e.target;
      if (t.closest && t.closest('input, .grid-controls, select, textarea, .sp-seek, .sp-tag-btn, .sp-sheet, .sp-sheet-back, .sp-radial, #settings-view')) _ctx = 'none';
      else if (authorViewOpen() && authorViewEl.contains(t)) _ctx = 'author';
      else if (playerViewEl && playerViewEl.style.display !== 'none' && playerViewEl.contains(t)) _ctx = playerReturnTab ? 'pr' : 'feed';
      else _ctx = 'tabs';
      _outEl = _ctx === 'author' ? authorViewEl : getSwipeViewEl();
    }, { passive: true });

    document.addEventListener('touchmove', e => {
      if (_ctx === 'none') return;
      const dx = e.touches[0].clientX - _tsx;
      const dy = e.touches[0].clientY - _tsy;
      if (!_swipeDir && (Math.abs(dx) > 8 || Math.abs(dy) > 8))
        _swipeDir = Math.abs(dx) > Math.abs(dy) ? 'h' : 'v';
      if (_swipeDir !== 'h') return;
      const W = window.innerWidth || 1;
      if (_ctx === 'author') {          // the page follows the finger; only a rightward drag does anything
        if (dx > 0) { _swiping = true; if (e.cancelable) e.preventDefault(); dragAuthorTo(Math.min(W, dx)); }
        return;
      }
      if (_ctx === 'pr') {              // a video opened from a grid: drag it off to the right to go back
        if (dx > 0) {
          if (!_under) _under = returnPlayerUnder();
          _swiping = true; lockFeed(true); if (e.cancelable) e.preventDefault();
          dragPair(playerViewEl, _under, Math.min(W, dx));
        }
        return;
      }
      if (_ctx === 'feed' && (dx < 0 || _pull)) {   // leftward drag on a video: the user's page rides in from the right
        if (!_pull) {
          const name = feedAuthorName();
          const id = _dbCache && name ? authorIdForName(name) : null;
          if (!id) return;
          _pull = { id, wasOpen: openAuthors.some(a => a.id === id) };
          spTrace('pull start');
          showAuthorTab(id, name);
          spTrace('pull shown');
        }
        _swiping = true; lockFeed(true); if (e.cancelable) e.preventDefault();
        dragAuthorTo(Math.max(0, Math.min(W, W + dx)));
        return;
      }
      const idx = MOBILE_TABS.indexOf(activeMobileTab);
      if ((dx < 0 && idx >= MOBILE_TABS.length - 1) || (dx > 0 && idx <= 0)) return;
      _swiping = true;
      if (_outEl) _outEl.style.transform = `translateX(${dx * 0.35}px)`;
      showSwipeHint(dx, idx);
    }, { passive: false });

    function endTouch(dx, dy) {
      lockFeed(false);
      hideSwipeHint();
      if (_ctx === 'none') return;
      const W = window.innerWidth || 1;
      const vel = dx / Math.max(1, Date.now() - _tt);
      spTrace('touch end ' + _ctx + ' dx=' + Math.round(dx));   // px per ms; fast flicks commit even when short
      if (_ctx === 'author') {
        if (!_swiping) return;
        if (dx > W * 0.3 || (dx > 40 && vel > 0.5)) swipeBackFromAuthor();
        else settleAuthorTo(0);
        return;
      }
      if (_ctx === 'pr') {
        if (!_swiping) return;
        const u = _under;
        if (dx > W * 0.3 || (dx > 40 && vel > 0.5)) settlePair(playerViewEl, u, W, closeReturnPlayer);
        else settlePair(playerViewEl, u, 0);
        return;
      }
      if (_pull) {
        const p = _pull;
        _pull = null;
        if (-dx > W * 0.3 || (-dx > 40 && vel < -0.5)) {
          settleAuthorTo(0);            // user page now covers the screen
        } else {
          settleAuthorTo(W, () => { if (p.wasOpen) hideAuthorView(true); else closeAuthorTab(p.id); });
        }
        return;
      }
      if (!_swiping) return;
      if (Math.abs(dx) < 60 || Math.abs(dx) <= Math.abs(dy)) {
        // snap back
        if (_outEl) { _outEl.style.transition = 'transform 0.2s ease'; _outEl.style.transform = ''; setTimeout(() => { if (_outEl) _outEl.style.transition = ''; }, 200); }
        return;
      }
      const idx = MOBILE_TABS.indexOf(activeMobileTab);
      const newTab = dx < 0 ? MOBILE_TABS[idx + 1] : MOBILE_TABS[idx - 1];
      if (!newTab) { if (_outEl) { _outEl.style.transform = ''; } return; }
      doSwipe(newTab, dx < 0 ? 'left' : 'right', _outEl);
    }
    document.addEventListener('touchend', e => {
      endTouch(e.changedTouches[0].clientX - _tsx, e.changedTouches[0].clientY - _tsy);
    }, { passive: true });
    document.addEventListener('touchcancel', () => endTouch(0, 0), { passive: true });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PLAYER — OVERLAY
  // ═══════════════════════════════════════════════════════════════════════════

  function isMobilePlayer() { return window.innerWidth < 768; }

  // ═══════════════════════════════════════════════════════════════════════════
  // RECENTS GRID (mobile) — the most recent likes as a cover grid
  // ═══════════════════════════════════════════════════════════════════════════

  async function showRecentsView() {
    if (!recentsGridEl) {
      recentsGridEl = document.createElement('div');
      recentsGridEl.id = 'recents-grid-view';
      document.body.appendChild(recentsGridEl);
    }
    recentsGridEl.style.display = 'flex';
    if (recentsGridBuilt) return;

    recentsGridEl.innerHTML = '<div id="recents-grid-loading">Loading…</div>';
    await archiveDbPromise().catch(() => {});
    const ids = collectionItems('likes', 'official').map(v => v.id);
    recentsGridEl.innerHTML = '';

    // Build context list for the video overlay (same shape as stars context)
    const contextList = ids.map(id => ({
      id,
      coverSrc:  `data/Likes/covers/${id}.jpg`,
      videoPath: `data/Likes/videos/${id}.mp4`,
      authorName: '', desc: '',
    }));

    // ── Stats overlay (shown/hidden by button) ──────────────────────────────
    const statsOverlay = document.createElement('div');
    statsOverlay.id = 'recents-stats-overlay';

    const statsBtn = document.createElement('button');
    statsBtn.id = 'recents-stats-btn';
    statsBtn.textContent = '📈';
    statsBtn.title = 'Stats';
    statsBtn.addEventListener('click', e => {
      e.stopPropagation();
      const open = statsOverlay.classList.toggle('recents-stats-open');
      if (open) {
        statsOverlay.innerHTML = '';

        // ── Stats from the archive database
        const lk = _dbCache && _dbCache.likes;
        const total      = (lk && lk.total) || ids.length;
        const downloaded = (lk && lk.downloaded && lk.downloaded.length) || 0;

        // disappeared = downloaded videos no longer in the official list
        let disappeared = 0;
        if (lk && lk.downloaded && lk.officialList && lk.officialList.length) {
          const offSet = new Set(lk.officialList);
          disappeared = lk.downloaded.filter(n => !offSet.has(n)).length;
        }

        // date from lastRun (seconds or milliseconds)
        let lastRunDate = null;
        if (lk && lk.lastRun) {
          const ts = Math.max(lk.lastRun.start || 0, lk.lastRun.finish || 0);
          if (ts > 0) lastRunDate = ts;
        }

        // ── Render stats row ─────────────────────────────────────────────────
        const p = document.createElement('p');
        p.style.cssText = 'display:flex;gap:14px;flex-wrap:wrap;align-items:center;margin:0;padding:12px 16px;font-size:14px;color:#ccc;';

        const mkSpan = (text, clickFn) => {
          const s = document.createElement('span');
          s.textContent = text;
          if (clickFn) { s.style.cssText = 'cursor:pointer;text-decoration:underline;color:#f66;'; s.addEventListener('click', clickFn); }
          return s;
        };

        p.appendChild(mkSpan(`❤️ ${total}`));

        if (disappeared > 0) {
          p.appendChild(mkSpan(`⛔️ ${disappeared}`, ev => {
            ev.stopPropagation();
            statsOverlay.classList.remove('recents-stats-open');
            listScope.likes = 'gone'; listTabKind = null; setMobileTab('favs'); showListTab('likes');
          }));
        }

        if (downloaded > 0) p.appendChild(mkSpan(`⬇️ ${downloaded}`));

        if (lastRunDate) {
          // ttpull writes milliseconds, the original extension wrote seconds: accept both
          const d = new Date(lastRunDate > 1e12 ? lastRunDate : lastRunDate * 1000);
          p.appendChild(mkSpan(`🏃🏼‍♀️ ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`));
        }

        statsOverlay.appendChild(p);
      }
    });
    recentsGridEl.appendChild(statsOverlay);
    recentsGridEl.appendChild(statsBtn);

    // ── Grid ────────────────────────────────────────────────────────────────
    const grid = document.createElement('div');
    grid.id = 'recents-grid';

    ids.forEach((id, idx) => {
      const card = document.createElement('div');
      card.className = 'recents-card';

      // Cover wrapper — reuse stars-grid-cover for consistent styling
      const cover = document.createElement('div');
      cover.className = 'stars-grid-cover recents-cover-wrap';
      card.appendChild(cover);

      const img = document.createElement('img');
      img.loading = 'lazy';
      img.src = `data/Likes/covers/${id}.jpg`;
      cover.appendChild(img);

      // Tap cover → open video overlay (same as stars, returns to recents)
      cover.addEventListener('click', () => {
        const info = getVideoInfo(id);
        contextList[idx].authorName = info.authorName || '';
        contextList[idx].desc       = info.desc       || '';
        openVideoOverlay(idx, contextList);
      });

      // Star button (top-right) ── same position as stars-grid-remove
      const starBtn = document.createElement('button');
      starBtn.className = 'stars-grid-remove recents-star-btn';
      const refreshStarBtn = () => {
        const on = Boolean(stars[id]);
        starBtn.textContent = on ? '★' : '☆';
        starBtn.title = on ? 'Remove from Stars' : 'Add to Stars';
        starBtn.classList.toggle('recents-star-active', on);
      };
      refreshStarBtn();
      starBtn.addEventListener('click', e => {
        e.stopPropagation();
        toggleStar(id, `data/Likes/covers/${id}.jpg`);
        refreshStarBtn();
      });
      cover.appendChild(starBtn);
      cover.appendChild(makeBracesBtn('stars-grid-remove grid-braces-btn', id, 13));

      // Group button (top-left) ── same position as stars-grid-add-group
      const grpBtn = document.createElement('button');
      grpBtn.className = 'stars-grid-add-group recents-grp-btn';
      grpBtn.textContent = '⊕';
      grpBtn.title = 'Add to group';
      grpBtn.addEventListener('click', e => {
        e.stopPropagation();
        showGroupPicker(grpBtn, id);
      });
      cover.appendChild(grpBtn);

      grid.appendChild(card);
    });

    recentsGridEl.appendChild(grid);
    recentsGridBuilt = true;
  }

  function hideRecentsView() {
    if (recentsGridEl) recentsGridEl.style.display = 'none';
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // WATCH LOG + RANKED FEED
  // ═══════════════════════════════════════════════════════════════════════════
  // How you watch is kept as counters per video (ids and numbers only): s = times shown,
  // m = ms watched, k = quick skips, e = plays to the end (a replay counts again), t = last shown.
  // They live in localStorage and go to /api/watch as deltas so every device adds to one picture.
  // The ranker below never needs to know what any group is called: it only sees which videos
  // share a group, how big the groups are, and which videos were starred or watched.

  const WATCH_KEY = 'sp_watch';
  const SKIP_MS   = 2500;
  let watchStats  = {};      // id -> { s, m, k, e, t }
  let watchDelta  = {};      // counters not yet sent to the server
  let watchTimer  = null;
  let endFeedVisit = null;   // set by the phone feed; closes the visit being timed

  (function loadWatchLocal() {
    try {
      const raw = JSON.parse(localStorage.getItem(WATCH_KEY) || 'null');
      if (raw && typeof raw === 'object') { watchStats = raw.stats || {}; watchDelta = raw.delta || {}; }
    } catch (_) {}
  })();

  function saveWatchLocal() {
    try { localStorage.setItem(WATCH_KEY, JSON.stringify({ stats: watchStats, delta: watchDelta })); } catch (_) {}
  }

  function addCounters(target, id, d) {
    const c = target[id] || (target[id] = { s: 0, m: 0, k: 0, e: 0, t: 0 });
    c.s += d.s || 0; c.m += d.m || 0; c.k += d.k || 0; c.e += d.e || 0; c.t = Math.max(c.t || 0, d.t || 0);
  }

  function watchAdd(id, d) {
    const full = { s: 0, m: 0, k: 0, e: 0, t: Date.now(), ...d };
    addCounters(watchStats, id, full);
    addCounters(watchDelta, id, full);
    saveWatchLocal();
    clearTimeout(watchTimer);
    watchTimer = setTimeout(() => flushWatch(false), 20000);
  }

  function flushWatch(useBeacon) {
    if (!Object.keys(watchDelta).length) return;
    const sent = watchDelta;
    const body = JSON.stringify({ delta: sent });
    watchDelta = {};
    saveWatchLocal();
    const restore = () => { Object.entries(sent).forEach(([id, d]) => addCounters(watchDelta, id, d)); saveWatchLocal(); };
    if (useBeacon && navigator.sendBeacon) {
      if (!navigator.sendBeacon('/api/watch', new Blob([body], { type: 'application/json' }))) restore();
      return;
    }
    fetch('/api/watch', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body })
      .then(r => { if (!r.ok) throw new Error(r.status); })
      .catch(restore);   // no server, or it failed: keep the counters for the next try
  }

  // The server's totals (all devices) plus whatever this device has not sent yet
  const watchReady = fetch('/api/watch', { cache: 'no-store' })
    .then(r => r.ok ? r.json() : null)
    .then(d => {
      if (!d || !d.watch) return;
      const merged = JSON.parse(JSON.stringify(d.watch));
      Object.entries(watchDelta).forEach(([id, x]) => addCounters(merged, id, x));
      watchStats = merged;
      saveWatchLocal();
    })
    .catch(() => { /* no server */ });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { if (endFeedVisit) endFeedVisit(); flushWatch(true); }
  });
  window.addEventListener('pagehide', () => { if (endFeedVisit) endFeedVisit(); flushWatch(true); });

  // ── Ranking ────────────────────────────────────────────────────────────────
  // score = how much your own habits favour the video + a little novelty. Every number is here so
  // it is easy to tune.
  const RANK = {
    lift: 1.0,         // groups whose videos you star more often than average pull their videos up
    interest: 1.0,     // ...and so do groups you have put many videos in
    star: 1.5, level: 0.3, liked: 1.2, disliked: -4,
    engagement: 1.6,   // finishing/replaying lifts a video, skipping it quickly lowers it
    unseen: 0.4,       // a small push for videos the feed has never shown
    recent: -2.5, recentDays: 2,   // just shown: keep it out for a while
    cooldownDays: 0.5, // a shown video goes to the back of the line for this long (x times it was shown, up to cooldownMax)
    cooldownMax: 30,
    repeat: -0.2,      // shown many times overall
    maxRewatch: 2,     // replays beyond this add nothing to a video's engagement score
    popularity: 0.15,  // like count from the archive, a gentle prior
    temperature: 1.6,  // higher = more variety between runs
    authorGap: 3,      // avoid the same author within this many videos
    lookahead: 25,     // how far ahead to look for a different author
    explore: 0.2,      // chance a slot in the first 200 is given to a random unseen video
  };
  const QUICK_POSITIVE = 'liked', QUICK_NEGATIVE = 'disliked';

  // list: [{ id, ... }]. Returns a new array in feed order. rng/now are injectable for tests.
  function rankVideos(list, rng, now) {
    rng = rng || Math.random;
    now = now || Date.now();
    const n = list.length;
    if (n < 2) return list.slice();
    const d = _dbCache;
    const inList = new Set(list.map(v => v.id));

    // Group statistics over the videos being ranked
    const starCount = list.reduce((k, v) => k + (stars[v.id] ? 1 : 0), 0);
    const base = (starCount + 1) / (n + 2);
    const PRIOR = 8;
    const stat = [];
    let maxN = 1;
    const liked = new Set(), disliked = new Set();
    const member = new Map();                      // video id -> [group ids that count as tags]
    groups.forEach(g => {
      const name = String(g.name).trim().toLowerCase();
      if (name === QUICK_POSITIVE || name === QUICK_NEGATIVE) {
        g.videoIds.forEach(id => (name === QUICK_POSITIVE ? liked : disliked).add(id));
        return;
      }
      let ng = 0, sg = 0;
      g.videoIds.forEach(id => {
        if (!inList.has(id)) return;
        ng++; if (stars[id]) sg++;
        (member.get(id) || member.set(id, []).get(id)).push(g.id);
      });
      if (ng) { stat.push({ id: g.id, ng, sg }); if (ng > maxN) maxN = ng; }
    });
    const weight = new Map();
    stat.forEach(({ id, ng, sg }) => {
      const rate = (sg + PRIOR * base) / (ng + PRIOR);
      // capped both ways: a group with no stars is not a dislike, and one huge lift must not drown the rest
      const lift = Math.max(-1, Math.min(2, Math.log(rate / base)));
      weight.set(id, RANK.lift * lift + RANK.interest * (Math.log1p(ng) / Math.log1p(maxN)));
    });

    let maxLog = 1;
    if (d) list.forEach(v => { const x = d.videos[v.id]; if (x) maxLog = Math.max(maxLog, Math.log10(1 + (x.diggCount || 0))); });

    const scored = list.map(item => {
      const id = item.id;
      const gs = member.get(id);
      let sc = 0;
      if (gs) sc = gs.reduce((a, g) => a + (weight.get(g) || 0), 0) / Math.sqrt(gs.length);
      if (stars[id]) sc += RANK.star;
      if (levels[id] != null) sc += RANK.level;
      if (liked.has(id)) sc += RANK.liked;
      if (disliked.has(id)) sc += RANK.disliked;
      const w = watchStats[id];
      if (w && w.s) {
        sc += RANK.engagement * Math.max(-1.2, Math.min(1.2, (0.8 * Math.min(w.e, RANK.maxRewatch * w.s) - 1.2 * w.k) / (w.s + 1)));
        sc += RANK.recent * Math.exp(-((now - (w.t || 0)) / 864e5) / RANK.recentDays);
        sc += RANK.repeat * Math.log1p(w.s);
      } else sc += RANK.unseen;
      const x = d && d.videos[id];
      if (x) sc += RANK.popularity * (Math.log10(1 + (x.diggCount || 0)) / maxLog);
      return { item, id, score: sc, author: x ? x.authorId : null };
    });

    // Sample an order in proportion to the scores (adds Gumbel noise), so every run differs
    scored.forEach(r => { r.key = r.score / RANK.temperature - Math.log(-Math.log(Math.max(rng(), 1e-12))); });
    scored.sort((a, b) => b.key - a.key);

    // Spread authors out: take the best-ranked video whose author wasn't just shown
    const out = [], recent = [], taken = new Uint8Array(n);
    let head = 0;
    while (out.length < n) {
      while (taken[head]) head++;
      let pick = head;
      for (let j = head, seen = 0; j < n && seen < RANK.lookahead; j++) {
        if (taken[j]) continue;
        seen++;
        if (!scored[j].author || !recent.includes(scored[j].author)) { pick = j; break; }
      }
      taken[pick] = 1;
      out.push(scored[pick]);
      recent.push(scored[pick].author);
      if (recent.length > RANK.authorGap) recent.shift();
    }

    // Cooldown: anything shown lately goes behind everything that wasn't, however well it scores
    // (the longer ago it was shown, and the fewer times, the sooner it may come back)
    const fresh = [], cooling = [];
    out.forEach(r => {
      const w = watchStats[r.id];
      const days = w && w.s && w.t ? Math.min(RANK.cooldownMax, RANK.cooldownDays * w.s) : 0;
      (days && (now - w.t) < days * 864e5 ? cooling : fresh).push(r);
    });
    if (cooling.length) { out.length = 0; fresh.forEach(r => out.push(r)); cooling.forEach(r => out.push(r)); }

    // A little exploration near the top so the feed can't lock itself in
    const pool = [];
    out.forEach((r, i) => { if (!watchStats[r.id] && !disliked.has(r.id)) pool.push(i); });
    for (let i = 0; i < Math.min(200, n) && pool.length; i++) {
      if (rng() < RANK.explore) {
        const j = pool[Math.floor(rng() * pool.length)];
        if (j > i) [out[i], out[j]] = [out[j], out[i]];
      }
    }
    return out.map(r => r.item);
  }

  function shuffleList(list) {
    const a = list.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // Change how the Home feed is ordered (Ranked or Shuffle). A new order starts from the top.
  function setFeedMode(mode) {
    try { localStorage.setItem('sp_feed_mode', mode === 'shuffle' ? 'shuffle' : 'ranked'); } catch (_) {}
    homeResume = null;
    try { localStorage.removeItem('sp_home_last'); } catch (_) {}   // a new order starts from the top
    spToast('Home feed: ' + (mode === 'shuffle' ? 'Shuffle' : 'Ranked'));
    if (isMobilePlayer() && activeMobileTab === 'home' && playerOpen && !playerReturnTab) { closePlayer(); openPlayer(); }
  }

  function feedMode() {
    try { return localStorage.getItem('sp_feed_mode') === 'shuffle' ? 'shuffle' : 'ranked'; } catch (_) { return 'ranked'; }
  }

  // Order a list of candidate videos for the Home feed / pop-out player
  async function orderHomeList(list) {
    if (feedMode() !== 'ranked') return shuffleList(list);
    try { await Promise.race([watchReady, new Promise(r => setTimeout(r, 1500))]); } catch (_) {}
    return rankVideos(list);
  }

  // The Home feed's videos: from the archive database when it is available (fast, nothing flickers);
  // otherwise the app's own lists are read (that switches tabs behind the scenes)
  async function buildHomeList() {
    try { const l = await buildVideoListFromDb(); if (l.length) return l; } catch (e) { console.warn('[Feed] database list failed', e); }
    return [];
  }

  let spFeedMuted = true;   // one mute setting for every phone feed and video: on until the user turns sound on
  let homeResume = null;   // { list, pos, pool }: where the Home feed was when the user left it
  let homeFeedPool = [];   // every video the Home feed can serve; re-ranked to keep it endless

  async function openPlayer() {
    if (!isMobilePlayer()) { launchPlayerWindow(); return; }
    if (starsTabActive) showMainContent();

    // Mobile: show loading screen, build list, then scroll-snap feed
    playerOpen = true;
    activeMobileTab = 'home'; updateMobileNavActive();
    showMobilePlayerLoading();
    if (homeResume && !playerStartId) {   // coming back to Home: same list, same video
      const r = homeResume; homeResume = null;
      spTrace('home: resumed at ' + r.pos);
      playerVideoList = r.list; homeFeedPool = r.pool; playerColumnOffsets = [r.pos];
      renderMobilePlayerContent();
      return;
    }
    homeResume = null;
    playerVideoList = await buildHomeList();
    if (!playerOpen) { hideMobilePlayerView(); return; }
    // The page was reloaded a moment ago (the phone can discard a page that used a lot of memory): reopen on the video
    // that was showing instead of a brand new order
    if (!playerStartId) {
      try {
        const last = JSON.parse(localStorage.getItem('sp_home_last') || 'null');
        if (last && last.id && Date.now() - last.at < 10 * 60 * 1000) { playerStartId = last.id; spTrace('home: reopened on the last video'); }
        else spTrace('home: new list');
      } catch (_) {}
    }
    // If a specific video was requested (e.g. tapped from recents grid), put it first
    if (playerStartId) {
      const si = playerVideoList.findIndex(v => v.id === playerStartId);
      if (si > 0) { const [it] = playerVideoList.splice(si, 1); playerVideoList.unshift(it); }
      playerStartId = null;
    }
    playerColumnOffsets = [0];
    homeFeedPool = playerVideoList.slice();   // the Home feed refills from this when it runs out
    renderMobilePlayerContent();
  }

  // Desktop: open a new pop-out player window without touching the current tab.
  // The list comes from the archive db.
  async function launchPlayerWindow() {
    let list = [];
    try { list = await buildVideoListFromDb(); } catch (e) { console.warn('[Player] db list failed', e); }
    if (list.length) popoutPlayer(list, 0);
  }

  async function buildVideoListFromDb() {
    const d = await archiveDbPromise();
    const list = [];
    const seen = new Set();
    const add = (ids, dir) => {
      for (const id of ids) {
        const v = d.videos[id];
        if (!v || seen.has(id)) continue;
        seen.add(id);
        const a = d.authors[v.authorId];
        list.push({
          id, authorName: (a && a.uniqueIds && a.uniqueIds[0]) || '', desc: d.videoDescriptions[id] || '',
          videoPath: `data/${dir}/videos/${id}.mp4`, coverSrc: `data/${dir}/covers/${id}.jpg`,
        });
        seen.add(id);
      }
    };
    const dl = new Set((d.likes && d.likes.downloaded) || []);
    add(((d.likes && d.likes.officialList) || []).filter(id => dl.has(id)), 'Likes');
    const bm = new Set((d.bookmarked && d.bookmarked.downloaded) || []);
    add(((d.bookmarked && d.bookmarked.officialList) || []).filter(id => bm.has(id)), 'Favorites');
    return orderHomeList(list);
  }

  function closePlayer() {
    playerOpen = false;
    navPopQuiet('player');
    closeVideoOverlay();
    document.getElementById('player-overlay')?.remove();
    hideMobilePlayerView();
    if (!isMobilePlayer()) document.querySelector('nav .player-tab')?.classList.remove('active');
  }

  // Show #player-view immediately as a fixed loading screen.
  // The fixed overlay covers the page, so nothing else needs to be hidden.
  function showMobilePlayerLoading() {
    if (!playerViewEl) {
      playerViewEl = document.createElement('div');
      playerViewEl.id = 'player-view';
      document.body.appendChild(playerViewEl);
    }
    playerViewEl.innerHTML = '';
    playerViewEl.style.display = 'flex';
    const loading = document.createElement('div');
    loading.id = 'player-view-loading';
    loading.textContent = 'Loading videos…';
    playerViewEl.appendChild(loading);
  }

  function hideMobilePlayerView() {
    if (endFeedVisit) endFeedVisit();
    if (!playerViewEl) return;
    // Pause any playing videos before hiding
    playerViewEl.querySelectorAll('video').forEach(v => v.pause());
    playerViewEl.style.display = 'none';
    playerViewEl.style.zIndex = '';
    playerViewEl.innerHTML = '';
    setPreviewsSuspended(false);
  }

  function renderMobilePlayerContent() {
    if (!playerViewEl) return;
    playerViewEl.innerHTML = '';

    if (!playerVideoList.length) {
      const empty = document.createElement('div');
      empty.id = 'player-view-loading';
      empty.textContent = 'No videos found.';
      playerViewEl.appendChild(empty);
      return;
    }

    renderMobileScrollFeed(playerViewEl);
  }

  // ── Mobile scroll-snap player feed ─────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════
  // PHONE TAGGING: tag button -> bottom sheet (tap) / radial fan of top tags (press and hold)
  // Works on whatever groups exist; nothing here knows or cares what the tags are called.
  // ═══════════════════════════════════════════════════════════════════════════
  const TAG_RECENT_KEY = 'sp_tag_recent';
  const isQuickGroupName = n => n === 'liked' || n === 'disliked';   // these have their own buttons
  const tagRecent = () => { try { return JSON.parse(localStorage.getItem(TAG_RECENT_KEY) || '{}') || {}; } catch (_) { return {}; } };

  // Tags the user can pick: recently used first, then biggest first
  function tagsOrdered() {
    const rec = tagRecent();
    return groups.filter(g => !isQuickGroupName(g.name))
      .sort((a, b) => ((rec[b.id] || 0) - (rec[a.id] || 0)) || (b.videoIds.length - a.videoIds.length));
  }
  function videoTagged(videoId) { return groups.some(g => !isQuickGroupName(g.name) && g.videoIds.includes(videoId)); }

  // Flip a tag on a video; returns true when the video now has it
  function toggleTagFor(videoId, groupId) {
    const g = groups.find(x => x.id === groupId);
    if (!g) return false;
    const i = g.videoIds.indexOf(videoId);
    if (i === -1) {
      g.videoIds.push(videoId);
      const rec = tagRecent(); rec[g.id] = Date.now();
      try { localStorage.setItem(TAG_RECENT_KEY, JSON.stringify(rec)); } catch (_) {}
    } else g.videoIds.splice(i, 1);
    saveGroups();
    return g.videoIds.includes(videoId);
  }

  function spToast(msg, undo) {
    document.getElementById('sp-toast')?.remove();
    const t = document.createElement('div');
    t.id = 'sp-toast';
    const span = document.createElement('span');
    span.textContent = msg;
    t.appendChild(span);
    if (undo) {
      const b = document.createElement('button');
      b.textContent = 'Undo';
      b.addEventListener('click', () => { undo(); t.remove(); });
      t.appendChild(b);
    }
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2600);
  }

  // Builds the tag button plus its sheet and radial. host = the player view; getVideoId() = the video on screen.
  function buildTagControls(host, getVideoId) {
    const btn = document.createElement('button');
    btn.className = 'player-ctrl-btn player-tag-btn sp-tag-btn';
    btn.title = 'Tag (hold for quick tags)';
    btn.innerHTML = '<svg viewBox="0 0 24 24" width="30" height="30" fill="currentColor"><path d="M21.41 11.58l-9-9C12.05 2.22 11.55 2 11 2H4c-1.1 0-2 .9-2 2v7c0 .55.22 1.05.59 1.42l9 9c.36.36.86.58 1.41.58s1.05-.22 1.41-.59l7-7c.37-.36.59-.86.59-1.41s-.23-1.06-.59-1.42zM5.5 7C4.67 7 4 6.33 4 5.5S4.67 4 5.5 4 7 4.67 7 5.5 6.33 7 5.5 7z"/></svg>';

    const apply = (g) => {
      const vid = getVideoId();
      if (!vid) return;
      const now = toggleTagFor(vid, g.id);
      spToast((now ? 'Tagged ' : 'Removed ') + g.name, () => { toggleTagFor(vid, g.id); refresh(); });
      refresh();
    };

    // ── bottom sheet ──
    let sheet = null, back = null, query = '';
    function renderChips() {
      if (!sheet) return;
      const vid = getVideoId();
      const list = sheet.querySelector('.sp-sheet-chips');
      list.innerHTML = '';
      const q = query.trim().toLowerCase();
      const all = tagsOrdered();
      all.filter(g => !q || g.name.toLowerCase().includes(q)).forEach(g => {
        const on = g.videoIds.includes(vid);
        const c = document.createElement('button');
        c.className = 'sp-chip' + (on ? ' on' : '');
        c.textContent = (on ? '✓ ' : '') + g.name;
        c.addEventListener('click', () => { apply(g); });
        list.appendChild(c);
      });
      if (q && !all.some(g => g.name.toLowerCase() === q)) {
        const c = document.createElement('button');
        c.className = 'sp-chip new';
        c.textContent = '+ Create "' + query.trim() + '"';
        c.addEventListener('click', () => {
          const g = { id: uid(), name: query.trim(), videoIds: [] };
          groups.push(g);
          apply(g);
          query = '';
          if (sheet) sheet.querySelector('.sp-sheet-search').value = '';
          renderChips();
        });
        list.appendChild(c);
      }
      if (!list.children.length) {
        const e = document.createElement('div');
        e.className = 'sp-sheet-empty';
        e.textContent = 'No tags yet. Type a name to create one.';
        list.appendChild(e);
      }
    }
    function closeSheet() {
      if (back) back.remove();
      if (sheet) sheet.remove();
      sheet = back = null;
    }
    function openSheet() {
      if (sheet) return;
      query = '';
      back = document.createElement('div');
      back.className = 'sp-sheet-back';
      back.addEventListener('click', closeSheet);
      sheet = document.createElement('div');
      sheet.className = 'sp-sheet';
      sheet.innerHTML = '<div class="sp-sheet-grab"><span></span></div>' +
        '<input class="sp-sheet-search" type="text" placeholder="Search or create a tag" autocomplete="off" autocapitalize="off">' +
        '<div class="sp-sheet-chips"></div>';
      sheet.querySelector('.sp-sheet-search').addEventListener('input', e => { query = e.target.value; renderChips(); });
      // drag the handle down to dismiss
      const grab = sheet.querySelector('.sp-sheet-grab');
      let y0 = null;
      grab.addEventListener('pointerdown', e => { y0 = e.clientY; try { grab.setPointerCapture(e.pointerId); } catch (_) {} });
      grab.addEventListener('pointermove', e => { if (y0 != null) sheet.style.transform = `translateY(${Math.max(0, e.clientY - y0)}px)`; });
      const end = e => {
        if (y0 == null) return;
        const dy = e.clientY - y0; y0 = null;
        if (dy > 70) closeSheet(); else sheet.style.transform = '';
      };
      grab.addEventListener('pointerup', end);
      grab.addEventListener('pointercancel', end);
      host.appendChild(back);
      host.appendChild(sheet);
      renderChips();
    }

    // ── radial fan (press and hold, slide onto a tag, let go) ──
    let radial = null, radialItems = [], hover = -1;
    function openRadial() {
      const all = tagsOrdered().slice(0, 6);
      const hr = host.getBoundingClientRect();
      const br = btn.getBoundingClientRect();
      const cx0 = br.left + br.width / 2 - hr.left, cy0 = br.top + br.height / 2 - hr.top;
      radial = document.createElement('div');
      radial.className = 'sp-radial';
      const vid = getVideoId();
      const items = all.map(g => ({ g })).concat([{ more: true }]);
      const n = items.length;
      // The button sits low on the screen, so the tags fan upward in a curve: the first (most recent) is nearest the thumb
      radialItems = items.map((it, i) => {
        const t = n === 1 ? 0 : i / (n - 1);
        const el = document.createElement('div');
        el.className = 'sp-radial-item' + (it.more ? ' more' : '') + (it.g && it.g.videoIds.includes(vid) ? ' on' : '');
        el.textContent = it.more ? '⋯  All tags' : ((it.g.videoIds.includes(vid) ? '✓ ' : '') + it.g.name);
        el.style.left = Math.min(hr.width - 8, cx0 + 26 - 96 * Math.cos(t * Math.PI / 2)) + 'px';
        el.style.top = (cy0 - 34 - 44 * i) + 'px';
        radial.appendChild(el);
        return Object.assign(it, { el });
      });
      host.appendChild(radial);
      hover = -1;
      try { navigator.vibrate && navigator.vibrate(12); } catch (_) {}
    }
    function hoverRadial(x, y) {
      let h = -1;
      radialItems.forEach((it, i) => {
        const r = it.el.getBoundingClientRect();
        if (x >= r.left - 6 && x <= r.right + 6 && y >= r.top - 8 && y <= r.bottom + 8) h = i;
      });
      if (h !== hover) {
        hover = h;
        radialItems.forEach((it, i) => it.el.classList.toggle('hot', i === h));
      }
    }
    function closeRadial() {
      if (radial) radial.remove();
      radial = null; radialItems = []; hover = -1;
    }

    let lp = null, held = false, p0 = null;
    btn.addEventListener('pointerdown', e => {
      e.stopPropagation();
      held = false; p0 = { x: e.clientX, y: e.clientY };
      try { btn.setPointerCapture(e.pointerId); } catch (_) {}
      clearTimeout(lp);
      lp = setTimeout(() => { held = true; openRadial(); }, 420);
    });
    btn.addEventListener('pointermove', e => {
      if (held) hoverRadial(e.clientX, e.clientY);
      else if (p0 && Math.hypot(e.clientX - p0.x, e.clientY - p0.y) > 12) { clearTimeout(lp); p0 = null; }
    });
    btn.addEventListener('pointerup', e => {
      clearTimeout(lp);
      if (!p0 && !held) return;     // the finger wandered off before the hold: nothing to do
      p0 = null;
      if (held) {
        held = false;
        const it = radialItems[hover];
        closeRadial();
        if (it) { if (it.more) openSheet(); else apply(it.g); }
      } else openSheet();
    });
    btn.addEventListener('pointercancel', () => { clearTimeout(lp); held = false; p0 = null; closeRadial(); });
    btn.addEventListener('contextmenu', e => e.preventDefault());
    btn.addEventListener('click', e => e.stopPropagation());

    function refresh() {
      const vid = getVideoId();
      btn.classList.toggle('active', Boolean(vid) && videoTagged(vid));
      renderChips();
    }
    return { btn, refresh, close: closeSheet };
  }

  function renderMobileScrollFeed(overlay) {
    const counter = overlay.querySelector('#player-counter');
    const total   = playerVideoList.length;

    const feed = document.createElement('div');
    feed.id = 'player-feed';
    overlay.appendChild(feed);

    if (!total) return;

    // Cap rendered slides on mobile to avoid OOM crash from creating hundreds
    // of <video> elements at once. 60 gives ~30 min of content to scroll through.
    const MOBILE_CAP = 60;
    // For long lists (tens of thousands) render a window around the starting video, not the first 60
    const globalStart = Math.max(0, Math.min(playerColumnOffsets[0] || 0, total - 1));
    let winStart = total > MOBILE_CAP ? Math.max(0, Math.min(globalStart - 10, total - MOBILE_CAP)) : 0;
    playerWinStart = winStart;
    const renderList = (total > MOBILE_CAP ? playerVideoList.slice(winStart, winStart + MOBILE_CAP) : playerVideoList).slice();
    // The Home feed never ends: it keeps adding slides (and re-ranks the whole list when it is used up)
    const endless = activeMobileTab === 'home' && !playerReturnTab && homeFeedPool.length > 0;
    let io = null;
    if (counter && total > MOBILE_CAP) {
      counter.title = `Showing ${renderList.length} of ${total}`;
    }

    // ── Single fixed controls layer (stays put while videos scroll) ──────────
    let currentMuted = spFeedMuted;
    let currentItem  = null;
    let currentVid   = null;

    const ctrlLayer = document.createElement('div');
    ctrlLayer.id = 'player-overlay-controls';

    const rightCenter = document.createElement('div');
    rightCenter.className = 'player-right-center';

    const thumbUpBtn = document.createElement('button');
    thumbUpBtn.className = 'player-ctrl-btn player-thumb-btn player-thumb-up';
    thumbUpBtn.title = 'Add to Liked';
    thumbUpBtn.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M1 21h4V9H1v12zm22-11c0-1.1-.9-2-2-2h-6.31l.95-4.57.03-.32c0-.41-.17-.79-.44-1.06L14.17 1 7.59 7.59C7.22 7.95 7 8.45 7 9v10c0 1.1.9 2 2 2h9c.83 0 1.54-.5 1.84-1.22l3.02-7.05c.09-.23.14-.47.14-.73v-2z"/></svg>';
    thumbUpBtn.addEventListener('click', e => {
      e.stopPropagation();
      if (!currentItem) return;
      const now = toggleQuickGroup(currentItem.id, 'liked');
      thumbUpBtn.classList.toggle('active', now);
      // Mutually exclusive: remove from disliked if adding to liked
      if (now) {
        const dg = groups.find(x => x.name === 'disliked');
        if (dg) { dg.videoIds = dg.videoIds.filter(id => id !== currentItem.id); saveGroups(); }
        thumbDownBtn.classList.remove('active');
      }
    });

    // Double tap on the video: like it (never un-like), with a heart where the finger was
    function likeFromDoubleTap(slide, x, y) {
      if (!currentItem) return;
      const id = currentItem.id;
      if (!inQuickGroup(id, 'liked')) {
        toggleQuickGroup(id, 'liked');
        const dg = groups.find(g => g.name === 'disliked');
        if (dg && dg.videoIds.includes(id)) { dg.videoIds = dg.videoIds.filter(v => v !== id); saveGroups(); }
        thumbUpBtn.classList.add('active');
        thumbDownBtn.classList.remove('active');
      }
      const r = slide.getBoundingClientRect();
      const heart = document.createElement('div');
      heart.className = 'sp-heart';
      heart.innerHTML = '<svg viewBox="0 0 24 24" width="96" height="96" fill="#ff2d55"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>';
      heart.style.left = (x - r.left) + 'px';
      heart.style.top = (y - r.top) + 'px';
      slide.appendChild(heart);
      setTimeout(() => heart.remove(), 750);
    }

    const thumbDownBtn = document.createElement('button');
    thumbDownBtn.className = 'player-ctrl-btn player-thumb-btn player-thumb-down';
    thumbDownBtn.title = 'Add to Disliked';
    thumbDownBtn.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M15 3H6c-.83 0-1.54.5-1.84 1.22l-3.02 7.05c-.09.23-.14.47-.14.73v2c0 1.1.9 2 2 2h6.31l-.95 4.57-.03.32c0 .41.17.79.44 1.06L9.83 23l6.59-6.59c.36-.36.58-.86.58-1.41V5c0-1.1-.9-2-2-2zm4 0v12h4V3h-4z"/></svg>';
    thumbDownBtn.addEventListener('click', e => {
      e.stopPropagation();
      if (!currentItem) return;
      const now = toggleQuickGroup(currentItem.id, 'disliked');
      thumbDownBtn.classList.toggle('active', now);
      // Mutually exclusive: remove from liked if adding to disliked
      if (now) {
        const lg = groups.find(x => x.name === 'liked');
        if (lg) { lg.videoIds = lg.videoIds.filter(id => id !== currentItem.id); saveGroups(); }
        thumbUpBtn.classList.remove('active');
      }
    });

    const starBtn = document.createElement('button');
    starBtn.className = 'player-ctrl-btn player-star-btn';
    starBtn.innerHTML = '★';
    starGesture(starBtn,
      () => { if (!currentItem) return; toggleStar(currentItem.id, currentItem.coverSrc); paintStarBtn(starBtn, currentItem.id, false); },
      () => {
        if (!currentItem) return;
        const now = toggleSuperStar(currentItem.id, currentItem.coverSrc);
        paintStarBtn(starBtn, currentItem.id, false);
        spToast(now ? 'Super star' : 'Normal star');
      });

    const bracesBtn = makeBracesBtn('player-ctrl-btn player-braces-btn', null, 24);

    const lvlBtn = document.createElement('button');
    lvlBtn.className = 'player-ctrl-btn player-lvl-btn';
    lvlBtn.title = 'Set level';
    lvlBtn.addEventListener('click', e => {
      e.stopPropagation();
      if (!currentItem) return;
      showLevelPicker(lvlBtn, currentItem.id, newLvl => {
        lvlBtn.textContent = newLvl != null ? String(newLvl) : 'lvl';
        lvlBtn.classList.toggle('active', newLvl != null);
        if (starsTabActive) renderStarsView();
      });
    });

    const tagUI = buildTagControls(overlay, () => currentItem && currentItem.id);
    const groupBtn = tagUI.btn;

    const muteBtn = document.createElement('button');
    muteBtn.className = 'player-ctrl-btn player-mute-btn';
    muteBtn.innerHTML = muteIcon(true);
    muteBtn.title = 'Unmute';
    const paintMute = () => {
      muteBtn.innerHTML = muteIcon(currentMuted);
      muteBtn.title = currentMuted ? 'Unmute' : 'Mute';
    };
    paintMute();
    muteBtn.addEventListener('click', e => {
      e.stopPropagation();
      currentMuted = !currentMuted;
      spFeedMuted = currentMuted;
      videoEls.forEach(v => { v.muted = currentMuted; });
      paintMute();
    });

    rightCenter.appendChild(thumbUpBtn);
    rightCenter.appendChild(thumbDownBtn);
    rightCenter.appendChild(starBtn);
    rightCenter.appendChild(bracesBtn);
    rightCenter.appendChild(lvlBtn);
    rightCenter.appendChild(groupBtn);
    rightCenter.insertBefore(muteBtn, rightCenter.firstChild);   // mute sits at the top of the button column, above like
    ctrlLayer.appendChild(rightCenter);

    // Username above the caption in one box anchored to the bottom: with no caption the username drops down
    const metaEl = document.createElement('div');
    metaEl.className = 'player-meta';
    const authorEl  = document.createElement('div');
    authorEl.className = 'player-author';
    const captionEl = document.createElement('div');
    captionEl.className = 'player-caption';
    metaEl.append(authorEl, captionEl);
    ctrlLayer.appendChild(metaEl);


    overlay.appendChild(ctrlLayer);

    // Thin seek bar along the bottom edge, right above the tab bar; drag it to scrub the playing video
    const seek = document.createElement('div');
    seek.className = 'sp-seek';
    seek.innerHTML = '<div class="sp-seek-track"><div class="sp-seek-fill"></div></div><div class="sp-seek-time"></div>';
    const seekFill = seek.querySelector('.sp-seek-fill');
    const seekTime = seek.querySelector('.sp-seek-time');
    let scrubbing = false;
    const fmtT = t => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
    function paintSeek() {
      const v = currentVid;
      if (!v || !v.duration || !isFinite(v.duration)) { seekFill.style.width = '0%'; return; }
      seekFill.style.width = (Math.min(1, v.currentTime / v.duration) * 100) + '%';
      if (scrubbing) seekTime.textContent = `${fmtT(v.currentTime)} / ${fmtT(v.duration)}`;
    }
    function scrubTo(clientX) {
      const v = currentVid;
      if (!v || !v.duration || !isFinite(v.duration)) return;
      const r = seek.getBoundingClientRect();
      v.currentTime = Math.max(0, Math.min(1, (clientX - r.left) / (r.width || 1))) * v.duration;
      paintSeek();
    }
    seek.addEventListener('pointerdown', e => {
      e.stopPropagation();
      scrubbing = true;
      seek.classList.add('scrubbing');
      try { seek.setPointerCapture(e.pointerId); } catch (_) {}
      scrubTo(e.clientX);
    });
    seek.addEventListener('pointermove', e => { if (scrubbing) scrubTo(e.clientX); });
    const endScrub = () => { scrubbing = false; seek.classList.remove('scrubbing'); };
    seek.addEventListener('pointerup', endScrub);
    seek.addEventListener('pointercancel', endScrub);
    ctrlLayer.appendChild(seek);
    (function seekLoop() {
      if (!feed.isConnected) return;
      paintSeek();
      requestAnimationFrame(seekLoop);
    })();

    // Called by IntersectionObserver each time a new slide becomes dominant
    function updateControls(item, vid) {
      currentItem = item;
      currentVid  = vid;
      vid.muted   = currentMuted;

      thumbUpBtn.classList.toggle('active', inQuickGroup(item.id, 'liked'));
      thumbDownBtn.classList.toggle('active', inQuickGroup(item.id, 'disliked'));

      paintStarBtn(starBtn, item.id, false);

      bracesBtn.dataset.vid = item.id;
      bracesBtn._refresh();

      lvlBtn.textContent = levels[item.id] != null ? String(levels[item.id]) : 'lvl';
      lvlBtn.classList.toggle('active', levels[item.id] != null);
      tagUI.refresh();

      const info    = getVideoInfo(item.id);
      const name    = info.authorName || item.authorName || '';
      const caption = info.desc || '';
      if (name) setAuthorLink(authorEl, name); else clearAuthorLink(authorEl);
      captionEl.textContent = caption.length > 120 ? caption.slice(0, 120) + '…' : caption;
    }
    // ── End fixed controls layer ─────────────────────────────────────────────

    const videoEls = [];
    const coverEls = [];

    // Only the covers around the playing slide are loaded: 60 full-size images decoded at once can
    // exhaust a phone's memory (iOS then reloads the page, which looks like the feed refreshing).
    function coverWindow(idx) {
      coverEls.forEach((c, j) => {
        if (Math.abs(j - idx) <= 2) { if (!c.getAttribute('src')) c.src = c._src; }
        else if (c.getAttribute('src')) c.removeAttribute('src');
      });
    }

    // Start a video and cope with browsers refusing autoplay (common on phones):
    // - sound refused (e.g. after you unmuted, the next video has no tap of its own): play muted instead
    //   and show the muted state on the button
    // - even muted play refused: mark the slide so a tap on it starts the video
    // - a play() cut short by pause()/a new load is normal while scrolling, not a refusal
    function startPlayback(vid) {
      const p = vid.play();
      if (!p || !p.catch) return;
      p.catch(err => {
        if (vid !== currentVid || (err && err.name === 'AbortError')) return;
        if (!vid.muted) {
          currentMuted = true;   // the browser refused sound (no tap yet): fall back to muted
          spFeedMuted = true;
          vid.muted = true;
          paintMute();
          startPlayback(vid);
        } else {
          vid.parentElement?.classList.add('needs-tap');
        }
      });
    }

    // Time how long each video is watched (see WATCH LOG): a visit starts when a slide becomes active
    // and ends when another one does, or the feed closes or the page is hidden.
    let visit = null;
    function endVisit() {
      if (!visit) return;
      const v = visit;
      visit = null;
      const dur = v.vid.duration;
      const ms = Math.min(Date.now() - v.t0, dur && isFinite(dur) ? dur * 3000 : 120000);
      if (ms < 400) return;   // flicked past while scrolling: not a view
      watchAdd(v.id, { s: 1, m: Math.round(ms), k: (v.loops === 0 && ms < SKIP_MS) ? 1 : 0, e: v.loops });
    }
    endFeedVisit = endVisit;

    // Make the slide at idx the active one: controls, counter, playback
    function activate(idx) {
      const vid = videoEls[idx];
      if (!vid) return;
      // The observer can report the same slide again (drags, page pulls, layout changes): that is not a new view
      if (visit && visit.vid === vid && currentVid === vid) {
        if (vid.paused && !vid._userPaused) startPlayback(vid);
        return;
      }
      if (currentVid && currentVid !== vid) { dropBridge(); releaseBlob(currentVid); currentVid.playbackRate = 1; }
      endVisit();
      coverWindow(idx);
      visit = { id: renderList[idx].id, vid, t0: Date.now(), loops: 0 };
      playerColumnOffsets[0] = winStart + idx;
      if (endless) { try { localStorage.setItem('sp_home_last', JSON.stringify({ id: renderList[idx].id, at: Date.now() })); } catch (_) {} }
      updateControls(renderList[idx], vid);
      vid._userPaused = false;
      vid.parentElement?.classList.remove('sp-paused');
      startPlayback(vid);
      feed.dataset.pos = winStart + idx;
      feed.dataset.total = playerVideoList.length;
      if (counter) counter.textContent = endless ? String(winStart + idx + 1) : `${winStart + idx + 1} / ${playerVideoList.length}`;
      if (renderList.length - idx <= 10) appendMore();
      // a little head start for the next video
      const next = videoEls[idx + 1];
      if (next && next.preload !== 'auto') next.preload = 'auto';
      if (vid.preload !== 'auto') vid.preload = 'auto';
    }

    // Safety net for the observer: once scrolling settles, the slide in view must be the one playing
    let settleTimer = null;
    function syncToView() {
      const h = feed.clientHeight;
      if (!h) return;
      const idx = Math.max(0, Math.min(videoEls.length - 1, Math.round(feed.scrollTop / h)));
      const vid = videoEls[idx];
      if (!vid) return;
      if (currentVid !== vid) {
        videoEls.forEach((v, j) => { if (j !== idx && !v.paused) v.pause(); });
        activate(idx);
      } else if (vid.paused && !vid._userPaused) {
        startPlayback(vid);
      }
    }

    function makeSlide(item, idx) {
      const slide = document.createElement('div');
      slide.className = 'player-slide';
      slide.dataset.idx = idx;

      // Video — preload=none so only the playing one downloads
      const video = document.createElement('video');
      video.src = item.videoPath;
      video._netSrc = item.videoPath;
      video.preload = 'none';
      video.muted = currentMuted;
      video.playsInline = true;
      video.className = 'player-video';
      // The cover image stays up until the first video frame is really on screen, so there is no black flash
      const cover = document.createElement('img');
      cover.className = 'player-cover';
      cover.alt = '';
      cover.decoding = 'async';
      cover._src = item.coverSrc;
      coverEls.push(cover);
      // Videos that nearly fill the screen are zoomed to fill it (this also covers the notch); very wide ones stay letterboxed
      const fit = (w, h) => {
        const fw = feed.clientWidth, fh = feed.clientHeight;
        if (!w || !h || !fw || !fh) return;
        const a = fw / w, b = fh / h;
        slide.classList.toggle('sp-fill', Math.max(a, b) / Math.min(a, b) <= 1.25);
      };
      cover.addEventListener('load', () => fit(cover.naturalWidth, cover.naturalHeight));
      video.addEventListener('loadedmetadata', () => fit(video.videoWidth, video.videoHeight));
      const dropCover = () => cover.classList.add('gone');
      video.addEventListener('playing', () => {
        if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(dropCover);
        setTimeout(dropCover, 400);
      }, { once: true });
      video.addEventListener('playing', () => { slide.classList.remove('needs-tap'); });
      // Looping is left to the browser (loop attribute): restarting from an 'ended' handler needs a fresh play()
      // that iOS can refuse or leave black after a few rounds. The loop count is read from the clock wrapping round.
      video.loop = true;
      let lastT = 0;
      video.addEventListener('timeupdate', () => {
        const t = video.currentTime, d = video.duration;
        if (d && isFinite(d) && lastT > d * 0.6 && t < lastT - d * 0.4 && visit && visit.vid === video) visit.loops++;
        lastT = t;
        if (video === currentVid) paintSeek();
      });
      video.addEventListener('ended',   () => { video.currentTime = 0; video.play().catch(() => {}); });   // only if loop were ignored
      video.addEventListener('contextmenu', e => e.preventDefault());   // a long press is the 2x gesture, not a menu

      let _stx = 0, _sty = 0, _lastTap = null, _tapTimer = null, _holdTimer = null, _held = false, _badge = null;
      // Hold a finger on the video: 2x speed until it lifts
      const endHold = () => {
        clearTimeout(_holdTimer);
        if (!_held) return;
        _held = false;
        video.playbackRate = 1;
        if (_badge) { _badge.remove(); _badge = null; }
      };
      slide.addEventListener('touchstart', e => {
        _stx = e.touches[0].clientX; _sty = e.touches[0].clientY; _held = false;
        clearTimeout(_holdTimer);
        if (e.touches.length !== 1) return;
        _holdTimer = setTimeout(() => {
          if (video.paused || video !== currentVid) return;
          _held = true;
          video.playbackRate = 2;
          _badge = document.createElement('div');
          _badge.className = 'sp-speed';
          _badge.textContent = '▶▶ 2×';
          slide.appendChild(_badge);
          try { navigator.vibrate && navigator.vibrate(8); } catch (_) {}
        }, 380);
      }, { passive: true });
      slide.addEventListener('touchmove', e => {
        const t = e.touches[0];
        if (Math.hypot(t.clientX - _stx, t.clientY - _sty) > 18) { clearTimeout(_holdTimer); endHold(); }
      }, { passive: true });
      slide.addEventListener('touchcancel', endHold, { passive: true });
      slide.addEventListener('touchend', e => {
        const wasHeld = _held;
        endHold();
        if (wasHeld) { _lastTap = null; return; }   // lifting after a hold is not a tap
        const t = e.changedTouches[0];
        const dx = t.clientX - _stx;
        const dy = t.clientY - _sty;
        // Tap only — overlay handles horizontal swipe, feed handles vertical scroll
        if (Math.abs(dx) < 15 && Math.abs(dy) < 15) {
          const now = Date.now();
          if (_lastTap && now - _lastTap.t < 300 && Math.hypot(t.clientX - _lastTap.x, t.clientY - _lastTap.y) < 60) {
            // second tap: a like, not a pause
            clearTimeout(_tapTimer); _lastTap = null;
            likeFromDoubleTap(slide, t.clientX, t.clientY);
            return;
          }
          _lastTap = { t: now, x: t.clientX, y: t.clientY };
          // single tap: pause/resume, once we know no second tap is coming
          _tapTimer = setTimeout(() => {
            _lastTap = null;
            if (video.paused) { video._userPaused = false; slide.classList.remove('sp-paused'); video.play().catch(() => {}); }
            else { video._userPaused = true; slide.classList.add('sp-paused'); video.pause(); }
          }, 260);
        }
      }, { passive: true });

      slide.appendChild(video);
      slide.appendChild(cover);
      feed.appendChild(slide);
      videoEls.push(video);
      if (io) { slide.style.height = feed.clientHeight + 'px'; io.observe(slide); }   // added after the feed is live
    }
    renderList.forEach(makeSlide);

    // ── Keeping loops alive (watches only the video in view) ──
    // 1) Over the loop point a still of the last frame is held on top (a canvas; the cover image if the phone hands
    //    back a blank copy), and it only comes off once a genuinely new frame has been shown. No black gap.
    // 2) After its first loop the video is swapped for a copy held in memory, so later loops never touch the network.
    // 3) If the clock stops moving (iOS can stall a looping video) the video is nudged back to life.
    let bridge = null, clock = { v: null, t: -1, at: 0 }, kicks = 0;
    const blobUrls = new Set();
    function loopLog(msg) {
      try {
        const l = JSON.parse(localStorage.getItem('sp_looplog') || '[]');
        l.push(new Date().toISOString().slice(14, 23) + ' ' + msg);
        while (l.length > 8) l.shift();
        localStorage.setItem('sp_looplog', JSON.stringify(l));
      } catch (_) {}
    }
    function removeBridge(b) {
      if (!b) return;
      if (b.cover) { b.cover.classList.add('gone'); b.cover.style.transition = ''; } else if (b.canvas) b.canvas.remove();
    }
    function dropBridge() { removeBridge(bridge); bridge = null; }
    function releaseBlob(v) {
      if (!v || !v._blob) return;
      const bl = v._blob; v._blob = null;
      if (bl.url) {
        if (bl.state === 'swapped' && v._netSrc) { v.preload = 'none'; v.src = v._netSrc; }
        URL.revokeObjectURL(bl.url); blobUrls.delete(bl.url);
      }
    }
    function startBlob(v) {
      if (v._blob || !v._netSrc) return;
      const bl = v._blob = { state: 'fetching' };
      fetch(v._netSrc).then(r => (r.ok ? r.blob() : null)).then(b => {
        if (v._blob !== bl) return;   // the video moved on while this was downloading
        if (!b || b.size > 80e6) { v._blob = null; return; }
        bl.url = URL.createObjectURL(b); blobUrls.add(bl.url); bl.state = 'ready';
      }).catch(() => { if (v._blob === bl) v._blob = null; });
    }
    function blankCopy(c) {
      try {
        const t = document.createElement('canvas'); t.width = t.height = 8;
        const x = t.getContext('2d'); x.drawImage(c, 0, 0, 8, 8);
        const d = x.getImageData(0, 0, 8, 8).data;
        let sum = 0; for (let i = 0; i < d.length; i += 4) sum += d[i] + d[i + 1] + d[i + 2] + d[i + 3];
        return sum === 0;
      } catch (_) { return false; }
    }
    function dropBridgeWhenFresh(v, b) {
      const gone = () => removeBridge(b);
      if (v.requestVideoFrameCallback) {
        let tries = 0;
        const cb = (now, md) => {
          // a frame from the end of the old round can still be in flight: wait for one from the new round
          if (md && v.duration && md.mediaTime > v.duration * 0.5 && tries++ < 30) { v.requestVideoFrameCallback(cb); return; }
          setTimeout(gone, 40);
        };
        v.requestVideoFrameCallback(cb);
        setTimeout(gone, 1500);
      } else setTimeout(gone, 400);
    }
    const loopTimer = setInterval(() => {
      if (!feed.isConnected) {   // this feed was replaced (the container is reused, so test the feed itself)
        clearInterval(loopTimer); dropBridge();
        blobUrls.forEach(u => URL.revokeObjectURL(u)); blobUrls.clear();
        return;
      }
      const v = currentVid;
      const hidden = !v || v._userPaused || document.hidden || authorViewOpen() || overlay.style.visibility === 'hidden' || overlay.getClientRects().length === 0;
      if (hidden) { dropBridge(); clock.at = Date.now(); return; }
      if (bridge && bridge.vid !== v) dropBridge();
      const d = v.duration, t = v.currentTime;
      if (!d || !isFinite(d)) return;

      // stall watchdog: playing (or wrongly paused/ended) with a clock that is not moving
      if (clock.v !== v || t !== clock.t) { clock = { v, t, at: Date.now() }; kicks = 0; }
      else if (Date.now() - clock.at > 2000 && !v.parentElement.classList.contains('needs-tap') && !v.seeking) {
        clock.at = Date.now();
        kicks++;
        loopLog('stall kick ' + kicks);
        if (kicks > 2) { try { v.load(); } catch (_) {} kicks = 0; }   // last resort: reload the file
        try { v.currentTime = 0; } catch (_) {}
        startPlayback(v);
        return;
      }

      const left = d - t;
      if (!bridge && left >= 0 && left < 0.15 && !v.paused && v.videoWidth) {
        let b = null, kind = 'frame';
        try {
          const c = document.createElement('canvas');
          c.width = v.videoWidth; c.height = v.videoHeight;
          c.getContext('2d').drawImage(v, 0, 0);
          if (blankCopy(c)) {
            const cv = v.parentElement.querySelector('.player-cover');
            if (cv && cv.getAttribute('src')) { cv.style.transition = 'none'; cv.classList.remove('gone'); b = { cover: cv, vid: v, at: Date.now() }; kind = 'cover'; }
          } else {
            c.className = 'player-video sp-bridge';
            v.parentElement.insertBefore(c, v.nextSibling);
            b = { canvas: c, vid: v, at: Date.now() };
          }
        } catch (_) {}
        bridge = b;
        // second round onwards: play from the copy held in memory (the swap happens under the bridge)
        let swapped = false;
        if (b && v._blob && v._blob.state === 'ready') {
          v._blob.state = 'swapped'; swapped = true;
          v.src = v._blob.url; v.load(); startPlayback(v);
        }
        loopLog('loop ' + (b ? kind : 'no-bridge') + ' blob:' + (v._blob ? v._blob.state : '-') + (swapped ? ' swap' : ''));
      } else if (bridge && ((t < 0.4 && left > 0.5) || Date.now() - bridge.at > 1500)) {
        const b = bridge; bridge = null;
        v._loops = (v._loops || 0) + 1;
        if (v._loops === 1) startBlob(v);
        dropBridgeWhenFresh(v, b);
      }
    }, 40);

    // More slides as the end gets near: from the list, then (Home feed) a fresh ranking of everything
    let appending = false;
    function appendMore() {
      if (appending) return;
      const g = winStart + renderList.length;
      if (g >= playerVideoList.length) {
        if (!endless) return;
        appending = true;
        orderHomeList(homeFeedPool.slice()).then(next => {
          const recent = new Set(playerVideoList.slice(-300).map(v => v.id));
          const fresh = next.filter(v => !recent.has(v.id));
          playerVideoList.push(...(fresh.length ? fresh : next));
          appending = false;
          appendMore();
        }).catch(() => { appending = false; });
        return;
      }
      playerVideoList.slice(g, g + 20).forEach(it => { renderList.push(it); makeSlide(it, renderList.length - 1); });
    }

    // Drop slides far behind the one in view so a long session stays light on memory
    function trimBehind() {
      const cur = videoEls.indexOf(currentVid);
      const n = cur - 25;
      const h = feed.clientHeight;
      if (n < 20 || !h) return;
      const slides = [...feed.children].slice(0, n);
      slides.forEach(sl => {
        if (io) io.unobserve(sl);
        const v = sl.querySelector('video');
        if (v) { v.pause(); v.removeAttribute('src'); v.load(); }
        sl.remove();
      });
      videoEls.splice(0, n); coverEls.splice(0, n); renderList.splice(0, n);
      winStart += n; playerWinStart = winStart;
      feed.style.scrollSnapType = 'none';
      feed.scrollTop = Math.max(0, feed.scrollTop - n * h);
      [...feed.children].forEach((sl, i) => { sl.dataset.idx = i; });
      requestAnimationFrame(() => { feed.style.scrollSnapType = ''; });
    }

    const startIdx = globalStart - winStart;

    // Size each slide to exactly fill the feed container (resolved after layout).
    // scrollIntoView and IO setup are deferred until heights are applied so that
    // the browser can resolve the correct scroll target position.
    const setSlideHeights = () => {
      const h = feed.clientHeight;
      if (h > 0) {
        feed.querySelectorAll('.player-slide').forEach(s => { s.style.height = h + 'px'; });

        // Scroll to starting position NOW that slides have real heights
        if (startIdx > 0 && feed.children[startIdx]) {
          const snap = feed.style.scrollSnapType;
          feed.style.scrollSnapType = 'none';
          feed.scrollTop = startIdx * h;   // every slide is exactly one screen tall
          requestAnimationFrame(() => { feed.style.scrollSnapType = snap; });
        }

        // IntersectionObserver: play the centered slide, pause everything else.
        // Set up AFTER scrollIntoView so slide 0 doesn't incorrectly fire first.
        io = new IntersectionObserver(entries => {
          entries.forEach(entry => {
            const idx = parseInt(entry.target.dataset.idx);
            const vid = videoEls[idx];
            if (!vid) return;
            if (entry.isIntersecting && entry.intersectionRatio >= 0.6) {
              activate(idx);
            } else {
              vid.pause();
            }
          });
        }, { threshold: 0.6 });

        feed.querySelectorAll('.player-slide').forEach(s => io.observe(s));

        // Kick off the starting video
        activate(startIdx);

        feed.addEventListener('scroll', () => {
          clearTimeout(settleTimer);
          settleTimer = setTimeout(() => { syncToView(); trimBehind(); }, 140);
        }, { passive: true });
      } else {
        requestAnimationFrame(setSlideHeights);
      }
    };
    requestAnimationFrame(setSlideHeights);
  }

  function muteIcon(muted) {
    return muted
      ? '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/></svg>'
      : '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>';
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PLAYER — POP-OUT WINDOW
  // ═══════════════════════════════════════════════════════════════════════════

  function popoutPlayer(startList, startIdx) {
    const win = window.open(
      'about:blank', '',   // empty name = new window every time
      'width=360,height=640,resizable=yes,menubar=no,toolbar=no,location=no,status=no'
    );
    if (!win) { alert('Pop-out was blocked. Please allow pop-ups for this file and try again.'); return; }

    const safeJson  = obj => JSON.stringify(obj).replace(/<\/script>/gi, '<\\/script>');
    const vidList   = startList != null ? startList : playerVideoList;
    const vidOffset = startIdx  != null ? startIdx  : (playerColumnOffsets[0] || 0);
    // Snapshot current in-memory state so pop-out starts with fresh data
    const initStars  = safeJson(stars);
    const initGroups = safeJson(groups);
    const initLevels = safeJson(levels);
    const apiOrigin  = location.origin;

    win.document.write(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>kashibox</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%;overflow:hidden;background:#000;color:#ddd;font-family:system-ui,sans-serif;position:relative}
video{width:100%;height:100%;object-fit:contain;display:block}
.ctl{position:absolute;inset:0;pointer-events:none;opacity:0;transition:opacity .2s}
body:hover .ctl,.ctl.pinned{opacity:1}
.close{position:absolute;top:10px;right:10px;background:rgba(0,0,0,.5);border:none;border-radius:50%;color:#fff;width:32px;height:32px;font-size:16px;cursor:pointer;display:flex;align-items:center;justify-content:center;pointer-events:auto}
.close:hover{background:rgba(0,0,0,.85)}
.rc{position:absolute;right:10px;top:50%;transform:translateY(-50%);display:flex;flex-direction:column;gap:10px;pointer-events:auto;align-items:center}
.b{background:rgba(0,0,0,.5);border:none;border-radius:50%;color:#ddd;width:40px;height:40px;font-size:18px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background .15s;pointer-events:auto;flex-shrink:0}
.b:hover{background:rgba(0,0,0,.85)}
.b.on{color:gold}
.b.sup{color:#4fc3f7}
.bbr.on{color:#4fc3f7}
.blvl{font-size:12px;font-weight:700;letter-spacing:-.5px}
.bgrp svg{pointer-events:none}
.scrim{position:absolute;bottom:0;left:0;right:0;height:180px;background:linear-gradient(transparent,rgba(0,0,0,.8));pointer-events:none}
.meta{position:absolute;bottom:12px;left:12px;max-width:calc(100% - 70px);pointer-events:none}
.au{font-size:13px;font-weight:600;color:#fff;text-shadow:0 1px 4px rgba(0,0,0,.9);margin-bottom:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.au.lnk{display:inline-block;max-width:100%;vertical-align:top;pointer-events:auto;cursor:pointer}
.au.lnk:hover{text-decoration:underline}
.cap{font-size:11px;color:rgba(255,255,255,.85);text-shadow:0 1px 3px rgba(0,0,0,.8);line-height:1.4;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.mu{position:absolute;bottom:10px;right:10px;pointer-events:auto}
.ct{position:absolute;top:10px;left:50%;transform:translateX(-50%);font-size:11px;color:rgba(255,255,255,.35);pointer-events:none;white-space:nowrap}
.nav{position:absolute;bottom:14px;left:50%;transform:translateX(-50%);display:flex;gap:8px;pointer-events:auto}
.navbtn{background:rgba(0,0,0,.5);border:none;border-radius:50%;color:#ddd;width:36px;height:36px;font-size:20px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background .15s}
.navbtn:hover{background:rgba(0,0,0,.85)}
.navbtn:disabled{opacity:.25;cursor:default}
.picker{position:fixed;z-index:9999;background:#252525;border:1px solid #555;border-radius:8px;padding:8px;box-shadow:0 4px 20px rgba(0,0,0,.8)}
.lpicker{display:flex;flex-direction:column;gap:3px}
.lpbtn{background:#1e1e1e;border:1px solid #3a3a3a;border-radius:4px;color:#bbb;font-size:13px;font-weight:600;padding:5px 20px;cursor:pointer;text-align:center;white-space:nowrap}
.lpbtn:hover{background:#2a2a2a;color:#fff}
.lpbtn.cur{background:#fe2c55;border-color:#fe2c55;color:#fff}
.gpicker{display:flex;flex-direction:column;min-width:170px;max-height:320px}
.gplst{overflow-y:auto;max-height:220px;display:flex;flex-direction:column;gap:1px;padding:4px 0}
.gpempty{padding:8px 12px;font-size:12px;color:#555}
.gprow{display:flex;align-items:center;gap:8px;padding:6px 10px;font-size:13px;cursor:pointer;color:#ccc;white-space:nowrap;border-radius:4px}
.gprow:hover{background:#333}
.gpname{flex:1;overflow:hidden;text-overflow:ellipsis}
.gpcnt{font-size:11px;color:#666;flex-shrink:0}
.gpnew{border-top:1px solid #333;padding:6px 8px}
.gpaddbt{background:none;border:none;color:#888;font-size:12px;cursor:pointer;padding:2px 4px;width:100%;text-align:left}
.gpaddbt:hover{color:#ccc}
.gpinf{display:flex;gap:4px;align-items:center}
.gpinf input{flex:1;background:#1a1a1a;border:1px solid #444;border-radius:4px;color:#ccc;font-size:12px;padding:4px 6px;outline:none}
.gpok{background:#333;border:none;border-radius:4px;color:#aaa;cursor:pointer;font-size:13px;padding:3px 7px}
.gpok:hover{background:#444;color:#fff}
</style></head><body>
<video id="v" muted autoplay playsinline></video>
<div class="ctl" id="c">
  <div class="scrim"></div>
  <button class="close" id="x">✕</button>
  <div class="rc" id="rc"></div>
  <div class="meta"><div class="au" id="au"></div><div class="cap" id="cp"></div></div>
  <div class="ct" id="ct"></div>
  <div class="nav" id="nv">
    <button class="navbtn" id="nb" title="Previous">&#8679;</button>
    <button class="navbtn" id="pb" title="Next">&#8681;</button>
  </div>
  <button class="b mu" id="mb"></button>
</div>
<script>
const API='${apiOrigin}/api/stars';
const BR='${BRACES_SVG(20)}';
let vids=${safeJson(vidList)};
let idx=${vidOffset};
let muted=true;

// Start with a snapshot of the main window's current in-memory state
let starsData=${initStars};
let groupsData=${initGroups};
let levelsData=${initLevels};

function ls(){return starsData;}
function lg(){return groupsData;}
function ll(){return levelsData;}

let _bc=null;
try{_bc=new BroadcastChannel('kashibox_popout');}catch(_){}

// Saving: the server refuses a save made from an out-of-date copy. This window keeps the copy it last saw (base) and, on a
// conflict, merges its own changes into the server's latest instead of overwriting it.
let rev=${JSON.stringify(serverRev)};
let base=JSON.parse(JSON.stringify({stars:starsData,groups:groupsData,levels:levelsData}));
const merge3=${merge3.toString()};
let _saving=false,_again=false;
async function putServer(){
  if(_saving){_again=true;return;}
  _saving=true;
  try{
    for(let i=0;i<4;i++){
      let r;
      try{r=await fetch(API,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({stars:starsData,groups:groupsData,levels:levelsData,rev})});}catch(_){return;}
      if(r.ok){rev=(await r.json()).rev;base=JSON.parse(JSON.stringify({stars:starsData,groups:groupsData,levels:levelsData}));return;}
      if(r.status!==409&&r.status!==428)return;
      const d=await (await fetch(API,{cache:'no-store'})).json();
      const theirs={stars:d.stars||{},groups:d.groups||[],levels:d.levels||{}};
      const m=merge3(base,{stars:starsData,groups:groupsData,levels:levelsData},theirs);
      starsData=m.stars;groupsData=m.groups;levelsData=m.levels;rev=d.rev;base=JSON.parse(JSON.stringify(theirs));
    }
  }finally{_saving=false;if(_again){_again=false;putServer();}}
}
function syncAll(s,g,l){
  // Tell the main window what changed (it merges this window's changes with its own), and save to the server ourselves
  if(_bc) _bc.postMessage({s,g,l,base});
  putServer();
}
function openAuthor(name){
  if(_bc) _bc.postMessage({openAuthor:name});
  try{ if(window.opener&&!window.opener.closed) window.opener.focus(); }catch(_){}
}
function ss(s){starsData=s;syncAll(s,groupsData,levelsData);}
function sg(g){groupsData=g;syncAll(starsData,g,levelsData);}
function sl(l){levelsData=l;syncAll(starsData,groupsData,l);}

function mi(m){
  return m
    ? '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/></svg>'
    : '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>';
}

function closePicker(){document.querySelectorAll('.picker').forEach(p=>p.remove());document.getElementById('c').classList.remove('pinned');}

function positionLeft(el, anchorRect){
  document.body.appendChild(el);
  const ew=el.offsetWidth||160, eh=el.offsetHeight||200;
  el.style.top=Math.max(4,Math.min(anchorRect.top+anchorRect.height/2-eh/2,window.innerHeight-eh-4))+'px';
  el.style.left=Math.max(4,anchorRect.left-ew-8)+'px';
}

function showLvlPicker(btn,id){
  closePicker();
  document.getElementById('c').classList.add('pinned');
  const cur=(ll()[id]??null);
  const p=document.createElement('div');
  p.className='picker lpicker';
  for(let n=10;n<=23;n++){
    const b=document.createElement('button');
    b.className='lpbtn'+(cur===n?' cur':'');
    b.textContent=n;
    b.addEventListener('click',()=>{
      const lv=ll();
      if(cur===n){delete lv[id];}else{lv[id]=n;}
      sl(lv);
      const newCur=lv[id]??null;
      btn.textContent=newCur!=null?String(newCur):'lvl';
      closePicker();
    });
    p.appendChild(b);
  }
  positionLeft(p,btn.getBoundingClientRect());
  setTimeout(()=>{document.addEventListener('click',function h(e){if(!p.contains(e.target)){closePicker();document.removeEventListener('click',h);}});},0);
}

function showGrpPicker(btn,id){
  closePicker();
  document.getElementById('c').classList.add('pinned');
  const p=document.createElement('div');
  p.className='picker gpicker';

  const lst=document.createElement('div'); lst.className='gplst'; p.appendChild(lst);
  const buildRows=()=>{
    lst.innerHTML='';
    const sorted=[...lg()].sort((a,b)=>b.videoIds.length-a.videoIds.length);
    if(!sorted.length){const e=document.createElement('div');e.className='gpempty';e.textContent='No groups yet';lst.appendChild(e);return;}
    sorted.forEach(g=>{
      const row=document.createElement('label'); row.className='gprow';
      const cb=document.createElement('input'); cb.type='checkbox'; cb.checked=g.videoIds.includes(id);
      cb.addEventListener('change',()=>{
        const gs=lg(); const gi=gs.find(x=>x.id===g.id);
        if(gi){if(cb.checked){if(!gi.videoIds.includes(id))gi.videoIds.push(id);}else gi.videoIds=gi.videoIds.filter(x=>x!==id); sg(gs);}
        buildRows();
      });
      const ns=document.createElement('span'); ns.className='gpname'; ns.textContent=g.name;
      const cs=document.createElement('span'); cs.className='gpcnt'; cs.textContent=g.videoIds.length;
      row.appendChild(cb); row.appendChild(ns); row.appendChild(cs); lst.appendChild(row);
    });
  };
  buildRows();

  const nr=document.createElement('div'); nr.className='gpnew'; p.appendChild(nr);
  const ab=document.createElement('button'); ab.className='gpaddbt'; ab.textContent='＋ New group';
  const inf=document.createElement('div'); inf.className='gpinf'; inf.style.display='none';
  const fi=document.createElement('input'); fi.type='text'; fi.placeholder='Group name'; fi.maxLength=40;
  const ok=document.createElement('button'); ok.textContent='✓'; ok.className='gpok';
  const commit=()=>{
    const name=fi.value.trim();
    if(name){
      const gs=lg();
      gs.push({id:(Math.random().toString(36).slice(2)),name,videoIds:[id]});
      sg(gs); buildRows();
    }
    fi.value=''; inf.style.display='none'; ab.style.display='';
  };
  ok.addEventListener('click',commit);
  fi.addEventListener('keydown',e=>{if(e.key==='Enter')commit(); e.stopPropagation();});
  ab.addEventListener('click',e=>{e.stopPropagation();ab.style.display='none';inf.style.display='flex';fi.focus();});
  inf.appendChild(fi); inf.appendChild(ok); nr.appendChild(ab); nr.appendChild(inf);

  positionLeft(p,btn.getBoundingClientRect());
  setTimeout(()=>{document.addEventListener('click',function h(e){if(!p.contains(e.target)){closePicker();document.removeEventListener('click',h);}});},0);
}

function render(){
  closePicker();
  v.pause();
  const item=vids[idx]; if(!item)return;
  v.poster=item.coverSrc; v.src=item.videoPath; v.muted=muted;
  v.play().catch(()=>{});
  v.onended=()=>{v.currentTime=0;v.play().catch(()=>{});};

  const rc=document.getElementById('rc'); rc.innerHTML='';

  // ★ Star
  const sb=document.createElement('button');
  const SSVG='<svg viewBox="0 0 24 24" width="24" height="24"><path fill="#4fc3f7" d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/><path fill="#e6f7ff" d="M20 .6l.8 2L22.8 3.4l-2 .8L20 6.2l-.8-2-2-.8 2-.8z"/><path fill="#e6f7ff" d="M4.3 14.8l.6 1.5 1.5.6-1.5.6-.6 1.5-.6-1.5-1.5-.6 1.5-.6z"/></svg>';
  const paintStar=()=>{const st=ls()[item.id]; sb.className='b'+(st?' on':'')+(st&&st.super?' sup':''); if(st&&st.super)sb.innerHTML=SSVG; else sb.textContent='★'; sb.title=st&&st.super?'Super star (hold to make it a normal star)':'Star (hold for a super star)';};
  const addStar=s=>{s[item.id]={id:item.id,coverSrc:item.coverSrc,authorName:item.authorName||'',desc:item.desc||''};};
  paintStar();
  let starHold=null, starHeld=false;
  sb.addEventListener('pointerdown',()=>{starHeld=false;clearTimeout(starHold);starHold=setTimeout(()=>{
    starHeld=true; const s=ls(); if(!s[item.id])addStar(s);
    if(s[item.id].super)delete s[item.id].super; else s[item.id].super=true;
    ss(s); paintStar();
  },450);});
  ['pointerup','pointerleave','pointercancel'].forEach(t=>sb.addEventListener(t,()=>clearTimeout(starHold)));
  sb.addEventListener('contextmenu',e=>e.preventDefault());
  sb.addEventListener('click',()=>{
    if(starHeld){starHeld=false;return;}
    const s=ls();
    if(s[item.id])delete s[item.id]; else addStar(s);
    ss(s); paintStar();
  });
  rc.appendChild(sb);

  // braces tag (toggles the shared "braces" group)
  const bb=document.createElement('button');
  bb.className='b bbr'; bb.innerHTML=BR;
  const bracesOf=gs=>gs.find(x=>String(x.name).trim().toLowerCase()==='braces');
  const inBr=()=>{const g=bracesOf(lg());return !!(g&&g.videoIds.includes(item.id));};
  const paintBr=()=>{const on=inBr();bb.classList.toggle('on',on);bb.title=on?'Remove from braces':'Add to braces';};
  paintBr();
  bb.addEventListener('click',e=>{
    e.stopPropagation();
    const gs=lg(); let g=bracesOf(gs);
    if(!g){g={id:Math.random().toString(36).slice(2),name:'braces',videoIds:[]};gs.push(g);}
    const i=g.videoIds.indexOf(item.id);
    if(i<0)g.videoIds.push(item.id); else g.videoIds.splice(i,1);
    sg(gs); paintBr();
  });
  rc.appendChild(bb);

  // lvl
  const lb=document.createElement('button');
  const curL=ll()[item.id]??null;
  lb.className='b blvl'; lb.textContent=curL!=null?String(curL):'lvl'; lb.title='Set level';
  lb.addEventListener('click',e=>{e.stopPropagation();showLvlPicker(lb,item.id);});
  rc.appendChild(lb);

  // ⊕ Group
  const gb=document.createElement('button');
  gb.className='b bgrp';
  gb.innerHTML='<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="9"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>';
  gb.title='Add to group';
  gb.addEventListener('click',e=>{e.stopPropagation();showGrpPicker(gb,item.id);});
  rc.appendChild(gb);

  const au=document.getElementById('au');
  au.textContent=item.authorName?'@'+item.authorName:'';
  au.classList.toggle('lnk',Boolean(item.authorName));
  au.title=item.authorName?'All videos by @'+item.authorName:'';
  au.onclick=item.authorName?function(e){e.stopPropagation();openAuthor(item.authorName);}:null;
  document.getElementById('cp').textContent=item.desc||'';
  document.getElementById('ct').textContent=vids.length>1?(idx+1)+' / '+vids.length:'';
  document.getElementById('mb').innerHTML=mi(muted);
  document.getElementById('nb').disabled=idx<=0;
  document.getElementById('pb').disabled=idx>=vids.length-1;
  document.getElementById('nv').style.display=vids.length>1?'flex':'none';
}

const v=document.getElementById('v');
v.addEventListener('contextmenu',e=>{e.preventDefault();v.paused?v.play().catch(()=>{}):v.pause();});
document.getElementById('x').addEventListener('click',()=>window.close());
document.getElementById('mb').addEventListener('click',()=>{
  muted=!muted; v.muted=muted; document.getElementById('mb').innerHTML=mi(muted);
});
document.getElementById('nb').addEventListener('click',()=>{if(idx>0){idx--;render();}});
document.getElementById('pb').addEventListener('click',()=>{if(idx<vids.length-1){idx++;render();}});
document.addEventListener('keydown',e=>{
  if(e.key==='ArrowDown'||e.key==='ArrowRight'){if(idx<vids.length-1){idx++;render();}}
  else if(e.key==='ArrowUp'||e.key==='ArrowLeft'){if(idx>0){idx--;render();}}
  else if(e.key==='Escape'){if(document.querySelector('.picker'))closePicker();else window.close();}
});
let sy=0;
document.addEventListener('touchstart',e=>{sy=e.touches[0].clientY;},{passive:true});
document.addEventListener('touchend',e=>{
  const dy=sy-e.changedTouches[0].clientY;
  if(Math.abs(dy)<50){v.paused?v.play().catch(()=>{}):v.pause();return;}
  if(dy>0&&idx<vids.length-1){idx++;render();}
  else if(dy<0&&idx>0){idx--;render();}
},{passive:true});
render();
<\/script></body></html>`);
    win.document.close();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // NAV INJECTION
  // ═══════════════════════════════════════════════════════════════════════════

  // ═══════════════════════════════════════════════════════════════════════════
  // AUTHOR TABS — click a username to see all of that author's videos
  // ═══════════════════════════════════════════════════════════════════════════

  let authorViewEl   = null;
  let activeAuthorId = null;
  const openAuthors  = [];   // { id, name }, in nav-tab order

  function setAuthorLink(el, name) {
    el.textContent = '@' + name;
    el.classList.add('sp-author-link');
    el.title = 'All videos by @' + name;
    el.onclick = e => { e.stopPropagation(); openAuthorByName(name); };
  }

  function clearAuthorLink(el) {
    el.textContent = '';
    el.classList.remove('sp-author-link');
    el.onclick = null;
  }

  function openAuthorByName(name, after) {
    if (!_dbCache) {
      archiveDbPromise().then(() => openAuthorByName(name, after)).catch(() => {});
      return;
    }
    const id = authorIdForName(name);
    if (id) { showAuthorTab(id, name); if (after) after(); }
  }

  function authorViewOpen() {
    return Boolean(activeAuthorId && authorViewEl && authorViewEl.style.display !== 'none');
  }

  // ── Where did focus come from? ────────────────────────────────────────────
  // Each username tab remembers the view that was showing the last time it was focused, so closing
  // it returns there (browser-style) instead of always landing on the same tab.
  const authorReturn = new Map();   // author id -> { kind, id? }

  function currentViewDescriptor() {
    if (activeAuthorId) return { kind: 'author', id: activeAuthorId };
    if (autotagTabActive) return { kind: 'autotag' };
    if (logTabActive) return { kind: 'log' };
    if (settingsTabActive) return { kind: 'settings' };
    if (listTabKind) return { kind: 'list', list: listTabKind };
    if (starsTabActive) return { kind: 'stars' };
    return { kind: 'stars' };   // the app's own pages (Likes, Favorites, Following, Explain)
  }

  // Where to go when username tab `id` closes: its remembered view, skipping username tabs that are
  // gone themselves (follow where those came from); Stars if nothing usable is left.
  function resolveReturn(id) {
    let d = authorReturn.get(id);
    for (let hops = 0; d && d.kind === 'author' && hops < 10; hops++) {
      if (d.id !== id && openAuthors.some(a => a.id === d.id)) return d;
      d = authorReturn.get(d.id);
    }
    return d && d.kind !== 'author' ? d : { kind: 'stars' };
  }

  function restoreView(d) {
    if (isMobilePlayer()) return;
    switch (d && d.kind) {
      case 'author': {
        const a = openAuthors.find(x => x.id === d.id);
        if (a) { showAuthorTab(a.id, a.name, true); return; }
        break;
      }
      case 'list':    showListTab(d.list); return;
      case 'settings': showSettingsTab(); return;
      case 'autotag': showAutotagTab(); return;
      case 'log':     showLogTab();     return;
    }
    showStarsTab();
  }

  function showAuthorTab(id, name, keepReturn) {
    if (!keepReturn) {
      const from = currentViewDescriptor();
      if (!(from.kind === 'author' && from.id === id)) authorReturn.set(id, from);
    }
    if (autotagTabActive) hideAutotagView();
    if (logTabActive) hideLogView();
    if (!openAuthors.some(a => a.id === id)) openAuthors.push({ id, name });
    activeAuthorId = id;
    closeVideoOverlay();
    document.body.classList.add('sp-author-open');

    const main = document.querySelector('main');
    if (isMobilePlayer()) {
      // Mobile: the view overlays whatever is underneath. A player launched from an
      // author view sits above it, so close that one; otherwise just silence the feed.
      if (playerReturnTab === '__author__') { closePlayer(); playerReturnTab = null; restoreHomeStash(); }
      if (endFeedVisit) endFeedVisit();
      document.querySelectorAll('#player-view video').forEach(v => v.pause());
      navPush('author');
    } else {
      if (settingsTabActive) hideSettingsView();
      if (listTabKind) hideListView();
      if (starsTabActive) {
        starsTabActive = false;
        if (starsViewEl) { releaseGridPreviews(starsViewEl); starsViewEl.style.display = 'none'; }
        document.querySelector('nav .stars-tab')?.classList.remove('active');
      }
      main?.style.setProperty('display', 'none');
    }

    if (!authorViewEl) {
      authorViewEl = document.createElement('div');
      authorViewEl.id = 'author-view';
      if (main) main.parentNode.insertBefore(authorViewEl, main);
      else document.body.appendChild(authorViewEl);
    }
    authorViewEl.style.display = 'flex';
    renderAuthorView();
    syncAuthorTabs();
    autosaveSession();
  }

  function hideAuthorView(resumePlayback = true) {
    releaseGridPreviews(authorViewEl);
    activeAuthorId = null;
    if (authorViewEl) authorViewEl.style.display = 'none';
    document.body.classList.remove('sp-author-open');
    navPopQuiet('author');
    spTrace('hide author');
    // Free the page's thumbnails (the page is rebuilt every time it opens) before the feed starts decoding video again
    if (isMobilePlayer() && authorViewEl) authorViewEl.textContent = '';
    syncAuthorTabs();
    // A video opened from this page replaced the Home feed; rebuild it for the tab underneath
    if (isMobilePlayer() && activeMobileTab === 'home' && !playerOpen) openPlayer();
    spTrace('resume feed');
    if (resumePlayback && isMobilePlayer() && playerOpen && playerViewEl && playerViewEl.style.display !== 'none') {
      playerViewEl.querySelectorAll('video')[(playerColumnOffsets[0] || 0) - playerWinStart]?.play().catch(() => {});
    }
  }

  function closeAuthorTab(id) {
    const i = openAuthors.findIndex(a => a.id === id);
    if (i >= 0) openAuthors.splice(i, 1);
    if (activeAuthorId === id) {
      const back = resolveReturn(id);
      hideAuthorView();
      // Closing the tab you were on returns to the one you came from (on a phone the view just closes)
      restoreView(back);
    }
    syncAuthorTabs();
    autosaveSession();
  }

  function renderAuthorView() {
    if (!authorViewEl || !activeAuthorId) return;
    const author = openAuthors.find(a => a.id === activeAuthorId);
    const videos = sortVideos(authorVideos(activeAuthorId), 'author');
    releaseGridPreviews(authorViewEl);
    authorViewEl.innerHTML = '';

    const grid = document.createElement('div');
    grid.id = 'author-grid';
    grid.classList.add('preview-grid');

    const header = document.createElement('div');
    header.id = 'author-view-header';
    const title = document.createElement('span');
    title.className = 'stars-main-title';
    title.textContent = '@' + author.name;
    const count = document.createElement('span');
    count.className = 'stars-main-count';
    count.textContent = `${videos.length} video${videos.length !== 1 ? 's' : ''}`;
    const closeBtn = document.createElement('button');
    closeBtn.className = 'author-view-close';
    closeBtn.textContent = '✕';
    closeBtn.title = 'Close';
    closeBtn.addEventListener('click', () => closeAuthorTab(activeAuthorId));
    header.append(title, count, buildGridControls('author', grid, authorViewEl), closeBtn);
    authorViewEl.appendChild(header);

    if (!videos.length) {
      const empty = document.createElement('div');
      empty.className = 'author-empty';
      empty.textContent = 'No downloaded videos found for this author.';
      grid.appendChild(empty);
    }
    fillGrid(grid, videos, (v, idx) => buildAuthorCard(v, idx, videos));
    authorViewEl.appendChild(grid);
    observeGridPreviews(grid);
  }

  function buildAuthorCard(v, idx, list) {
    const card = document.createElement('div');
    card.className = 'stars-grid-card';

    const cover = document.createElement('div');
    cover.className = 'stars-grid-cover';
    attachPreview(cover, v.videoPath);
    cover.addEventListener('click', () => openVideoOverlay(idx, list));
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.src = v.coverSrc;
    img.onerror = () => { img.style.display = 'none'; };
    cover.appendChild(img);

    cover.appendChild(buildThumbTools(v.id, v.coverSrc, v.authorName, v.desc));
    card.appendChild(cover);

    if (v.desc) {
      const d = document.createElement('div');
      d.className = 'stars-grid-desc';
      d.textContent = v.desc.length > 80 ? v.desc.slice(0, 80) + '…' : v.desc;
      card.appendChild(d);
    }
    return card;
  }

  // Keep the nav's author tabs in sync with openAuthors
  function syncAuthorTabs() {
    const nav = document.querySelector('nav');
    if (!nav) return;
    nav.querySelectorAll('.author-tab').forEach(t => {
      if (!openAuthors.some(a => a.id === t.dataset.id)) t.remove();
    });
    openAuthors.forEach(a => {
      let tab = nav.querySelector(`.author-tab[data-id="${a.id}"]`);
      if (!tab) {
        tab = document.createElement('div');
        tab.className = 'author-tab pressable';
        tab.dataset.id = a.id;
        tab.title = '@' + a.name;
        const label = document.createElement('span');
        label.className = 'author-tab-label';
        label.textContent = '@' + a.name;
        const x = document.createElement('span');
        x.className = 'author-tab-close';
        x.textContent = '✕';
        x.title = 'Close tab';
        x.addEventListener('click', e => { e.stopPropagation(); closeAuthorTab(a.id); });
        tab.append(label, x);
        tab.addEventListener('click', () => { if (activeAuthorId !== a.id) showAuthorTab(a.id, a.name); });
        tab.addEventListener('dblclick', e => {
          if (e.target.closest('.author-tab-close')) return;
          const url = profileUrlFor(a.name);
          if (url) window.open(url, '_blank', 'noopener');
        });
        const last = [...nav.querySelectorAll('.author-tab')].pop()
          || nav.querySelector('.player-tab') || nav.querySelector('.stars-tab');
        last?.insertAdjacentElement('afterend', tab);
      }
      tab.classList.toggle('active', a.id === activeAuthorId);
      tab.title = '@' + a.name + (profileUrlFor(a.name) ? ' — double-click to open the profile' : '');
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // TAB SESSIONS — open username tabs are autosaved and can be restored later
  // ═══════════════════════════════════════════════════════════════════════════

  let tabSessions       = [];    // { id, name, createdAt, updatedAt, tabs: [{id, name}], activeId }
  let currentSessionId  = null;  // the session open tabs are autosaved into
  let sessionsMenuEl    = null;
  let _sessionSyncTimer = null;

  function saveSessions() {
    try { localStorage.setItem('sp_sessions', JSON.stringify(tabSessions)); } catch (_) {}
    clearTimeout(_sessionSyncTimer);
    _sessionSyncTimer = setTimeout(() => {
      fetch('/api/sessions', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessions: tabSessions }),
      }).catch(() => { /* no server — localStorage is fine */ });
    }, 400);
  }

  (() => {
    try { tabSessions = JSON.parse(localStorage.getItem('sp_sessions') || '[]'); } catch (_) {}
    if (!Array.isArray(tabSessions)) tabSessions = [];
    fetch('/api/sessions').then(r => r.ok ? r.json() : null).then(d => {
      if (!d || !Array.isArray(d.sessions)) return;
      if (d.sessions.length || !tabSessions.length) {
        const cur = tabSessions.find(x => x.id === currentSessionId);
        tabSessions = d.sessions;
        if (cur && !tabSessions.some(x => x.id === cur.id)) tabSessions.unshift(cur);
        try { localStorage.setItem('sp_sessions', JSON.stringify(tabSessions)); } catch (_) {}
        if (dedupeSessions()) saveSessions();
      } else {
        saveSessions();   // first run against a server: push what is stored locally
      }
      renderSessionsMenu();
    }).catch(() => { /* no server */ });
  })();

  const sessionKey = s => (s.tabs || []).map(t => t.id).sort().join('|');

  // Collapse sessions holding exactly the same set of tabs: named ones always stay; otherwise the newest wins.
  // Returns true when something was removed.
  function dedupeSessions() {
    const groups = new Map();
    tabSessions.forEach(s => {
      const k = sessionKey(s);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(s);
    });
    const drop = new Set();
    groups.forEach(list => {
      if (list.length < 2) return;
      const named = list.filter(x => x.name);
      const keep = named.length ? new Set(named) : new Set([list.reduce((a, b) => ((b.updatedAt || b.createdAt || 0) > (a.updatedAt || a.createdAt || 0) ? b : a))]);
      list.forEach(x => { if (!keep.has(x)) drop.add(x); });
    });
    if (!drop.size) return false;
    tabSessions = tabSessions.filter(x => !drop.has(x));
    return true;
  }

  function sessionLabel(s) {
    return s.name || s.tabs.map(t => '@' + t.name).join(', ');
  }

  // Called whenever the set of open username tabs changes
  function autosaveSession() {
    if (isMobilePlayer()) return;   // on a phone a username page is a passing view, not a tab set worth saving
    if (!openAuthors.length) { currentSessionId = null; return; }  // the last non-empty state stays saved
    let s = tabSessions.find(x => x.id === currentSessionId);
    if (!s) {
      // the same set of tabs was saved before: carry on in that session instead of making a twin
      const key = openAuthors.map(a => a.id).sort().join('|');
      s = tabSessions.find(x => sessionKey(x) === key);
      if (s) currentSessionId = s.id;
    }
    if (!s) {
      s = { id: uid(), name: '', createdAt: Date.now(), tabs: [], activeId: null };
      tabSessions.unshift(s);
      currentSessionId = s.id;
    }
    s.tabs = openAuthors.map(a => ({ id: a.id, name: a.name }));
    s.activeId = activeAuthorId;
    s.updatedAt = Date.now();
    saveSessions();
    renderSessionsMenu();
  }

  function restoreSession(id) {
    const s = tabSessions.find(x => x.id === id);
    if (!s || !s.tabs.length) return;
    closeSessionsMenu();
    // The author data must be loaded before a view can be rendered
    archiveDbPromise().then(() => {
      openAuthors.length = 0;
      s.tabs.forEach(t => openAuthors.push({ id: t.id, name: t.name }));
      currentSessionId = s.id;
      const target = s.tabs.find(t => t.id === s.activeId) || s.tabs[s.tabs.length - 1];
      syncAuthorTabs();
      showAuthorTab(target.id, target.name);
    }).catch(() => {});
  }

  function startNewSession() {
    openAuthors.length = 0;
    currentSessionId = null;
    if (activeAuthorId) {
      const back = resolveReturn(activeAuthorId);
      hideAuthorView();
      restoreView(back);
    }
    syncAuthorTabs();
    closeSessionsMenu();
  }

  function renameSession(id) {
    const s = tabSessions.find(x => x.id === id);
    if (!s) return;
    const name = prompt('Session name (leave empty to use the usernames)', s.name || '');
    if (name === null) return;
    s.name = name.trim();
    saveSessions();
    renderSessionsMenu();
  }

  function deleteSession(id) {
    const s = tabSessions.find(x => x.id === id);
    if (!s || !confirm(`Delete session "${sessionLabel(s)}"?`)) return;
    tabSessions = tabSessions.filter(x => x.id !== id);
    if (currentSessionId === id) currentSessionId = null;
    saveSessions();
    renderSessionsMenu();
  }

  function renderSessionsMenu() {
    if (!sessionsMenuEl) return;
    sessionsMenuEl.innerHTML = '';

    const head = document.createElement('div');
    head.className = 'sessions-head';
    const title = document.createElement('span');
    title.textContent = 'Tab sessions';
    const newBtn = document.createElement('button');
    newBtn.className = 'sessions-new';
    newBtn.textContent = '+ New';
    newBtn.title = 'Close all username tabs and start a new session';
    newBtn.addEventListener('click', startNewSession);
    head.append(title, newBtn);
    sessionsMenuEl.appendChild(head);

    const list = document.createElement('div');
    list.className = 'sessions-list';
    const sorted = [...tabSessions].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    if (!sorted.length) {
      const empty = document.createElement('div');
      empty.className = 'sessions-empty';
      empty.textContent = 'No sessions yet. Open a username tab and it is saved here automatically.';
      list.appendChild(empty);
    }
    sorted.forEach(s => {
      const isCurrent = s.id === currentSessionId;
      const row = document.createElement('div');
      row.className = 'sessions-row' + (isCurrent ? ' current' : '');
      row.title = s.tabs.map(t => '@' + t.name).join('\n');
      row.addEventListener('click', () => restoreSession(s.id));

      const info = document.createElement('div');
      info.className = 'sessions-info';
      const label = document.createElement('div');
      label.className = 'sessions-label';
      label.textContent = sessionLabel(s);
      const when = new Date(s.updatedAt || s.createdAt || Date.now())
        .toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
      const meta = document.createElement('div');
      meta.className = 'sessions-meta';
      meta.textContent = `${s.tabs.length} tab${s.tabs.length !== 1 ? 's' : ''} · ${when}${isCurrent ? ' · open now' : ''}`;
      info.append(label, meta);

      const mk = (text, title, fn) => {
        const b = document.createElement('button');
        b.className = 'sessions-act';
        b.textContent = text;
        b.title = title;
        b.addEventListener('click', e => { e.stopPropagation(); fn(); });
        return b;
      };
      row.append(info, mk('✎', 'Rename', () => renameSession(s.id)), mk('✕', 'Delete', () => deleteSession(s.id)));
      list.appendChild(row);
    });
    sessionsMenuEl.appendChild(list);
  }

  const sessionsOutside = e => {
    if (sessionsMenuEl && !sessionsMenuEl.contains(e.target) && !e.target.closest('.session-tab')) closeSessionsMenu();
  };
  const sessionsEscape = e => { if (e.key === 'Escape') closeSessionsMenu(); };

  function closeSessionsMenu() {
    if (!sessionsMenuEl) return;
    sessionsMenuEl.remove();
    sessionsMenuEl = null;
    document.removeEventListener('mousedown', sessionsOutside, true);
    document.removeEventListener('keydown', sessionsEscape, true);
    document.querySelector('nav .session-tab')?.classList.remove('menu-open');
  }

  function toggleSessionsMenu() {
    if (sessionsMenuEl) { closeSessionsMenu(); return; }
    const btn = document.querySelector('nav .session-tab');
    if (!btn) return;
    sessionsMenuEl = document.createElement('div');
    sessionsMenuEl.id = 'sessions-menu';
    document.body.appendChild(sessionsMenuEl);
    renderSessionsMenu();
    const r = btn.getBoundingClientRect();
    sessionsMenuEl.style.top = (r.bottom + 6) + 'px';
    sessionsMenuEl.style.right = Math.max(8, window.innerWidth - r.right - 4) + 'px';
    btn.classList.add('menu-open');
    document.addEventListener('mousedown', sessionsOutside, true);
    document.addEventListener('keydown', sessionsEscape, true);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // LIVE LOG — ttpull's log, polled through the Starplayer server (/api/ttpull/logs)
  // ═══════════════════════════════════════════════════════════════════════════

  let logTabActive  = false;
  let logViewEl     = null;
  let logBodyEl     = null;
  let logStatusEl   = null;
  let logPaused     = false;
  let logFollow     = true;
  let logFilter     = '';
  let logLastRaw    = null;     // last real line seen, used to find where new lines start
  let logTimer      = null;
  let logPollGen    = 0;
  const logEntries  = [];       // { raw, time, level, msg, marker }
  const logLevels   = { info: true, warn: true, error: true };
  const LOG_KEEP    = 2000;

  function parseLogLine(raw) {
    const m = /^\[([^\]]+)\] \[(\w+)\] ([\s\S]*)$/.exec(raw);
    if (!m) return { raw, time: '', level: 'info', msg: raw };
    const d = new Date(m[1]);
    const time = isNaN(d) ? m[1] : d.toLocaleTimeString([], { hour12: false });
    return { raw, time, level: (m[2] === 'warn' || m[2] === 'error') ? m[2] : 'info', msg: m[3] };
  }

  function logEntryVisible(e) {
    if (e.marker) return true;
    if (!logLevels[e.level]) return false;
    return !logFilter || e.msg.toLowerCase().includes(logFilter);
  }

  function logLineEl(e) {
    const row = document.createElement('div');
    if (e.marker) {
      row.className = 'log-line log-marker';
      row.textContent = e.msg;
      return row;
    }
    row.className = 'log-line lvl-' + e.level;
    const ts = document.createElement('span');
    ts.className = 'log-ts';
    ts.textContent = e.time;
    const msg = document.createElement('span');
    msg.textContent = e.msg;
    row.append(ts, msg);
    return row;
  }

  function scrollLogToEnd() { if (logBodyEl) logBodyEl.scrollTop = logBodyEl.scrollHeight; }

  function renderLogAll() {
    if (!logBodyEl) return;
    logBodyEl.innerHTML = '';
    const frag = document.createDocumentFragment();
    logEntries.forEach(e => { if (logEntryVisible(e)) frag.appendChild(logLineEl(e)); });
    logBodyEl.appendChild(frag);
    if (logFollow) scrollLogToEnd();
  }

  // Take the lines ttpull returned and append only the ones we haven't shown yet
  function ingestLog(lines) {
    let start = 0;
    const fresh = [];
    if (logLastRaw !== null) {
      const i = lines.lastIndexOf(logLastRaw);
      if (i >= 0) start = i + 1;
      else if (lines.length) fresh.push({ marker: true, msg: '… log restarted or lines were missed …' });
    }
    lines.slice(start).forEach(raw => fresh.push(parseLogLine(raw)));
    if (!fresh.length) return;
    if (lines.length) logLastRaw = lines[lines.length - 1];

    fresh.forEach(e => logEntries.push(e));
    while (logEntries.length > LOG_KEEP) logEntries.shift();
    if (!logBodyEl) return;
    fresh.forEach(e => { if (logEntryVisible(e)) logBodyEl.appendChild(logLineEl(e)); });
    while (logBodyEl.childElementCount > LOG_KEEP) logBodyEl.firstChild.remove();
    if (logFollow) scrollLogToEnd();
  }

  function setLogStatus(kind, text) {
    if (!logStatusEl) return;
    logStatusEl.className = 'log-status ' + kind;
    logStatusEl.textContent = text;
  }

  async function pollLog() {
    const gen = logPollGen;
    try {
      const r = await fetch('/api/ttpull/logs', { cache: 'no-store' });
      const d = await r.json();
      if (gen !== logPollGen) return;
      if (d.ok) {
        ingestLog(d.lines);
        const st = d.status;
        setLogStatus('ok', st ? 'ttpull · ' + (st.running ? 'running' + (st.phase ? ': ' + st.phase : '') : 'idle') : 'ttpull · connected');
      } else {
        setLogStatus('error', d.error || 'ttpull unreachable');
      }
    } catch (_) {
      if (gen !== logPollGen) return;
      setLogStatus('error', 'Starplayer server unreachable (the live log needs the server)');
    }
    if (gen === logPollGen && logTabActive && !logPaused) logTimer = setTimeout(pollLog, 2000);
  }

  function startLogPolling() {
    stopLogPolling();
    if (!logPaused) pollLog();
  }

  function stopLogPolling() {
    logPollGen++;
    clearTimeout(logTimer);
    logTimer = null;
  }

  function buildLogView() {
    logViewEl = document.createElement('div');
    logViewEl.id = 'log-view';

    const head = document.createElement('div');
    head.id = 'log-head';
    const title = document.createElement('span');
    title.className = 'stars-main-title';
    title.textContent = 'ttpull log';
    logStatusEl = document.createElement('span');
    logStatusEl.className = 'log-status';
    logStatusEl.textContent = 'connecting…';

    const controls = document.createElement('div');
    controls.className = 'log-controls';
    const filter = document.createElement('input');
    filter.type = 'search';
    filter.className = 'log-filter';
    filter.placeholder = 'Filter';
    filter.addEventListener('input', () => { logFilter = filter.value.trim().toLowerCase(); renderLogAll(); });
    controls.appendChild(filter);

    ['info', 'warn', 'error'].forEach(level => {
      const b = document.createElement('button');
      b.className = 'log-btn log-level lvl-' + level + (logLevels[level] ? ' on' : '');
      b.textContent = level;
      b.title = 'Show or hide ' + level + ' lines';
      b.addEventListener('click', () => {
        logLevels[level] = !logLevels[level];
        b.classList.toggle('on', logLevels[level]);
        renderLogAll();
      });
      controls.appendChild(b);
    });

    const follow = document.createElement('button');
    follow.className = 'log-btn log-follow' + (logFollow ? ' on' : '');
    follow.textContent = '↓ Follow';
    follow.title = 'Keep the newest line in view';
    follow.addEventListener('click', () => {
      logFollow = !logFollow;
      follow.classList.toggle('on', logFollow);
      if (logFollow) scrollLogToEnd();
    });
    controls.appendChild(follow);

    const pause = document.createElement('button');
    pause.className = 'log-btn log-pause';
    const paintPause = () => {
      pause.textContent = logPaused ? '▶ Resume' : '⏸ Pause';
      pause.classList.toggle('on', logPaused);
    };
    paintPause();
    pause.addEventListener('click', () => {
      logPaused = !logPaused;
      paintPause();
      if (logPaused) { stopLogPolling(); setLogStatus('paused', 'paused'); }
      else startLogPolling();
    });
    controls.appendChild(pause);

    const clear = document.createElement('button');
    clear.className = 'log-btn';
    clear.textContent = 'Clear';
    clear.title = 'Clear the view (the log on the server is not affected)';
    clear.addEventListener('click', () => { logEntries.length = 0; if (logBodyEl) logBodyEl.innerHTML = ''; });
    controls.appendChild(clear);

    head.append(title, logStatusEl, controls);

    logBodyEl = document.createElement('div');
    logBodyEl.id = 'log-body';
    // Scrolling up turns Follow off; scrolling back to the bottom turns it on again
    logBodyEl.addEventListener('scroll', () => {
      const atEnd = logBodyEl.scrollHeight - logBodyEl.scrollTop - logBodyEl.clientHeight < 24;
      if (atEnd !== logFollow) {
        logFollow = atEnd;
        follow.classList.toggle('on', logFollow);
      }
    });

    logViewEl.append(head, logBodyEl);
    const main = document.querySelector('main');
    if (main) main.parentNode.insertBefore(logViewEl, main);
    else document.body.appendChild(logViewEl);
    renderLogAll();
  }

  function showLogTab() {
    if (isMobilePlayer() || logTabActive) return;
    if (settingsTabActive) hideSettingsView();
    if (listTabKind) hideListView();
    if (autotagTabActive) hideAutotagView();
    if (activeAuthorId) hideAuthorView();
    if (starsTabActive) {
      starsTabActive = false;
      if (starsViewEl) { releaseGridPreviews(starsViewEl); starsViewEl.style.display = 'none'; }
      document.querySelector('nav .stars-tab')?.classList.remove('active');
    }
    closeVideoOverlay();
    logTabActive = true;
    document.querySelector('main')?.style.setProperty('display', 'none');
    document.body.classList.add('sp-log-open');
    document.querySelector('nav .log-tab')?.classList.add('active');
    if (!logViewEl) buildLogView();
    logViewEl.style.display = 'flex';
    if (logFollow) scrollLogToEnd();
    startLogPolling();
  }

  // Hide only; the caller decides what to show next
  function hideLogView() {
    if (!logTabActive) return;
    logTabActive = false;
    stopLogPolling();
    if (logViewEl) logViewEl.style.display = 'none';
    document.body.classList.remove('sp-log-open');
    document.querySelector('nav .log-tab')?.classList.remove('active');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // AUTOTAGTT — review suggestions made by the local autotagTT batch job
  // Accept: records the decision, then adds the video to the tag's group (explicit click only).
  // Reject: records the decision only; group membership is never changed.
  // ═══════════════════════════════════════════════════════════════════════════

  let autotagTabActive = false;
  let autotagViewEl    = null;
  let atTag            = 'braces';
  let atMode           = 'pending';   // 'pending' | 'accepted' | 'rejected'
  let atData           = null;        // last /api/autotag response
  let atError          = '';
  let atBusy           = new Set();
  let atEnabled        = [];          // tags ticked in the picker (may not have suggestions yet)
  let atRun            = null;        // last /api/autotag/run status
  let atRunTimer       = null;

  function atGroupName(tag) {
    const g = groups.find(x => String(x.name).trim().toLowerCase() === tag);
    return g ? g.name : tag;
  }

  async function atLoad() {
    atError = '';
    try {
      const r = await fetch('/api/autotag?tag=' + encodeURIComponent(atTag), { cache: 'no-store' });
      if (!r.ok) throw new Error(r.status);
      atData = await r.json();
    } catch (_) { atData = null; atError = 'Could not load suggestions.'; }
    try { atEnabled = (await (await fetch('/api/autotag/tags', { cache: 'no-store' })).json()).enabled || []; } catch (_) {}
    renderAutotagView();
  }

  async function atSendFeedback(id, decision, change, tag = atTag) {
    const r = await fetch('/api/autotag/feedback', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tag, id, decision, change: !!change }),
    });
    if (!r.ok) throw new Error(r.status);
  }

  async function atDecide(id, decision, card) {
    if (atBusy.has(id)) return;
    atBusy.add(id);
    card.querySelectorAll('.at-btn').forEach(b => { b.disabled = true; });
    try {
      await atSendFeedback(id, decision, atMode !== 'pending');
      if (decision === 'accepted') {
        // Only now, after the explicit click and a recorded decision, touch the group
        const name = atGroupName(atTag);
        if (!inQuickGroup(id, name)) toggleQuickGroup(id, name);
      }
      atApplyLocal(id, decision);
    } catch (_) {
      card.querySelectorAll('.at-btn').forEach(b => { b.disabled = false; });
      atError = 'Could not save that decision; nothing was changed.';
      renderAutotagView();
    } finally { atBusy.delete(id); }
  }

  // Move one video between the pending / not sure / accepted / rejected lists without rebuilding the grid,
  // so the scroll position and the card under the mouse stay where they are.
  function atApplyLocal(id, decision) {
    if (!atData) return;
    const names = ['pending', 'unsure', 'accepted', 'rejected'];
    const src = names.find(n => (atData[n] || []).some(x => x.id === id));
    if (!src) return;
    const item = atData[src].find(x => x.id === id);
    // New arrays on purpose: the grid is still lazily filling from the old one
    atData[src] = atData[src].filter(x => x.id !== id);
    atData[decision] = [item, ...(atData[decision] || [])];
    const grid = document.getElementById('autotag-grid');
    if (src === atMode && grid) {
      grid.querySelector('[data-id="' + id + '"]')?.remove();
      if (!grid.querySelector('.stars-grid-card') && !grid.querySelector('.grid-sentinel')) {
        const d = document.createElement('div'); d.id = 'autotag-msg';
        d.textContent = atMode === 'pending' ? 'All reviewed. Nothing pending for "' + atTag + '".' : 'Nothing here now.';
        grid.appendChild(d);
      }
    }
    const labels = { pending: 'Pending', accepted: 'Accepted', rejected: 'Rejected', unsure: 'Not sure' };
    document.querySelectorAll('#autotag-head .at-mode').forEach(b => {
      const m = names.find(n => b.textContent.startsWith(labels[n]));
      if (m) b.textContent = labels[m] + ' ' + (atData[m] || []).length;
    });
  }

  // Accepted videos that are no longer in the tag's group (for example after an out-of-date tab overwrote the group)
  function atMissingAccepted() {
    if (!atData) return [];
    const name = atGroupName(atTag);
    return (atData.accepted || []).map(x => x.id).filter(id => !inQuickGroup(id, name));
  }

  async function atRestoreAccepted(btn, msg) {
    const miss = atMissingAccepted();
    if (!miss.length) return;
    const name = atGroupName(atTag);
    const ok = window.confirm('Add the ' + miss.length.toLocaleString() + ' videos you accepted for "' + name + '" back into that group?\n\n' +
      'Close every other Starplayer tab and window first: an old one can overwrite this again.\n' +
      'Only videos you accepted are added, and nothing is removed.');
    if (!ok) return;
    btn.disabled = true; msg.textContent = 'Restoring…';
    let g = groups.find(x => String(x.name).trim().toLowerCase() === atTag);
    if (!g) { g = { id: uid(), name: atTag, videoIds: [] }; groups.push(g); }
    const have = new Set(g.videoIds);
    miss.forEach(id => { if (!have.has(id)) g.videoIds.push(id); });
    saveGroups();
    await new Promise(r => setTimeout(r, 1500));                      // the save is debounced
    try {                                                              // check that the server really has them
      const d = await (await fetch('/api/stars', { cache: 'no-store' })).json();
      const sg = (d.groups || []).find(x => String(x.name).trim().toLowerCase() === atTag);
      const got = sg ? miss.filter(id => sg.videoIds.includes(id)).length : 0;
      msg.textContent = got === miss.length
        ? 'Restored ' + got.toLocaleString() + ' videos. "' + name + '" now has ' + sg.videoIds.length.toLocaleString() + '.'
        : 'Only ' + got + ' of ' + miss.length + ' were saved. Close other Starplayer windows and try again.';
    } catch (_) { msg.textContent = 'Could not confirm the save. Reload and check.'; }
    btn.disabled = false;
    renderAutotagView();
  }

  function buildAutotagCard(item, idx, list) {
    const id = item.id;
    const coverSrc = coverSrcFor(id);
    const info = getVideoInfo(id);
    const card = document.createElement('div');
    card.className = 'stars-grid-card';
    card.dataset.id = id;

    const cover = document.createElement('div');
    cover.className = 'stars-grid-cover';
    attachPreview(cover, getVideoPath(coverSrc));
    cover.addEventListener('click', () => openVideoOverlay(list.findIndex(v => v.id === id), list));
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.src = coverSrc;
    img.onerror = () => { img.style.display = 'none'; };
    cover.appendChild(img);
    cover.appendChild(buildThumbTools(id, coverSrc, info.authorName, info.desc));
    const un = info.authorName || '';
    if (un) {
      const u = document.createElement('span');
      u.className = 'at-user';
      setAuthorLink(u, un);
      cover.appendChild(u);
    }
    if (item.score != null) {
      const sc = document.createElement('span');
      sc.className = 'at-score';
      sc.title = 'Model score (higher = more like the tagged examples; not a probability)';
      sc.textContent = item.score.toFixed(2);
      cover.appendChild(sc);
    }
    card.appendChild(cover);

    const row = document.createElement('div');
    row.className = 'at-actions';
    const mk = (cls, text, title, fn) => {
      const b = document.createElement('button');
      b.className = 'at-btn ' + cls; b.textContent = text; b.title = title;
      b.addEventListener('click', e => { e.stopPropagation(); fn(); });
      return b;
    };
    const accept = () => mk('accept', '✓', 'Accept: add to "' + atGroupName(atTag) + '"', () => atDecide(id, 'accepted', card));
    const reject = () => mk('reject', '✕', 'Reject: not ' + atTag, () => atDecide(id, 'rejected', card));
    if (atMode === 'pending') {
      row.append(accept(),
        mk('unsure', '?', 'Not sure: set aside, no label for training', () => atDecide(id, 'unsure', card)),
        reject());
    } else if (atMode === 'unsure') {
      row.append(accept(), reject(), mk('', '↺', 'Move back to pending', () => atDecide(id, 'pending', card)));
    } else if (atMode === 'rejected') {
      row.append(mk('', 'Restore', 'Move back to pending', () => atDecide(id, 'pending', card)));
    } else {
      const n = document.createElement('div');
      n.className = 'at-note';
      n.textContent = inQuickGroup(id, atGroupName(atTag)) ? 'in "' + atGroupName(atTag) + '"' : 'accepted (no longer in group)';
      card.appendChild(n);
    }
    if (row.childNodes.length) card.appendChild(row);
    return card;
  }

  function renderAutotagView() {
    if (!autotagViewEl) return;
    releaseGridPreviews(autotagViewEl);
    const openPanels = ['at-picker', 'at-run-panel'].map(id => document.getElementById(id)).filter(Boolean);   // survive a re-render
    autotagViewEl.innerHTML = '';

    const head = document.createElement('div');
    head.id = 'autotag-head';
    const title = document.createElement('span');
    title.className = 'stars-main-title';
    title.textContent = 'autotagTT';
    const sel = document.createElement('select');
    sel.title = 'Tag';
    const tags = (atData && atData.tags && atData.tags.length) ? [...atData.tags] : [atTag];
    if (!tags.includes(atTag)) tags.push(atTag);
    tags.forEach(t => {
      const o = document.createElement('option');
      o.value = t; o.textContent = groupDisplayName(t); o.selected = t === atTag;
      sel.appendChild(o);
    });
    // Ticked in "Tags…" but not trained yet: listed, but nothing to review until the next run
    atEnabled.filter(t => !tags.includes(t)).forEach(t => {
      const o = document.createElement('option');
      o.value = t; o.disabled = true; o.textContent = groupDisplayName(t) + ' (waiting for next run)';
      sel.appendChild(o);
    });
    sel.addEventListener('change', () => { atTag = sel.value; atMode = 'pending'; atLoad(); });

    const modes = document.createElement('div');
    modes.className = 'at-modes';
    const counts = atData ? { pending: atData.pending.length, accepted: atData.accepted.length, rejected: atData.rejected.length, unsure: (atData.unsure || []).length } : {};
    const labels = { pending: 'Pending', accepted: 'Accepted', rejected: 'Rejected', unsure: 'Not sure' };
    ['pending', 'unsure', 'accepted', 'rejected'].forEach(m => {
      const b = document.createElement('button');
      b.className = 'at-mode' + (atMode === m ? ' on' : '');
      b.textContent = labels[m] + (counts[m] != null ? ' ' + counts[m] : '') + (m === 'accepted' && atMissingAccepted().length ? ' ⚠' : '');
      if (m === 'accepted' && atMissingAccepted().length) b.title = 'Some accepted videos are not in your group. Open this view to restore them.';
      b.addEventListener('click', () => { atMode = m; renderAutotagView(); });
      modes.appendChild(b);
    });
    const pick = document.createElement('button');
    pick.className = 'at-mode'; pick.textContent = 'Tags…'; pick.title = 'Choose which of your groups the AI tagger learns';
    pick.addEventListener('click', openTagPicker);
    const runBtn = document.createElement('button');
    runBtn.className = 'at-mode'; runBtn.textContent = 'Run…'; runBtn.title = 'Train the AI tagger now, or set it to run nightly';
    runBtn.addEventListener('click', openRunPanel);
    const chip = document.createElement('span');
    chip.id = 'at-run-chip'; chip.className = 'at-note';
    const row1 = document.createElement('div'); row1.className = 'at-row';
    const row2 = document.createElement('div'); row2.className = 'at-row';
    row1.append(title, sel, modes, pick, runBtn);
    head.append(row1, row2);
    atUpdateChip();

    const grid = document.createElement('div');
    grid.id = 'autotag-grid';
    grid.className = 'preview-grid';
    const msg = text => {
      const d = document.createElement('div'); d.id = 'autotag-msg'; d.textContent = text; grid.appendChild(d);
    };
    const list = sortVideos(atData && atData[atMode] ? atData[atMode] : [], 'autotag');  // unsure may be missing on an older server
    if (atError) msg(atError);
    if (!atData) { if (!atError) msg('Loading…'); }
    else if (!atData.available) msg('No suggestions yet. Run the autotagTT job first.');
    else if (!list.length) msg(atMode === 'pending' ? 'No pending suggestions for "' + atTag + '".' : 'Nothing here yet.');
    else {
      const ctx = list.map(it => {
        const cs = coverSrcFor(it.id), inf = getVideoInfo(it.id);
        return { id: it.id, coverSrc: cs, videoPath: getVideoPath(cs), authorName: inf.authorName || '', desc: inf.desc || '' };
      });
      fillGrid(grid, list, (it, i) => buildAutotagCard(it, i, ctx));
    }
    row2.append(buildGridControls('autotag', grid, autotagViewEl), chip);
    const miss = atMissingAccepted();
    let banner = null;
    if (miss.length && atMode === 'accepted') {
      banner = document.createElement('div');
      banner.id = 'at-restore';
      const t = document.createElement('span');
      t.textContent = miss.length.toLocaleString() + ' accepted videos are not in your "' + atGroupName(atTag) + '" group.';
      const b = document.createElement('button'); b.className = 'at-mode on'; b.textContent = 'Restore to group';
      const m = document.createElement('span'); m.className = 'at-note';
      b.addEventListener('click', () => atRestoreAccepted(b, m));
      banner.append(t, b, m);
    }
    autotagViewEl.append(head, ...(banner ? [banner] : []), grid, ...openPanels);
    observeGridPreviews(grid);
  }

  function showAutotagTab() {
    if (autotagTabActive) return;
    if (settingsTabActive && !isMobilePlayer()) hideSettingsView();
    if (listTabKind && !isMobilePlayer()) hideListView();
    if (activeAuthorId) hideAuthorView();
    if (logTabActive) hideLogView();
    if (starsTabActive) {
      starsTabActive = false;
      if (starsViewEl) { releaseGridPreviews(starsViewEl); starsViewEl.style.display = 'none'; }
      document.querySelector('nav .stars-tab')?.classList.remove('active');
    }
    closeVideoOverlay();
    autotagTabActive = true;
    document.querySelector('main')?.style.setProperty('display', 'none');
    document.body.classList.add('sp-autotag-open');
    if (isMobilePlayer()) { activeMobileTab = 'review'; updateMobileNavActive(); }
    else document.querySelector('nav .autotag-tab')?.classList.add('active');
    if (!autotagViewEl) {
      autotagViewEl = document.createElement('div');
      autotagViewEl.id = 'autotag-view';
      const main = document.querySelector('main');
      if (main) main.parentNode.insertBefore(autotagViewEl, main); else document.body.appendChild(autotagViewEl);
    }
    autotagViewEl.style.display = 'flex';
    atStartPolling();
    ensureArchiveDb();
    if (_dbCache) { renderAutotagView(); atLoad(); }
    else { renderAutotagView(); archiveDbPromise().catch(() => {}).then(() => { if (autotagTabActive) atLoad(); }); }
  }

  function hideAutotagView() {
    if (!autotagTabActive) return;
    autotagTabActive = false;
    releaseGridPreviews(autotagViewEl);
    if (autotagViewEl) autotagViewEl.style.display = 'none';
    document.body.classList.remove('sp-autotag-open');
    document.querySelector('nav .autotag-tab')?.classList.remove('active');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // LABEL BUBBLES — human group labels or AI tags under each Stars thumbnail
  // AI tags are the model's guesses, kept apart from human groups. ✓ promotes one into the human
  // group (explicit click only); ✕ records a rejection and never touches groups.
  // ═══════════════════════════════════════════════════════════════════════════

  let labelMode   = (() => { try { return localStorage.getItem('sp_label_mode') === 'ai' ? 'ai' : 'human'; } catch (_) { return 'human'; } })();
  let aiVideos    = null;          // { videoId: [[tag, score], ...] } from /api/autotag/ai
  let aiLoading   = false;
  let activeAiTag = '__all__';     // AI view selection: a tag key, or '__all__'
  const aiDone    = new Set();     // "tag|id" decided in this session (hidden at once)

  function loadAiVideos(force) {
    if (aiLoading || (aiVideos && !force)) return;
    aiLoading = true;
    fetch('/api/autotag/ai', { cache: 'no-store' }).then(r => r.ok ? r.json() : null).then(d => {
      aiVideos = (d && d.videos) || {};
    }).catch(() => { aiVideos = {}; }).finally(() => {
      aiLoading = false;
      if (starsTabActive && labelMode === 'ai') renderStarsView();
    });
  }

  function buildLabelToggle() {
    const wrap = document.createElement('div');
    wrap.className = 'grid-sort sp-label-toggle';
    wrap.setAttribute('role', 'group');
    wrap.title = 'Labels shown under each thumbnail: your groups, or the AI tagger\'s guesses';
    [['human', 'Human'], ['ai', 'AI']].forEach(([mode, text]) => {
      const b = document.createElement('button');
      b.className = 'grid-sort-btn' + (labelMode === mode ? ' on' : '');
      b.textContent = text;
      b.setAttribute('aria-pressed', labelMode === mode ? 'true' : 'false');
      b.addEventListener('click', e => {
        e.stopPropagation();
        if (labelMode === mode) return;
        labelMode = mode;
        try { localStorage.setItem('sp_label_mode', mode); } catch (_) {}
        if (mode === 'ai') loadAiVideos(true);
        renderStarsView();
      });
      wrap.appendChild(b);
    });
    return wrap;
  }

  // ── AI view of the Stars page: browse every video the AI tagger labelled ──
  function aiBrowseData() {
    const byTag = new Map();
    const items = [];
    Object.entries(aiVideos || {}).forEach(([id, list]) => {
      const tags = list.filter(([tag]) => !aiDone.has(tag + '|' + id) && !inQuickGroup(id, groupDisplayName(tag)));
      if (!tags.length) return;
      tags.forEach(([tag]) => byTag.set(tag, (byTag.get(tag) || 0) + 1));
      items.push({ id, tags });
    });
    return { byTag, items };
  }

  function aiSelectedList(data) {
    const sel = activeAiTag;
    const rows = [];
    data.items.forEach(it => {
      const hit = sel === '__all__' ? it.tags : it.tags.filter(([t]) => t === sel);
      if (!hit.length) return;
      const best = Math.max(...hit.map(t => t[1]));
      const star = stars[it.id] ? { ...stars[it.id], id: it.id }
        : { id: it.id, coverSrc: coverSrcFor(it.id), authorName: '', desc: '', lvlOnly: true };
      rows.push({ star, best });
    });
    rows.sort((a, b) => b.best - a.best);
    return sortVideos(rows.map(r => r.star), 'stars');
  }

  function aiViewAfterDecision(id, tag) {
    const grid = document.getElementById('stars-grid');
    const card = grid && [...grid.querySelectorAll('.stars-grid-card')].find(c => c.dataset.vid === id);
    if (card && (activeAiTag === tag || !card.querySelector('.sp-bubble.ai'))) card.remove();
    const data = aiBrowseData();
    document.querySelectorAll('[data-ai-count]').forEach(el => {
      const k = el.dataset.aiCount;
      el.textContent = k === '__all__' ? data.items.length : (data.byTag.get(k) || 0);
    });
    const n = aiSelectedList(data).length;
    document.querySelectorAll('#stars-view .stars-main-count').forEach(el => { el.textContent = n + ' video' + (n !== 1 ? 's' : ''); });
  }

  function renderAiStarsView(keep) {
    if (!aiVideos) loadAiVideos();
    const data = aiBrowseData();
    if (activeAiTag !== '__all__' && !data.byTag.has(activeAiTag)) activeAiTag = '__all__';
    const tagKeys = [...data.byTag.keys()].sort((a, b) => data.byTag.get(b) - data.byTag.get(a));

    const sidebar = document.createElement('div');
    sidebar.id = 'stars-sidebar';
    sidebar.appendChild(buildLabelToggle());
    const mk = (key, label, count) => {
      const item = document.createElement('div');
      item.className = 'stars-group-item' + (activeAiTag === key ? ' active' : '');
      const nm = document.createElement('span'); nm.className = 'stars-group-name'; nm.textContent = label;
      const ct = document.createElement('span'); ct.className = 'stars-group-count'; ct.textContent = count; ct.dataset.aiCount = key;
      item.append(nm, ct);
      item.addEventListener('click', () => { activeAiTag = key; renderStarsView(); });
      return item;
    };
    sidebar.appendChild(mk('__all__', 'All AI-tagged', data.items.length));
    const hr = document.createElement('hr'); hr.className = 'stars-sidebar-divider'; sidebar.appendChild(hr);
    tagKeys.forEach(t => sidebar.appendChild(mk(t, groupDisplayName(t), data.byTag.get(t))));
    const note = document.createElement('div');
    note.className = 'sp-ai-note';
    note.textContent = 'AI guesses, not your tags. ✓ on a bubble adds the video to your group; ✕ says it is wrong.';
    sidebar.appendChild(note);
    starsViewEl.appendChild(sidebar);

    const list = aiSelectedList(data);
    const label = activeAiTag === '__all__' ? 'All AI-tagged' : groupDisplayName(activeAiTag);
    const countText = list.length + ' video' + (list.length !== 1 ? 's' : '');
    const titleHtml = `<span class="stars-main-title">AI · ${label.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))}</span><span class="stars-main-count">${countText}</span>`;

    const mainArea = document.createElement('div');
    mainArea.id = 'stars-main';
    const mainHeader = document.createElement('div');
    mainHeader.id = 'stars-main-header';
    mainHeader.innerHTML = titleHtml;
    mainArea.appendChild(mainHeader);

    // Phone header: title, a tag picker in place of the sidebar, then the usual controls
    const mobileHdr = document.createElement('div');
    mobileHdr.id = 'stars-mobile-header';
    const mobileTopRow = document.createElement('div');
    mobileHdr.appendChild(mobileTopRow);
    const mobileTitle = document.createElement('div');
    mobileTitle.id = 'stars-mobile-title';
    mobileTitle.innerHTML = titleHtml;
    mobileTopRow.appendChild(mobileTitle);
    const pick = document.createElement('select');
    pick.className = 'sp-ai-pick';
    [['__all__', 'All AI-tagged', data.items.length], ...tagKeys.map(t => [t, groupDisplayName(t), data.byTag.get(t)])].forEach(([k, l, c]) => {
      const o = document.createElement('option'); o.value = k; o.textContent = l + ' (' + c + ')'; o.selected = k === activeAiTag; pick.appendChild(o);
    });
    pick.addEventListener('change', () => { activeAiTag = pick.value; renderStarsView(); });
    mobileTopRow.appendChild(pick);
    mainArea.insertBefore(mobileHdr, mainHeader);

    const grid = document.createElement('div');
    grid.id = 'stars-grid';
    grid.classList.add('preview-grid');
    setStarsContext(list);
    if (!aiVideos) {
      const e = document.createElement('div'); e.id = 'stars-empty'; e.textContent = 'Loading AI tags…'; grid.appendChild(e);
    } else if (!list.length) {
      const e = document.createElement('div'); e.id = 'stars-empty';
      e.innerHTML = tagKeys.length ? 'Nothing left to review for this tag.' : 'No AI tags yet.<br>Run the AI tagger from the autotagTT page (Run…).';
      grid.appendChild(e);
    } else {
      fillGrid(grid, list, star => {
        const info = getVideoInfo(star.id);
        const card = buildStarsGridCard(star, info.authorName || star.authorName || '', info.desc || star.desc || '', null, true);
        card.dataset.vid = star.id;
        return card;
      });
    }
    mainHeader.appendChild(buildGridControls('stars', grid, starsViewEl));
    mobileTopRow.appendChild(buildGridControls('stars', grid, starsViewEl));
    mobileTopRow.appendChild(buildLabelToggle());
    mainArea.appendChild(grid);
    starsViewEl.appendChild(mainArea);
    if (keep && grid._fillTo) { grid._fillTo(keep.loaded); grid.scrollTop = keep.scroll; }
    observeGridPreviews(grid);
  }

  function groupDisplayName(tag) {
    const g = groups.find(x => String(x.name).trim().toLowerCase() === tag);
    return g ? g.name : tag;
  }

  function makeBubble(text, cls) {
    const b = document.createElement('span');
    b.className = 'sp-bubble ' + cls;
    const t = document.createElement('span');
    t.className = 'sp-bubble-name';
    t.textContent = text;
    b.appendChild(t);
    return b;
  }

  async function aiBubbleDecide(bubble, id, tag, decision) {
    if (bubble._busy) return;
    bubble._busy = true;
    bubble.classList.add('busy');
    try {
      await atSendFeedback(id, decision, false, tag);
      aiDone.add(tag + '|' + id);
      if (decision === 'accepted') {
        const name = atGroupName(tag);
        if (!inQuickGroup(id, name)) toggleQuickGroup(id, name);   // re-renders the stars view
      }
      if (bubble.isConnected) bubble.remove();
      if (labelMode === 'ai' && starsTabActive) aiViewAfterDecision(id, tag);
    } catch (_) {
      bubble._busy = false;
      bubble.classList.remove('busy');
      bubble.classList.add('err');
      bubble.title = 'Could not save; nothing was changed';
    }
  }

  function appendLabelBubbles(cover, videoId) {
    const items = [];
    if (labelMode === 'ai') {
      if (!aiVideos) { loadAiVideos(); return; }
      (aiVideos[videoId] || []).slice().sort((a, b) => b[1] - a[1]).forEach(([tag, score]) => {
        if (aiDone.has(tag + '|' + videoId) || inQuickGroup(videoId, groupDisplayName(tag))) return;
        items.push({ tag, score });
      });
    } else {
      groups.forEach(g => { if (g.videoIds.includes(videoId)) items.push({ name: g.name }); });
    }
    if (!items.length) return;
    const box = document.createElement('div');
    box.className = 'sp-bubbles';
    box.addEventListener('click', e => e.stopPropagation());
    items.slice(0, 5).forEach(it => {
      if (it.name != null) { box.appendChild(makeBubble(it.name, 'human')); return; }
      const b = makeBubble(groupDisplayName(it.tag), 'ai');
      b.title = 'AI tag "' + groupDisplayName(it.tag) + '" (score ' + it.score.toFixed(2) + '). ✓ add to your group, ✕ not this tag';
      const ok = document.createElement('button');
      ok.className = 'sp-bubble-act ok'; ok.textContent = '✓'; ok.title = 'Accept: add to "' + groupDisplayName(it.tag) + '"';
      ok.addEventListener('click', e => { e.stopPropagation(); aiBubbleDecide(b, videoId, it.tag, 'accepted'); });
      const no = document.createElement('button');
      no.className = 'sp-bubble-act no'; no.textContent = '✕'; no.title = 'Reject: not ' + groupDisplayName(it.tag);
      no.addEventListener('click', e => { e.stopPropagation(); aiBubbleDecide(b, videoId, it.tag, 'rejected'); });
      b.append(ok, no);
      box.appendChild(b);
    });
    cover.appendChild(box);
  }

  // ── Run panel: start the AI tagger and schedule it nightly. Starplayer only leaves a request; the
  // autotagTT worker container runs its own fixed job and reports back through a status file. ──
  function fmtAgo(t) {
    if (!t) return 'never';
    const s = Math.max(0, Date.now() / 1000 - t);
    if (s < 90) return 'just now';
    if (s < 5400) return Math.round(s / 60) + ' min ago';
    if (s < 129600) return Math.round(s / 3600) + ' h ago';
    return new Date(t * 1000).toLocaleDateString();
  }

  function atStateText(r) {
    if (!r) return '';
    if (!r.workerOnline) return 'AI tagger worker is offline';
    if (r.state === 'queued') return 'Queued, starting shortly…';
    if (r.state === 'running') return 'Running: ' + (r.phase === 'frames' ? 'reading video frames' : (r.phase || 'starting')) + (r.detail ? ' (' + r.detail + ')' : '');
    if (r.phase === 'failed') return 'Last run failed' + (r.error ? ': ' + r.error : '');
    return 'Idle. Last run ' + fmtAgo(r.lastOk);
  }

  function fmtEta(min) {
    if (min == null || !isFinite(min)) return '';
    if (min < 1) return 'under a minute';
    if (min < 90) return Math.round(min) + ' min';
    const h = Math.floor(min / 60);
    return h + ' h ' + Math.round(min - h * 60) + ' min';
  }

  // What to show for the video-frame scan, from the server's live progress (so it is the same on every device and survives reloads)
  function atFramesModel() {
    const f = atRun && atRun.frames;
    const p = f && f.progress;
    if (!p) return null;
    if (p.mode === 'trial') {
      if (!p.running || !p.sessionTarget) return null;
      const pct = Math.min(100, 100 * p.sessionDone / p.sessionTarget);
      return { kind: 'trial', pct, threshold: null, running: true,
               short: 'Frame trial ' + Math.round(pct) + '% (' + p.sessionDone.toLocaleString() + ' of ' + p.sessionTarget.toLocaleString() + ' videos)',
               long: 'Reading a sample of videos to measure whether frames help. Your tags and suggestions are not affected.' };
    }
    const wantsFull = f.config && f.config.mode === 'full';
    if ((!wantsFull && !p.running) || !p.total || p.covered >= p.total) return null;
    const pct = 100 * p.covered / p.total;
    const rate = p.running && p.rate > 0 ? p.rate : ((f.stats && f.stats.rate) || 0);
    const eta = rate > 0 ? fmtEta((p.total - p.covered) / rate / 60) : '';
    const inUse = p.covered / p.total >= p.threshold;
    return { kind: 'full', pct, threshold: p.threshold, running: p.running, covered: p.covered, total: p.total,
             short: 'Frames ' + (pct < 10 ? pct.toFixed(1) : Math.round(pct)) + '% · ' + p.covered.toLocaleString() + ' of ' + p.total.toLocaleString() +
                    (p.running ? (eta ? ' · about ' + eta + ' left' : '') : ' · paused until the next run'),
             long: p.covered.toLocaleString() + ' of ' + p.total.toLocaleString() + ' videos read. ' +
                   (p.running ? (eta ? 'About ' + eta + ' left at this speed. ' : '') : 'Waiting for the next run (Run now, or the nightly run). ') +
                   (inUse ? 'The AI is using frames.' : 'The AI starts using frames at ' + Math.round(p.threshold * 100) + '% (the yellow mark).') };
  }

  function makeProgressBar(m, big) {
    const bar = document.createElement('span');
    bar.className = 'at-bar' + (big ? ' big' : '') + (m.running ? ' run' : '');
    bar.setAttribute('role', 'progressbar');
    bar.setAttribute('aria-valuemin', '0'); bar.setAttribute('aria-valuemax', '100'); bar.setAttribute('aria-valuenow', String(Math.round(m.pct)));
    const fill = document.createElement('i'); fill.style.width = m.pct + '%';
    bar.appendChild(fill);
    if (m.threshold) { const mark = document.createElement('b'); mark.style.left = (m.threshold * 100) + '%'; mark.title = 'The AI uses frames from here'; bar.appendChild(mark); }
    return bar;
  }

  function atUpdateChip() {
    const c = document.getElementById('at-run-chip');
    if (!c) return;
    const m = atFramesModel();
    c.textContent = '';
    if (m) {
      c.appendChild(makeProgressBar(m, false));
      c.appendChild(document.createTextNode(m.short));
      c.title = m.long;
    } else {
      c.textContent = atRun && (atRun.state !== 'idle' || !atRun.workerOnline) ? atStateText(atRun) : '';
      c.title = '';
    }
  }

  // A thin strip on the autotagTT nav tab (and the phone's Review button) so the scan is visible from any page
  function atUpdateStrips() {
    const m = atFramesModel();
    const targets = [document.querySelector('nav .autotag-tab'), document.querySelector('#sp-mobile-nav .sp-nav-btn[data-tab="review"]')];
    targets.forEach(el => {
      if (!el) return;
      let i = el.querySelector(':scope > .sp-prog');
      if (!m) { if (i) i.remove(); if ('baseTitle' in el.dataset) el.title = el.dataset.baseTitle; return; }
      if (!i) { i = document.createElement('i'); i.className = 'sp-prog'; el.appendChild(i); }
      i.style.width = m.pct + '%';
      if (!('baseTitle' in el.dataset)) el.dataset.baseTitle = el.title || '';
      el.title = (el.dataset.baseTitle ? el.dataset.baseTitle + ' · ' : '') + m.short;
    });
  }

  async function atPollRun(done) {
    let was = atRun && atRun.state;
    try { atRun = await (await fetch('/api/autotag/run', { cache: 'no-store' })).json(); } catch (_) { return; }
    atUpdateChip();
    atUpdateStrips();
    const panel = document.getElementById('at-run-panel');
    if (panel && panel._render) panel._render();
    if (was && was !== 'idle' && atRun.state === 'idle') { aiVideos = null; if (autotagTabActive) await atLoad(); }   // a run just finished: refresh
    if (done) done();
  }

  // Light background check on every page, so the progress strip is right on any device without opening the review page
  function atGlobalLoop() {
    const busy = atRun && (atRun.state !== 'idle' || (atRun.frames && atRun.frames.progress && atRun.frames.progress.running));
    const delay = document.hidden ? 60000 : busy ? 5000 : 30000;
    setTimeout(async () => { if (!document.hidden) await atPollRun(); atGlobalLoop(); }, delay);
  }

  function atStartPolling() {
    clearInterval(atRunTimer);
    atPollRun();
    atRunTimer = setInterval(() => {
      if (!autotagTabActive) { clearInterval(atRunTimer); atRunTimer = null; return; }
      atPollRun();
    }, 3000);
  }

  function openRunPanel() {
    const old = document.getElementById('at-run-panel');
    if (old) { old.remove(); return; }
    const panel = document.createElement('div');
    panel.id = 'at-run-panel';
    panel.className = 'at-popup';
    const h = document.createElement('div');
    h.className = 'at-picker-head'; h.textContent = 'AI tagger';
    const status = document.createElement('div');
    status.className = 'at-run-status';
    const run = document.createElement('button');
    run.className = 'at-mode on'; run.textContent = 'Run now';
    run.addEventListener('click', async () => {
      run.disabled = true;
      try {
        const r = await fetch('/api/autotag/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        if (!r.ok && r.status !== 409 && r.status !== 429) throw new Error(r.status);
      } catch (_) { status.textContent = 'Could not request a run.'; }
      atPollRun();
    });
    const results = document.createElement('div');
    results.className = 'at-run-results';
    const sched = document.createElement('div');
    sched.className = 'at-run-sched';
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.id = 'at-sched-on';
    const lab = document.createElement('label'); lab.htmlFor = 'at-sched-on'; lab.textContent = 'Run every night at';
    const hour = document.createElement('select');
    for (let i = 0; i < 24; i++) { const o = document.createElement('option'); o.value = i; o.textContent = String(i).padStart(2, '0') + ':00'; hour.appendChild(o); }
    const msg = document.createElement('span'); msg.className = 'at-note';
    const saveSched = async () => {
      try {
        const r = await fetch('/api/autotag/schedule', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: cb.checked, hour: parseInt(hour.value, 10) }) });
        msg.textContent = r.ok ? 'Saved' : 'Could not save';
      } catch (_) { msg.textContent = 'Could not save'; }
    };
    cb.addEventListener('change', saveSched); hour.addEventListener('change', saveSched);
    sched.append(cb, lab, hour, msg);
    const notif = document.createElement('div');
    notif.className = 'at-run-sched';
    const notifText = document.createElement('span');
    const notifBtn = document.createElement('button');
    notifBtn.className = 'at-mode'; notifBtn.textContent = 'Send test';
    const notifMsg = document.createElement('span'); notifMsg.className = 'at-note';
    notifBtn.addEventListener('click', async () => {
      notifBtn.disabled = true; notifMsg.textContent = 'Sending…';
      const before = atRun && atRun.notifyTest ? atRun.notifyTest.id : null;
      try {
        const r = await fetch('/api/autotag/notify-test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        if (!r.ok) throw new Error(r.status);
        for (let i = 0; i < 12; i++) {                         // the worker answers within a few seconds
          await new Promise(res => setTimeout(res, 1500));
          await atPollRun();
          if (atRun && atRun.notifyTest && atRun.notifyTest.id !== before) { notifMsg.textContent = atRun.notifyTest.ok ? 'Sent. Check your phone.' : 'The server rejected it.'; break; }
          if (i === 11) notifMsg.textContent = 'No answer from the worker.';
        }
      } catch (_) { notifMsg.textContent = 'Could not request a test.'; }
      notifBtn.disabled = false;
    });
    notif.append(notifText, notifBtn, notifMsg);
    // ── Video frames (looks inside the videos). Off by default; a trial measures the benefit first. ──
    const fr = document.createElement('div');
    fr.className = 'at-frames';
    const frHead = document.createElement('div');
    frHead.className = 'at-picker-head'; frHead.textContent = 'Video frames';
    const frNote = document.createElement('div');
    frNote.className = 'at-note';
    frNote.textContent = 'Reads about 5 frames from each video so tags that are not visible on the cover can work. Nothing is kept except the numbers; frames are deleted as each batch finishes.';
    const frMode = document.createElement('select');
    [['off', 'Off'], ['trial', 'Trial (a few thousand videos)'], ['full', 'Full scan (every video)']].forEach(([v, t]) => {
      const o = document.createElement('option'); o.value = v; o.textContent = t; frMode.appendChild(o);
    });
    const frBudget = document.createElement('select');
    [30, 60, 120, 240].forEach(m => { const o = document.createElement('option'); o.value = m; o.textContent = 'up to ' + m + ' min per run'; frBudget.appendChild(o); });
    const frMouthLab = document.createElement('label');
    const frMouth = document.createElement('input'); frMouth.type = 'checkbox';
    frMouthLab.append(frMouth, document.createTextNode(' Also look at the lower face (finds small details such as braces)'));
    const frBar = document.createElement('div');
    frBar.className = 'at-frbar';
    const frInfo = document.createElement('div');
    frInfo.className = 'at-note';
    const frTrial = document.createElement('div');
    frTrial.className = 'at-run-results';
    const frMsg = document.createElement('span'); frMsg.className = 'at-note';
    let frLoaded = false;
    const frEstimate = () => {
      const f = atRun && atRun.frames; const st = f && f.stats;
      if (!st || !st.total) return 'No frames read yet. Run the trial first to measure the speed on your server.';
      const left = Math.max(0, st.total - st.done);
      const pct = Math.round(100 * st.done / st.total);
      let t = st.done.toLocaleString() + ' of ' + st.total.toLocaleString() + ' videos done (' + pct + '%).';
      if (st.rate > 0 && left) t += ' About ' + Math.max(1, Math.round(left / st.rate / 60)).toLocaleString() + ' min of reading left at ' + (st.rate * 60).toFixed(0) + ' videos/min.';
      else if (!st.rate && left) t += ' Speed not measured yet.';
      if (!left) t += ' All videos covered; the AI uses frames wherever they improve a tag.';
      else t += ' The AI starts using frames once 95% are done.';
      return t;
    };
    const frSave = async (confirmed) => {
      const body = { mode: frMode.value, mouth: frMouth.checked, budget_min: parseInt(frBudget.value, 10) };
      if (body.mode === 'full' && !confirmed) {
        const ok = window.confirm('Full scan: reads frames from every video in the archive on your server.\n\n' + frEstimate() + '\n\nIt runs inside the normal runs (up to ' + body.budget_min + ' min each) and can be stopped by switching to Off. Start?');
        if (!ok) { frMode.value = (atRun && atRun.frames ? atRun.frames.config.mode : 'off'); return; }
      }
      try {
        const r = await fetch('/api/autotag/frames', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        frMsg.textContent = r.ok ? 'Saved. Takes effect on the next run.' : 'Could not save.';
      } catch (_) { frMsg.textContent = 'Could not save.'; }
    };
    frMode.addEventListener('change', () => frSave(false));
    frBudget.addEventListener('change', () => frSave(true));
    frMouth.addEventListener('change', () => frSave(true));
    fr.append(frHead, frNote, frMode, frBudget, frMouthLab, frBar, frInfo, frTrial, frMsg);
    panel._renderFrames = () => {
      const f = atRun && atRun.frames;
      if (f && !frLoaded) { frMode.value = f.config.mode; frBudget.value = String(f.config.budget_min); frMouth.checked = f.config.mouth; frLoaded = true; }
      const fm = atFramesModel();
      frBar.textContent = '';
      if (fm) frBar.appendChild(makeProgressBar(fm, true));
      frInfo.textContent = fm ? fm.long : frEstimate();
      frTrial.innerHTML = '';
      const tr = f && f.trial;
      if (tr && Object.keys(tr).length) {
        const h = document.createElement('div'); h.className = 'at-note'; h.textContent = 'Trial: accuracy (average precision) with and without frames';
        frTrial.appendChild(h);
        Object.entries(tr).forEach(([tag, m]) => {
          const row = document.createElement('div'); row.className = 'at-run-row';
          const nm = document.createElement('span'); nm.textContent = groupDisplayName(tag);
          const v = document.createElement('span'); v.className = 'at-note';
          const gain = m.ap_frames - m.ap_cover;
          v.textContent = m.ap_cover.toFixed(2) + ' → ' + m.ap_frames.toFixed(2) + (m.ap_mouth != null ? ' (+face ' + m.ap_mouth.toFixed(2) + ')' : '') + (gain > 0.05 ? '  ↑ helps' : gain < -0.02 ? '  no help' : '  similar');
          row.append(nm, v); frTrial.appendChild(row);
        });
      }
    };
    const close = document.createElement('button');
    close.className = 'at-mode'; close.textContent = 'Close';
    close.addEventListener('click', () => panel.remove());
    let schedLoaded = false;
    panel._render = () => {
      status.textContent = atStateText(atRun);
      const nOn = !!(atRun && atRun.notifications);
      notifText.textContent = nOn ? 'Phone notifications: on' : 'Phone notifications: off (set NTFY_URL on the worker)';
      notifBtn.style.display = nOn ? '' : 'none';
      run.disabled = !atRun || !atRun.workerOnline || atRun.state !== 'idle';
      if (atRun && !schedLoaded) { cb.checked = atRun.schedule.enabled; hour.value = String(atRun.schedule.hour); schedLoaded = true; }
      panel._renderFrames();
      results.innerHTML = '';
      const res = atRun && atRun.result;
      if (res) Object.entries(res).forEach(([tag, m]) => {
        const row = document.createElement('div');
        row.className = 'at-run-row';
        const nm = document.createElement('span'); nm.textContent = groupDisplayName(tag);
        const info = document.createElement('span'); info.className = 'at-note';
        info.textContent = m.gate === 'weak' ? 'too weak to use' : (m.pending + ' to review, ' + m.ai_count + ' AI-tagged');
        row.append(nm, info);
        results.appendChild(row);
      });
    };
    const foot = document.createElement('div');
    foot.className = 'at-picker-foot';
    foot.append(run, close);
    panel.append(h, status, foot, results, sched, notif, fr);
    autotagViewEl.appendChild(panel);
    panel._render();
    atPollRun();
  }

  // ── Tag picker: which of your groups the autotagTT job should train and tag ──
  async function openTagPicker() {
    const old = document.getElementById('at-picker');
    if (old) { old.remove(); return; }
    let enabled = [];
    try { enabled = (await (await fetch('/api/autotag/tags', { cache: 'no-store' })).json()).enabled || []; } catch (_) {}
    const sel = new Set(enabled);
    const panel = document.createElement('div');
    panel.id = 'at-picker';
    const h = document.createElement('div');
    h.className = 'at-picker-head';
    h.textContent = 'Tags for the AI tagger';
    const note = document.createElement('div');
    note.className = 'at-note';
    note.textContent = 'This only saves your choice. Ticked groups are trained the next time the AI tagger runs (use Run… or wait for the nightly run); then they appear in the tag dropdown with suggestions. Choose visual, non-sensitive tags; a group needs about 30 videos.';
    const list = document.createElement('div');
    list.className = 'at-picker-list';
    [...groups].sort((a, b) => a.name.localeCompare(b.name)).forEach(g => {
      const key = String(g.name).trim().toLowerCase();
      const row = document.createElement('label');
      row.className = 'at-picker-row';
      const cb = document.createElement('input');
      cb.type = 'checkbox'; cb.checked = sel.has(key);
      cb.addEventListener('change', () => { cb.checked ? sel.add(key) : sel.delete(key); });
      const nm = document.createElement('span');
      nm.textContent = g.name;
      const ct = document.createElement('span');
      ct.className = 'at-note';
      ct.textContent = g.videoIds.length + (g.videoIds.length < 30 ? ' (too few)' : '');
      row.append(cb, nm, ct);
      list.appendChild(row);
    });
    const msg = document.createElement('span');
    msg.className = 'at-note';
    const save = document.createElement('button');
    save.className = 'at-mode on'; save.textContent = 'Save';
    save.addEventListener('click', async () => {
      try {
        const r = await fetch('/api/autotag/tags', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: [...sel] }) });
        if (!r.ok) throw new Error(r.status);
        msg.textContent = 'Saved. Not trained yet: use Run… or wait for the nightly run.'; atEnabled = [...sel]; renderAutotagView();
      } catch (_) { msg.textContent = 'Could not save.'; }
    });
    const close = document.createElement('button');
    close.className = 'at-mode'; close.textContent = 'Close';
    close.addEventListener('click', () => panel.remove());
    const foot = document.createElement('div');
    foot.className = 'at-picker-foot';
    foot.append(save, close, msg);
    panel.append(h, note, list, foot);
    autotagViewEl.appendChild(panel);
  }

  function makeNavTab(className, svgPath, label, onClick) {
    const tab = document.createElement('div');
    tab.className = className + ' pressable';
    tab.title = label;
    tab.innerHTML =
      `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" style="flex-shrink:0">${svgPath}</svg>${label}`;
    tab.addEventListener('click', onClick);
    return tab;
  }

  function injectNavTabs() {
    const nav = document.querySelector('nav');
    if (!nav) return;

    // Labels are hidden by CSS, so keep them available as tooltips
    nav.querySelectorAll('.pressable').forEach(t => {
      if (!t.title) t.title = t.textContent.trim();
    });

    // Likes, Favorites and Following are kashibox's own pages
    [['.likes', 'likes'], ['.bookmarked', 'bookmarked'], ['.following', 'following']].forEach(([sel, kind]) => {
      const el = nav.querySelector(sel);
      if (el && !el._spWired) { el._spWired = true; el.addEventListener('click', () => showListTab(kind)); }
    });

    // Stars tab — after .following
    if (!nav.querySelector('.stars-tab')) {
      const following = nav.querySelector('.following');
      if (following) {
        const tab = makeNavTab('stars-tab',
          '<path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>',
          'Stars',
          () => { if (!starsTabActive) showStarsTab(); }
        );
        if (starsTabActive) tab.classList.add('active');
        following.insertAdjacentElement('afterend', tab);
      }
    }

    // Player tab — after .stars-tab
    if (!nav.querySelector('.player-tab')) {
      const starsTab = nav.querySelector('.stars-tab');
      if (starsTab) {
        const tab = makeNavTab('player-tab',
          '<path d="M8 5v14l11-7z"/>',
          'Open player in a new window',
          () => {
            if (isMobilePlayer()) {
              if (!playerOpen) openPlayer(); else closePlayer();
            } else {
              launchPlayerWindow();
            }
          }
        );
        // A button, not a page tab: without .pressable the nav click handler leaves the current view alone
        tab.classList.remove('pressable');
        starsTab.insertAdjacentElement('afterend', tab);
      }
    }

    // Sessions button — next to Player
    if (!nav.querySelector('.session-tab')) {
      const playerTab = nav.querySelector('.player-tab');
      if (playerTab) {
        const tab = makeNavTab('session-tab',
          '<path d="M21 3H3c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H3V5h10v4h8v10z"/>',
          'Tab sessions',
          toggleSessionsMenu
        );
        tab.classList.remove('pressable');
        playerTab.insertAdjacentElement('afterend', tab);
      }
    }

    // Settings — the gear, right of the player button
    if (!nav.querySelector('.settings-tab')) {
      const tab = makeNavTab('settings-tab',
        GEAR_PATH,
        'Settings',
        () => showSettingsTab()
      );
      if (settingsTabActive) tab.classList.add('active');
      nav.appendChild(tab);
    }

    // Live log tab — last in the nav, right-aligned so it sits against the search field
    if (!nav.querySelector('.log-tab')) {
      const tab = makeNavTab('log-tab',
        '<path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 14H4V8h16v10zm-2-1h-6v-2h6v2zM7.5 17l-1.41-1.41L8.67 13l-2.58-2.59L7.5 9l4 4-4 4z"/>',
        'ttpull live log',
        () => showLogTab()
      );
      if (logTabActive) tab.classList.add('active');
      nav.appendChild(tab);
    }

    // autotagTT review tab — last in the nav, after the log tab
    if (!nav.querySelector('.autotag-tab')) {
      const tab = makeNavTab('autotag-tab',
        '<path d="M9 16.2L4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2z"/><path d="M3 3h18v2H3z"/>',
        'autotagTT suggestions',
        () => showAutotagTab()
      );
      if (autotagTabActive) tab.classList.add('active');
      nav.appendChild(tab);
    }

    syncAuthorTabs();
    atUpdateStrips();
  }

  function startObserving() {
    const root = document.getElementById('archive');
    if (!root) { setTimeout(startObserving, 300); return; }

    if (!window._atLoopStarted) { window._atLoopStarted = true; setTimeout(atPollRun, 1500); atGlobalLoop(); }

    if (isMobilePlayer()) {
      setupPhoneChrome();
      createMobileNav();
      injectCastNavBtn();
      setupMobileSwipe();
      // Show loading overlay immediately, then open player
      showDefaultStarsView();
    } else {
      const nav = document.querySelector('nav');
      if (nav) new MutationObserver(injectNavTabs).observe(nav, { childList: true });
      new MutationObserver(() => {
        if (castSession) document.querySelectorAll('div.cover:not([data-cast-wired])').forEach(wireCastOverlay);
      }).observe(root, { childList: true, subtree: true });
      injectNavTabs();
      ensureArchiveDb();
      showDefaultStarsView();
    }
  }

  // Desktop opens on the Stars page. Wait for the app's <main> so the view can be inserted next to it.
  let defaultViewShown = false;
  function showDefaultStarsView(tries = 0) {
    if (defaultViewShown) return;
    if (!document.querySelector('main') || (!isMobilePlayer() && !document.querySelector('nav .stars-tab'))) {
      if (tries < 50) setTimeout(() => showDefaultStarsView(tries + 1), 100);
      return;
    }
    defaultViewShown = true;
    if (isMobilePlayer()) { setMobileTab('home', true); return; }
    if (!starsTabActive && !logTabActive && !autotagTabActive && !activeAuthorId) showStarsTab();
  }

  // ── Expose live API for pop-out windows ──────────────────────────────────
  window._kashiboxWin = {
    applyStars:  s  => { stars  = s;  saveStarsLocal();   if (starsTabActive) renderStarsView(); },
    applyGroups: g  => { groups = g;  saveGroupsLocal(); if (starsTabActive) renderStarsView(); },
    applyLevels: lv => { levels = lv; saveLevelsLocal(); if (starsTabActive) renderStarsView(); },
    merge3,   // exposed for the test harness
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // GOOGLE CAST — SENDER
  // ═══════════════════════════════════════════════════════════════════════════

  // ← Replace with your App ID from cast.google.com/publish after registering
  // Receiver URL to submit: https://kashibox.fexel.net/cast
  const CAST_APP_ID  = '5B3E2EFF';
  const CAST_NS      = 'urn:x-cast:net.fexel.kashibox';
  const CAST_SDK_URL = 'https://www.gstatic.com/cast/sdk/libs/caf_sender/v3/cast_framework.js';

  let castReady   = false;
  let castSession = null;

  // True when running inside the Kashibox iOS app (Capacitor native bridge)
  const isCap = !!(window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.KashiboxCast);

  // DEBUG: show Capacitor status on screen — remove once Cast is working
  (function() {
    const d = document.createElement('div');
    d.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:rgba(0,0,0,.8);color:#fff;font-size:13px;padding:6px 10px;text-align:center';
    d.textContent = 'Cap:' + !!(window.Capacitor) + ' Plugin:' + isCap;
    document.body ? document.body.appendChild(d) : document.addEventListener('DOMContentLoaded', () => document.body.appendChild(d));
    setTimeout(() => d.remove(), 8000);
  })();

  function initCapCast() {
    if (!isCap) return;
    const Plugin = window.Capacitor.Plugins.KashiboxCast;
    const applyState = ({state}) => {
      const connected = state === 'connected';
      const available = state !== 'noDevicesAvailable';
      castReady   = true;
      castSession = connected ? Plugin : null;
      const btn = document.getElementById('sp-cast-nav-btn');
      if (btn) {
        btn.style.display = available ? '' : 'none';
        btn.classList.toggle('sp-cast-on', connected);
      }
      refreshCastOverlays();
    };
    Plugin.addListener('castStateChanged', applyState);
    Plugin.getState().then(applyState).catch(() => {});
  }

  // Must be set before the SDK script loads
  window['__onGCastApiAvailable'] = function(isAvailable) {
    if (!isAvailable) return;
    castReady = true;
    cast.framework.CastContext.getInstance().setOptions({
      receiverApplicationId: CAST_APP_ID,
      autoJoinPolicy: chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED,
    });
    const ctx = cast.framework.CastContext.getInstance();
    ctx.addEventListener(cast.framework.CastContextEventType.CAST_STATE_CHANGED,    onCastStateChange);
    ctx.addEventListener(cast.framework.CastContextEventType.SESSION_STATE_CHANGED, onCastStateChange);
    onCastStateChange();
  };

  function onCastStateChange() {
    const ctx     = cast.framework.CastContext.getInstance();
    const state   = ctx.getCastState();
    const session = ctx.getCurrentSession();
    castSession = session || null;

    const available = state !== cast.framework.CastState.NO_DEVICES_AVAILABLE;
    const connected = state === cast.framework.CastState.CONNECTED;

    const btn = document.getElementById('sp-cast-nav-btn');
    if (btn) {
      btn.style.display = available ? '' : 'none';
      btn.classList.toggle('sp-cast-on', connected);
    }

    refreshCastOverlays();
  }

  function initCastSDK() {
    if (document.querySelector('script[src="' + CAST_SDK_URL + '"]')) return;
    const s = document.createElement('script');
    s.src = CAST_SDK_URL;
    document.head.appendChild(s);
  }

  function castVideo(coverSrc) {
    if (!castSession) return;
    const videoUrl = window.location.origin + '/' + getVideoPath(coverSrc);
    const coverUrl = window.location.origin + '/' + coverSrc;
    if (isCap) {
      window.Capacitor.Plugins.KashiboxCast.sendMessage({ data: { action: 'add', videoUrl, coverUrl } }).catch(() => {});
    } else {
      castSession.sendMessage(CAST_NS, { action: 'add', videoUrl, coverUrl }).catch(() => {});
    }
  }

  const CAST_SVG = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M21 3H3c-1.1 0-2 .9-2 2v3h2V5h18v14h-7v2h7c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-1 8H10c-.55 0-1 .45-1 1v7c0 .55.45 1 1 1h10c.55 0 1-.45 1-1v-7c0-.55-.45-1-1-1zm-1 7h-8v-5h8v5zM1 18v3h3c0-1.66-1.34-3-3-3zm0-4v2c2.76 0 5 2.24 5 5h2c0-3.87-3.13-7-7-7zm0-4v2c4.97 0 9 4.03 9 9h2C12 14.92 7.08 10 1 10z"/></svg>';

  function injectCastNavBtn() {
    const nav = document.getElementById('sp-mobile-nav');
    if (!nav || document.getElementById('sp-cast-nav-btn')) return;

    const btn = document.createElement('button');
    btn.id        = 'sp-cast-nav-btn';
    btn.className = 'sp-nav-btn';
    btn.title     = 'Cast to TV';
    btn.innerHTML = CAST_SVG + '<span>Cast</span>';
    btn.style.display = 'none'; // hidden until SDK reports devices nearby
    btn.addEventListener('click', () => {
      if (!castReady) return;
      if (isCap) {
        if (castSession) window.Capacitor.Plugins.KashiboxCast.endSession().catch(() => {});
        else             window.Capacitor.Plugins.KashiboxCast.requestSession().catch(() => {});
      } else {
        if (castSession) cast.framework.CastContext.getInstance().endCurrentSession(true);
        else             cast.framework.CastContext.getInstance().requestSession().catch(() => {});
      }
    });

    nav.appendChild(btn);
    if (isCap) initCapCast();
    else       initCastSDK();
  }

  function refreshCastOverlays() {
    // Wire any unwired covers; update visibility of existing overlays
    document.querySelectorAll('div.cover').forEach(coverDiv => {
      if (!coverDiv.dataset.castWired) wireCastOverlay(coverDiv);
      const ov = coverDiv.querySelector('.sp-cast-ov');
      if (ov) ov.style.display = castSession ? '' : 'none';
    });
  }

  function wireCastOverlay(coverDiv) {
    const img = coverDiv.querySelector('img.thumbnail');
    const src = img && img.getAttribute('src');
    if (!getVideoIdFromSrc(src)) return;
    coverDiv.dataset.castWired = '1';

    const btn = document.createElement('button');
    btn.className    = 'sp-cast-ov';
    btn.title        = 'Cast to TV';
    btn.innerHTML    = CAST_SVG;
    btn.style.display = castSession ? '' : 'none';
    btn.addEventListener('click', e => {
      e.stopPropagation();
      castVideo(img.getAttribute('src'));
      btn.classList.add('sp-cast-ov-sent');
      setTimeout(() => btn.classList.remove('sp-cast-ov-sent'), 500);
    });
    coverDiv.appendChild(btn);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STYLES
  // ═══════════════════════════════════════════════════════════════════════════

  function injectStyles() {
    const s = document.createElement('style');
    s.textContent = `


      /* ── Cast button in mobile nav ── */
      #sp-cast-nav-btn svg { width: 22px; height: 22px; display: block; }
      #sp-cast-nav-btn.sp-cast-on { color: #4dd0e1; }

      /* ── Cast overlay on video cards ── */
      .sp-cast-ov {
        position: absolute; bottom: 6px; left: 6px;
        width: 30px; height: 30px;
        background: rgba(0,0,0,.55); border: none; border-radius: 5px;
        color: #fff; cursor: pointer; padding: 4px;
        display: flex; align-items: center; justify-content: center;
        z-index: 5; transition: background .15s, transform .1s;
      }
      .sp-cast-ov svg { width: 100%; height: 100%; display: block; }
      .sp-cast-ov:active, .sp-cast-ov.sp-cast-ov-sent {
        background: rgba(77,208,225,.7); transform: scale(0.88);
      }

      /* ── Braces tag buttons ── */
      .braces-btn svg { display: block; pointer-events: none; }
      .overlay-braces-btn.braces-on, .player-braces-btn.braces-on { color: #4fc3f7; }
      .grid-braces-btn { right: 28px !important; }
      .grid-braces-btn:hover { background: rgba(30,110,160,.85) !important; color: #fff !important; }
      .grid-braces-btn.braces-on { color: #4fc3f7 !important; opacity: 1 !important; }



      /* ── Stars & Player nav tabs ── */
      nav .stars-tab, nav .player-tab, nav .session-tab, nav .settings-tab, nav .log-tab, nav .autotag-tab {
        display: flex; align-items: center;
        cursor: pointer; border-bottom: 3px solid transparent; color: inherit;
        white-space: nowrap;
      }

      /* ── Icon-only top nav (labels hidden; title tooltips added in JS) ── */
      nav { margin-left: 20px !important; }
      nav .likes, nav .bookmarked, nav .following, nav .stars-tab, nav .player-tab, nav .session-tab, nav .settings-tab, nav .log-tab, nav .autotag-tab {
        font-size: 0 !important; gap: 0 !important;
        margin: 3.3px 2px 0 !important; padding: 0 14px !important;
        justify-content: center; border-radius: 6px 6px 0 0;
        transition: color .15s, background .15s;
      }
      nav .likes svg, nav .bookmarked svg, nav .following svg, nav .stars-tab svg, nav .player-tab svg, nav .session-tab svg, nav .settings-tab svg, nav .log-tab svg, nav .autotag-tab svg {
        width: 20px !important; height: 20px !important; margin: 0 !important;
      }
      nav .likes:not(.active):hover, nav .bookmarked:not(.active):hover,
      nav .following:not(.active):hover, nav .stars-tab:not(.active):hover, nav .player-tab:not(.active):hover, nav .session-tab:not(.menu-open):hover, nav .settings-tab:not(.active):hover, nav .log-tab:not(.active):hover, nav .autotag-tab:not(.active):hover {
        color: var(--active, #d7d7d7); background: rgba(255,255,255,.05);
      }
      nav .likes.active, nav .bookmarked.active, nav .following.active, nav .stars-tab.active, nav .player-tab.active, nav .session-tab.menu-open, nav .settings-tab.active, nav .log-tab.active, nav .autotag-tab.active {
        color: var(--active, #d7d7d7); background: rgba(255,255,255,.09);
        border-bottom: 3px solid var(--active, #d7d7d7); cursor: default;
      }

      /* ── Author tabs + view ── */
      nav .author-tab {
        display: flex; align-items: center; gap: 6px;
        margin: 3.3px 2px 0; padding: 0 8px 0 12px; max-width: 160px;
        font-size: 13px; cursor: pointer; color: inherit;
        border-bottom: 3px solid transparent; border-radius: 6px 6px 0 0;
        transition: color .15s, background .15s;
      }
      nav .author-tab-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      nav .author-tab-close { font-size: 10px; line-height: 1; padding: 3px 5px; border-radius: 50%; opacity: .55; flex-shrink: 0; }
      nav .author-tab-close:hover { opacity: 1; background: rgba(255,255,255,.15); }
      nav .author-tab:not(.active):hover { color: var(--active, #d7d7d7); background: rgba(255,255,255,.05); }
      nav .author-tab.active {
        color: var(--active, #d7d7d7); background: rgba(255,255,255,.09);
        border-bottom: 3px solid var(--active, #d7d7d7); cursor: default;
      }
      nav .log-tab { margin-left: auto !important; }
      nav .stars-tab { order: -1; }
      nav .autotag-tab { order: 100; }
      /* the app keeps its own tab marked active underneath; hide that highlight while Stars is showing */
      nav:has(.stars-tab.active) .pressable.active:not(.stars-tab) {
        color: var(--inactive, rgb(160,160,160)) !important;
        background: none !important; border-bottom-color: transparent !important;
      }
      body.sp-log-open nav .pressable.active:not(.log-tab),
      body.sp-autotag-open nav .pressable.active:not(.autotag-tab),
      body.sp-author-open nav .pressable.active:not(.author-tab) {
        color: var(--inactive, rgb(160,160,160)) !important;
        background: none !important; border-bottom-color: transparent !important;
      }
      /* ── Settings, Player and Sessions buttons sit at the right end of the header ──
         They stay in the nav DOM (other code looks up "nav .player-tab")
         and are positioned out of the flow instead. */
      @media (min-width: 769px) {
        header:has(> nav) {
          position: relative;
          padding-right: calc(var(--left-padding, 20px) + 168px) !important;
        }
        header:has(> nav) nav .settings-tab,
        header:has(> nav) nav .player-tab,
        header:has(> nav) nav .session-tab {
          position: absolute !important; z-index: 2; top: 3.3px !important; bottom: 0; margin: 0 !important;
          box-sizing: border-box; width: 52px; padding: 0 !important;
        }
        header:has(> nav) nav .settings-tab { right: var(--left-padding, 20px); }
        header:has(> nav) nav .player-tab   { right: calc(var(--left-padding, 20px) + 56px); }
        header:has(> nav) nav .session-tab  { right: calc(var(--left-padding, 20px) + 112px); }
      }

      #autotag-view { display: none; flex-direction: column; flex: 1; min-height: 0; overflow: hidden; position: relative; }
      /* two fixed rows that never wrap, so the cards below never move when the window or the status text changes */
      #autotag-head { display: flex; flex-direction: column; gap: 6px; padding: 10px 18px 8px; flex-shrink: 0; border-bottom: 1px solid #333; }
      .at-row { display: flex; align-items: center; flex-wrap: nowrap; gap: 10px; height: 26px; overflow-x: auto; overflow-y: hidden; scrollbar-width: none; }
      .at-row::-webkit-scrollbar { display: none; }
      .at-row > * { flex-shrink: 0; white-space: nowrap; }
      .at-row > #at-run-chip { flex: 1 1 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
      #autotag-head select { background: #1e1e1e; border: 1px solid #444; border-radius: 12px; color: #ddd; font-size: 12px; padding: 2px 8px; height: 24px; }
      .at-modes { display: flex; gap: 6px; }
      .at-mode { background: rgba(255,255,255,.06); border: 1px solid #444; color: #999; border-radius: 12px; padding: 2px 10px; font-size: 12px; line-height: 18px; cursor: pointer; }
      .at-mode.on { color: #fff; background: rgba(255,255,255,.14); }
      #autotag-grid { flex: 1; overflow-y: auto; padding: 14px 18px; display: grid; grid-template-columns: repeat(auto-fill,minmax(150px,1fr)); gap: 14px; align-content: start; }
      #at-restore { display: flex; align-items: center; gap: 10px; padding: 8px 18px; background: rgba(255,193,7,.12); border-bottom: 1px solid #5a4a10; font-size: 13px; flex-wrap: wrap; flex-shrink: 0; }
      #autotag-msg { grid-column: 1 / -1; color: #888; text-align: center; padding: 40px 10px; font-size: 13px; line-height: 1.6; }
      .at-score { position: absolute; bottom: 4px; left: 4px; background: rgba(0,0,0,.7); color: #ddd; border-radius: 8px; padding: 1px 7px; font-size: 11px; pointer-events: none; z-index: 2; }
      .sp-bubbles { position: absolute; left: 4px; right: 4px; bottom: 4px; z-index: 3; display: flex; flex-wrap: wrap; gap: 3px; align-items: flex-end; pointer-events: none; max-height: 70%; overflow: hidden; }
      .sp-bubble { pointer-events: auto; display: inline-flex; align-items: center; max-width: 100%; background: rgba(0,0,0,.72); color: #ddd; border-radius: 10px; padding: 1px 7px; font-size: 11px; line-height: 16px; box-shadow: 0 1px 4px rgba(0,0,0,.5); }
      .sp-bubble.ai { background: rgba(60,40,120,.82); }
      .sp-bubble-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .sp-bubble-act { display: none; border: none; background: none; color: #ddd; font-size: 12px; line-height: 16px; padding: 0 0 0 5px; cursor: pointer; }
      .sp-bubble-act.ok:hover { color: #4caf50; } .sp-bubble-act.no:hover { color: #f44336; }
      .sp-bubble:hover .sp-bubble-act { display: inline; }
      .sp-bubble.busy { opacity: .5; } .sp-bubble.err { outline: 1px solid #f44336; }
      @media (hover: none) { .sp-bubble-act { display: inline; } }
      .stars-grid-cover .sp-bubble:nth-child(n+6) { display: none; }
      [data-cap="1"] .sp-bubble:nth-child(n+2), [data-cap="2"] .sp-bubble:nth-child(n+3),
      [data-cap="3"] .sp-bubble:nth-child(n+4), [data-cap="4"] .sp-bubble:nth-child(n+5) { display: none; }
      .sp-label-toggle { margin: 8px 10px 4px; align-self: flex-start; }
      .sp-ai-note { margin: 12px 10px; font-size: 11px; line-height: 1.5; color: #777; }
      .sp-ai-pick { background: #1e1e1e; border: 1px solid #444; border-radius: 12px; color: #ddd; font-size: 12px; padding: 2px 8px; height: 24px; max-width: 160px; }
      .at-popup { position: absolute; top: 52px; right: 12px; z-index: 20; width: min(340px, calc(100% - 24px)); max-height: 70%; overflow: auto; background: #1e1e1e; border: 1px solid #555; border-radius: 8px; padding: 10px; box-shadow: 0 4px 20px rgba(0,0,0,.7); }
      .at-run-status { font-size: 12px; color: #bbb; margin: 6px 0 10px; min-height: 16px; }
      .at-run-results { margin: 10px 0; font-size: 13px; }
      .at-run-row { display: flex; justify-content: space-between; gap: 10px; padding: 3px 0; }
      .at-bar { display: inline-block; position: relative; width: 120px; height: 6px; margin-right: 8px; background: #333; border-radius: 3px; overflow: hidden; vertical-align: middle; }
      .at-bar.big { display: block; width: 100%; height: 10px; margin: 2px 0 6px; }
      .at-bar i { position: absolute; top: 0; bottom: 0; left: 0; background: #4fc3f7; border-radius: 3px; transition: width .6s; }
      .at-bar.run i { background-image: linear-gradient(90deg, rgba(255,255,255,.0), rgba(255,255,255,.25), rgba(255,255,255,.0)); background-size: 40px 100%; animation: at-shine 1.4s linear infinite; background-color: #4fc3f7; }
      .at-bar b { position: absolute; top: 0; bottom: 0; width: 2px; background: #ffc107; }
      @keyframes at-shine { from { background-position: -40px 0; } to { background-position: 160px 0; } }
      nav .autotag-tab, #sp-mobile-nav .sp-nav-btn { position: relative; }
      .sp-prog { position: absolute; left: 0; bottom: 0; height: 3px; background: #4fc3f7; border-radius: 2px; pointer-events: none; transition: width .6s; max-width: 100%; }
      #sp-sync-note { position: fixed; left: 12px; bottom: 12px; z-index: 99999; max-width: min(420px, calc(100vw - 24px)); background: #1e1e1e; border: 1px solid #555; color: #ddd; border-radius: 8px; padding: 8px 12px; font-size: 12px; line-height: 1.4; box-shadow: 0 4px 20px rgba(0,0,0,.7); cursor: pointer; display: none; }
      #sp-sync-note.warn { border-color: #f44336; background: #3a1a1a; color: #ffb4a8; }
      .at-frames { display: flex; flex-direction: column; gap: 8px; border-top: 1px solid #333; margin-top: 10px; padding-top: 10px; font-size: 13px; }
      .at-frames select { background: #1e1e1e; border: 1px solid #444; border-radius: 6px; color: #ddd; padding: 3px 6px; }
      .at-run-sched { display: flex; align-items: center; gap: 8px; font-size: 13px; border-top: 1px solid #333; padding-top: 10px; }
      .at-run-sched select { background: #1e1e1e; border: 1px solid #444; border-radius: 6px; color: #ddd; padding: 2px 4px; }
      #at-picker { position: absolute; top: 52px; right: 12px; z-index: 20; width: min(340px, calc(100% - 24px)); max-height: 70%; overflow: auto; background: #1e1e1e; border: 1px solid #555; border-radius: 8px; padding: 10px; box-shadow: 0 4px 20px rgba(0,0,0,.7); }
      .at-picker-head { font-size: 13px; font-weight: 600; margin-bottom: 4px; }
      .at-picker-list { max-height: 300px; overflow: auto; margin: 8px 0; }
      .at-picker-row { display: flex; align-items: center; gap: 8px; padding: 4px 2px; font-size: 13px; cursor: pointer; }
      .at-picker-row .at-note { margin-left: auto; }
      .at-picker-foot { display: flex; align-items: center; gap: 8px; }
      .at-user { position: absolute; top: 6px; right: 6px; z-index: 5; max-width: 85%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; background: rgba(0,0,0,.7); color: #ddd; border-radius: 8px; padding: 1px 7px; font-size: 11px; }
      #autotag-view .thumb-tools { top: 30px; }
      .at-btn.unsure:hover { color: #ffc107; border-color: #ffc107; }
      .at-actions { display: flex; gap: 6px; }
      .at-btn { flex: 1; border: 1px solid #444; background: #1e1e1e; color: #ccc; border-radius: 6px; padding: 7px 0; font-size: 16px; line-height: 1; cursor: pointer; min-height: 34px; }
      .at-btn.accept:hover { color: #4caf50; border-color: #4caf50; }
      .at-btn.reject:hover { color: #f44336; border-color: #f44336; }
      .at-btn:disabled { opacity: .4; cursor: default; }
      .at-note { font-size: 11px; color: #777; text-align: center; }
      #log-view { display: none; flex-direction: column; flex: 1; min-height: 0; overflow: hidden; }
      #log-head { display: flex; align-items: center; gap: 12px; padding: 12px 18px 10px; flex-shrink: 0; border-bottom: 1px solid #333; }
      .log-status { font-size: 12px; color: #888; display: flex; align-items: center; gap: 6px; min-width: 0; }
      .log-status::before { content: ''; width: 8px; height: 8px; border-radius: 50%; background: #666; flex-shrink: 0; }
      .log-status.ok::before { background: #4caf50; }
      .log-status.error { color: #ff8a80; }
      .log-status.error::before { background: #f44336; }
      .log-status.paused::before { background: #e5c07b; }
      .log-controls { margin-left: auto; display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
      .log-filter { width: 150px; height: 24px; padding: 0 8px; background: #1e1e1e; border: 1px solid #444; border-radius: 12px; color: #ddd; font-size: 12px; outline: none; }
      .log-btn { background: rgba(255,255,255,.06); border: 1px solid #444; color: #999; border-radius: 12px; padding: 2px 10px; font-size: 12px; line-height: 18px; cursor: pointer; }
      .log-btn:hover { background: rgba(255,255,255,.14); color: #fff; }
      .log-btn.on { background: rgba(255,255,255,.18); border-color: #888; color: #fff; }
      .log-level.lvl-warn.on { color: #e5c07b; border-color: #e5c07b; }
      .log-level.lvl-error.on { color: #ff6b6b; border-color: #ff6b6b; }
      #log-body { flex: 1; overflow-y: auto; padding: 8px 18px 14px; background: #121212; font: 12px/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
      .log-line { white-space: pre-wrap; overflow-wrap: anywhere; color: #c8c8c8; }
      .log-line.lvl-warn { color: #e5c07b; }
      .log-line.lvl-error { color: #ff6b6b; }
      .log-line.log-marker { color: #777; font-style: italic; }
      .log-ts { color: #6d6d6d; margin-right: 10px; }
      #sessions-menu {
        position: fixed; z-index: 10000; width: 300px; max-height: 70vh;
        display: flex; flex-direction: column; overflow: hidden;
        background: #1e1e1e; border: 1px solid #444; border-radius: 8px;
        box-shadow: 0 8px 28px rgba(0,0,0,.6); color: #ddd; font-size: 13px;
      }
      .sessions-head { display: flex; align-items: center; justify-content: space-between; padding: 10px 12px; border-bottom: 1px solid #333; font-weight: 600; }
      .sessions-new { background: rgba(255,255,255,.08); border: 1px solid #444; color: #ccc; border-radius: 12px; padding: 2px 10px; font-size: 12px; cursor: pointer; }
      .sessions-new:hover { background: rgba(255,255,255,.16); color: #fff; }
      .sessions-list { overflow-y: auto; padding: 4px 0; }
      .sessions-empty { padding: 14px 12px; color: #888; line-height: 1.4; }
      .sessions-row { display: flex; align-items: center; gap: 6px; padding: 7px 12px; cursor: pointer; }
      .sessions-row:hover { background: #2a2a2a; }
      .sessions-row.current { background: #262626; box-shadow: inset 3px 0 0 var(--active, #d7d7d7); }
      .sessions-info { flex: 1; min-width: 0; }
      .sessions-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .sessions-meta { font-size: 11px; color: #888; margin-top: 2px; }
      .sessions-act { background: none; border: none; color: #888; cursor: pointer; font-size: 13px; padding: 2px 5px; border-radius: 4px; }
      .sessions-act:hover { color: #fff; background: rgba(255,255,255,.12); }
      .sp-author-link { cursor: pointer; pointer-events: auto !important; }
      .sp-author-link:hover { color: #fff; text-decoration: underline; }
      #author-view { display: none; flex-direction: column; flex: 1; min-height: 0; overflow: hidden; }
      #author-view-header { display: flex; align-items: baseline; gap: 10px; padding: 14px 18px 10px; flex-shrink: 0; border-bottom: 1px solid #333; }
      .grid-controls { display: flex; align-items: center; gap: 8px; align-self: center; }
      .grid-playall { background: rgba(255,255,255,.08); border: 1px solid #444; color: #ccc; border-radius: 12px; padding: 1px 10px; font-size: 12px; line-height: 18px; cursor: pointer; }
      .grid-playall:hover { background: rgba(255,255,255,.16); color: #fff; }
      .grid-playall.on { background: rgba(255,255,255,.2); border-color: #888; color: #fff; }
      .grid-sort { display: inline-flex; flex-shrink: 0; border: 1px solid #444; border-radius: 12px; overflow: hidden; }
      .grid-sort-btn { background: transparent; border: none; border-left: 1px solid #444; color: #999; font-size: 12px; line-height: 22px; padding: 0 9px; cursor: pointer; white-space: nowrap; }
      .grid-sort-btn:first-child { border-left: none; }
      .grid-sort-btn:hover { background: rgba(255,255,255,.1); color: #fff; }
      .grid-sort-btn.on { background: rgba(255,255,255,.2); color: #fff; }
      .grid-size { width: 110px; height: 16px; margin: 0; accent-color: #aaa; cursor: pointer; }
      .preview-video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; pointer-events: none; }
      .stars-grid-cover.is-playing::after { display: none; }
      .player-slide.needs-tap::after {
        content: '▶'; position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
        width: 64px; height: 64px; border-radius: 50%; background: rgba(0,0,0,.55); color: #fff;
        font-size: 28px; line-height: 64px; text-align: center; pointer-events: none;
      }
      .author-view-close { display: none; margin-left: auto; background: none; border: none; color: #ccc; font-size: 18px; cursor: pointer; padding: 0 4px; }
      #author-grid { flex: 1; overflow-y: auto; padding: 14px 18px; display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 14px; align-content: start; }
      .author-empty { color: #777; font-size: 14px; grid-column: 1 / -1; }
      #author-view .stars-grid-remove, #author-view .stars-grid-add-group { opacity: 1; }
      .thumb-tools {
        position: absolute; right: 6px; top: 6px; z-index: 4;
        display: flex; flex-direction: column; align-items: center;
        gap: calc(var(--tool, 28px) * 0.25);
      }
      .thumb-tool {
        width: var(--tool, 28px); height: var(--tool, 28px); padding: 0;
        border: none; border-radius: 50%; background: rgba(0,0,0,.62); color: #ddd;
        font-size: calc(var(--tool, 28px) * 0.52); line-height: 1; cursor: pointer;
        display: flex; align-items: center; justify-content: center;
        box-shadow: 0 1px 5px rgba(0,0,0,.5); opacity: 0;
        transition: opacity .1s, background .1s, color .1s;
      }
      .thumb-tool svg { width: 62%; height: 62%; }
      .stars-grid-remove.stars-grid-x { right: auto; left: 4px; }
      .stars-grid-cover:hover .thumb-tool, .thumb-tool.on, .thumb-tool.braces-on { opacity: 1; }
      .thumb-tool:hover { background: rgba(0,0,0,.9); color: #fff; }
      .thumb-star.on { color: gold; }
      .thumb-star.super, .overlay-star-btn.super, .player-star-btn.super { color: #4fc3f7; }
      .thumb-star.super svg, .overlay-star-btn.super svg, .player-star-btn.super svg { filter: drop-shadow(0 0 4px rgba(79,195,247,.7)); }
      .overlay-star-btn.super svg { width: 24px; height: 24px; }
      .thumb-star, .overlay-star-btn, .player-star-btn { -webkit-touch-callout: none; user-select: none; -webkit-user-select: none; }
      .stars-super-item .stars-group-name { color: #8fd8ff; }
      .follow-card { position: relative; }
      .follow-card.is-super { background: #2e3a43; box-shadow: 0 0 0 2px #4fc3f7, 0 0 16px rgba(79,195,247,.35); }
      .follow-card.is-super:hover { background: #34444f; }
      .follow-super { position: absolute; top: 8px; right: 8px; line-height: 0; filter: drop-shadow(0 0 4px rgba(79,195,247,.7)); }
      .follow-card.is-super .follow-name { color: #bfe9ff; }
      .stars-filter-super svg { width: 18px; height: 18px; }
      .thumb-lvl { font-size: calc(var(--tool, 28px) * 0.36); font-weight: 700; letter-spacing: -.5px; }
      .thumb-lvl.on { color: #fe2c55; }
      .thumb-tool.braces-on { color: #4fc3f7; }
      @media (hover: none) { .thumb-tool { opacity: .9; } }
      @media (max-width: 768px) {
        #autotag-view { position: fixed; inset: 0; bottom: calc(var(--sp-nav-base, 56px) + var(--sp-safe-b, 0px)); z-index: 500; background: #0d0d0d; }
        #autotag-grid { grid-template-columns: repeat(2, 1fr); gap: 8px; padding: 8px; }
        #autotag-head { padding: 8px 10px; }
        #author-view { position: fixed; inset: 0; bottom: calc(var(--sp-nav-base, 56px) + var(--sp-safe-b, 0px)); z-index: 3500; background: #0d0d0d; }
        .author-view-close { display: none; }   /* swipe right (or the browser's back) closes the page */
        /* the controls (play, size, sort buttons) get their own row under the title */
        #author-view-header { flex-wrap: wrap; align-items: center; row-gap: 6px; }
        #author-view-header .author-view-close { order: 1; margin-left: auto; }
        #author-view-header .grid-controls { order: 2; flex: 0 0 100%; }
        #author-view-header .stars-main-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        #author-view-header .stars-main-count, #author-view-header .grid-controls { flex-shrink: 0; }
        #author-grid { grid-template-columns: repeat(2, 1fr); gap: 8px; padding: 8px; }
      }



      /* ── Settings page ── */
      #settings-view { display: none; flex-direction: column; flex: 1; min-height: 0; overflow-y: auto; }
      .set-wrap { width: 100%; max-width: 640px; box-sizing: border-box; padding: 18px 22px 40px; }
      .set-head { display: flex; align-items: baseline; gap: 12px; }
      .set-head h2 { margin: 0 0 6px; font-size: 20px; font-weight: 600; }
      .set-back { display: none; background: none; border: none; color: #8ab4f8; font-size: 16px; padding: 0; cursor: pointer; }
      .set-section { margin-top: 22px; padding-top: 16px; border-top: 1px solid #444; }
      .set-section h3 { margin: 0 0 6px; font-size: 14px; font-weight: 700; color: #eee; text-transform: uppercase; letter-spacing: .5px; }
      .set-note { margin: 0 0 10px; font-size: 13px; line-height: 1.5; color: #aaa; }
      .set-input { width: 100%; box-sizing: border-box; background: #444; border: 1px solid #303030; border-radius: 6px; color: #eee; font-size: 15px; padding: 9px 10px; outline: none; }
      .set-input:focus { border-color: #888; }
      .set-input.bad { border-color: #c55; }
      .set-try { display: flex; gap: 8px; margin-top: 12px; }
      .set-try-input { flex: 1; }
      .set-status { margin-top: 6px; font-size: 12px; color: #aaa; min-height: 16px; }
      .set-input.bad + .set-status { color: #e88; }
      .set-preview { margin-top: 2px; font-size: 12px; color: #888; word-break: break-all; }
      .set-facts > div { display: flex; justify-content: space-between; gap: 12px; padding: 6px 0; font-size: 14px; border-bottom: 1px solid #3c3c3c; color: #bbb; }
      .set-facts b { color: #eee; font-weight: 600; }
      .set-btn { background: rgba(255,255,255,.1); border: 1px solid #555; border-radius: 8px; color: #ddd; padding: 8px 14px; font-size: 14px; cursor: pointer; }
      .set-btn:hover { background: rgba(255,255,255,.18); }
      .list-gear { display: none; background: none; border: none; color: #ddd; padding: 2px; cursor: pointer; }

      /* ── Library pages (Likes, Favorites, Following) ── */
      #list-view { display: none; flex-direction: column; flex: 1; min-height: 0; overflow: hidden; }
      #list-view-header { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; padding: 14px 18px 10px; flex-shrink: 0; border-bottom: 1px solid #333; }
      #list-view-header .stars-main-title { margin-right: 2px; }
      .list-seg { display: none; }
      .list-seg-btn, .list-scope-btn { background: rgba(255,255,255,.08); border: none; color: #bbb; padding: 4px 11px; font-size: 12px; cursor: pointer; }
      .list-seg-btn.on, .list-scope-btn.on { background: rgba(255,255,255,.22); color: #fff; }
      .list-scope { display: inline-flex; border-radius: 12px; overflow: hidden; border: 1px solid #444; }
      .list-seg { border-radius: 14px; overflow: hidden; border: 1px solid #444; }
      .list-search { flex: 1 1 160px; max-width: 280px; min-width: 120px; background: #444; border: 1px solid #303030; border-radius: 5px; color: #ddd; font-size: 14px; padding: 4px 8px; outline: none; }
      #list-grid { flex: 1; overflow-y: auto; padding: 14px 18px; display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 14px; align-content: start; }
      #list-grid.follow-grid { grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); }
      .follow-card { display: flex; flex-direction: column; align-items: center; text-align: center; gap: 3px; padding: 16px 10px 14px; background: #3a3a3a; border-radius: 10px; cursor: pointer; transition: background .12s; min-width: 0; }
      .follow-card:hover { background: #444; }
      .follow-card.no-videos { opacity: .6; }
      .follow-avatar { position: relative; width: 84px; height: 84px; border-radius: 50%; overflow: hidden; background: #555; color: #ddd; font-size: 32px; font-weight: 700; display: flex; align-items: center; justify-content: center; margin-bottom: 6px; }
      .follow-avatar img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
      .follow-name { font-size: 14px; font-weight: 600; color: #eee; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .follow-sub { font-size: 12px; color: #999; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .follow-stats { font-size: 11px; color: #777; }

      /* ── Stars view ── */
      #stars-view { display:none; flex-direction:row; flex:1; min-height:0; overflow:hidden; }
      #stars-sidebar { width:200px; flex-shrink:0; background:#1a1a1a; border-right:1px solid #3a3a3a; display:flex; flex-direction:column; overflow-y:auto; padding:8px 0; }
      .grid-sentinel { grid-column: 1 / -1; height: 1px; }
      .stars-sidebar-divider { border:none; border-top:1px solid #3a3a3a; margin:6px 0; }
      .stars-group-item { display:flex; align-items:center; justify-content:space-between; padding:7px 14px; cursor:pointer; font-size:13px; transition:background .1s; gap:6px; }
      .stars-group-item:hover { background:#262626; }
      .stars-group-item.active { background:#2e2e2e; color:var(--active,#d7d7d7); }
      .stars-group-name { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .stars-group-count { font-size:11px; color:#666; flex-shrink:0; }
      .stars-group-item.active .stars-group-count { color:#999; }
      .stars-group-row { display:flex; align-items:center; gap:2px; padding-right:6px; }
      .stars-group-row .stars-group-item { flex:1; min-width:0; }
      .stars-group-action { background:none; border:none; color:#555; cursor:pointer; font-size:13px; padding:4px 3px; transition:color .1s; flex-shrink:0; }
      .stars-group-action:hover { color:#aaa; }
      .stars-group-delete:hover { color:#e55; }
      #stars-new-group-btn { margin:8px 10px 4px; padding:6px 10px; background:none; border:1px dashed #444; border-radius:5px; color:#666; cursor:pointer; font-size:12px; transition:border-color .15s,color .15s; text-align:left; }
      #stars-new-group-btn:hover { border-color:#777; color:#aaa; }
      #stars-group-sort { margin:4px 10px 8px; padding:4px 6px; background:#1e1e1e; border:1px solid #3a3a3a; border-radius:4px; color:#888; font-size:11px; cursor:pointer; width:calc(100% - 20px); }
      #stars-group-sort:hover { border-color:#666; color:#ccc; }
      .stars-inline-form { display:flex; align-items:center; gap:4px; padding:6px 8px; margin:4px 8px; }
      .stars-inline-input { flex:1; min-width:0; background:#2a2a2a; border:1px solid #555; border-radius:4px; color:#ddd; font-size:12px; padding:4px 6px; outline:none; }
      .stars-inline-input:focus { border-color:#888; }
      .stars-inline-confirm { background:none; border:none; cursor:pointer; font-size:13px; padding:2px 4px; color:#6c6; }
      .stars-inline-cancel  { background:none; border:none; cursor:pointer; font-size:13px; padding:2px 4px; color:#c66; }
      #stars-main { flex:1; display:flex; flex-direction:column; overflow:hidden; }
      #stars-main-header { display:flex; align-items:baseline; gap:10px; padding:14px 18px 10px; flex-shrink:0; border-bottom:1px solid #333; }
      #stars-mobile-header { display: none; }
      .stars-main-title { font-size:16px; font-weight:600; }
      .stars-main-count { font-size:12px; color:#666; }
      #stars-grid { flex:1; overflow-y:auto; padding:14px 18px; display:grid; grid-template-columns:repeat(auto-fill,minmax(110px,1fr)); gap:14px; align-content:start; }
      #stars-empty { grid-column:1/-1; text-align:center; color:#555; padding:48px 20px; font-size:14px; line-height:1.8; }
      .stars-grid-card { display:flex; flex-direction:column; gap:4px; }
      .stars-grid-cover { position:relative; aspect-ratio:9/16; overflow:hidden; border-radius:5px; background:#2a2a2a; cursor:pointer; }
      .stars-grid-cover img { width:100%; height:100%; object-fit:cover; display:block; transition:filter .15s; }
      .stars-grid-cover:hover img { filter:brightness(.7); }
      .stars-grid-cover::after { content:'▶'; position:absolute; top:50%; left:50%; transform:translate(-50%,-50%); color:#fff; font-size:26px; opacity:0; pointer-events:none; transition:opacity .15s; text-shadow:0 1px 6px rgba(0,0,0,.9); }
      .stars-grid-cover:hover::after { opacity:1; }
      .stars-grid-remove { position:absolute; top:4px; right:4px; background:rgba(0,0,0,.65); border:none; border-radius:50%; color:#bbb; width:20px; height:20px; font-size:10px; cursor:pointer; display:flex; align-items:center; justify-content:center; opacity:0; transition:opacity .1s,background .1s; padding:0; }
      .stars-grid-cover:hover .stars-grid-remove { opacity:1; }
      .stars-grid-remove:hover { background:rgba(180,0,0,.8); color:#fff; }
      .stars-grid-add-group { position:absolute; top:4px; left:4px; background:rgba(0,0,0,.65); border:none; border-radius:50%; color:#bbb; width:20px; height:20px; font-size:14px; cursor:pointer; display:flex; align-items:center; justify-content:center; opacity:0; transition:opacity .1s,background .1s; padding:0; line-height:1; }
      .stars-grid-cover:hover .stars-grid-add-group { opacity:1; }
      .stars-grid-add-group:hover { background:rgba(0,100,200,.7); color:#fff; }
      .stars-grid-author { font-size:11px; color:#999; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .stars-grid-desc   { font-size:11px; color:#666; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }

      /* ── Group picker popup ── */
      #stars-group-picker {
        position:fixed; z-index:9999; background:#252525; border:1px solid #555;
        border-radius:8px; box-shadow:0 4px 20px rgba(0,0,0,.7);
        display:flex; flex-direction:column; min-width:180px; max-height:320px; overflow:hidden;
      }
      .grp-picker-list { overflow-y:auto; max-height:220px; display:flex; flex-direction:column; gap:1px; padding:4px 0; }
      .grp-picker-empty { padding:8px 14px; font-size:12px; color:#555; }
      .grp-picker-row { display:flex; align-items:center; gap:8px; padding:6px 12px; font-size:13px; cursor:pointer; color:#ccc; border-radius:0; }
      .grp-picker-row:hover { background:#333; }
      .grp-picker-name { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .grp-picker-count { font-size:11px; color:#666; flex-shrink:0; }
      .grp-picker-new-row { border-top:1px solid #333; padding:6px 8px; flex-shrink:0; }
      .grp-picker-add-btn { background:none; border:none; color:#888; font-size:12px; cursor:pointer; padding:2px 4px; width:100%; text-align:left; }
      .grp-picker-add-btn:hover { color:#ccc; }
      .grp-picker-inp { display:flex; gap:4px; align-items:center; }
      .grp-picker-inp input { flex:1; background:#1a1a1a; border:1px solid #444; border-radius:4px; color:#ccc; font-size:12px; padding:4px 6px; outline:none; }
      .grp-picker-ok { background:#333; border:none; border-radius:4px; color:#aaa; cursor:pointer; font-size:13px; padding:3px 7px; }
      .grp-picker-ok:hover { background:#444; color:#fff; }

      /* ── Level picker popup ── */
      #level-picker {
        position:fixed; z-index:9999; background:#252525; border:1px solid #555;
        border-radius:8px; padding:6px; box-shadow:0 4px 20px rgba(0,0,0,.7);
        display:grid; grid-template-columns:repeat(2,1fr); gap:4px;
      }
      .lvl-picker-btn {
        background:#1e1e1e; border:1px solid #3a3a3a; border-radius:4px;
        color:#bbb; font-size:12px; font-weight:700; padding:5px 10px;
        cursor:pointer; transition:background .1s, color .1s;
      }
      .lvl-picker-btn:hover { background:#2a2a2a; color:#fff; }
      .lvl-picker-btn.cur   { background:#fe2c55; border-color:#fe2c55; color:#fff; }

      /* ── Overlay lvl button ── */
      .overlay-lvl-btn { font-size:11px; font-weight:700; letter-spacing:.5px; }

      /* ── Stars sidebar lvl numbered filter ── */
      #stars-lvl-grid {
        display:grid; grid-template-columns:repeat(4,1fr); gap:4px;
        padding:2px 6px 8px;
      }
      .stars-lvl-btn {
        background:#1e1e1e; border:1px solid #3a3a3a; border-radius:4px;
        color:#bbb; font-size:12px; font-weight:600; padding:4px 0;
        cursor:pointer; transition:background .1s, color .1s, border-color .1s;
      }
      .stars-lvl-btn:hover  { background:#2a2a2a; color:#fff; }
      .stars-lvl-btn.active { background:#fe2c55; border-color:#fe2c55; color:#fff; }

      /* ── Lvl groups main-area cards ── */
      #stars-grid:has(.stars-lvl-group-card) { grid-template-columns: repeat(auto-fill, minmax(130px,1fr)); }
      .stars-lvl-group-card {
        position:relative; aspect-ratio:9/16; border-radius:8px; overflow:hidden;
        cursor:pointer; background:#1a1a1a; transition:transform .15s;
      }
      .stars-lvl-group-card:hover { transform:scale(1.03); }
      .stars-lvl-group-img { width:100%; height:100%; object-fit:cover; display:block; }
      .stars-lvl-group-badge {
        position:absolute; bottom:28px; left:0; right:0; text-align:center;
        font-size:32px; font-weight:900; color:#fff;
        text-shadow:0 2px 8px rgba(0,0,0,1);
      }
      .stars-lvl-group-count {
        position:absolute; bottom:8px; left:0; right:0; text-align:center;
        font-size:11px; font-weight:600; color:rgba(255,255,255,.8);
        text-shadow:0 1px 4px rgba(0,0,0,.9);
      }

      /* ── Video overlay (unified player) ── */
      #video-overlay {
        position: fixed; inset: 0; z-index: 4000;
        background: rgba(0,0,0,0.92);
        display: flex; align-items: center; justify-content: center;
        cursor: default;
      }
      #video-overlay-content {
        position: relative; width: 100%; max-width: 480px;
        height: 90vh; max-height: 90vh;
        display: flex; align-items: center; justify-content: center;
      }
      .overlay-video {
        width: 100%; height: 100%; object-fit: contain; display: block;
        border-radius: 8px;
      }
      .overlay-close {
        position: absolute; top: 16px; right: 16px; z-index: 10;
        background: rgba(0,0,0,.5); border: none; border-radius: 50%;
        color: #fff; width: 36px; height: 36px; font-size: 18px;
        cursor: pointer; display: flex; align-items: center; justify-content: center;
        opacity: 0; transition: opacity .2s;
      }
      #video-overlay:hover .overlay-close { opacity: 1; }
      .overlay-close:hover { background: rgba(0,0,0,.8); }
      .overlay-controls-layer {
        position: absolute; inset: 0; pointer-events: none;
      }
      .overlay-controls-layer::after {
        content: ''; position: absolute; bottom: 0; left: 0; right: 0;
        height: 120px; background: linear-gradient(transparent, rgba(0,0,0,.6));
        pointer-events: none;
      }
      .overlay-right-center {
        position: absolute; right: 14px; top: 50%; transform: translateY(-50%);
        display: flex; flex-direction: column; gap: 12px;
        pointer-events: auto; align-items: center;
      }
      .overlay-ctrl-btn {
        background: rgba(0,0,0,.55); border: none; border-radius: 50%;
        color: #ddd; width: 46px; height: 46px; font-size: 20px;
        cursor: pointer; display: flex; align-items: center; justify-content: center;
        transition: background .15s, transform .1s; pointer-events: auto;
        box-shadow: 0 2px 8px rgba(0,0,0,.4);
      }
      .overlay-ctrl-btn:hover { background: rgba(0,0,0,.8); transform: scale(1.08); }
      .overlay-star-btn.active { color: gold; }
      .overlay-meta {
        position: absolute; bottom: 16px; left: 16px;
        max-width: 55%; pointer-events: none;
      }
      .overlay-author {
        font-size: 14px; font-weight: 600; color: #fff;
        text-shadow: 0 1px 4px rgba(0,0,0,.9);
        margin-bottom: 4px;
      }
      .overlay-caption {
        font-size: 12px; color: rgba(255,255,255,.85);
        text-shadow: 0 1px 3px rgba(0,0,0,.8);
        line-height: 1.4; display: -webkit-box;
        -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden;
      }
      .overlay-mute-btn {
        position: absolute; bottom: 14px; right: 14px; pointer-events: auto;
      }
      .overlay-counter {
        position: absolute; top: 16px; left: 50%; transform: translateX(-50%);
        font-size: 12px; color: rgba(255,255,255,.4); pointer-events: none;
      }
      .overlay-nav-btns {
        position: absolute; bottom: 14px; left: 50%; transform: translateX(-50%);
        display: flex; gap: 8px; pointer-events: auto;
      }
      .overlay-nav-btn {
        width: 36px !important; height: 36px !important; font-size: 20px !important;
      }
      .overlay-nav-btn:disabled { opacity: .25; cursor: default; }

      @media (max-width: 768px) {
        #video-overlay { align-items: stretch; }
        #video-overlay-content {
          max-width: 100%; width: 100%; height: 100%;
          max-height: 100%;
        }
        .overlay-video { border-radius: 0; }
        .overlay-close { opacity: 1; }
        #video-overlay { bottom: var(--sp-nav-base, 56px); } /* above bottom nav */
      }

      #player-title-group { flex: 1; display: flex; align-items: baseline; gap: 10px; justify-content: center; }
      #player-title { font-size: 15px; font-weight: 600; }
      #player-counter { font-size: 12px; color: #666; }
      .player-video-wrap { flex: 1; position: relative; }
      .player-video { width: 100%; height: 100%; object-fit: contain; display: block; }
      .player-controls { position: absolute; inset: 0; pointer-events: none; }
      .player-right-center {
        position: absolute; right: 14px; top: 50%; transform: translateY(-50%);
        display: flex; flex-direction: column; gap: 12px;
        pointer-events: auto; align-items: center;
      }
      .player-ctrl-btn {
        background: rgba(0,0,0,.6); border: none; border-radius: 50%;
        color: #ddd; width: 46px; height: 46px; font-size: 20px;
        cursor: pointer; display: flex; align-items: center; justify-content: center;
        transition: background .15s, transform .1s; pointer-events: auto;
        box-shadow: 0 2px 8px rgba(0,0,0,.5);
      }
      .player-ctrl-btn:hover { background: rgba(0,0,0,.85); transform: scale(1.08); }
      .player-star-btn.active { color: gold; }
      .player-lvl-btn { font-size: 11px; font-weight: 700; letter-spacing: .5px; }
      .player-lvl-btn.active { color: #fe2c55; }
      .player-author {
        position: absolute; bottom: 32px; left: 14px;
        font-size: 14px; font-weight: 600; pointer-events: none;
        text-shadow: 0 1px 4px rgba(0,0,0,.9); color: #fff;
        max-width: 55%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .player-caption {
        position: absolute; bottom: 14px; left: 14px;
        font-size: 12px; color: rgba(255,255,255,.85); pointer-events: none;
        text-shadow: 0 1px 3px rgba(0,0,0,.8);
        max-width: 55%; line-height: 1.4;
        display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
      }
      .player-mute-btn { position: absolute; bottom: 10px; right: 10px; pointer-events: auto; }



      /* ── Mobile scroll-snap feed ── */
      #player-feed {
        flex: 1; overflow-y: scroll; overflow-x: hidden;
        scroll-snap-type: y mandatory;
        -webkit-overflow-scrolling: touch;
        overscroll-behavior-y: contain;
      }
      .player-slide {
        /* height set via JS after layout; scroll-snap handles full-view snapping */
        scroll-snap-align: start; scroll-snap-stop: always;
        position: relative; background: #000; overflow: hidden;
        flex-shrink: 0;
      }

      /* ── Responsive / mobile ── */

      /* Tablets and small desktops: tighten the star panel */
      @media (max-width: 768px) {
        /* Slightly bigger touch targets */
        .player-ctrl-btn { width: 52px; height: 52px; font-size: 22px; }
        /* Stars: hide sidebar, show compact mobile header instead */
        #stars-view { flex-direction: column; }
        #stars-sidebar { display: none !important; }
        #stars-main-header { display: none !important; }
        #stars-grid { padding: 10px 12px; gap: 10px; }
        /* ── Mobile stars: title-only header ── */
        #stars-main { position: relative; overflow: hidden; }
        #stars-mobile-header {
          display: flex; flex-direction: column; gap: 0;
          flex-shrink: 0; z-index: 10;
          padding: 12px 14px 10px;
          background: rgba(13,13,13,0.97);
          box-shadow: 0 2px 16px rgba(0,0,0,0.5);
          pointer-events: none; user-select: none;
        }
        #stars-mobile-header > :first-child { display: flex; align-items: center; }
        #stars-mobile-title {
          display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0;
          pointer-events: none;
        }
        #stars-mobile-title .stars-main-title {
          font-size: 18px; font-weight: 700; color: #fff;
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        #stars-mobile-title .stars-main-count { font-size: 12px; color: #666; flex-shrink: 0; }
        #stars-mobile-header .grid-controls { pointer-events: auto; flex-shrink: 0; }
        #stars-mobile-header > :first-child { flex-wrap: wrap; row-gap: 6px; }
        #stars-mobile-title { flex: 1 1 100%; }
        .grid-size { width: 56px; }
        .grid-controls { gap: 5px; }
        .grid-sort-btn { font-size: 11px; padding: 0 6px; }

        /* ── Filter buttons: fixed bottom-right stack (like player controls) ── */
        #stars-mobile-filters {
          position: fixed;
          bottom: calc(var(--sp-nav-base, 56px) + var(--sp-safe-b, 0px) + 16px);
          right: 14px;
          display: flex; flex-direction: column; gap: 10px;
          z-index: 210; pointer-events: auto;
          align-items: center;
        }
        .stars-filter-btn {
          width: 42px; height: 42px;
          background: rgba(20,20,20,0.82); border: 1px solid rgba(80,80,80,0.5);
          border-radius: 50%; color: #aaa; cursor: pointer;
          font-size: 18px; font-weight: 700; line-height: 1;
          display: flex; align-items: center; justify-content: center;
          backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);
          transition: color .15s, border-color .15s, background .15s;
          flex-shrink: 0; padding: 0;
        }
        .stars-filter-btn.active { color: #fff; border-color: rgba(255,255,255,0.6); background: rgba(60,60,60,0.92); }
        .stars-filter-btn.stars-filter-thumb-up.active  { color: #4caf50; border-color: #4caf50; }
        .stars-filter-btn.stars-filter-thumb-down.active { color: #f44336; border-color: #f44336; }

        /* ── Group picker: bottom sheet ── */
        #stars-mobile-groups-wrap {
          position: fixed;
          bottom: calc(var(--sp-nav-base, 56px) + var(--sp-safe-b, 0px));
          left: 0; right: 0;
          max-height: 52vh;
          overflow-y: auto; -webkit-overflow-scrolling: touch;
          background: rgba(13,13,13,0.97);
          padding: 14px 14px 18px;
          z-index: 209; border-top: 1px solid #2a2a2a;
          pointer-events: auto; scrollbar-width: none;
        }
        #stars-mobile-groups-wrap::-webkit-scrollbar { display: none; }
        #stars-mobile-groups { display: flex; flex-wrap: wrap; gap: 8px; }
        .stars-mobile-group-pill {
          background: rgba(35,35,35,0.9); border: 1px solid rgba(70,70,70,0.6);
          border-radius: 20px; color: #888; cursor: pointer; padding: 5px 13px;
          font-size: 12px; white-space: nowrap;
          transition: color .15s, border-color .15s, background .15s;
        }
        .stars-mobile-group-pill.active { color: #fff; border-color: rgba(255,255,255,0.5); background: rgba(55,55,55,0.95); }
        /* ── Lvl number strip ── */
        #stars-mobile-lvl-strip {
          display: flex; gap: 6px; overflow-x: auto; padding: 8px 0 6px;
          scrollbar-width: none; pointer-events: auto; flex-shrink: 0;
        }
        #stars-mobile-lvl-strip::-webkit-scrollbar { display: none; }
        .stars-filter-lvl-num {
          min-width: 34px; padding: 5px 8px; font-size: 13px; border-radius: 8px;
        }

        /* ── Recents grid (mobile) ── */
        #recents-grid-view {
          position: fixed; inset: 0;
          bottom: calc(var(--sp-nav-base, 56px) + var(--sp-safe-b, 0px));
          z-index: 500; background: #0d0d0d;
          flex-direction: column; overflow-y: auto;
          -webkit-overflow-scrolling: touch;
        }
        #recents-grid {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 2px; padding: 2px;
        }
        .recents-card { position: relative; }
        /* reuse stars-grid-cover for the cover wrapper */
        .recents-cover-wrap { border-radius: 0; }
        /* always show star + group buttons on mobile (no hover) */
        .recents-cover-wrap .stars-grid-remove,
        .recents-cover-wrap .stars-grid-add-group { opacity: 0.8 !important; }
        .recents-star-btn { font-size: 13px !important; }
        .recents-star-active { color: #ffe234 !important; }
        #recents-grid-loading {
          flex: 1; display: flex; align-items: center; justify-content: center;
          color: #555; font-size: 15px;
        }
        /* ── Recents: stats button (bottom-right, like stars filters) ── */
        #recents-stats-btn {
          position: fixed;
          bottom: calc(var(--sp-nav-base, 56px) + var(--sp-safe-b, 0px) + 16px);
          right: 14px; z-index: 210;
          width: 42px; height: 42px; border-radius: 50%;
          background: rgba(20,20,20,0.82); border: 1px solid rgba(80,80,80,0.5);
          color: #fff; font-size: 18px; cursor: pointer;
          display: flex; align-items: center; justify-content: center;
          backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);
        }
        /* ── Recents: stats bottom sheet ── */
        #recents-stats-overlay {
          position: fixed;
          bottom: calc(var(--sp-nav-base, 56px) + var(--sp-safe-b, 0px));
          left: 0; right: 0;
          background: rgba(13,13,13,0.97);
          padding: 14px 16px 18px; z-index: 209;
          border-top: 1px solid #2a2a2a;
          font-size: 14px; display: none;
          pointer-events: auto;
        }
        #recents-stats-overlay.recents-stats-open { display: block; }


        /* ── Mobile player: fixed full-screen view (display toggled via JS) ── */
        #player-view {
          position: fixed; inset: 0; bottom: 72px; z-index: 3000;
          background: #0d0d0d; flex-direction: column;
          /* display controlled entirely by JS (style.display = 'flex' / 'none') */
        }
        #player-view-loading {
          flex: 1; display: flex; align-items: center; justify-content: center;
          color: #666; font-size: 15px;
        }
        #player-view-header {
          display: flex; align-items: center; gap: 10px;
          padding: 8px 12px; background: #1a1a1a;
          border-bottom: 1px solid #2a2a2a; flex-shrink: 0;
        }
        #player-view-back {
          background: none; border: 1px solid #444; border-radius: 4px;
          color: #ccc; cursor: pointer; padding: 5px 10px; font-size: 13px;
        }
        #player-view #player-counter { font-size: 12px; color: #666; flex: 1; text-align: center; }
        #player-view #player-feed { flex: 1; min-height: 0; }

        /* ── Collapse header on mobile; nav is position:fixed so escapes overflow:hidden ── */
        header {
          height: 0 !important; min-height: 0 !important;
          padding: 0 !important; margin: 0 !important;
          border: none !important; background: transparent !important;
          overflow: hidden !important;
        }

        /* ── Prevent text selection during swipes ── */
        #sp-mobile-nav, #sp-swipe-hint, #player-view, #stars-view,
        .sp-nav-btn, #stars-mobile-header {
          user-select: none; -webkit-user-select: none;
        }

        /* ── The top nav is replaced by the bottom bar on phones ── */
        nav { display: none !important; }

        /* ── Custom bottom nav bar ── */
        #sp-mobile-nav {
          position: fixed; bottom: 0; left: 0; right: 0; z-index: 600;
          background: #1a1a1a; border-top: 1px solid #2a2a2a;
          display: flex; height: 72px; align-items: stretch;
          padding-bottom: 10px; box-sizing: border-box;
        }
        .sp-nav-btn {
          flex: 1; display: flex; flex-direction: column; align-items: center;
          justify-content: center; gap: 3px; background: none; border: none;
          color: #555; font-size: 10px; cursor: pointer;
          border-top: 3px solid transparent; transition: color .15s;
          padding: 5px 4px 3px;
        }
        .sp-nav-btn.sp-active { color: #fff; border-top-color: #fff; }
        .sp-nav-btn svg { flex-shrink: 0; }

        /* ── Swipe hint indicator ── */
        #sp-swipe-hint {
          position: fixed; top: 50%; transform: translateY(-50%);
          background: rgba(40,40,40,0.85); backdrop-filter: blur(10px);
          color: #fff; display: flex; align-items: center; gap: 6px;
          padding: 10px 16px; z-index: 700; pointer-events: none;
          opacity: 0; font-size: 14px; font-weight: 600;
          border: 1px solid rgba(255,255,255,0.12);
          transition: opacity 0.05s;
        }
        .sp-sh-arrow { font-size: 22px; line-height: 1; }

        /* ── View entrance animations ── */
        @keyframes sp-enter-from-right { from { transform: translateX(100vw); } to { transform: translateX(0); } }
        @keyframes sp-enter-from-left  { from { transform: translateX(-100vw); } to { transform: translateX(0); } }
        .sp-enter-from-right { animation: sp-enter-from-right 0.25s cubic-bezier(0.4,0,0.2,1) both; }
        .sp-enter-from-left  { animation: sp-enter-from-left  0.25s cubic-bezier(0.4,0,0.2,1) both; }

        /* Push all page content above the fixed bottom nav */
        body { padding-bottom: var(--sp-nav-base, 56px) !important; }
        /* Stars view: fixed full-screen overlay (avoids dead space from header parent) */
        #stars-view {
          position: fixed !important; top: 0 !important; left: 0 !important; right: 0 !important;
          bottom: 72px !important; max-height: none !important; z-index: 500;
        }







      }

      /* Phones: star panel and toggle sit above the bottom nav */
      @media (max-width: 480px) {
        /* Smaller grid min so more columns fit */
        #stars-grid { grid-template-columns: repeat(auto-fill, minmax(85px, 1fr)); }

        .player-controls { display: none; }    /* hide per-slide controls */
        #player-overlay-controls {              /* single fixed controls layer */
          position: absolute; inset: 0; pointer-events: none; z-index: 10;
        }
        #player-overlay-controls .player-right-center {
          position: absolute; right: 10px; bottom: 120px;
          top: auto; transform: none;
          display: flex; flex-direction: column; gap: 10px;
          pointer-events: auto; align-items: center;
        }
        #player-overlay-controls .player-ctrl-btn {
          width: 41px; height: 41px; font-size: 18px;
        }
        #player-overlay-controls .player-author {
          position: absolute; bottom: 32px; left: 12px;
          font-size: 13px; font-weight: 600; pointer-events: none;
          text-shadow: 0 1px 4px rgba(0,0,0,.9); color: #fff;
          max-width: 58%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        #player-overlay-controls .player-caption {
          position: absolute; bottom: 14px; left: 12px;
          font-size: 11px; color: rgba(255,255,255,.85); pointer-events: none;
          text-shadow: 0 1px 3px rgba(0,0,0,.8);
          max-width: 58%; line-height: 1.4;
          display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
        }
        #player-overlay-controls .player-mute-btn {
          position: absolute; bottom: 14px; right: 10px;
          pointer-events: auto; width: 41px; height: 41px; font-size: 18px;
        }
        #player-overlay-controls .player-overlay-close {
          position: absolute; top: 10px; right: 10px;
          pointer-events: auto; width: 36px; height: 36px; font-size: 18px;
          background: rgba(0,0,0,0.45); border: none; color: #fff;
          border-radius: 50%; display: flex; align-items: center; justify-content: center;
        }
        #player-overlay-controls .player-thumb-up.active  { color: #4caf50; }
        #player-overlay-controls .player-thumb-down.active { color: #f44336; }

        /* Safe area inset for iPhone home indicator */
        #sp-mobile-nav {
          padding-bottom: calc(15px + var(--sp-safe-b, 0px)) !important;
          height: calc(var(--sp-nav-base, 56px) + var(--sp-safe-b, 0px)) !important;
        }
        body { padding-bottom: calc(var(--sp-nav-base, 56px) + var(--sp-safe-b, 0px)) !important; }
        #stars-view {
          bottom: calc(var(--sp-nav-base, 56px) + var(--sp-safe-b, 0px)) !important;
        }
      }

      /* Very small phones: 2-col star panel grid */
      @media (max-width: 360px) {
      }

      #sp-devinfo { position: fixed; left: 8px; right: 8px; top: calc(env(safe-area-inset-top, 0px) + 40px); z-index: 99999;
        background: rgba(20,20,20,.97); color: #fff; border: 1px solid #555; border-radius: 10px; padding: 10px 12px; font-size: 12px; }
      #sp-devinfo pre { margin: 6px 0; font: 10px/1.45 monospace; white-space: pre-wrap; word-break: break-all; color: #cfe; }
      #sp-devinfo button { background: #fff; color: #000; border: none; border-radius: 8px; padding: 6px 14px; font-weight: 700; }
      #sp-crash { position: fixed; left: 8px; right: 8px; top: calc(env(safe-area-inset-top, 0px) + 8px); z-index: 99999;
        background: #3a1010; color: #fff; border: 1px solid #a33; border-radius: 10px; padding: 10px 12px; font-size: 12px; }
      #sp-crash pre { margin: 6px 0; max-height: 40vh; overflow: auto; font: 10px/1.35 monospace; white-space: pre-wrap; color: #fcc; }
      #sp-crash button { background: #fff; color: #000; border: none; border-radius: 8px; padding: 6px 14px; font-weight: 700; }
        /* ── tagging: button, sheet, radial, toast ── */
        #player-view #player-overlay-controls .player-tag-btn { -webkit-touch-callout: none; user-select: none; -webkit-user-select: none; touch-action: none; }
        #player-view #player-overlay-controls .player-tag-btn.active { color: #4fc3f7; }
        .sp-sheet-back { position: absolute; inset: 0; z-index: 40; background: rgba(0,0,0,.25); }
        .sp-sheet {
          position: absolute; left: 0; right: 0; bottom: 0; z-index: 41; height: min(52%, 430px);
          display: flex; flex-direction: column; background: rgba(24,24,24,.96);
          -webkit-backdrop-filter: blur(14px); backdrop-filter: blur(14px);
          border-radius: 16px 16px 0 0; box-shadow: 0 -6px 24px rgba(0,0,0,.5);
          animation: sp-sheet-up .18s ease-out;
        }
        @keyframes sp-sheet-up { from { transform: translateY(100%); } to { transform: translateY(0); } }
        .sp-sheet-grab { padding: 10px 0 6px; display: flex; justify-content: center; touch-action: none; }
        .sp-sheet-grab span { width: 38px; height: 5px; border-radius: 3px; background: rgba(255,255,255,.3); }
        .sp-sheet-search {
          margin: 2px 14px 10px; padding: 9px 12px; border-radius: 10px; border: none; outline: none;
          background: rgba(255,255,255,.1); color: #fff; font-size: 16px;
        }
        .sp-sheet-chips { flex: 1; overflow-y: auto; padding: 0 14px 14px; display: flex; flex-wrap: wrap; gap: 8px; align-content: flex-start; -webkit-overflow-scrolling: touch; }
        .sp-chip { background: rgba(255,255,255,.12); color: #fff; border: none; border-radius: 18px; padding: 8px 14px; font-size: 14px; }
        .sp-chip.on { background: #fff; color: #000; font-weight: 700; }
        .sp-chip.new { background: none; border: 1px dashed rgba(255,255,255,.5); }
        .sp-sheet-empty { color: rgba(255,255,255,.6); font-size: 14px; padding: 8px 2px; }
        .sp-radial { position: absolute; inset: 0; z-index: 45; background: rgba(0,0,0,.45); pointer-events: none; }
        .sp-radial-item {
          position: absolute; transform: translate(-100%, -50%); max-width: 62%;
          padding: 8px 14px; border-radius: 18px; background: rgba(40,40,40,.95); color: #fff;
          font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
          border: 1px solid rgba(255,255,255,.18); transition: transform .08s, background .08s;
        }
        .sp-radial-item.on { border-color: #fff; }
        .sp-radial-item.more { color: rgba(255,255,255,.75); }
        .sp-radial-item.hot { background: #fff; color: #000; transform: translate(-100%, -50%) scale(1.12); }
        #sp-toast {
          position: fixed; left: 50%; transform: translateX(-50%); z-index: 99998;
          bottom: calc(var(--sp-nav-h, 77px) + 18px); display: flex; align-items: center; gap: 12px;
          background: rgba(30,30,30,.96); color: #fff; padding: 9px 14px; border-radius: 20px; font-size: 14px;
          max-width: 86vw;
        }
        #sp-toast span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        #sp-toast button { background: none; border: none; color: #4fc3f7; font-weight: 700; font-size: 14px; }

      /* ═══ PHONE UI v2: edge-to-edge feed, white icon buttons, seek bar above the tab bar ═══ */
      .sp-seek { display: none; }
      @media (max-width: 768px) {
        :root {
          --sp-nav-base: 56px;
          --sp-safe-b: max(0px, calc(env(safe-area-inset-bottom, 0px) - 18px));   /* icons sit down into the home-bar zone */
          --sp-nav-h: calc(var(--sp-nav-base) + var(--sp-safe-b, 0px));
          --sp-top: env(safe-area-inset-top, 0px);
        }
        html, body { background: #000; }

        /* tab bar: black, white icons, the active tab full white */
        #sp-mobile-nav {
          background: #000 !important; border-top: 1px solid rgba(255,255,255,.14) !important;
          height: var(--sp-nav-h) !important;
          padding-bottom: var(--sp-safe-b, 0px) !important;   /* icons sit low, right above the home bar */
        }
        .sp-nav-btn { color: rgba(255,255,255,.55); border-top: none !important; font-weight: 600; }
        .sp-nav-btn.sp-active { color: #fff; }
        .sp-nav-btn svg { width: 25px; height: 25px; }

        /* every full-screen view stops at the tab bar and keeps clear of the notch */
        #player-view { bottom: var(--sp-nav-h) !important; background: #000; }
        #author-view, #autotag-view, #recents-grid-view { bottom: var(--sp-nav-h) !important; padding-top: var(--sp-top); box-sizing: border-box; }
        #stars-view { bottom: var(--sp-nav-h) !important; padding-top: var(--sp-top) !important; box-sizing: border-box; }
        #author-view { border-left: 1px solid rgba(255,255,255,.08); }

        /* video fills the screen; only landscape clips letterbox */
        #player-feed { background: #000; }
        /* never crop or stretch: the video keeps its own aspect ratio, pinned to the very top of the screen */
        #player-view .player-video, #player-view .player-cover { object-fit: contain; object-position: center top; }
        .player-cover { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; z-index: 1; transition: opacity .12s; }
        .player-cover.gone { opacity: 0; }
        .player-slide.sp-paused::before {
          content: ''; position: absolute; top: 50%; left: 50%; z-index: 3;
          transform: translate(-30%, -50%); pointer-events: none;
          border-style: solid; border-width: 28px 0 28px 48px;
          border-color: transparent transparent transparent rgba(255,255,255,.8);
          filter: drop-shadow(0 2px 6px rgba(0,0,0,.5));
        }

        /* soft shade behind the white text and icons */
        #player-view #player-overlay-controls::before {
          content: ''; position: absolute; left: 0; right: 0; bottom: 0; height: 280px;
          background: linear-gradient(to top, rgba(0,0,0,.6), rgba(0,0,0,0)); pointer-events: none;
        }
        #player-view #player-overlay-controls::after {
          content: ''; position: absolute; left: 0; right: 0; top: 0; height: calc(var(--sp-top) + 90px);
          background: linear-gradient(to bottom, rgba(0,0,0,.4), rgba(0,0,0,0)); pointer-events: none;
        }

        /* action buttons: plain white icons, no circles */
        #player-view #player-overlay-controls .player-ctrl-btn {
          background: none !important; box-shadow: none !important; border-radius: 0;
          width: 48px; height: 48px; font-size: 32px; line-height: 1; color: #fff; padding: 0;
          filter: drop-shadow(0 1px 3px rgba(0,0,0,.65)); transform: none !important;
        }
        #player-view #player-overlay-controls .player-ctrl-btn svg { width: 32px; height: 32px; }
        #player-view #player-overlay-controls .player-lvl-btn { font-size: 17px; font-weight: 800; }
        #player-view #player-overlay-controls .player-star-btn.active { color: gold; }
        #player-view #player-overlay-controls .player-thumb-up.active { color: #4caf50; }
        #player-view #player-overlay-controls .player-thumb-down.active { color: #f44336; }
        #player-view #player-overlay-controls .player-lvl-btn.active { color: #fe2c55; }
        #player-view #player-overlay-controls .player-ctrl-btn.braces-on { color: #4fc3f7; }
        #player-view #player-overlay-controls .player-right-center {
          right: 6px; bottom: 30px; gap: 4px; z-index: 1;
        }
        /* mute is the first button of the right-hand column, above like */
        #player-view #player-overlay-controls .player-right-center .player-mute-btn {
          position: static; width: 48px; height: 48px;
        }
        #player-view #player-overlay-controls .player-right-center .player-mute-btn svg { width: 28px; height: 28px; }
        #player-view #player-overlay-controls .player-overlay-close {
          top: calc(var(--sp-top) + 8px); left: 6px; right: auto; width: 44px; height: 44px; font-size: 24px;
        }

        /* who and what, bottom-left like the reference */
        #player-view #player-overlay-controls .player-author {
          bottom: 70px; left: 14px; font-size: 17px; font-weight: 700; max-width: calc(100% - 90px);
        }
        #player-view #player-overlay-controls .player-caption {
          bottom: 22px; left: 14px; font-size: 14px; color: #fff; max-width: calc(100% - 90px);
        }

        /* seek bar: a hairline along the bottom that grows under the finger */
        .sp-seek {
          display: block; position: absolute; left: 0; right: 0; bottom: 0; height: 26px;
          z-index: 12; pointer-events: auto; touch-action: none; cursor: pointer;
        }
        .sp-seek-track { position: absolute; left: 0; right: 0; bottom: 0; height: 2px; background: rgba(255,255,255,.28); transition: height .12s; }
        .sp-seek-fill { height: 100%; width: 0; background: #fff; }
        .sp-seek.scrubbing .sp-seek-track { height: 8px; }
        .sp-seek-time {
          position: absolute; left: 50%; bottom: 44px; transform: translateX(-50%);
          font-size: 13px; font-weight: 700; color: #fff; text-shadow: 0 1px 4px rgba(0,0,0,.8);
          opacity: 0; transition: opacity .12s; pointer-events: none;
        }
        .sp-seek.scrubbing .sp-seek-time { opacity: 1; }
        .sp-fan { position: fixed; inset: 0; z-index: 9000; background: rgba(0,0,0,.45); pointer-events: none; }
        .sp-fan-item {
          position: absolute; transform: translateY(-50%); padding: 10px 18px; border-radius: 20px;
          background: rgba(40,40,40,.96); color: #fff; font-size: 15px; white-space: nowrap;
          border: 1px solid rgba(255,255,255,.18); transition: transform .08s, background .08s;
        }
        .sp-fan-item.on { border-color: #fff; }
        .sp-fan.sticky, .sp-fan.sticky .sp-fan-item { pointer-events: auto; }
        .sp-fan-item:active { background: #fff; color: #000; }
        .sp-fan-item.hot { background: #fff; color: #000; transform: translateY(-50%) scale(1.1); }


        /* Settings on phones: a full-screen page above the tab bar, reached from the gear in the Library header */
        #settings-view { position: fixed; inset: 0; bottom: var(--sp-nav-h) !important; padding-top: var(--sp-top); box-sizing: border-box; z-index: 650; background: #0d0d0d; }
        .set-back { display: inline-block; }
        .set-wrap { max-width: none; padding: 14px 16px 40px; }
        .list-gear { display: block; margin-left: auto; order: 1; }
        .set-input { font-size: 16px; }

        /* Library pages on phones: a full-screen page above the tab bar */
        #list-view { position: fixed; inset: 0; bottom: var(--sp-nav-h) !important; padding-top: var(--sp-top); box-sizing: border-box; z-index: 500; background: #0d0d0d; }
        .list-seg { display: inline-flex; flex: 0 0 100%; order: 2; }
        .list-seg-btn { flex: 1; padding: 6px 4px; font-size: 13px; }
        #list-view-header .list-scope { order: 3; flex-wrap: nowrap; }
        #list-view-header .list-search { order: 4; flex: 1 1 100%; max-width: none; }
        #list-view-header .grid-controls { order: 5; flex: 0 0 100%; }
        #list-grid { grid-template-columns: repeat(2, 1fr); gap: 8px; padding: 8px; }
        #list-grid.follow-grid { grid-template-columns: repeat(2, 1fr); }
        #player-view .player-slide { -webkit-touch-callout: none; -webkit-user-select: none; user-select: none; }
        .sp-speed {
          position: absolute; top: calc(var(--sp-top, 0px) + 16px); left: 50%; transform: translateX(-50%); z-index: 7;
          background: rgba(0,0,0,.55); color: #fff; padding: 5px 14px; border-radius: 16px;
          font-size: 14px; font-weight: 700; pointer-events: none;
        }

        /* zoom a little so the video fills the screen, notch included */
        #player-view .player-slide.sp-fill .player-video, #player-view .player-slide.sp-fill .player-cover { object-fit: cover; object-position: center; }

        /* username over caption in one bottom-anchored box (no caption: the username sits at the bottom) */
        #player-view #player-overlay-controls .player-meta {
          position: absolute; left: 14px; bottom: 32px; max-width: calc(100% - 90px);
          display: flex; flex-direction: column; gap: 4px; pointer-events: none;
        }
        #player-view #player-overlay-controls .player-meta .player-author,
        #player-view #player-overlay-controls .player-meta .player-caption { position: static; max-width: 100%; }
        #player-view #player-overlay-controls .player-meta .player-caption:empty { display: none; }
        .sp-heart { position: absolute; z-index: 6; pointer-events: none; transform: translate(-50%, -50%); animation: sp-heart-pop .7s ease-out forwards; filter: drop-shadow(0 2px 8px rgba(0,0,0,.45)); }
        @keyframes sp-heart-pop {
          0% { transform: translate(-50%, -50%) scale(.3); opacity: 0; }
          25% { transform: translate(-50%, -50%) scale(1.15); opacity: 1; }
          70% { transform: translate(-50%, -62%) scale(1); opacity: 1; }
          100% { transform: translate(-50%, -85%) scale(1); opacity: 0; }
        }
      }
    `;
    document.head.appendChild(s);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // INIT
  // ═══════════════════════════════════════════════════════════════════════════

  function init() {
    injectStyles();

    function tryInject() {
      if (document.querySelector('nav .following')) {
        injectNavTabs();
        startObserving();
      } else {
        setTimeout(tryInject, 200);
      }
    }
    tryInject();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

})();
