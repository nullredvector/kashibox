// Watches responses for video files and HLS playlists, keeps a per-tab list in
// session storage (the service worker can be stopped at any time) and shows the
// count on the toolbar button.
const MEDIA_TYPE = /^(video\/|application\/(vnd\.apple\.mpegurl|x-mpegurl)|audio\/(mpegurl|x-mpegurl))/i;
const MEDIA_EXT = /\.(mp4|webm|m4v|mov|m3u8)(\?|#|$)/i;
const SEGMENT = /\.(ts|m4s|aac|m4a)(\?|#|$)/i;

let chain = Promise.resolve();

function update(tabId, fn) {
  chain = chain.then(async () => {
    const k = 't' + tabId;
    const cur = (await chrome.storage.session.get(k))[k] || [];
    const next = fn(cur);
    await chrome.storage.session.set({ [k]: next });
    await chrome.action.setBadgeText({ tabId, text: next.length ? String(next.length) : '' });
  }).catch(() => {});
}

chrome.webRequest.onResponseStarted.addListener((d) => {
  if (d.tabId < 0 || d.statusCode >= 400 || SEGMENT.test(d.url)) return;
  const header = (n) => d.responseHeaders?.find((h) => h.name.toLowerCase() === n)?.value || '';
  const type = header('content-type').split(';')[0].trim().toLowerCase();
  if (!MEDIA_TYPE.test(type) && !MEDIA_EXT.test(d.url)) return;
  if (type.startsWith('text/html')) return;

  const hls = /mpegurl/.test(type) || /\.m3u8(\?|#|$)/i.test(d.url);
  const range = /^bytes (\d+)-\d+\/(\d+)$/.exec(header('content-range'));
  // A player asking for the middle of a file is not a new video.
  if (range && range[1] !== '0') return;
  const size = range ? Number(range[2]) : Number(header('content-length')) || 0;

  update(d.tabId, (list) => {
    if (list.some((x) => x.url === d.url)) return list;
    return [...list, { url: d.url, kind: hls ? 'hls' : 'file', type, size, seen: Date.now() }];
  });
}, { urls: ['<all_urls>'], types: ['media', 'xmlhttprequest', 'other'] }, ['responseHeaders']);

// A new page load starts a new list (single-page navigations keep theirs).
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading' && info.url) update(tabId, () => []);
});
chrome.tabs.onRemoved.addListener((tabId) => {
  chain = chain.then(() => chrome.storage.session.remove('t' + tabId)).catch(() => {});
});
