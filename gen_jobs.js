'use strict';
// "Generate from this": makes a new video from an archive video with the local ComfyUI instance (genvideo.js).
// One job runs at a time (one GPU). A short piece of the source is cut with ffmpeg, sent to that instance only
// (a container with no internet route), and the result is saved in the appdata folder and added to the Library.
// Nothing is deleted or changed in the archive. File names, prompts and frames are never logged.
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { spawn } = require('child_process');
const library = require('./library');
const genvideo = require('./genvideo');

const ARCHIVE_DIR = process.env.ARCHIVE_DIR || '/archive';
const OUT_DIR = path.join(ARCHIVE_DIR, 'data', '.appdata', 'generated');
const ENABLED = !!process.env.COMFY_URL;
const MODES = genvideo.MODES;
const KEEP_JOBS = 30;
const SEGMENT = 4;   // seconds of the source used by extend / restyle

const jobs = [];       // newest last: { id, mode, state, at, error?, libId? }
let running = false;
let seq = 0;

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    let out = '';
    let p;
    try { p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] }); } catch (e) { return reject(e); }
    p.stdout.on('data', d => { out += d; });
    p.on('error', reject);
    p.on('close', code => code === 0 ? resolve(out) : reject(new Error(cmd + ' failed')));
  });
}

// A path from the page (an archive path or a Library url) -> a real file we may read, or null
function resolveSource(p) {
  if (typeof p !== 'string' || p.includes('\0')) return null;
  let s;
  try { s = decodeURIComponent(p.split('?')[0]); } catch (_) { return null; }
  s = s.replace(/^\/+/, '');
  const m = /^api\/library\/videos\/(l[0-9a-f]{12})\.mp4$/.exec(s);
  if (m) return library.fileFor(m[1]);
  const base = path.resolve(ARCHIVE_DIR, 'data');
  const f = path.resolve(ARCHIVE_DIR, s);
  if (!f.startsWith(base + path.sep) || !/\.(mp4|m4v|mov|webm)$/i.test(f) || !fs.existsSync(f)) return null;
  return f;
}

async function probeSize(file) {
  const [w, h] = (await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', file])).trim().split('x').map(Number);
  if (!w || !h) throw new Error('size');
  return { w, h };
}

async function work(job, srcFile, opts) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kgen-'));
  try {
    const { w, h } = await probeSize(srcFile);
    const size = h > w * 1.1 ? { width: 480, height: 832 } : w > h * 1.1 ? { width: 832, height: 480 } : { width: 640, height: 640 };
    const at = Math.max(0, Number(opts.at) || 0);
    let input;
    if (job.mode === 'i2v') {
      input = path.join(tmp, 'in.png');
      await run('ffmpeg', ['-v', 'error', '-y', '-ss', String(at), '-i', srcFile, '-frames:v', '1', input]);
    } else {
      input = path.join(tmp, 'in.mp4');
      const from = job.mode === 'extend' ? Math.max(0, at - SEGMENT) : at;
      await run('ffmpeg', ['-v', 'error', '-y', '-ss', String(from), '-i', srcFile, '-t', String(SEGMENT), '-an',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', input]);
    }
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const out = path.join(OUT_DIR, 'g' + job.id + '-' + job.mode + '.mp4');
    const o = { ...size, prompt: String(opts.prompt || '').slice(0, 500) };
    if (job.mode === 'restyle' && Number.isFinite(opts.denoise)) o.denoise = Math.min(0.95, Math.max(0.2, opts.denoise));
    await genvideo.generate(job.mode, input, out, o);
    job.libId = library.addGenerated(out);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function pump() {
  if (running) return;
  const job = jobs.find(j => j.state === 'queued');
  if (!job) return;
  running = true;
  job.state = 'running';
  try {
    await work(job, job._src, job._opts);
    job.state = 'done';
  } catch (_) {
    job.state = 'failed';
    job.error = 'Generation failed';   // no details: they can contain names
  }
  delete job._src; delete job._opts;
  running = false;
  while (jobs.length > KEEP_JOBS) jobs.shift();
  pump();
}

// Returns { id } or { error }
function start({ src, mode, at, prompt, denoise }) {
  if (!ENABLED) return { error: 'Video generation is not set up' };
  if (!MODES.includes(mode)) return { error: 'Unknown mode' };
  const file = resolveSource(src);
  if (!file) return { error: 'Video not found' };
  if (jobs.filter(j => j.state === 'queued' || j.state === 'running').length >= 5) return { error: 'Too many waiting' };
  const job = { id: Date.now().toString(36) + (++seq).toString(36), mode, state: 'queued', at: Date.now() };
  Object.defineProperty(job, '_src', { value: file, writable: true, configurable: true, enumerable: false });
  Object.defineProperty(job, '_opts', { value: { at, prompt, denoise }, writable: true, configurable: true, enumerable: false });
  jobs.push(job);
  pump();
  return { id: job.id };
}

const list = () => jobs.map(j => ({ id: j.id, mode: j.mode, state: j.state, error: j.error, libId: j.libId }));

module.exports = { ENABLED, start, list, resolveSource };
