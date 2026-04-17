# Development notes

Technical details of `export-group-posts-by-user.user.js` and the companion
CDP runner. Companion to [README.md](./README.md).

## Repository layout

| File | Role |
|---|---|
| `export-group-posts-by-user.user.js` | The Tampermonkey userscript. All extraction, scrolling, carousel logic, UI, and download pipeline live here. Pure browser-side JS. |
| `run.mjs` | Puppeteer-CDP runner. Attaches to a remote-debugged Chrome, shims `GM_xmlhttpRequest` + intercepts blob downloads, injects the userscript unmodified, auto-clicks Full Scan, and writes the captured JSON/ZIP to `output/`. |
| `capture-graphql.mjs` | Debug helper. Intercepts Facebook's GraphQL POSTs while the user navigates a multi-photo post, used to reverse-engineer which queries carry hidden-photo data. |
| `launch-chrome.sh` | Launches a Chromium-based browser with `--remote-debugging-port=9222` against a dedicated profile dir so your regular browser session is untouched. |
| `jszip.min.js` | Vendored [JSZip](https://stuk.github.io/jszip/) so the CDP runner can inject it without a CDN round-trip. Under Tampermonkey the script uses the `@require` CDN copy. |

## URL contract

The userscript only activates on `https://www.facebook.com/groups/<gid>/user/<uid>/`
(enforced by `@match` *and* a runtime regex). Both the group ID and user ID
are parsed from `window.location.href` by `parseIdsFromUrl()` — there are no
hardcoded IDs anywhere in the userscript.

## Extraction pipeline

The end-to-end flow for **Full Scan + Export** is:

```
createPanel()
  └── handleFullScan()
        ├── scanCurrentPosts()             # initial pass over already-rendered posts
        ├── autoScroll()                   # scroll + re-scan until EOF heuristics fire
        │     └── scanCurrentPosts() (per cycle)
        ├── scanCurrentPosts()             # one final pass
        └── runExport(posts)
              ├── downloadJSON(posts)
              └── buildPhotoZip(posts)  →  downloadBlob(zip)
```

### `scanCurrentPosts()` — per-post extraction

For each post container (`[data-virtualized="false"]`, falling back to
non-comment `[role="article"]`):

1. **Expand "See more"** (`expandSeeMoreInPosts`). Matches localized text
   + aria-label patterns for ~15 languages.
2. **Permalink** (`extractPermalink`). Prefers `/posts/` or `/permalink/`
   URLs, then numeric post-ID links, then reconstructs from
   `set=(gm|pcb|a).<postId>` photo-set params.
3. **Timestamp** (`extractTimestamp`). Handles the classic `<abbr>`
   element, `aria-labelledby` → hidden span, timestamp-link text, and
   date-like `aria-label` patterns, skipping anything inside a comment
   article.
4. **Body text** (`extractText`). Fallback chain:
   `data-ad-preview="message"` → `data-ad-comet-preview="message"` →
   `data-ad-rendering-role="story_message"` → `div[dir="auto"]` blocks →
   `data-ad-rendering-role="title"`.
5. **Inline photos** (`extractPhotos`). Collects from
   `img[data-imgperflogname="feedImage"]`, `a[href*="/photo/"]` thumbnails,
   remaining CDN-hosted `<img>` tags, `srcset`, `data-src`, and
   `background-image` styles. Rejects avatars
   (`/v/t<N>.<M>-1/` filename pattern), profile cover photos, static
   `rsrc.php` assets, tiny icons (≤ 50 px), and decorative styled-text
   backgrounds (`/v/t<N>.10873-<M>/`).
6. **Hidden photos** (`resolveHiddenPhotos`). For posts that surface a
   photo-set link, fetches the photo-viewer HTML through
   `GM_xmlhttpRequest` and mines embedded JSON `"uri":"…"` values, the
   `og:image` meta tag, and `data-src`/`src` attrs. Follows "next photo"
   links up to `GALLERY_CRAWL_MAX_PAGES_PER_POST` hops.
7. **Carousel photos** — two independent strategies (both off by default is
   also valid):
   - **Script-state extraction** (`extractCarouselFromScripts`) — walks
     `<script>` tags that mention the post ID, pulls every `"uri":"…"`
     under `t<N>.<M>-<K>/`, dedupes by the middle-fbid, and requires that
     each fbid share a long common prefix with the post's visible photo
     fbids (carousel siblings are minted sequentially, so this prefix
     heuristic cleanly rejects commenter avatars and link-preview thumbs
     that happen to be in the same JSON blob).
   - **Interactive viewer crawl** (`crawlCarousel`) — opens the photo
     viewer, captures the current image, clicks "next", repeats until it
     loops back to the starting image, the viewer closes, or a pending/
     lazy-load budget is exhausted. Disabled by default
     (`CAROUSEL_CRAWL_ENABLED: false`) because the viewer can hijack SPA
     routing and destroy feed state if FB's DOM shifts mid-run.
8. **De-duplicate** by `urlPathKey(url)` (origin + pathname), preferring
   non-thumbnail variants where available.

Every intermediate step feeds counters on `extractionStats` /
`carouselDebug`, which are embedded in the exported JSON's
`meta.extraction_stats` and `meta.carousel_control_debug`.

### `autoScroll()` — EOF detection

Scrolling terminates on two independent signals:

1. **Deterministic hard-stop**: `EOF_HARD_STOP_IDLE_CYCLES` consecutive
   scroll cycles where both (a) the unique-post-key count and (b) the
   raw post-DOM-node count are unchanged.
2. **Multi-signal EOF**: once `IDLE_THRESHOLD` cycles go by without
   height growth, we additionally probe the bottom of the document,
   track whether the tail post-key signature is unchanged, and only
   declare EOF after `EOF_CONSECUTIVE_CYCLES` where all of these hold.

A limited number of **retry bursts** (`RETRY_BURSTS`) force-scroll to the
bottom before giving up, since Facebook's virtualized feed sometimes
defers loading until the viewport is actually near the bottom.

### Photo-URL quality upgrade

`upgradeToHighRes` strips the `stp=` size/transform parameter from FB CDN
URLs (e.g. `p180x540`, `cp0_dst-jpg`), which causes the CDN to serve the
original-resolution variant. `parseBestSrcset` picks the highest `Nw` entry
from an `srcset`.

## UI

`createPanel()` injects a fixed-position dark panel in the bottom-right of
the page with two buttons (`fb-export-full-btn`, `fb-export-now-btn`) and
a status line (`fb-export-status`). The CDP runner uses the presence of
`#fb-export-full-btn` as its auto-start signal.

## CDP runner (`run.mjs`)

The userscript is **never modified** for CDP use. Instead, `run.mjs`:

1. Connects via `puppeteer-core` to an already-running Chrome at
   `http://127.0.0.1:9222` (launched by `launch-chrome.sh`).
2. Navigates to `FB_EXPORT_URL` / `argv[2]` and waits for the user to log
   in if they aren't already.
3. Injects `jszip.min.js` from disk. Because Facebook pages define an AMD
   `window.define`, the JSZip UMD wrapper would otherwise register as an
   AMD module; `run.mjs` temporarily shadows `define` so JSZip falls
   through to the global branch.
4. Injects a **prelude shim** (`PRELUDE_SHIM`) that provides:
   - `GM_xmlhttpRequest`, backed by `fetch` — same-origin requests get
     `credentials: 'include'`, cross-origin fbcdn requests get
     `credentials: 'omit'` (the real Tampermonkey bypasses CORS; the
     in-page shim can't, so it has to route carefully).
   - Monkey-patched `HTMLAnchorElement.prototype.click` — captures
     `blob:`-href downloads into `window.__FB_EXPORT_FILES` instead of
     saving via the browser dialog.
   - `MutationObserver` that auto-clicks `#fb-export-full-btn` once the
     panel mounts, and transitions `window.__FB_EXPORT_STATUS` from
     `starting` → `running` → `done` (with a grace period for the zip to
     land after the JSON).
5. Evaluates the userscript with the `// ==UserScript== … // ==/UserScript==`
   header stripped.
6. Polls `window.__FB_EXPORT_STATUS` until `done` or a 30-minute hard cap,
   then copies every entry in `__FB_EXPORT_FILES` to `output/`.

A copy of the stripped userscript is written to
`output/_injected-userscript.js` each run, so you can diff what actually
executed against the source on disk.

## GraphQL capture helper (`capture-graphql.mjs`)

Purely a debugging tool. Attaches request/response handlers to the same
remote-debugged Chrome, scrolls until it finds a multi-photo post
(identified by a `+N` overlay), clicks into the photo viewer, and
advances through the carousel. Every GraphQL POST is recorded with its
`fb_api_req_friendly_name`, `doc_id`, variables, and response snippet;
the full `CometPhotoRootContentQuery` responses are dumped to
`graphql-photo-raw.json` and a summary to `graphql-captured.json`.

These outputs are **gitignored** — they contain session-scoped data (feed
cursors, viewer info).

## Stats emitted in every export

The `meta` block of the exported JSON includes:

- `extraction_stats` — post counts, images, hidden/carousel discovery,
  scroll-cycle counters, EOF reason.
- `carousel_control_debug` — per-strategy counts for next-button
  selection, lazy-load wait totals, loop/recovery detection.

Both also appear in the `Carousel validation:` and
`Validation summary:` log lines in the browser console.

## Gotchas and known limitations

- Facebook's markup churns frequently. Every selector has at least one
  fallback, but extraction is still best-effort.
- Photo URLs are high-res variants of the *rendered* image. Facebook
  strips EXIF on upload, so the export is visually faithful but not
  byte-identical to the original.
- Cross-origin fetches to `scontent*.fbcdn.net` under the in-page shim
  rely on the CDN's permissive CORS headers; if FB ever tightens these
  the CDP runner's photo ZIP will fail even though real Tampermonkey
  will keep working.
