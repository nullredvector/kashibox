# Brief for the ttpull chat: build the "scout"

You are working in the **ttpull** repository. Read [README.md](README.md) (the shared contract) first; this brief is your half of it. kashibox (the viewer) is finished: the queue screen, the Settings controls and the decision storage already exist and are tested with a fake scout.

## What to build
A **scout** that runs inside the ttpull container, using the Chromium and the saved login that ttpull already has. At a human pace, within limits the user sets, it looks through the site's For You feed, sends each video's cover to the scorer, and writes the best matches to the shared archive folder as **suggestions**. The user then opens and likes them by hand in kashibox's Review -> For You picks.

**The scout is strictly read-only on the site. It never likes, unlikes, follows, comments, shares, saves or posts. There is no auto-like mode. Do not add one, not even behind a flag.**

## The loop
Every cycle (about a minute):
1. Read `<archive>/data/.appdata/settings.json` (`scoutEnabled`, `scoutDaily`, `scoutMin`, `scoutFrom`, `scoutTo`; see the table in README.md, defaults apply to missing keys). Also honour an environment variable `SCOUT` (`on`/`off`, default `off`) as a hard kill switch. If either says off, write `status.json` with `state: "off"` and do nothing.
2. If the current local hour is outside `scoutFrom`..`scoutTo`, or `today.viewed >= scoutDaily`, write `state: "paused"` and wait.
3. If the 30-minute likes sync is running, wait (they must never run at the same time).
4. **Backpressure:** count pending picks (lines in `candidates.jsonl` whose id has no entry in `scout_feedback.json` and is not in the archive's Likes list). If that is **200 or more**, write `paused` and stop collecting. The queue must not pile up.
5. Run a **session** of at most about 15-20 minutes (random), then rest for 30-90 minutes (random).

Inside a session, for each video the feed shows:
- Skip it if its id is already in the archive (Likes, Favorites, Following), already a candidate, in `scout_feedback.json`, or in the scout's own `seen` set (keep that set in ttpull's own state folder, not in the archive).
- Download the **cover image only** (never the video file) to `scout/covers/<id>.jpg` (write a temp file, then rename). Cap the size at about 1 MB.
- `POST` the cover to the scorer (`SCORER_URL`, default `http://autotagtt:8090/score?id=<id>`). If the scorer is down or answers 503, wait and retry a few times, then stop the session with `state: "error"` and a short message. Never guess a score.
- If `round(score * 100) >= scoutMin`, append one line to `scout/candidates.jsonl` (fields in README.md). **Cover first, line second.** One `write` call, ending with a newline.
- Pace like a person: a random 3-12 second pause between videos, occasional longer pauses, never a perfectly regular rhythm. Count every video looked at in `today.viewed`; reset the counters at local midnight.

## Stop conditions (this is the most important part)
The scout stops the whole run, writes `status.json`, sends a notification through ttpull's existing ntfy path, and **stays stopped for at least 6 hours** (or until the user switches `scoutEnabled` off and on again) when it sees any of:
- a verification or "prove you are human" screen, a slider, a captcha, or any unexpected dialog: `state: "challenge"`. **Do not try to solve, bypass or work around it. Do not click anything on it.**
- being logged out, or a login prompt: `state: "login"` (ttpull's `login` notification already exists; reuse it).
- HTTP 403 or 429, or the feed failing to load three times in a row: `state: "error"` with a plain message.
- more than a handful of errors in a row for any reason.

There must be **no** stealth plugins, fingerprint spoofing, proxy rotation, user-agent tricks or anything else meant to avoid detection. If the site decides the scout is unwelcome, the right outcome is that it stops and tells the user.

## Reading the feed
Use the same approach ttpull already uses for the likes lists: the page's own requests in the logged-in browser, read-only. Only read the fields you need: id, author username, caption, cover URL. Do not store cookies, tokens, signed URLs or user data in files or logs.

## Files you write (exact formats are in README.md)
- `data/.appdata/scout/candidates.jsonl` (append; you may rewrite it with temp+rename to trim it to the newest 5000 lines)
- `data/.appdata/scout/covers/<id>.jpg`
- `data/.appdata/scout/status.json` (atomic write; at least on every state change and every few minutes while running)
Create the `scout/` folders if they do not exist. Do not write anywhere else in the archive. Do not modify the database files.

## Configuration
- `SCOUT=off` by default (an environment variable, the hard switch).
- `SCORER_URL` default `http://autotagtt:8090`.
- A dry-run mode `SCOUT_DRY=1`: runs the loop and logs what it would write, writes nothing to the archive, and still obeys every limit.
- Log lines prefixed `[scout]`, with no secrets in them.

## Tests (no real account needed)
Build a fake feed page and a fake scorer and test: it writes nothing when disabled; honours the hour window and `scoutDaily`; stops on a challenge page and stays stopped; stops on a login page; stops when backpressure is reached; never calls any like/follow endpoint (assert that no request other than reading the feed and cover downloads is ever made); skips ids already in the archive; writes the cover before the candidate line; survives the scorer being down.

## Done when
- With the real kashibox Settings toggle on and a running scorer, the picks screen fills up at the limits the user set, and the status line in Settings shows what the scout is doing.
- Turning the toggle off stops it within a minute.
- The challenge/login/error states show the warning banner in kashibox.
- Nothing about your tag names or the user's likes is ever logged or sent anywhere.
