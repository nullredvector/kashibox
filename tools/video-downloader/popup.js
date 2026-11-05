const listEl = document.getElementById('list');
const emptyEl = document.getElementById('empty');

const clean = (s) => (s || 'video').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'video';
const mb = (n) => (n ? (n / 1048576).toFixed(1) + ' MB' : 'size unknown');

// Video elements with a plain address (blob: ones are covered by what was seen on the network).
function scanPage() {
  return [...document.querySelectorAll('video')].flatMap((v) =>
    [v.currentSrc, v.src, ...[...v.querySelectorAll('source')].map((s) => s.src)]
  ).filter((u) => /^https?:/i.test(u));
}

async function load() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const k = 't' + tab.id;
  const items = [...((await chrome.storage.session.get(k))[k] || [])];

  try {
    const frames = await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, func: scanPage });
    for (const url of new Set(frames.flatMap((f) => f.result || []))) {
      if (!items.some((x) => x.url === url)) {
        items.push({ url, kind: /\.m3u8(\?|#|$)/i.test(url) ? 'hls' : 'file', size: 0 });
      }
    }
  } catch { /* pages the browser does not allow scripting on */ }

  emptyEl.hidden = items.length > 0;
  for (const it of items) listEl.append(row(tab, it));
}

function row(tab, it) {
  const ext = it.kind === 'hls' ? 'ts' : (/\.(mp4|webm|m4v|mov)(\?|#|$)/i.exec(it.url)?.[1] || 'mp4').toLowerCase();
  const name = clean(tab.title);
  const el = document.createElement('div');
  el.className = 'row';
  el.innerHTML = '<div class="info"><div class="name"></div><div class="meta"></div></div><button>Save</button>';
  el.querySelector('.name').textContent = name + (it.kind === 'hls' ? ' (stream)' : '.' + ext);
  el.querySelector('.meta').textContent = (it.kind === 'hls' ? 'HLS stream' : mb(it.size)) + ' · ' + new URL(it.url).host;
  el.querySelector('button').onclick = () => {
    if (it.kind === 'hls') {
      chrome.tabs.create({ url: chrome.runtime.getURL('hls.html') + '?u=' + encodeURIComponent(it.url) + '&n=' + encodeURIComponent(name) });
    } else {
      chrome.downloads.download({ url: it.url, filename: name + '.' + ext });
    }
  };
  return el;
}

load();
