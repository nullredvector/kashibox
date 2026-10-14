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
| `tv_sessions.js` | TV sessions: the grid on the TV saved automatically (`tv_sessions.json`) so it can be brought back |
| `tools/tv_refresh/` | Mac background job that rebuilds the TV app from master and reinstalls it on the Apple TV (a free Apple ID signs for 7 days): `install.sh` sets it up (launchd, checks every 6 h, acts when the last install is over 4 days old; `--uninstall` removes it), `refresh.sh` does the work; log in `~/Library/Logs/kashibox-tv-refresh.log` |
| `assets/` | icons and logo (also served by the server) |
| `tvos/` | the Apple TV app (SwiftUI): shows the grid of videos phones send to it; project generated with `xcodegen generate` from `project.yml` |
| `Dockerfile`, `entrypoint.sh`, `docker-compose.yml`, `.github/workflows/` | image build and deployment |

## The archive folder

```
<archive>/data/.appdata/   db_videos.js db_authors.js db_texts.js db_likes.js db_bookmarked.js db_following.js   (read-only for kashibox)
                           stars.json sessions.json settings.json watch.json hidden.json autotag*    (written by kashibox)
<archive>/data/Likes|Favorites/{covers,videos}/<id>.jpg|mp4
<archive>/data/Following/Avatars/small_<account>.jpg and <account>/{covers,videos}/
```

`db_*.js` files are `window.<name>_base64="<base64(gzip(JSON))>"`. The official lists are newest-first. Videos and covers are served with cache headers; everything else is revalidated.

## Architecture notes

- `starplayer.js` is one IIFE. State lives in module-level `let`s; views are shown/hidden by `showStarsTab`, `showListTab`, `showAuthorTab`, `showLogTab`, `showAutotagTab` (phones also use `setMobileTab`). Keep that pattern and always hide the other views first.
- TV relay: the Apple TV app holds `GET /api/tv/stream` (server-sent events); phones `POST /api/tv/cast` (`add`/`clear`, paths only, at most 12 tiles) `GET /api/tv/author?v=<video path>` (more from the same author), `GET /api/tv/starred` and `POST /api/tv/star` (explicit star state), `GET /api/tv/sessions` and `POST /api/tv/session` (TV sessions: every grid is saved by itself in `tv_sessions.js` / `tv_sessions.json`, paths only; picking one on the TV restores it). `POST /api/tv/select` (the TV reports the panel whose highlight is showing: a video sent from a phone replaces that panel in place, otherwise it is added and, past 12, the oldest goes). `POST /api/tv/remove` takes one panel off the grid (a long click on the TV remote, only while the highlight shows). The TV app keeps muted videos on an ambient audio session (`AudioMode`) so background music is not paused until a video is unmuted. The POST routes accept same-origin JSON only and read `GET /api/tv/status` to know whether a TV is listening. State is in memory only.
- Hidden videos: `hidden.json` (`{ hidden: { "<video id>": <ms> } }`, `loadHidden`/`updateHidden`/`hiddenIds` in `db_stars.js`) via `GET /api/hidden` and same-origin-JSON `POST /api/hidden { add, remove, clear }`. Hiding only removes a video from view; nothing is deleted. The page keeps the map in `hidden` (`isHidden`, `visibleOnly`, `hideVideo`, `unhideVideos`, `unhideAll`, `afterHiddenChange`) and filters at every place a list is built: `collectionItems`, `authorVideos`, the Home feed candidates, `superVideoItems`, the five Stars-view lists (`visibleOnly(sortVideos(...))`), the sidebar counts and the Review stack; the TV author feed filters on the server (`tv_author.authorFeed(..., hiddenSet)`). Hide buttons: the thumbnail tool stack (`thumb-hide`), the grid overlay (`overlay-hide-btn`, closes it), the phone feed (`player-hide-btn`, then `skipHidden` scrolls to the next slide; `activate` also never plays a hidden slide). Settings -> Hidden videos shows the count and opens `showHiddenManager` (Unhide / Unhide all). A new list builder must call `isHidden`.
- Phone layout: `isMobilePlayer()` (< 768 px) switches to the bottom nav `#sp-mobile-nav`; the Home feed is a scroll-snap list in `#player-view` built by `renderMobileScrollFeed`.
- A star is `stars[id]`; a super star is the same entry with `super: true` (long-press on a star button: `starGesture`, `toggleSuperStar`, `paintStarBtn`). `superState(id)` is `'origin'` (the video you picked, rainbow `ORIGIN_STAR_SVG`), `'inherited'` (any other video by a super-star account, blue sparkle) or null; accounts come from the memoized `superAuthorSet()` (invalidated by `_starsStamp`), and `superVideoItems()` (only the explicitly super-starred videos, not the creator's others) feeds the Super stars category. They also drive the Following page highlight. Review cards on phones get the same button column as the Home feed via `buildActionRail`. The pop-out window has its own small copy of the star logic.
- Settings (`settings.json`, `/api/settings`, the gear page) only accept whitelisted keys (`profileUrl`, `debugBanner`, `numericName`, `numericMin`, `numericMax`; `numRange()`/`numList()` give the choices, `numFilterList()` adds numbers already in use outside the range); the number-per-video feature is user-facing "numeric tags" (`numName()`, never say "level"/"lvl" in the UI; internal names like `levels` stay). `profileUrl`, an `http(s)://` address containing `{username}`. Add a key to `cleanSettings` in `db_stars.js` before using it in the page.
- Account check: `GET /api/profile-check?name=` (`checkProfile` in server.js) asks the profile-link address from the server (404/410, a redirect to `/404`, or a 200 page whose embedded profile status is 10202/10221 = gone; the visible "couldn't find this account" text also sits in normal pages, so don't match it; anything else odd = unknown, never red) and caches it; `checkAuthorGone` in starplayer.js paints desktop username tabs red.
- Gestures use a document-level handler (`setupMobileSwipe`). The username page and grid-opened videos own a history entry (`navPush`/`navPopQuiet`).
- Performance: the server gzips the page, script, bigger JSON replies and archive text files, and gives the page/script/db files ETags (`sendStatic`, `sendBody`, `gzMemo` in server.js); the db files are decoded in parallel with the browser's native base64 decoder (`loadArchiveDb`/`readDbFile`). Measured on a 58k-video synthetic archive: db decode ~100 ms, ranking ~100 ms, tab switches under 150 ms on a laptop.
- Looping videos are left to the browser (the `loop` attribute); a small watcher only restarts stalled videos. Do not add tricks over the loop point: an iPhone cannot paint a hidden or covered second video, swapping a video's source reloads it black, and a held still adds a visible freeze. The real cause of a black flash is in the files, see below.

## Video files

A video flashes black at every loop on iPhones when its video track starts after time 0 while its audio starts at 0 (the file has sound but no picture for that first stretch). Most downloaded videos have a video start of 0.03-0.25 s. They are also padded with zero bytes after the last atom, up to fixed sizes, and have the index (moov) at the end, so playback only starts once the whole file is there. `tools/rewrap_videos.py` fixes all of that without re-encoding (`ffmpeg -c copy`, the video timestamps moved back, `+faststart`): it writes copies to a staging folder by default, and with `--replace` swaps each file in place only after checking codec, size, duration and that video and audio both start at 0. Run it on the archive folder with ffmpeg available (the autotag container has it); new downloads need the same re-wrap.

## Working rules

- Work on branch `star-breakaway` (CI publishes `ghcr.io/nullredvector/starplayer:testing`); `master` publishes `:latest`, which the production container pulls automatically. Merge to `master` only when the user asks: tag the current master as `pre-<feature>`, open a PR with a Rollback section, merge with a merge commit.
- Test changes in a browser against a **synthetic** archive (fake ids, generated images/videos), including a phone-sized window.
- **Privacy:** never read or print the user's group/tag names, and never send images/videos to any API or cloud service.
- Do not name the source platform in code comments, commit messages, descriptions or docs; say "kashibox" or "the archive".
- Bump nothing else by hand: there is no version file; images are tagged by branch.
