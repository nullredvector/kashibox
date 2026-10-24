# For You picks: how the three programs fit together

A **suggestion queue**. A scout on the server looks through the site's For You feed, a scorer judges each video by the tags you taught the AI tagger, and kashibox shows the best ones in **Review -> For You picks**. You open a video and like it yourself (or skip it). **Nothing in this system ever likes, follows, comments on or posts anything.**

```
 ttpull container                 autotagTT container                kashibox
 ┌──────────────────┐  cover.jpg  ┌────────────────────┐             ┌──────────────────────────┐
 │ scout            │ ──────────► │ scorer (HTTP)      │             │ Review -> For You picks  │
 │  reads the feed, │ ◄────────── │  POST /score       │             │  cards: Open / I liked   │
 │  read-only       │ score,tags  └────────────────────┘             │  it / Skip               │
 └────────┬─────────┘                       ▲                         └───────────┬──────────────┘
          │ writes                          │ reads (nightly)                     │ writes
          ▼                                 │                                     ▼
   data/.appdata/scout/candidates.jsonl     └──── data/.appdata/scout_feedback.json (your decisions)
   data/.appdata/scout/covers/<id>.jpg
   data/.appdata/scout/status.json          settings.json (kashibox Settings page) is read by the scout
```

Everything is local. Nothing is uploaded anywhere. The programs talk only through files in the shared archive folder and one internal HTTP call (scout -> scorer).

## Who builds what

| Piece | Where | Brief |
| --- | --- | --- |
| Queue screen, Settings controls, decision storage, API | kashibox (this repo, done) | this file |
| The scout: looks through the feed at a human pace, read-only | ttpull | [ttpull-brief.md](ttpull-brief.md) |
| The scorer: "how well does this cover fit my tags?" | autotagTT | [autotagtt-brief.md](autotagtt-brief.md) |

## The contract (all three must agree on this)

All paths are inside the archive folder, under `data/.appdata/`.

### `scout/candidates.jsonl`, written by the scout
One JSON object per line, appended. Write the cover file first, then the line. Latest line per `id` wins. kashibox keeps the newest 5000.

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | string of digits (5-25) | the video id |
| `author` | string `[A-Za-z0-9_.-]{0,64}` | the creator's username, no `@` |
| `desc` | string, at most 300 chars | the caption |
| `score` | number 0..1 | the scorer's score |
| `tags` | up to 3 of `[name, 0..1]` | why: the best-matching tags |
| `found` | number, ms since epoch | when the scout found it |

The cover image must exist at `scout/covers/<id>.jpg` (kashibox builds that path from the id and ignores any path in the file).

### `scout/status.json`, written by the scout (atomic write: temp file, then rename)
```json
{ "state": "idle", "updated": 1790000000000, "message": "", "today": { "date": "2026-10-24", "viewed": 96, "collected": 24 } }
```
`state` is one of `off`, `idle`, `running`, `paused`, `challenge`, `login`, `error`. `challenge` and `login` show a warning in kashibox. `message` is shown for `error`. Update it at least when the state changes and every few minutes while running.

### `scout_feedback.json`, written by kashibox only
```json
{ "decisions": { "7700000000000000013": { "d": "liked", "t": 1790000000000 } } }
```
`d` is `liked` (you said it was a good pick), `skipped` (a bad pick: **the only real negative label there is**) or `opened` (you opened it but have not decided). A candidate whose id appears in the archive's Likes list also counts as liked: that is the strongest signal, because you really liked it on the site.

**Videos the scout saw but never suggested are not negatives.** The scout saw them, you did not. Treat them as unlabeled.

### `settings.json`, written by kashibox's Settings page, read by the scout
Read it at the start of every loop, so changes apply within a minute. A missing key means its default.

| Key | Default | Meaning |
| --- | --- | --- |
| `scoutEnabled` | `false` | the scout does nothing unless this is `true` |
| `scoutDaily` | `100` | most videos it may look at per day (0 pauses it) |
| `scoutMin` | `60` | lowest score, in percent, worth suggesting |
| `scoutFrom`, `scoutTo` | `0`, `23` | only look in these local hours, both inclusive; `from > to` wraps past midnight; `0`/`23` means any time |

### The scorer's HTTP call (scout -> autotagTT, inside the compose network)
`POST http://autotagtt:8090/score?id=<video id>` with the cover image bytes as the body (`Content-Type: image/jpeg`).
Response: `{"score": 0.83, "tags": [["tagname", 0.91], ["tagname2", 0.74]], "model": "2026-10-24-a1b2c3"}`.
`GET http://autotagtt:8090/health` returns `{"ok": true, "ready": true, "model": "...", "tags": 3}` (`ready: false` while it is still loading).

## Hard rules for the whole system
1. **Read-only on the site.** Never like, unlike, follow, comment, share, save or post. Only load the feed and download cover images.
2. **No evasion.** Do not solve or bypass verification checks, do not alter the browser fingerprint, no stealth plugins. If the site challenges the scout, it stops, tells the user, and stays stopped.
3. **Privacy.** Covers, scores and decisions stay on the server, in the archive folder. Nothing is sent to any cloud or API. Never commit archive content, covers or decisions to a repository.
4. **The user decides.** There is no auto-like mode, and none should be added without the user asking for it again.

## Try the kashibox side without the other two
```bash
node tools/fake_scout.js /path/to/a/test/archive 24 idle      # invented picks, plain generated covers
ARCHIVE_DIR=/path/to/a/test/archive PORT=9560 node server.js
```
Then open Review -> For You picks. The last argument can be `challenge`, `login`, `error`, `paused`, `running` or `off` to see the banners.
