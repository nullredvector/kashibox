# Brief for the autotagTT chat: build the "scorer"

You are working in the **autotagTT** repository. Read [README.md](README.md) (the shared contract) first; this brief is your half of it. kashibox (the viewer) is finished, and the ttpull chat builds the scout that calls you.

## What to build
A small **HTTP service** inside the autotagTT container that answers one question: *"how well does this cover image fit the tags I taught you?"* The scout sends it the cover of a video from the For You feed; it answers with a score between 0 and 1 and the best-matching tags. The score is built from the classifiers you already train for the user's existing tags. There is no separate "taste" model to invent.

## The service
A new subcommand `python -m autotagtt serve` (listening on `0.0.0.0:8090`, **inside the compose network only**: use `expose`, never `ports`).

`POST /score?id=<video id>`: body is the raw image (JPEG, PNG or WebP). Limits: 2 MB, a sane maximum pixel count, decode errors give 400.
Response:
```json
{ "score": 0.83, "tags": [["tagname", 0.91], ["tagname2", 0.74]], "model": "2026-10-24-a1b2c3" }
```
`GET /health` -> `{ "ok": true, "ready": true, "model": "...", "tags": 3 }`. While the model is loading, `/score` answers 503 and `ready` is false.

Load the SigLIP model once (fp16, on the GPU) and keep it loaded. Target under 300 ms per cover. One request at a time is fine.

## How the score is made ("taste built on the existing tags")
1. **Persist the classifiers.** `train` must save, per tag, everything needed to score a new embedding without retraining (coefficients, intercept, calibration) under `data/.appdata/autotag/models/`. `serve` loads them and reloads when the files change after a nightly run.
2. Use only tags that are **enabled** (`autotag_tags.json`) and trained, and skip tags the pipeline already marks weak (`gate: weak`, `review_only`).
3. For each such tag `t`, turn the classifier's decision value into a probability `p_t`. Calibrate it (Platt or isotonic) using the out-of-fold decision values against the user's accepted and rejected review decisions where there are enough of them; otherwise fall back to the class-balanced logistic output. Remember the existing README caveat: negatives here are provisional (positive-unlabeled), so precision numbers are lower bounds.
4. Give each tag a weight `w_t` in 0..1 from its reviewed precision (or CV precision when there are few reviews). Drop tags with `w_t < 0.3`.
5. `score = 1 - product(1 - w_t * p_t)` (a noisy OR: one strong match is enough, several add up). `tags` is the best three by `w_t * p_t`, as `[name, value]`.
6. `model` is a short string that changes whenever the weights change (a date plus a hash).

## Learning from the user's decisions (second step; ship the service first)
kashibox writes `data/.appdata/scout_feedback.json` (format in README.md). It records what the user did with each suggestion.
- **Log every score you give**: append `{id, ts, p: {tag: p_t, ...}, score}` to `data/.appdata/autotag/scout_scores.jsonl` (rotate it, keep at most about 20,000 lines). This is how a decision can later be joined to the features that produced it.
- In the nightly `train`, once there are **at least 30 positives and 30 negatives**, fit a small logistic regression ("stacker") from the per-tag probabilities to the user's label, and use it instead of the noisy OR for `score`. Below those counts keep the noisy OR.
  - **Positives:** a candidate with decision `liked`, **or whose id appears in the archive's Likes list** (the strongest signal: the user liked it on the site).
  - **Negatives:** only candidates with decision `skipped`. That is the one explicit "no". `opened` with no decision is not a label.
  - **Everything else is unlabeled and must be ignored, never treated as a negative.** In particular a video the scout scored but did not suggest is *not* a negative: the scout saw it, the user did not.
- Report the picks' hit rate (liked / (liked + skipped)) in the run status so kashibox can show it later.

## Boundaries
- Everything stays local. The only network access is the model-weight download that already exists. Nothing about the images, tags or decisions leaves the server.
- Write only under `data/.appdata/autotag/`. Read `scout/candidates.jsonl`, `scout_feedback.json` and the archive's Likes list, but never write them. Never edit groups or `stars.json`.
- Keep the existing rule: suggestions only. The service never changes anything in the user's library.
- Do not print or commit any real tag names, archive content, covers or embeddings. Tests use synthetic vectors and fake ids, as now.

## docker-compose
Add `expose: ["8090"]` to the autotagtt service (no published port), and a health check against `/health`. The scout reaches it as `http://autotagtt:8090`.

## Tests
Synthetic embeddings only, no GPU: the noisy OR with known weights; weak and disabled tags excluded; the response shape and limits (oversize body, bad image, 503 while loading); the stacker only switches on at 30/30 labels; unlabeled items never become negatives; a candidate in the Likes list counts as a positive; the scores log is rotated.

## Done when
- `curl --data-binary @cover.jpg 'http://autotagtt:8090/score?id=123'` from the ttpull container returns a score and tags quickly.
- Retraining does not need the service to restart.
- With real feedback in `scout_feedback.json` the stacker switches on at the thresholds above and the run status shows the hit rate.
