# Minion Goal: make the FB group post exporter reliably work

/goal — Make this Tampermonkey userscript reliably export and download ALL
posts from a Facebook group, either (a) posts from every member, or (b) only
posts from one specific user, including EVERY photo in every multi-photo /
carousel post. The deliverable is a working userscript, verified end-to-end
in a real Chromium browser running under a real Tampermonkey extension (not
just the headless CDP shim) — see "Browser verification" below.

## Context (read these files first)
- README.md — product overview, install/use flow
- DIAGNOSIS.md — root cause of the current "runs but no photos / 403" failure
- DEVELOPMENT.md — extraction pipeline, carousel strategies, CDP runner
- export-group-posts-by-user.user.js — the userscript (the file you must
  finish/fix). It is large (~2500 lines) and self-contained.

## Current state (what is broken / incomplete)
- Written for the per-member view `…/groups/<gid>/user/<uid>/`. Photo
  download phase fails: every `scontent*.fbcdn.net` fetch returns HTTP 403
  (likely referer/origin/cookie header policy via GM_xmlhttpRequest, CDN URL
  expiry during long scans, and/or `stp=`-stripping breaking the URL
  signature). See DIAGNOSIS.md for candidate fixes — implement them robustly,
  don't just pick one:
  - Send proper headers (Referer: https://www.facebook.com/) with
    GM_xmlhttpRequest; grant/connect the correct `scontent*.fbcdn.net` hosts.
  - Fetch each post's photo URLs promptly rather than waiting until the end
    of a long scan (URLs go stale).
  - Preserve original signed URL and fall back on the original if the
    high-res stripped variant 403s.
- Carousel / multi-photo extraction is incomplete or disabled. Extracting all
  photos in a carousel is a **hard requirement**. Make the extraction
  reliable against the live DOM and script-state FB renders today, and
  document which strategy actually fires.

## Requirements
1. Runs as a Tampermonkey/Violentmonkey userscript only on
   `https://www.facebook.com/groups/<gid>/user/<uid>/` (per-member view) AND
   a general group feed `…/groups/<gid>/` for the "all members" export.
2. Support both modes: export posts by ALL members, or a SPECIFIC user
   (identify the member from the URL / profile view).
3. Capture for each post: permalink, timestamp, full body text, external
   links, and **every** photo URL including every image in a carousel /
   multi-photo post. Download the actual image bytes into the ZIP.
4. Robust auto-scroll to end-of-feed (persist scroll position, resume safely
   on feed remount, no duplicates).
5. Reliability is the bar: no 403 photo failures, no missing carousel images,
   no dropped posts. Everything is best-effort against FB churn, so build in
   fallbacks and clear console/status diagnostics (which strategy fired,
   failures reported).
6. Keep it self-contained; it may stay a single userscript file.

## Browser verification (REQUIRED, real Tampermonkey)
- Launch a visible Chromium via ./launch-chrome.sh (remote debugging port
  9222, dedicated profile).
- When you reach the point that needs a real logged-in Facebook session,
  STOP and report clearly to the operator: "READY FOR LOGIN" — list the exact
  URL you will open and which profile/browser to log into. Do NOT continue
  the login-dependent verification past this gate.
- After the operator confirms login, drive the flow: load the target group
  page, install/refresh the userscript in the Tampermonkey, run the export,
  and verify the resulting ZIP contains the expected number of posts AND all
  carousel photos for a known multi-photo post (open the exported HTML /
  list the images and confirm count matches the source post).
- Also validate it still works under the automated ./run.mjs CDP harness once
  logged in, and reconcile the 403 fix against BOTH the CDP shim path and the
  real Tampermonkey path (they fetch differently).
- Prove reliability: run the export at least once end-to-end to completion
  with ZERO photo 403s and a complete carousel, and record evidence (ZIP
  contents listing, counts, screenshots/logs).

## Finish
- Commit all changes to the repo with clear messages.
- Final report: what you changed, the root cause of the unreliability you
  fixed, exact browser-verification evidence (output ZIP path + contents +
  counts), and anything Kenneth must do manually. Deterministic lint/checks
  welcome but real proven run output is the gate.
