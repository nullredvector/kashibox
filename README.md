<p align="center">
  <img src="assets/kashibox-icon.svg" alt="kashibox logo" width="120">
</p>

<h1 align="center">kashibox</h1>

A self-hosted player and organizer for a library of saved videos. Point it at your archive folder and you get a fast, phone-friendly way to **browse, star, tag and watch** tens of thousands of videos, all served from your own machine.

kashibox is a complete app: it serves its own page, so there is nothing else to install. It reads the archive's database files and media straight from the folder.

> The Docker image and the compose service are still called `starplayer`.

> Your archive and everything you do with it stay on your server. There are no accounts, no analytics and no cloud calls.

## Features

### Pages
- **Stars** (the default page): star videos, put them into groups, give them a number ("numeric tags", renamable in Settings), and filter by *All tagged*, *All stars*, *Super stars*, *Untagged* or *Disappeared*.
- **Super stars:** press and hold any star button (about half a second) to turn it into a rainbow sparkle star. Every other video by that creator becomes a blue sparkle super star too. Super stars have their own category under *All stars*, and the account is highlighted and sorted to the top of the Following page. Tap a super star to remove it, hold it again to make it a normal star.
- **Likes** and **Favorites:** your downloaded collections, with *Current* (what is still listed), *Disappeared* (downloaded but no longer listed) and *All*, plus search.
- **Following:** the accounts you follow, with avatar, name, follower count and how many of their videos you have. Show only the accounts with videos, or everyone. Click an account to open its videos. It needs a `db_following.js` in the archive; ttpull does not download followed accounts, so for an archive it builds this page just says there is no Following data.
- **Settings** (the gear right of the Player button; on a phone, the gear in the Library header): the profile link, a summary of your archive and a device info box. Settings are saved on the server, so every device shares them.

### Organize
- **Groups as tags:** a video can be in any number of groups. The same groups drive filtering, the phone tagging UI and the feed ranking.
- **Sorting and sizing:** Added, Latest, Popular or Oldest, plus a thumbnail size slider, on every grid.
- **Hover and play-all previews:** mouse over a thumbnail to preview it, or play every visible thumbnail at once.
- **Built for big archives:** grids are filled in chunks as you scroll, so a collection with tens of thousands of videos stays responsive.

### Browse by creator
- **Username tabs:** click a creator's name anywhere to open all of their videos in a tab of their own. Double-click a tab to open that account's profile page, if you have set a profile link in Settings (an address with `{username}` in it). With a profile link set, desktop tabs also check whether the account still exists and show its name in red when it doesn't (including accounts whose profile page says it couldn't find them). Your server makes that check (never the browser) and caches the answer for 12 hours.
- **Tab sessions:** open tabs are saved automatically as sessions you can restore, rename or delete later.
- **Player window:** a pop-out player that doesn't disturb the tab you are on, with the same star, tag and number tools.

### On your phone
- **Home feed:** a full-screen, edge-to-edge, endless vertical feed that autoplays and loops, with a seek bar above the tab bar and plain white icon buttons. Hold a finger on a video to play it at 2×; double-tap to like.
- **Ranked or shuffled:** the Home feed is ordered from your stars, tags and how you actually watch (see below), or switch to a plain shuffle by pressing and holding the Home tab and sliding onto your choice. Leave and come back and it resumes on the video you were on.
- **Gestures:** swipe left on a video to pull that creator's page over the screen, swipe right to push it back. A video opened from a grid is dismissed the same way. Pages are switched with the bottom tab bar only.
- **Tagging while you watch:** tap the tag button for a bottom sheet of your tags (with search and "create"), or press and hold for a radial fan of your most recent tags. Every change has an Undo.
- **Tab bar:** Home, Stars, Recents, Library (Likes, Favorites and Following) and Review.

### Smarter feed
- **Watch log:** the phone feed notes how long each video is watched and whether you skip it quickly. It is stored only in your archive folder.
- **Ranker:** orders the Home feed from stars, numbers, group membership and size, like counts and the watch log, and gives videos you have just seen a cooldown. It only ever sees ids and numbers, never what a tag is called.
- **Review page:** suggestions from the optional **autotagTT** companion (local machine-learning tag suggestions) show up in a Review tab where you accept or reject them.

### Ops
- **Live log tab:** a tail of the optional **ttpull** downloader's log.
- **Safe writes:** your data files are written atomically (temp file, then rename).

## How it works

```
 Browser ──►  server.js ──►  /                 the page (shell.html)
                 │           /starplayer.js     all the UI above, served from the image
                 │
                 ├─ /api/stars, /api/sessions, /api/settings, /api/watch, /api/autotag*   (JSON files in the archive)
                 ├─ /api/ttpull/logs                                       (proxy to ttpull, optional)
                 └─ the archive's videos and covers, with HTTP range requests and caching
```

`server.js` is a small dependency-free Node server. `starplayer.js` is a single self-contained browser script that reads the database files directly.

### The archive folder

```
<archive>/
  data/
    .appdata/
      db_videos.js  db_authors.js  db_texts.js     videos, accounts, captions
      db_likes.js   db_bookmarked.js  db_following.js   what is in each collection
      stars.json  sessions.json  settings.json  watch.json   written by kashibox
    Likes/      covers/<id>.jpg   videos/<id>.mp4
    Favorites/  covers/<id>.jpg   videos/<id>.mp4
    Following/  Avatars/small_<account>.jpg
                <account>/covers/<id>.jpg   <account>/videos/<id>.mp4
```

The `db_*.js` files are `window.<name>_base64="…"` (gzip-compressed JSON, base64). kashibox only reads them; the downloader keeps them up to date. Archives created by the myfaveTT extension use this layout and work as they are.

| File in `data/.appdata/` | Written by kashibox |
| --- | --- |
| `stars.json` | stars, groups and numeric tags |
| `sessions.json` | saved username-tab sessions |
| `settings.json` | your settings (the profile link) |
| `watch.json` | the phone feed's watch log |

## Quick start (Docker)

You need an archive folder in the layout above (for example one kept up to date by ttpull). An empty folder works too: the pages simply say that nothing has been downloaded yet.

```yaml
services:
  starplayer:
    image: ghcr.io/nullredvector/starplayer:latest
    restart: unless-stopped
    ports:
      - "9494:8080"
    volumes:
      - /path/to/your/archive:/archive
    environment:
      - ARCHIVE_DIR=/archive
```

```bash
docker compose up -d
```

Open `http://localhost:9494`. On a phone, open the same address on your network, then add it to the Home Screen for the full-screen, edge-to-edge feed.

### Settings

| Variable | Default | Purpose |
| --- | --- | --- |
| `ARCHIVE_DIR` | `/archive` | the archive folder inside the container |
| `PORT` | `8080` | port the server listens on |
| `TTPULL_URL` | `http://ttpull:3847` | where the live log tab reads ttpull's log (optional) |

### Updates

The image is rebuilt on every push to `master` and published as `:latest`; the development branch publishes `:testing` for trying changes first. [Watchtower](https://containrrr.dev/watchtower/) can pick new images up automatically:

```yaml
    labels:
      - com.centurylinklabs.watchtower.enable=true
```

The UI is part of the image, so updating the image updates the UI.

## Companion projects

- **ttpull**: a headless downloader that keeps the archive topped up on a schedule. It creates a new archive folder on first start and keeps the database files up to date. Set `DB_UPDATE=write` on the ttpull container: its default is `dry`, which only logs what it would change. Settings shows ttpull's connection and when the archive was last updated.
- **autotagTT**: a local, GPU-friendly service that suggests tags. Suggestions only; it never changes your groups by itself.

Both are optional. kashibox works without them.

## Privacy

kashibox's own code only talks to your server (and to ttpull, if you set `TTPULL_URL`). It never uploads videos, covers or tag names anywhere, and the optional companions are designed the same way: models run locally.

## Development

There is no build step: `starplayer.js` is plain JavaScript.

```bash
ARCHIVE_DIR=/path/to/archive PORT=9560 node server.js
```

Edit `starplayer.js`, reload the page, and you're testing. The phone UI is the same script at narrow widths (under 768 px), so a browser window resized to a phone makes a good test bed.

Branches: work lands on `star-breakaway` (published as `:testing`) and is merged to `master` (published as `:latest`).

## Credits

The archive folder layout is the one used by the [myfaveTT](https://github.com/taoqili/myfaveTT) extension by taoqili, so archives it created can be used directly.
