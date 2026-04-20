# Photo-fetch failure diagnosis

Diagnosis of a Full Scan + Export run where the scan succeeded but the
photo ZIP appeared not to be produced. Based on the browser console log
captured from the Tampermonkey-driven run.

## TL;DR

The **scan phase worked correctly** — 26 posts collected, 24 scroll cycles,
clean hard-stop, validation summary emitted. The **photo download phase
is failing**: every call to `fetchImageAsArrayBuffer()` is coming back as
`HTTP 403` from `scontent*.fbcdn.net`. The captured log was cut off
mid-loop — the run had not yet reached the `zip.generateAsync()` call when
the log ended, which is why no ZIP download was triggered.

If the loop had been allowed to finish, a ZIP file *would* have been
produced — but it would contain only `manifest.json` + `photo-failures.json`
and zero actual images, because every photo fetch failed.

## What the log shows

Sequence of events from the captured log:

| Log line | Event |
|---|---|
| 3 | Userscript injected, panel mounted |
| 542 | "Full Scan + Export" clicked |
| 543–3266 | Posts #1–#26 discovered across scroll cycles |
| 1132, 2468, 2578, 2916, 3071, 3243 | "See more" expansions fired (6 batches) |
| 3309 | Hard-stop: 5 consecutive scroll cycles with zero new post DOM nodes AND zero new unique post keys |
| 3310 | Scrolling complete: 24 scrolls, 26 posts collected, 9 DOM nodes, `eof=true (reason=hard_stop_5_idle_cycles_zero_dom_and_keys)`, retries left=3 |
| 3312 | Validation summary emitted |
| 3381–3397 | 9 × `Failed to fetch photo: post-XXX/photo-YY.jpg — HTTP 403` |
| (end) | Log ends here — `Done!` line never appears |

All 9 fetch failures are `HTTP 403`. There are no successes interleaved.
The total number of photo URLs across the 26 posts is well above 9 (post #5
alone had 7 images, post #8 had 5, post #10 had 5, etc.), so the loop was
still running when the log was cut off.

The visible warnings in the log that *aren't* coming from the userscript
are noise:

- `SyntaxError: Invalid flags supplied to RegExp constructor '(\?[a-z]+=w+)?$'`
  and the `:has-text(/^S$/)` `querySelectorAll` errors — these are
  **uBlock Origin (or another adblock extension)** trying to apply
  cosmetic filter rules inside a Facebook MutationObserver. Not related.
- `Permissions-Policy header: Unrecognized feature: 'attribution-reporting'` etc.
  — Chrome warning about unknown FB-set policy headers. Not related.
- `WebSocket connection to '<URL>' failed` — Facebook's own realtime
  channel reconnecting. Not related.

## Where the failure happens in code

`buildPhotoZip()` (`export-group-posts-by-user.user.js:1821`) iterates the
collected posts and calls `fetchImageAsArrayBuffer(photoUrl)` for each
photo URL. On error, it pushes to a `failures` array and continues:

```js
try {
  const buf = await fetchImageAsArrayBuffer(photoUrl);
  zip.file(filename, buf);
  totalPhotos++;
} catch (e) {
  failures.push({ post_index: i + 1, photo_index: j + 1, url: photoUrl, error: e.message });
  warn(`Failed to fetch photo: ${filename} — ${e.message}`);
}
```

After the loop finishes:

```js
zip.file('manifest.json', JSON.stringify(posts, null, 2));
if (failures.length > 0) {
  zip.file('photo-failures.json', JSON.stringify(failures, null, 2));
}
return { zip, totalPhotos, failures };
```

So a ZIP is *always* produced (assuming the loop completes), it just won't
contain any image bytes when every fetch is 403.

`fetchImageAsArrayBuffer()` (line 1757) is a thin `GM_xmlhttpRequest`
wrapper. It currently sends:

- `method: 'GET'`
- `responseType: 'arraybuffer'`
- `timeout: CONFIG.PHOTO_FETCH_TIMEOUT_MS` (15s)

…and **no extra headers** — no `Referer`, no `Origin`, no `Cookie`
overrides.

## Why the CDN is returning 403

`scontent*.fbcdn.net` URLs are signed: each URL carries query params
roughly like `&_nc_cat=…&ccb=…&_nc_ohc=…&_nc_oc=…&_nc_zt=…&_nc_ht=…&oh=…&oe=…`,
where:

- `oe=` is a unix-timestamp expiry.
- `oh=` and `_nc_ohc=` are signed handshake tokens bound to the URL's
  parameters and (in some cases) the issuing session.

A 403 from this CDN almost always means one of three things:

1. **The signed URL has expired.** From the log, the elapsed time between
   the Full Scan click (line 542, ~"T=0") and the first photo fetch
   attempt (line 3381, after scan + validation summary) is on the order of
   minutes. Some `oe=` TTLs are short, especially for high-res variants.
   Long full scans amplify this risk because URLs extracted from early
   posts can stale before the fetch loop reaches them.

2. **Referer / Origin mismatch.** `GM_xmlhttpRequest` issues background
   requests that don't automatically inherit the page's `Referer:
   https://www.facebook.com/`. Some fbcdn endpoints accept anonymous
   fetches; others require a Facebook referer. Tampermonkey can be
   configured to set a referer, but the script doesn't request it.

3. **Stripped `stp=` doesn't match the signature.** `upgradeToHighRes()`
   (line 410) deletes the `stp=` (size/transform) query param to force
   the CDN to serve the original resolution. The accompanying signature
   (`oh=…`) was minted *for the sized variant*, so the CDN may reject
   the stripped variant as an unsigned request.

A previous successful run (Apr 17 16:38, produced
`output/fb-photos-...-1776415127708.zip`, 3.3 MB) used the same userscript
byte-for-byte (verified by diffing `export-group-posts-by-user.user.js`
against `output/_injected-userscript.js`). So whatever the trigger is, it
isn't a code change between the two runs — it's environmental.

## Why the log seemed to lack a final `Done!`

`runExport()` ends with one of these `updateStatus()` calls:

- `Done! ${total} posts + ${result.totalPhotos} photos${failMsg}`
- `Done! ${total} posts. ZIP failed: ${e.message}` (if `generateAsync` throws)
- `Done! ${total} posts (photo URLs in JSON, ZIP unavailable).` (if JSZip
  failed to load)
- `Done! ${total} posts exported (no photos found).` (if zero photo URLs)

None of these appear in the captured log, and `[FB-Export] Generating ZIP
file…` doesn't appear either. That means the run was **still inside the
per-photo fetch loop** when the log capture ended. The browser hadn't yet
reached `zip.generateAsync({ type: 'blob' })`, so no `blob:` URL was ever
created and no download was triggered. From the user's perspective:
"nothing was downloaded".

## How to confirm the cause without modifying the script

These steps are non-invasive — pure observation in DevTools:

1. **DevTools → Network tab**, filter by `scontent`. Run **Export Loaded
   Now** (faster than a full scan). Click on one of the 403 requests:
   - **Response headers**: look for `x-fb-debug`, `www-authenticate`,
     anything indicating the rejection reason.
   - **Request headers**: is `Referer` present? Is `Origin` present?
     Are FB cookies (`c_user`, `xs`, `datr`) being sent?
   - Copy the failing URL with **Copy → Copy as cURL** and try it from a
     terminal. Compare against pasting the same URL into a new browser
     tab.

2. **Right-click an `<img>` element in the feed → "Save image as…"** in
   the same browser session. If that works but the scripted fetch
   doesn't, the issue is fetch-context (referer / cookie / header
   policy), not URL expiry.

3. **Time-of-extraction vs time-of-fetch test**. Run **Export Loaded
   Now** with only a handful of posts visible. Photo URLs are extracted
   and fetched within seconds of each other. If those succeed where Full
   Scan fails, the URLs are expiring during the long scan.

4. **Compare against the previous successful run** (16:38, produced a
   3.3 MB zip). Same userscript, same browser, same group — what
   changed? Tampermonkey update, Chrome update, FB session age, group
   privacy settings, the posts the run hit this time being older?

## Likely fixes (not applied in this session)

In rough order of likelihood, the fixes that would address each diagnosis:

- **For URL expiry during long scans**: fetch each post's photos
  immediately after extraction (during `scanCurrentPosts`), instead of
  batching at the end in `buildPhotoZip`. URLs are then at most seconds
  old at fetch time. Cost: more memory pressure, parallel network
  pressure during scan.

- **For referer/origin issues**: pass `headers: { Referer:
  'https://www.facebook.com/' }` to `GM_xmlhttpRequest`, and add
  `// @grant GM.xmlHttpRequest` plus an `// @connect *.fbcdn.net`
  matching the actual CDN host being hit (`scontent.fbcdn.net`,
  `scontent-*.fbcdn.net`, etc. — currently only `fbcdn.net` is granted,
  which Tampermonkey treats as a suffix and *should* match, but worth
  verifying).

- **For `stp=`-stripping breaking the signature**: keep both the original
  URL and the upgraded URL, attempt the upgraded one first and fall back
  to the original on 403. Or stop stripping `stp=` entirely and accept
  the displayed-size variant.

- **For "ZIP arrives but is empty"**: log the failure count to the status
  line proactively (`Building photo ZIP… 9/40 fetched, 31 failed`) so
  the user notices mid-run instead of waiting silently.

## Minor unrelated finding

The hard-stop log line shows `26 posts collected (9 DOM nodes)`. That's
expected: virtualized feed entries get unmounted as you scroll past them,
so by end-of-feed only the tail ~9 are still in the DOM. The 26-post
count comes from the `collectedPosts` Map, which is the source of truth.
No action needed — flagging only because it can look alarming in the
log.
