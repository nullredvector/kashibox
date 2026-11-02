'use strict';
// Local AI video generation through a ComfyUI instance (kashi-comfy). Three modes:
//   i2v      one frame -> animated clip
//   extend   the last frames of a clip -> what comes next
//   restyle  a clip as the motion source -> same motion, new look
// Only talks to COMFY_URL (default http://kashi-comfy:8188, a container with no internet route).
// Nothing is uploaded anywhere else; inputs are copied to that instance's input folder.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const COMFY_URL = (process.env.COMFY_URL || 'http://kashi-comfy:8188').replace(/\/$/, '');
const CKPT = process.env.GENVIDEO_CKPT || 'ltxv-2b-0.9.8-distilled.safetensors';
const TEXT_ENCODER = process.env.GENVIDEO_TEXT_ENCODER || 't5xxl_fp16.safetensors';

const MODELS = ['ltx2b', 'ltx23'];   // ltx2b: LTX-Video 2B distilled (fast); ltx23: LTX 2.3 22B GGUF + distilled LoRA (better, slower, with sound)
const MODEL = MODELS.includes(process.env.GENVIDEO_MODEL) ? process.env.GENVIDEO_MODEL : 'ltx2b';
const F23 = {
  unet: process.env.GENVIDEO_23_UNET || 'newmodel.gguf',
  lora: process.env.GENVIDEO_23_LORA || 'ltx_2.3_22b_distilled_1.1_lora_dynamic_fro09_avg_rank_111_bf16.safetensors',
  text: process.env.GENVIDEO_23_TEXT || 'gemma-3-12b-it-heretic-v2_fp8_e4m3fn.safetensors',
  proj: process.env.GENVIDEO_23_PROJ || 'ltx-2.3_text_projection_bf16.safetensors',
  vae: process.env.GENVIDEO_23_VAE || 'ltx-2.3-22b-distilled_video_vae.safetensors',
  avae: process.env.GENVIDEO_23_AVAE || 'ltx-2.3-22b-distilled_audio_vae.safetensors',
};
// the distilled schedule (8 steps); restyle starts part-way down it
const SIGMAS23 = [1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0];

const MODES = ['i2v', 'extend', 'restyle'];
const DEFAULTS = {
  width: 480, height: 832,   // multiples of 32; portrait like the archive's clips
  frames: 97,                // 8k+1; about 4 s at 24 fps
  fps: 24, steps: 8, cfg: 1,
  guideFrames: 9,            // extend: how many trailing frames of the source are kept
  denoise: 0.6,              // restyle: lower keeps more of the source
  prompt: '', negative: 'worst quality, inconsistent motion, blurry, jittery, distorted',
};

function snap(n, m) { return Math.max(m, Math.round(n / m) * m); }

// Builds a ComfyUI API graph. `input` is the file name already in the instance's input folder.
function buildGraph(mode, input, o = {}) {
  if (!MODES.includes(mode)) throw new Error('unknown mode ' + mode);
  if ((o.model || MODEL) === 'ltx23') return buildGraph23(mode, input, o);
  const p = { ...DEFAULTS, ...o };
  const w = snap(p.width, 32), h = snap(p.height, 32);
  const frames = Math.max(9, Math.round((p.frames - 1) / 8) * 8 + 1);
  const seed = Number.isFinite(p.seed) ? p.seed : Math.floor(Math.random() * 2 ** 31);
  const g = {
    ckpt: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: CKPT } },
    clip: { class_type: 'CLIPLoader', inputs: { clip_name: TEXT_ENCODER, type: 'ltxv' } },
    pos: { class_type: 'CLIPTextEncode', inputs: { text: p.prompt, clip: ['clip', 0] } },
    neg: { class_type: 'CLIPTextEncode', inputs: { text: p.negative, clip: ['clip', 0] } },
    cond: { class_type: 'LTXVConditioning', inputs: { positive: ['pos', 0], negative: ['neg', 0], frame_rate: p.fps } },
  };
  let pos = ['cond', 0], neg = ['cond', 1], latent, crop = false, denoise = 1;

  if (mode === 'i2v') {
    g.img = { class_type: 'LoadImage', inputs: { image: input } };
    g.prep = { class_type: 'LTXVPreprocess', inputs: { image: ['img', 0], img_compression: 35 } };
    g.start = { class_type: 'LTXVImgToVideo', inputs: {
      positive: pos, negative: neg, vae: ['ckpt', 2], image: ['prep', 0],
      width: w, height: h, length: frames, batch_size: 1, strength: 1 } };
    pos = ['start', 0]; neg = ['start', 1]; latent = ['start', 2];
  } else {
    // load the source clip, scaled to the working size
    g.src = { class_type: 'VHS_LoadVideo', inputs: {
      video: input, force_rate: p.fps, custom_width: w, custom_height: h,
      frame_load_cap: mode === 'restyle' ? frames : 0, skip_first_frames: 0, select_every_nth: 1 } };
    if (mode === 'extend') {
      const n = Math.max(1, Math.round((p.guideFrames - 1) / 8) * 8 + 1);
      // total frames of the source are only known at run time: the caller passes `sourceFrames`
      const total = p.sourceFrames || n;
      g.tail = { class_type: 'ImageFromBatch', inputs: { image: ['src', 0], batch_index: Math.max(0, total - n), length: n } };
      g.empty = { class_type: 'EmptyLTXVLatentVideo', inputs: { width: w, height: h, length: frames, batch_size: 1 } };
      g.guide = { class_type: 'LTXVAddGuide', inputs: {
        positive: pos, negative: neg, vae: ['ckpt', 2], latent: ['empty', 0],
        image: ['tail', 0], frame_idx: 0, strength: 1 } };
      pos = ['guide', 0]; neg = ['guide', 1]; latent = ['guide', 2]; crop = true;
    } else {
      g.enc = { class_type: 'VAEEncode', inputs: { pixels: ['src', 0], vae: ['ckpt', 2] } };
      latent = ['enc', 0]; denoise = p.denoise;
    }
  }

  g.model = { class_type: 'ModelSamplingLTXV', inputs: { model: ['ckpt', 0], max_shift: 2.05, base_shift: 0.95, latent } };
  if (mode === 'restyle') {
    g.sample = { class_type: 'KSampler', inputs: {
      model: ['model', 0], seed, steps: p.steps, cfg: p.cfg, sampler_name: 'euler', scheduler: 'simple',
      positive: pos, negative: neg, latent_image: latent, denoise } };
  } else {
    g.sched = { class_type: 'LTXVScheduler', inputs: { steps: p.steps, max_shift: 2.05, base_shift: 0.95, stretch: true, terminal: 0.1, latent } };
    g.sampler = { class_type: 'KSamplerSelect', inputs: { sampler_name: 'euler' } };
    g.sample = { class_type: 'SamplerCustom', inputs: {
      model: ['model', 0], add_noise: true, noise_seed: seed, cfg: p.cfg, positive: pos, negative: neg,
      sampler: ['sampler', 0], sigmas: ['sched', 0], latent_image: latent } };
  }
  let out = ['sample', 0];
  if (crop) {
    g.crop = { class_type: 'LTXVCropGuides', inputs: { positive: pos, negative: neg, latent: out } };
    out = ['crop', 2];
  }
  g.decode = { class_type: 'VAEDecode', inputs: { samples: out, vae: ['ckpt', 2] } };
  g.save = { class_type: 'VHS_VideoCombine', inputs: {
    images: ['decode', 0], frame_rate: p.fps, loop_count: 0, filename_prefix: 'gen/' + mode,
    format: 'video/h264-mp4', pingpong: false, save_output: true } };
  return g;
}

// LTX 2.3 (audio + video). Same three modes; the picture and the sound are made together.
function buildGraph23(mode, input, o = {}) {
  const p = { ...DEFAULTS, steps: 8, ...o };
  const w = snap(p.width, 32), h = snap(p.height, 32);
  const frames = Math.max(9, Math.round((p.frames - 1) / 8) * 8 + 1);
  const seed = Number.isFinite(p.seed) ? p.seed : Math.floor(Math.random() * 2 ** 31);
  const g = {
    unet: { class_type: 'UnetLoaderGGUF', inputs: { unet_name: F23.unet } },
    lora: { class_type: 'LoraLoaderModelOnly', inputs: { model: ['unet', 0], lora_name: F23.lora, strength_model: 0.6 } },
    clip: { class_type: 'DualCLIPLoader', inputs: { clip_name1: F23.text, clip_name2: F23.proj, type: 'ltxv', device: 'default' } },
    vae: { class_type: 'VAELoader', inputs: { vae_name: F23.vae } },
    avae: { class_type: 'LTXVAudioVAELoader', inputs: { ckpt_name: F23.avae } },
    pos: { class_type: 'CLIPTextEncode', inputs: { text: p.prompt, clip: ['clip', 0] } },
    neg: { class_type: 'CLIPTextEncode', inputs: { text: p.negative, clip: ['clip', 0] } },
    cond: { class_type: 'LTXVConditioning', inputs: { positive: ['pos', 0], negative: ['neg', 0], frame_rate: p.fps } },
  };
  let pos = ['cond', 0], neg = ['cond', 1], latent, crop = false, sigmas = SIGMAS23;

  if (mode === 'i2v') {
    g.img = { class_type: 'LoadImage', inputs: { image: input } };
    g.rs = { class_type: 'ImageScale', inputs: { image: ['img', 0], upscale_method: 'lanczos', width: w, height: h, crop: 'center' } };
    g.prep = { class_type: 'LTXVPreprocess', inputs: { image: ['rs', 0], img_compression: 22 } };
    g.empty = { class_type: 'EmptyLTXVLatentVideo', inputs: { width: w, height: h, length: frames, batch_size: 1 } };
    g.start = { class_type: 'LTXVImgToVideoInplace', inputs: { vae: ['vae', 0], image: ['prep', 0], latent: ['empty', 0], strength: 1, bypass: false } };
    latent = ['start', 0];
  } else {
    g.src = { class_type: 'VHS_LoadVideo', inputs: {
      video: input, force_rate: p.fps, custom_width: w, custom_height: h,
      frame_load_cap: mode === 'restyle' ? frames : 0, skip_first_frames: 0, select_every_nth: 1 } };
    if (mode === 'extend') {
      const n = Math.max(1, Math.round((p.guideFrames - 1) / 8) * 8 + 1);
      const total = p.sourceFrames || n;
      g.tail = { class_type: 'ImageFromBatch', inputs: { image: ['src', 0], batch_index: Math.max(0, total - n), length: n } };
      g.empty = { class_type: 'EmptyLTXVLatentVideo', inputs: { width: w, height: h, length: frames, batch_size: 1 } };
      g.guide = { class_type: 'LTXVAddGuide', inputs: {
        positive: pos, negative: neg, vae: ['vae', 0], latent: ['empty', 0], image: ['tail', 0], frame_idx: 0, strength: 1 } };
      pos = ['guide', 0]; neg = ['guide', 1]; latent = ['guide', 2]; crop = true;
    } else {
      g.enc = { class_type: 'VAEEncode', inputs: { pixels: ['src', 0], vae: ['vae', 0] } };
      latent = ['enc', 0];
      // start part-way down the schedule: a lower start keeps more of the source
      const d = Math.min(0.95, Math.max(0.2, p.denoise));
      sigmas = [d, ...SIGMAS23.filter((x) => x < d)];
    }
  }
  g.aud = { class_type: 'LTXVEmptyLatentAudio', inputs: { frames_number: frames, frame_rate: p.fps, batch_size: 1, audio_vae: ['avae', 0] } };
  g.cat = { class_type: 'LTXVConcatAVLatent', inputs: { video_latent: latent, audio_latent: ['aud', 0] } };
  g.guider = { class_type: 'CFGGuider', inputs: { model: ['lora', 0], positive: pos, negative: neg, cfg: 1 } };
  g.sigmas = { class_type: 'ManualSigmas', inputs: { sigmas: sigmas.join(', ') } };
  g.ks = { class_type: 'KSamplerSelect', inputs: { sampler_name: 'euler' } };
  g.noise = { class_type: 'RandomNoise', inputs: { noise_seed: seed } };
  g.sample = { class_type: 'SamplerCustomAdvanced', inputs: {
    noise: ['noise', 0], guider: ['guider', 0], sampler: ['ks', 0], sigmas: ['sigmas', 0], latent_image: ['cat', 0] } };
  g.sep = { class_type: 'LTXVSeparateAVLatent', inputs: { av_latent: ['sample', 0] } };
  let out = ['sep', 0];
  if (crop) {
    g.crop = { class_type: 'LTXVCropGuides', inputs: { positive: pos, negative: neg, latent: out } };
    out = ['crop', 2];
  }
  g.decode = { class_type: 'VAEDecodeTiled', inputs: { samples: out, vae: ['vae', 0], tile_size: 512, overlap: 64, temporal_size: 4096, temporal_overlap: 8 } };
  g.sound = { class_type: 'LTXVAudioVAEDecode', inputs: { samples: ['sep', 1], audio_vae: ['avae', 0] } };
  g.save = { class_type: 'VHS_VideoCombine', inputs: {
    images: ['decode', 0], audio: ['sound', 0], frame_rate: p.fps, loop_count: 0, filename_prefix: 'gen/' + mode,
    format: 'video/h264-mp4', pingpong: false, save_output: true } };
  return g;
}

async function api(p, init) {
  const r = await fetch(COMFY_URL + p, init);
  if (!r.ok) throw new Error(`${p}: ${r.status} ${(await r.text()).slice(0, 300)}`);
  return r;
}

// Copies a local file into the instance's input folder; returns the stored name.
async function upload(file) {
  const fd = new FormData();
  fd.append('image', new Blob([fs.readFileSync(file)]), path.basename(file));
  fd.append('overwrite', 'true');
  return (await (await api('/upload/image', { method: 'POST', body: fd })).json()).name;
}

// Runs a graph and waits for it. Returns { file, subfolder } of the saved video.
async function runGraph(graph, { timeoutMs = 30 * 60 * 1000, onTick } = {}) {
  const { prompt_id: id } = await (await api('/prompt', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: graph }) })).json();
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    await new Promise((r) => setTimeout(r, 3000));
    const h = (await (await api('/history/' + id)).json())[id];
    if (onTick) onTick(Math.round((Date.now() - t0) / 1000));
    if (!h) continue;
    if (h.status && h.status.status_str === 'error') throw new Error('generation failed: ' + JSON.stringify(h.status.messages.slice(-1)));
    const o = Object.values(h.outputs || {}).flatMap((x) => x.gifs || x.videos || [])[0];
    if (o) return { id, filename: o.filename, subfolder: o.subfolder || '', type: o.type || 'output' };
  }
  throw new Error('generation timed out');
}

async function download(res, dest) {
  const q = new URLSearchParams({ filename: res.filename, subfolder: res.subfolder, type: res.type });
  fs.writeFileSync(dest, Buffer.from(await (await api('/view?' + q)).arrayBuffer()));
  return dest;
}

// One call: local file in, local file out.
async function generate(mode, inputFile, outFile, opts = {}) {
  if (mode === 'extend' && !opts.sourceFrames) {
    const sec = parseFloat(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', inputFile]));
    opts = { ...opts, sourceFrames: Math.max(1, Math.floor(sec * (opts.fps || DEFAULTS.fps)) - 1) };
  }
  const name = await upload(inputFile);
  const res = await runGraph(buildGraph(mode, name, opts), opts);
  return download(res, outFile);
}

module.exports = { MODELS, MODEL, MODES, DEFAULTS, buildGraph, upload, runGraph, download, generate, COMFY_URL };

if (require.main === module) {
  const [mode, input, out, ...rest] = process.argv.slice(2);
  if (!mode || !input || !out) {
    console.error('usage: COMFY_URL=http://host:8188 node genvideo.js <i2v|extend|restyle> <input> <out.mp4> [key=value ...]');
    process.exit(2);
  }
  const opts = { onTick: (s) => process.stderr.write(`\r${s}s `) };
  for (const kv of rest) {
    const [k, v] = kv.split('=');
    opts[k] = k === 'prompt' || k === 'negative' ? v : Number(v);
  }
  generate(mode, input, out, opts).then((f) => console.log('\nsaved', f), (e) => { console.error('\n' + e.message); process.exit(1); });
}
