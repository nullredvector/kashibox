# kashi-comfy: local video generation (ComfyUI)

All processing is local. The generator container has no internet route.

## Set up (once)
```bash
cd tools/genvideo
export GENVIDEO_DIR=/path/with/room/for/models   # ~30 GB+
docker compose build kashi-comfy                      # needs internet (build only)
docker compose --profile fetch run --rm fetch     # downloads weights, then exits
docker compose up -d kashi-comfy gate                 # runs offline; UI on http://<host>:8188
```
Verify isolation: `docker compose exec kashi-comfy python -c "import urllib.request as u;u.urlopen('https://example.com',timeout=5)"` must fail.

## Modes
Built in `genvideo.js` (used by kashibox later; also a CLI) and tested on a synthetic clip on the 2080 Ti:
```bash
COMFY_URL=https://kashicomfy.fexel.net node genvideo.js <i2v|extend|restyle> <input> <out.mp4> [prompt=... width=480 height=832 frames=97 denoise=0.6 seed=1]
```
1. `i2v`: one frame (image) -> animated clip.
2. `extend`: the last 9 frames of a clip (needs `ffprobe` where it runs) -> the continuation.
3. `restyle`: the clip as the motion source; `denoise` lower keeps more of the source.

A 49-frame 480x832 clip takes about 20 s with the distilled 2B model. Input is uploaded only to kashi-comfy (no internet route); results are fetched back.

## LTX 2.3 (better, with sound)

The dialog's "Quality" menu picks the model per job (`model: 'ltx2b'` fast, `'ltx23'` better); `GENVIDEO_MODEL` sets the default. `ltx23` uses the 22B GGUF through ComfyUI-GGUF with the small distilled LoRA, the Gemma encoder plus text projection, and separate video/audio VAEs (all in `models.txt`; file names can be overridden with `GENVIDEO_23_UNET`, `_LORA`, `_TEXT`, `_PROJ`, `_VAE`, `_AVAE`).

Folder layout the loaders expect: the GGUF is linked into `models/diffusion_models/`, the audio VAE into `models/checkpoints/` (both are symlinks to the real files).

On one 11 GB card ComfyUI runs with `--disable-dynamic-vram --reserve-vram 1.5` (see `docker-compose.yml`): without them the sampler runs out of GPU memory. Jobs use 49 frames at about 384x672 (portrait); a warm run takes roughly 30-75 s, the first after a restart a few minutes.
