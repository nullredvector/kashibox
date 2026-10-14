#!/usr/bin/env python3
"""Make the videos in an archive loop without a black flash on iPhones.

Many downloaded videos have their video track starting a little after time 0 (0.03-0.25 s) while the audio starts at 0.
For that first stretch the file has sound but no picture, and iOS shows it as a black flash every time a looping video
restarts. This tool re-wraps such a file WITHOUT re-encoding (ffmpeg -c copy): only the video timestamps move back so the
first picture is at 0. Quality and size stay the same.

Safe by default: nothing is changed unless --replace is given. Every new file is checked before it is used (same codec,
size and duration, video and audio both starting at 0). With --replace the original is swapped out atomically, never
deleted first.

    python3 tools/rewrap_videos.py /archive --staging /archive/rewrapped --limit 200      # try a batch, originals untouched
    python3 tools/rewrap_videos.py /archive --replace --jobs 4                             # fix files in place

Needs ffmpeg and ffprobe. Files that already start at 0 are skipped, so it can be stopped and run again.
"""
import argparse, json, os, shutil, struct, subprocess, sys, tempfile
from concurrent.futures import ThreadPoolExecutor

TOL_START = 0.001     # a video start below this counts as 0
TOL_DUR = 0.15        # seconds the duration may differ after the re-wrap


def probe(path):
    out = subprocess.check_output(['ffprobe', '-v', 'error', '-show_streams', '-show_format', '-of', 'json', path], timeout=120)
    j = json.loads(out)
    video = [s for s in j['streams'] if s['codec_type'] == 'video']
    audio = [s for s in j['streams'] if s['codec_type'] == 'audio']
    return j, (video[0] if video else None), audio


def start_of(stream):
    try:
        return float(stream.get('start_time') or 0)
    except ValueError:
        return 0.0


def payload_size(path):
    """Size of the real file content. Many downloads are padded with zero bytes after the last atom, up to a fixed size;
    that padding is not content and is not kept by the re-wrap."""
    size = os.path.getsize(path)
    with open(path, 'rb') as f:
        pos = 0
        while pos + 8 <= size:
            f.seek(pos)
            sz, typ = struct.unpack('>I4s', f.read(8))
            if typ == b'\x00\x00\x00\x00' or sz == 0 and pos > 0:
                return pos
            if sz == 1:
                sz = struct.unpack('>Q', f.read(8))[0]
            if sz < 8:
                return pos
            pos += sz
    return min(pos, size)


def video_files(root):
    data = os.path.join(root, 'data')
    for kind in ('Likes', 'Favorites'):
        d = os.path.join(data, kind, 'videos')
        if os.path.isdir(d):
            for f in sorted(os.listdir(d)):
                if f.endswith('.mp4') and not f.startswith('._'):   # ._name files are macOS leftovers, not videos
                    yield os.path.join(d, f)
    following = os.path.join(data, 'Following')
    if os.path.isdir(following):
        for acct in sorted(os.listdir(following)):
            d = os.path.join(following, acct, 'videos')
            if acct != 'Avatars' and os.path.isdir(d):
                for f in sorted(os.listdir(d)):
                    if f.endswith('.mp4') and not f.startswith('._'):
                        yield os.path.join(d, f)


def rewrap(src, dst):
    """Write the fixed copy to dst. Returns (status, note). status: skip | ok | fail"""
    j, v, a = probe(src)
    if v is None:
        return 'fail', 'no video stream'
    st = start_of(v)
    if st < TOL_START:
        return 'skip', 'starts at 0'
    cmd = ['ffmpeg', '-v', 'error', '-y', '-i', src, '-itsoffset', '%.6f' % (-st), '-i', src,
           '-map', '1:v:0', '-map', '0:a?', '-c', 'copy', '-movflags', '+faststart', dst]
    try:
        subprocess.check_call(cmd, timeout=900)
        j2, v2, a2 = probe(dst)
    except Exception as e:   # ffmpeg failed or the result cannot be read
        return 'fail', str(e)[:80]
    problems = []
    if v2 is None or v2['codec_name'] != v['codec_name']: problems.append('codec')
    elif (v2['width'], v2['height']) != (v['width'], v['height']): problems.append('size')
    if abs(start_of(v2)) > TOL_START: problems.append('video start %.3f' % start_of(v2))
    if len(a2) != len(a): problems.append('audio streams')
    elif a and abs(start_of(a2[0])) > TOL_START: problems.append('audio start %.3f' % start_of(a2[0]))
    if abs(float(j2['format']['duration']) - float(j['format']['duration'])) > TOL_DUR: problems.append('duration')
    so, sn = payload_size(src), os.path.getsize(dst)
    if not (0.95 * so <= sn <= 1.05 * so): problems.append('file size %d -> %d' % (so, sn))
    if problems:
        return 'fail', ', '.join(problems)
    return 'ok', 'start %.3f -> 0' % st


def work(args, src):
    root = os.path.abspath(args.root)
    if args.replace:
        tmp = tempfile.NamedTemporaryFile(prefix='.rewrap-', suffix='.mp4', dir=os.path.dirname(src), delete=False)
        tmp.close(); dst = tmp.name
    else:
        dst = os.path.join(args.staging, os.path.relpath(src, root))
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        if os.path.exists(dst):
            return src, 'skip', 'already in staging'
    status, note = rewrap(src, dst)
    if args.replace:
        if status == 'ok':
            st = os.stat(src)
            shutil.copystat(src, dst)
            try: os.chown(dst, st.st_uid, st.st_gid)
            except OSError: pass
            os.replace(dst, src)
        else:
            try: os.unlink(dst)
            except OSError: pass
    elif status != 'ok' and os.path.exists(dst):
        os.unlink(dst)
    return src, status, note


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('root', help='the archive folder (the one containing data/)')
    ap.add_argument('--replace', action='store_true', help='fix the files in place (default: only write copies to --staging)')
    ap.add_argument('--staging', help='where copies go when not replacing (default: <root>/data/.appdata/rewrapped)')
    ap.add_argument('--limit', type=int, default=0, help='stop after this many files that needed fixing')
    ap.add_argument('--jobs', type=int, default=2, help='files processed at once')
    args = ap.parse_args()
    if not args.replace and not args.staging:
        args.staging = os.path.join(args.root, 'data', '.appdata', 'rewrapped')
    counts = {'ok': 0, 'skip': 0, 'fail': 0}
    todo = list(video_files(args.root))
    print(f'{len(todo)} videos found', flush=True)
    done_fixed = 0
    with ThreadPoolExecutor(max_workers=max(1, args.jobs)) as pool:
        futures = []
        for src in todo:
            futures.append(pool.submit(work, args, src))
        for fut in futures:
            try:
                src, status, note = fut.result()
            except Exception as e:
                counts['fail'] += 1; print('FAIL', e, flush=True); continue
            counts[status] += 1
            if status == 'fail': print('FAIL', os.path.basename(src), note, flush=True)
            if status == 'ok':
                done_fixed += 1
                if done_fixed % 100 == 0: print(f'  {done_fixed} fixed so far', flush=True)
                if args.limit and done_fixed >= args.limit:
                    for f in futures: f.cancel()
                    break
    print(f"done: fixed {counts['ok']}, already fine {counts['skip']}, failed {counts['fail']}", flush=True)
    return 1 if counts['fail'] else 0


if __name__ == '__main__':
    sys.exit(main())
