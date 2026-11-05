// Downloads a plain HLS stream (optionally AES-128 encrypted with an openly served
// key) and joins the segments into one file. DRM-protected streams are refused.
const q = new URLSearchParams(location.search);
const src = q.get('u');
const name = q.get('n') || 'video';
const statusEl = document.getElementById('status');
const bar = document.getElementById('bar');

const abs = (u, base) => new URL(u, base).href;
const attrs = (line) => Object.fromEntries([...line.matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g)].map((m) => [m[1], m[2].replace(/^"|"$/g, '')]));

async function getText(u) {
  const r = await fetch(u);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.text();
}

// Master playlist -> its highest-bandwidth variant; media playlist -> segment list.
async function resolve(url) {
  const lines = (await getText(url)).split(/\r?\n/).map((l) => l.trim());
  if (lines.some((l) => l.startsWith('#EXT-X-STREAM-INF'))) {
    let best = null;
    lines.forEach((l, i) => {
      if (!l.startsWith('#EXT-X-STREAM-INF')) return;
      const bw = Number(attrs(l.slice(l.indexOf(':') + 1)).BANDWIDTH) || 0;
      const uri = lines.slice(i + 1).find((x) => x && !x.startsWith('#'));
      if (uri && (!best || bw > best.bw)) best = { bw, uri };
    });
    if (!best) throw new Error('No playable variant in the playlist');
    return resolve(abs(best.uri, url));
  }

  let seq = 0, key = null, map = null;
  const segs = [];
  for (const l of lines) {
    if (l.startsWith('#EXT-X-MEDIA-SEQUENCE:')) seq = Number(l.split(':')[1]) || 0;
    else if (l.startsWith('#EXT-X-KEY:')) {
      const a = attrs(l.slice(l.indexOf(':') + 1));
      if (a.METHOD === 'NONE') key = null;
      else if (a.METHOD === 'AES-128' && a.URI) key = { uri: abs(a.URI, url), iv: a.IV };
      else throw new Error('This stream is protected (' + a.METHOD + ') and cannot be saved');
    } else if (l.startsWith('#EXT-X-MAP:')) {
      map = abs(attrs(l.slice(l.indexOf(':') + 1)).URI, url);
    } else if (l && !l.startsWith('#')) {
      segs.push({ url: abs(l, url), key, seq: seq++ });
    }
  }
  if (!segs.length) throw new Error('The playlist has no segments');
  return { segs, map };
}

const keys = new Map();
async function decrypt(buf, seg) {
  if (!seg.key) return buf;
  if (!keys.has(seg.key.uri)) {
    keys.set(seg.key.uri, (async () => {
      const r = await fetch(seg.key.uri);
      if (!r.ok) throw new Error('Could not fetch the key');
      return crypto.subtle.importKey('raw', await r.arrayBuffer(), 'AES-CBC', false, ['decrypt']);
    })());
  }
  const iv = new Uint8Array(16);
  if (seg.key.iv) {
    const hex = seg.key.iv.replace(/^0x/i, '').padStart(32, '0');
    for (let i = 0; i < 16; i++) iv[i] = parseInt(hex.substr(i * 2, 2), 16);
  } else {
    new DataView(iv.buffer).setUint32(12, seg.seq);
  }
  return crypto.subtle.decrypt({ name: 'AES-CBC', iv }, await keys.get(seg.key.uri), buf);
}

async function fetchBuf(u) {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(u);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.arrayBuffer();
    } catch (e) {
      if (attempt >= 2) throw e;
    }
  }
}

async function main() {
  if (!src) throw new Error('No stream address');
  const { segs, map } = await resolve(src);
  const parts = new Array(segs.length);
  bar.max = segs.length;
  let done = 0, next = 0;

  const worker = async () => {
    while (next < segs.length) {
      const i = next++;
      parts[i] = await decrypt(await fetchBuf(segs[i].url), segs[i]);
      bar.value = ++done;
      statusEl.textContent = 'Downloading ' + done + ' / ' + segs.length;
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));

  if (map) parts.unshift(await fetchBuf(map));
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(parts));
  a.download = name + (map ? '.mp4' : '.ts');
  a.click();
  statusEl.textContent = 'Saved ' + a.download;
}

main().catch((e) => { statusEl.textContent = 'Failed: ' + e.message; });
