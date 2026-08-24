# FB Group Posts Export by User

A Tampermonkey userscript for exporting posts from a single Facebook group as
a ZIP containing JSON plus downloaded photos.

The script is strictly URL-driven. It runs in two modes:

- **Specific user** — `https://www.facebook.com/groups/<gid>/user/<uid>/`
  (the per-member-in-group view Facebook already shows you). Exports only
  that member's posts.
- **All members** — `https://www.facebook.com/groups/<gid>/` (the general
  group feed). Exports every member's posts.

It reads what's rendered in your own logged-in browser session and saves it
locally. Nothing is uploaded anywhere.

## Requirements

- A Chromium-based browser (Chrome, Brave, Edge, Chromium)
- [Tampermonkey](https://www.tampermonkey.net/) (or a compatible userscript
  manager such as Violentmonkey)
- A Facebook account that is a member of the group you want to export from

## Install the userscript

1. Install Tampermonkey from the browser's extension store.
2. Open Tampermonkey's dashboard → **Create a new script**.
3. Replace the placeholder contents with the contents of
   [`export-group-posts-by-user.user.js`](./export-group-posts-by-user.user.js).
4. Save (Cmd/Ctrl-S). Tampermonkey will pick up the `==UserScript==` header
   and register the `@match` pattern.
5. Ensure the script is **enabled** in the Tampermonkey dashboard.

The userscript includes a small built-in ZIP writer, so it does not need a
network-loaded ZIP dependency when running through Tampermonkey.

## Use

1. In your logged-in browser, visit the group you want to export from.
2. Either open the general group feed (`https://www.facebook.com/groups/<gid>/`)
   to export posts from **all members**, or click your own name/avatar to open
   the group's **"Your activity"** / member view for a **specific user**:

   ```
   https://www.facebook.com/groups/<groupId>/user/<yourUserId>/
   ```

3. A small dark panel appears in the bottom-right corner titled
   `Export: group <gid> / user <uid>` (or `Export group <gid> (all members)`),
   with two buttons:
   - **Full Scan + Export** — auto-scrolls the entire feed, expands
     "See more", crawls multi-photo carousels, and then downloads one ZIP.
   - **Export Loaded Now** — exports only what is currently rendered in the
     DOM (useful for testing or quick spot exports).

4. When the run finishes you'll get one download:
   - `fb-export-<gid>-user-<uid>-<timestamp>.zip` (specific user) or
     `fb-export-<gid>-<timestamp>.zip` (all members)
   - `export.json` inside the ZIP has one record per post: permalink,
     timestamp, text, external links, and photo URLs.
   - Downloaded photos are stored by post (`post-001/photo-01.jpg`, …). Every
     photo in a multi-photo / carousel post is captured.
   - If any photo downloads fail, the ZIP also includes `photo-failures.json`.

## Render an export as HTML

Use [`render-export.mjs`](./render-export.mjs) to turn an export ZIP into a
local, viewable HTML file:

```sh
node render-export.mjs fb-export-<gid>-user-<uid>-<timestamp>.zip
```

This writes `fb-export-<gid>-user-<uid>-<timestamp>.html` beside the ZIP and
extracts local image assets into a matching `_files/` folder. The generated
HTML references those local files, so it can be opened without a logged-in
Facebook session.

The renderer also supports older two-file exports:

```sh
node render-export.mjs fb-group-<gid>-user-<uid>-<timestamp>.json \
  fb-photos-<gid>-user-<uid>-<timestamp>.zip
```

## Tuning

All runtime knobs live in the `CONFIG` object at the top of the userscript:

- `MAX_PHOTOS_PER_POST`, `MAX_TOTAL_PHOTOS` — photo download caps.
- `SCROLL_INTERVAL_MS`, `MAX_SCROLL_ATTEMPTS`, `IDLE_THRESHOLD` —
  auto-scroll pacing.
- `EOF_*` — end-of-feed detection thresholds.
- `GALLERY_CRAWL_ENABLED`, `GALLERY_CRAWL_*` — controls the hidden-photo
  crawler that fetches photo-viewer pages via `GM_xmlhttpRequest`.
- `CAROUSEL_SCRIPT_EXTRACT_ENABLED` / `CAROUSEL_CRAWL_ENABLED` /
  `CAROUSEL_CRAWL_TARGETED_CAPS_ENABLED` — the three carousel extraction
  strategies (embedded script state, targeted "+N" grid crawl, broad
  interactive viewer crawl). All three are enabled by default; see
  [DEVELOPMENT.md](./DEVELOPMENT.md).
- `DRY_RUN` — emit validation summary to the console but skip the
  ZIP download.

## Notes and caveats

- Facebook's DOM and script-state formats change without warning; extraction
  is best-effort. The validation summary logged to the browser console
  (and to `meta.extraction_stats` in the exported JSON) will tell you what
  the run saw and which heuristics fired.
- For very long activity feeds the export can take a while — the status
  line in the panel shows live progress.
- Running this may violate Facebook's Terms of Service. Use at your own
  risk and only on your own account / your own content.

## Developer / CDP harness

If you want to debug the userscript or automate it headlessly, there is a
CDP (Chrome DevTools Protocol) runner in [`run.mjs`](./run.mjs). It attaches
to a Chrome instance launched with `--remote-debugging-port=9222`, injects a
`GM_xmlhttpRequest` shim, loads the unmodified userscript, auto-clicks
**Full Scan + Export**, and saves the resulting ZIP into `output/`.

See [DEVELOPMENT.md](./DEVELOPMENT.md) for the architecture and the
extraction pipeline in detail.

Quick start:

```sh
# 1. Launch Chrome with remote debugging (dedicated profile)
./launch-chrome.sh

# 2. Log in to Facebook in the launched window.

# 3. Run the exporter against your target URL
FB_EXPORT_URL="https://www.facebook.com/groups/<gid>/user/<uid>/" \
    node run.mjs
```
