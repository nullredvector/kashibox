# CLAUDE.md

Guidance for Claude Code (claude.ai/code) when working in this repository.

## What this is

**kashibox**: a self-hosted player and organizer for a saved-video archive. A small Node server (`server.js`) serves one page (`shell.html`), one browser script (`starplayer.js`) and a few JSON APIs; the archive folder (database files and media) is mounted into the container. There is no build step and no package manager: all JS is plain JavaScript.

Run locally: `ARCHIVE_DIR=/path/to/archive PORT=9560 node server.js`, then open `http://localhost:9560`. The phone UI is the same script at widths under 768 px.

## Files

| File | Role |
| --- | --- |
| `shell.html` | the page (header, nav, `<main>`); loads `/starplayer.js` |
| `starplayer.js` | all UI: Stars, Likes, Favorites, Following, username tabs, sessions, pop-out player, phone feed/tagging/gestures, ranker, watch log, review tab |
| `server.js` | serves the page, the script, icons, the archive's files (range requests, caching) and `/api/*` |
| `db_stars.js` | storage for `stars.json` / `sessions.json` / `settings.json` (atomic writes, revisioned saves, a whitelist for settings) |
| `tv_author.js` | for the TV app: one video's path -> the same author's downloaded videos (paths only), read from the archive database |
| `assets/` | icons and logo (also served by the server) |
| `tvos/` | the Apple TV app (SwiftUI): shows the grid of videos phones send to it; project generated with `xcodegen generate` from `project.yml` |
| `Dockerfile`, `entrypoint.sh`, `docker-compose.yml`, `.github/workflows/` | image build and deployment |

## The archive folder

```
<archive>/data/.appdata/   db_videos.js db_authors.js db_texts.js db_likes.js db_bookmarked.js db_following.js   (read-only for kashibox)
                           stars.json sessions.json settings.json watch.json autotag*    (written by kashibox)
<archive>/data/Likes|Favorites/{covers,videos}/<id>.jpg|mp4
<archive>/data/Following/Avatars/small_<account>.jpg and <account>/{covers,videos}/
```

`db_*.js` files are `window.<name>_base64="<base64(gzip(JSON))>"`. The official lists are newest-first. Videos and covers are served with cache headers; everything else is revalidated.

## Architecture notes

- `starplayer.js` is one IIFE. State lives in module-level `let`s; views are shown/hidden by `showStarsTab`, `showListTab`, `showAuthorTab`, `showLogTab`, `showAutotagTab` (phones also use `setMobileTab`). Keep that pattern and always hide the other views first.
- TV relay: the Apple TV app holds `GET /api/tv/stream` (server-sent events); phones `POST /api/tv/cast` (`add`/`clear`, paths only, at most 12 tiles) and `GET /api/tv/author?v=<video path>` lists more from the same author and read `GET /api/tv/status` to know whether a TV is listening. State is in memory only.
- Phone layout: `isMobilePlayer()` (< 768 px) switches to the bottom nav `#sp-mobile-nav`; the Home feed is a scroll-snap list in `#player-view` built by `renderMobileScrollFeed`.
- A star is `stars[id]`; a super star is the same entry with `super: true` (long-press on a star button: `starGesture`, `toggleSuperStar`, `paintStarBtn`). `superState(id)` is `'origin'` (the video you picked, rainbow `ORIGIN_STAR_SVG`), `'inherited'` (any other video by a super-star account, blue sparkle) or null; accounts come from the memoized `superAuthorSet()` (invalidated by `_starsStamp`), and `superVideoItems()` feeds the Super stars category. They also drive the Following page highlight. Review cards on phones get the same button column as the Home feed via `buildActionRail`. The pop-out window has its own small copy of the star logic.
- Settings (`settings.json`, `/api/settings`, the gear page) only accept whitelisted keys (`profileUrl`, `debugBanner`, `numericName`, `numericMin`, `numericMax`; `numRange()`/`numList()` give the choices, `numFilterList()` adds numbers already in use outside the range); the number-per-video feature is user-facing "numeric tags" (`numName()`, never say "level"/"lvl" in the UI; internal names like `levels` stay). `profileUrl`, an `http(s)://` address containing `{username}`. Add a key to `cleanSettings` in `db_stars.js` before using it in the page.
- Account check: `GET /api/profile-check?name=` (`checkProfile` in server.js) asks the profile-link address from the server (404/410, a redirect to `/404`, or a 200 page whose embedded profile status is 10202/10221 = gone; the visible "couldn't find this account" text also sits in normal pages, so don't match it; anything else odd = unknown, never red) and caches it; `checkAuthorGone` in starplayer.js paints desktop username tabs red.
- Gestures use a document-level handler (`setupMobileSwipe`). The username page and grid-opened videos own a history entry (`navPush`/`navPopQuiet`).
- Performance: the server gzips the page, script, bigger JSON replies and archive text files, and gives the page/script/db files ETags (`sendStatic`, `sendBody`, `gzMemo` in server.js); the db files are decoded in parallel with the browser's native base64 decoder (`loadArchiveDb`/`readDbFile`). Measured on a 58k-video synthetic archive: db decode ~100 ms, ranking ~100 ms, tab switches under 150 ms on a laptop.
- Looping videos are left to the browser; a watcher holds the last frame over the loop point, swaps to an in-memory copy after the first loop and restarts stalled videos.

## Working rules

- Work on branch `star-breakaway` (CI publishes `ghcr.io/nullredvector/starplayer:testing`); `master` publishes `:latest`, which the production container pulls automatically. Merge to `master` only when the user asks: tag the current master as `pre-<feature>`, open a PR with a Rollback section, merge with a merge commit.
- Test changes in a browser against a **synthetic** archive (fake ids, generated images/videos), including a phone-sized window.
- **Privacy:** never read or print the user's group/tag names, and never send images/videos to any API or cloud service.
- Do not name the source platform in code comments, commit messages, descriptions or docs; say "kashibox" or "the archive".
- Bump nothing else by hand: there is no version file; images are tagged by branch.
