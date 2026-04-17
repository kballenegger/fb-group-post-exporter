// ==UserScript==
// @name         FB Group Posts Export by User
// @namespace    https://github.com/kenneth-bot/klaw-workspace
// @version      4.0.0
// @description  Export posts from a Facebook group user page (/groups/<gid>/user/<uid>) as JSON + photo ZIP. URL-driven, no hardcoded IDs.
// @author       Kenneth
// @match        https://www.facebook.com/groups/*/user/*
// @grant        GM_xmlhttpRequest
// @connect      fbcdn.net
// @connect      www.facebook.com
// @connect      cdnjs.cloudflare.com
// @require      https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ═══════════════════════════════════════════════════════════════
  // ██  CONFIG
  // ═══════════════════════════════════════════════════════════════
  const CONFIG = {
    // ── Scrolling ──────────────────────────────────────────────
    SCROLL_INTERVAL_MS: 1500,
    SCROLL_STEP_PX: 1200,
    MAX_SCROLL_ATTEMPTS: 500,
    IDLE_THRESHOLD: 8,
    RETRY_BURSTS: 3,
    RETRY_BURST_WAIT_MS: 4000,

    // ── End-of-feed detection ────────────────────────────────
    EOF_CONSECUTIVE_CYCLES: 3,       // All hard-stop signals must hold for this many cycles
    EOF_TAIL_SIGNATURE_COUNT: 5,     // Number of tail post keys to track for re-observation
    EOF_BOTTOM_PROBE_COUNT: 2,       // scrollTo(bottom) probes per cycle
    EOF_HARD_STOP_IDLE_CYCLES: 5,    // Deterministic hard-stop: if N consecutive scroll cycles produce zero new posts, stop regardless of other signals

    // ── Photo download ─────────────────────────────────────────
    DOWNLOAD_PHOTOS: true,
    MAX_PHOTOS_PER_POST: 50,
    MAX_TOTAL_PHOTOS: 500,
    PHOTO_FETCH_TIMEOUT_MS: 15000,
    JSZIP_CDN: 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',

    // ── Hidden photo gallery crawl ──────────────────────────────
    GALLERY_CRAWL_ENABLED: true,
    GALLERY_CRAWL_MAX_PHOTOS_PER_POST: 50,
    GALLERY_CRAWL_TIMEOUT_MS: 10000,
    GALLERY_CRAWL_DELAY_MS: 800,
    GALLERY_CRAWL_MAX_PAGES_PER_POST: 10,

    // ── Carousel (interactive photo viewer) crawl ────────────
    CAROUSEL_CRAWL_ENABLED: false,         // Interactive viewer fallback (can lose feed state); prefer script-state extraction
    CAROUSEL_SCRIPT_EXTRACT_ENABLED: true,  // Extract carousel photos from embedded JSON state in page scripts
    CAROUSEL_CRAWL_MAX_PHOTOS: 100,        // Max images to capture per carousel session
    CAROUSEL_CRAWL_NAV_DELAY_MS: 600,      // Delay between carousel navigation steps
    CAROUSEL_CRAWL_OPEN_WAIT_MS: 1200,     // Wait for photo viewer overlay to appear after click
    CAROUSEL_CRAWL_CLOSE_WAIT_MS: 500,     // Wait after closing viewer before resuming
    CAROUSEL_CRAWL_IMAGE_READY_POLL_MS: 200,       // Polling interval when waiting for lazy-loaded image to become ready
    CAROUSEL_CRAWL_IMAGE_READY_TIMEOUT_MS: 3000,   // Max wait per slide for image src to populate
    CAROUSEL_CRAWL_MAX_CONSECUTIVE_PENDING: 3,      // Max consecutive unresolved lazy-loads before treating as failure

    DRY_RUN: false,
  };
  // ═══════════════════════════════════════════════════════════════

  /* ────────── URL parsing ────────── */

  /**
   * Parse group ID and user ID from the current URL.
   * Expected pattern: /groups/<groupId>/user/<userId>/...
   * Returns { groupId, userId } or null.
   */
  function parseIdsFromUrl(url) {
    const match = (url || window.location.href).match(
      /\/groups\/(\d+)\/user\/(\d+)/
    );
    if (!match) return null;
    return { groupId: match[1], userId: match[2] };
  }

  const PAGE_IDS = parseIdsFromUrl();
  if (!PAGE_IDS) {
    console.log('[FB-Export] Not on a /groups/<gid>/user/<uid> page. Exiting.');
    return;
  }

  const { groupId, userId } = PAGE_IDS;

  /* ────────── logging ────────── */

  function log(...args) {
    console.log('[FB-Export]', ...args);
  }
  function warn(...args) {
    console.warn('[FB-Export]', ...args);
  }

  /* ────────── URL helpers ────────── */

  function cleanUrl(raw) {
    try {
      const u = new URL(raw);
      u.search = '';
      u.hash = '';
      return u.toString();
    } catch {
      return raw;
    }
  }

  function urlPathKey(rawUrl) {
    try {
      const u = new URL(rawUrl);
      return u.origin + u.pathname;
    } catch {
      return rawUrl;
    }
  }

  /* ────────── permalink extraction ────────── */

  function extractPermalink(postEl) {
    const candidateLinks = postEl.querySelectorAll('a[href]');

    // 1. Direct /posts/ or /permalink/ link (best case)
    for (const a of candidateLinks) {
      const h = a.href;
      if (
        (h.includes('/posts/') || h.includes('/permalink/')) &&
        h.includes(groupId)
      ) {
        // Strip comment_id if present (comment links contain the post URL)
        try {
          const u = new URL(h);
          u.searchParams.delete('comment_id');
          u.searchParams.delete('reply_comment_id');
          u.search = '';
          u.hash = '';
          return u.toString();
        } catch {
          return cleanUrl(h);
        }
      }
    }

    // 2. Numeric post ID link under the group
    for (const a of candidateLinks) {
      const h = a.href;
      if (
        h.includes('/groups/' + groupId + '/') &&
        /\/\d+\/?(\?|$)/.test(h)
      ) {
        return cleanUrl(h);
      }
    }

    // 3. Photo links often contain set=gm.<postId> or set=pcb.<postId> —
    //    extract post ID. "gm" = group media (older), "pcb" = post content block
    //    (newer group layout), "a" = album.
    for (const a of candidateLinks) {
      const h = a.href || '';
      const setMatch = h.match(/set=(?:gm|pcb|a)\.(\d+)/);
      if (setMatch) {
        return `https://www.facebook.com/groups/${groupId}/posts/${setMatch[1]}/`;
      }
    }

    return null;
  }

  /* ────────── timestamp extraction ────────── */

  function extractTimestamp(postEl) {
    // 1. Classic <abbr> timestamps (older FB layout)
    const abbrEls = postEl.querySelectorAll('abbr[data-utime], abbr[title]');
    for (const el of abbrEls) {
      return el.getAttribute('title') || el.textContent.trim();
    }

    // 2. Modern FB: aria-labelledby on timestamp links → hidden <span id="...">
    //    These links often have href containing __cft__ or /posts/
    const labelledEls = postEl.querySelectorAll('a[aria-labelledby]');
    for (const el of labelledEls) {
      // Skip elements inside comments
      if (el.closest('[role="article"]')) continue;
      const labelId = el.getAttribute('aria-labelledby');
      if (!labelId) continue;
      const labelEl = document.getElementById(labelId);
      if (labelEl) {
        const text = labelEl.textContent.trim();
        if (text && text.length < 60 && /\d/.test(text)) return text;
      }
    }

    // 3. Timestamp link text (links to /posts/ or /permalink/)
    const links = postEl.querySelectorAll('a[href]');
    for (const a of links) {
      // Skip links inside comment articles
      if (a.closest('[role="article"]')) continue;
      const h = a.href || '';
      if (
        (h.includes('/posts/') || h.includes('/permalink/') || h.includes('__cft__')) &&
        (h.includes(groupId) || h.includes('__cft__'))
      ) {
        const txt = a.textContent.trim();
        if (txt.length > 0 && txt.length < 60 && /\d/.test(txt)) return txt;
      }
    }

    // 4. aria-label with date-like patterns (skip comment articles)
    const ariaEls = postEl.querySelectorAll('[aria-label]');
    for (const el of ariaEls) {
      if (el.closest('[role="article"]')) continue;
      const label = el.getAttribute('aria-label');
      if (
        label &&
        label.length < 80 &&
        /\d/.test(label) &&
        /hour|min|sec|day|week|month|year|ago|am|pm|january|february|march|april|may|june|july|august|september|october|november|december/i.test(
          label
        )
      ) {
        return label;
      }
    }
    return null;
  }

  /* ────────── "See more" expansion ────────── */

  /**
   * Localized patterns for "See more" buttons in Facebook.
   * Matches common languages: English, Spanish, French, Portuguese, German,
   * Italian, Indonesian, Vietnamese, Filipino, Thai, Arabic, Hindi, etc.
   * Also matches aria-label variants.
   */
  const SEE_MORE_PATTERNS = [
    /^see\s*more$/i,
    /^ver\s*m[aá]s$/i,
    /^voir\s*plus$/i,
    /^ver\s*mais$/i,
    /^mehr\s*ansehen$/i,
    /^vedi\s*altro$/i,
    /^lihat\s*selengkapnya$/i,
    /^xem\s*th[eê]m$/i,
    /^tingnan\s*ang\s*iba\s*pa$/i,
    /^ดูเพิ่มเติม$/,
    /^عرض المزيد$/,
    /^और\s*देखें$/,
    /^もっと見る$/,
    /^더\s*보기$/,
    /^查看更多$/,
    /^顯示更多$/,
  ];

  /**
   * Check if a text matches any known "See more" pattern.
   */
  function isSeeMoreText(text) {
    if (!text) return false;
    const trimmed = text.trim();
    return SEE_MORE_PATTERNS.some((re) => re.test(trimmed));
  }

  /**
   * Find "See more" buttons inside a post element.
   * Facebook renders these as <div role="button">, <span>, or <a> elements
   * with localized "See more" text or matching aria-label.
   */
  function findSeeMoreButtons(container) {
    const buttons = [];
    // role="button" elements and <a> tags are the most common wrappers
    const candidates = container.querySelectorAll(
      '[role="button"], a[href="#"], span[style*="cursor"]'
    );
    for (const el of candidates) {
      if (isInsideComment(el)) continue;
      // Check direct text content (avoid matching inside nested buttons)
      const text = el.textContent.trim();
      if (isSeeMoreText(text)) {
        buttons.push(el);
        continue;
      }
      // Check aria-label
      const ariaLabel = el.getAttribute('aria-label') || '';
      if (isSeeMoreText(ariaLabel)) {
        buttons.push(el);
      }
    }
    return buttons;
  }

  /**
   * Expand all collapsed "See more" text blocks inside a set of post elements.
   * Clicks each button and waits briefly for the DOM to update.
   * Idempotent: already-expanded posts won't have "See more" buttons visible.
   * Returns the number of buttons clicked.
   */
  async function expandSeeMoreInPosts(postElements) {
    let totalClicked = 0;
    for (const postEl of postElements) {
      const seeMoreBtns = findSeeMoreButtons(postEl);
      for (const btn of seeMoreBtns) {
        try {
          btn.click();
          totalClicked++;
        } catch {
          // Ignore click errors (e.g., element removed from DOM)
        }
      }
    }
    if (totalClicked > 0) {
      // Wait for DOM to update after clicking all buttons in this batch
      await sleep(600);
      extractionStats.see_more_expanded += totalClicked;
      log(`Expanded ${totalClicked} "See more" button(s).`);
    }
    return totalClicked;
  }

  /* ────────── text extraction ────────── */

  /**
   * Check if an element is inside a comment article (role="article" with
   * "Comment" aria-label) to avoid mixing comment text into post body.
   */
  function isInsideComment(el) {
    const article = el.closest('[role="article"]');
    if (!article) return false;
    const label = article.getAttribute('aria-label') || '';
    return label.startsWith('Comment');
  }

  /**
   * Extract post body text with a fallback chain:
   * 1. data-ad-preview="message" — standard text posts
   * 2. data-ad-comet-preview="message" — alternate attribute
   * 3. data-ad-rendering-role="story_message" — styled text posts (colored bg)
   * 4. div[dir="auto"] visible text blocks (>10 chars), excluding comments
   * 5. data-ad-rendering-role="title" — link-share titles as last resort
   */
  function extractText(postEl) {
    // 1–2. Standard message containers
    const msgEl =
      postEl.querySelector('[data-ad-preview="message"]') ||
      postEl.querySelector('[data-ad-comet-preview="message"]');
    if (msgEl && !isInsideComment(msgEl)) {
      const t = msgEl.innerText.trim();
      if (t) return t;
    }

    // 3. Styled text posts (data-ad-rendering-role="story_message")
    const storyMsgEl = postEl.querySelector('[data-ad-rendering-role="story_message"]');
    if (storyMsgEl && !isInsideComment(storyMsgEl)) {
      const t = storyMsgEl.innerText.trim();
      if (t) return t;
    }

    // 4. Fallback: div[dir="auto"] blocks not inside comments
    const candidates = postEl.querySelectorAll('div[dir="auto"]');
    const texts = [];
    for (const c of candidates) {
      if (isInsideComment(c)) continue;
      // Skip elements that are part of the author name / header area
      if (c.closest('h2, h3, h4')) continue;
      const t = c.innerText.trim();
      if (t.length > 10) texts.push(t);
    }
    if (texts.length > 0) return [...new Set(texts)].join('\n\n');

    // 5. Link-share title (e.g. shared article headline)
    const titleEl = postEl.querySelector('[data-ad-rendering-role="title"]');
    if (titleEl && !isInsideComment(titleEl)) {
      const t = titleEl.innerText.trim();
      if (t) return t;
    }

    return '';
  }

  /* ────────── photo URL extraction (robust) ────────── */

  function isFbCdnUrl(url) {
    return url && (url.includes('scontent') || url.includes('fbcdn'));
  }

  /**
   * Check if a URL path indicates a content photo (not avatar/profile).
   * Avatar paths contain segments like t39.30808-1, t1.6435-1 (suffix -1).
   * Content photos use -6 or -9 suffixes, or don't match the avatar pattern.
   */
  function isAvatarUrl(url) {
    if (!url) return false;
    // Profile/avatar images end with -1 in the type segment (e.g. t39.30808-1, t1.6435-1)
    if (/\/v\/t\d+\.\d+-1\//.test(url)) return true;
    // Default avatar placeholders
    if (url.includes('t1.30497-1')) return true;
    return false;
  }

  function isStaticAssetUrl(url) {
    if (!url) return false;
    return url.includes('static.xx.fbcdn.net/rsrc.php') || url.startsWith('data:');
  }

  /**
   * Upgrade a thumbnail URL to higher quality by stripping or replacing
   * the stp (size/transform) parameter.
   */
  function upgradeToHighRes(url) {
    if (!url) return url;
    try {
      const u = new URL(url);
      const stp = u.searchParams.get('stp');
      if (stp && /[ps]\d+x\d+|cp\d|fb\d+/.test(stp)) {
        // Remove the size constraint to get original resolution
        u.searchParams.delete('stp');
        return u.toString();
      }
      return url;
    } catch {
      return url;
    }
  }

  /**
   * Check if a URL is a Facebook styled-text-post background pattern
   * (decorative, not user content). These use type segment like t39.10873-6.
   */
  function isDecorativeBackground(url) {
    if (!url) return false;
    return /\/v\/t\d+\.10873-\d+\//.test(url);
  }

  /**
   * Extract high-quality photo URLs from a post element.
   *
   * Strategy:
   * 1. img[data-imgperflogname="feedImage"] — primary feed images
   * 2. Photo gallery anchors (href containing /photo/?fbid=...&set=gm.) → inner img
   * 3. All remaining <img> with scontent/fbcdn src, excluding avatars/icons
   * 4. srcset and data-src attributes (lazy-loaded images)
   * 5. Background images on elements (excluding decorative post backgrounds)
   *
   * Excludes: avatars (SVG <image>), profileCoverPhoto, reaction icons,
   *           static assets, tiny images (<=50px), comment images,
   *           decorative styled-text backgrounds.
   */
  function extractPhotos(postEl) {
    const seen = new Set();
    const urls = [];

    function add(url) {
      if (!url || !isFbCdnUrl(url)) return;
      if (isAvatarUrl(url) || isStaticAssetUrl(url)) return;
      if (isDecorativeBackground(url)) return;
      const upgraded = upgradeToHighRes(url);
      const key = urlPathKey(upgraded);
      if (seen.has(key)) return;
      seen.add(key);
      urls.push(upgraded);
    }

    // 1. Primary feed images — most reliable signal (skip if inside comments)
    const feedImgs = postEl.querySelectorAll('img[data-imgperflogname="feedImage"]');
    for (const img of feedImgs) {
      if (isInsideComment(img)) continue;
      add(img.src);
      // Also check srcset for higher-res versions
      const srcset = img.getAttribute('srcset');
      if (srcset) {
        const highRes = parseBestSrcset(srcset);
        if (highRes) add(highRes);
      }
    }

    // 2. Photo gallery links (multi-photo posts with thumbnails)
    const photoAnchors = postEl.querySelectorAll('a[href*="/photo/"]');
    for (const a of photoAnchors) {
      if (isInsideComment(a)) continue;
      const href = a.href || '';
      if (!href.includes('fbid=')) continue;
      const img = a.querySelector('img');
      if (img && img.src && isFbCdnUrl(img.src)) {
        add(img.src);
      }
    }

    // 3. Remaining <img> with CDN src — catch anything missed above
    const allImgs = postEl.querySelectorAll('img');
    for (const img of allImgs) {
      if (isInsideComment(img)) continue;

      const perfLog = img.getAttribute('data-imgperflogname') || '';
      if (perfLog === 'profileCoverPhoto') continue;
      if (img.getAttribute('draggable') === 'false') continue;
      if (img.getAttribute('role') === 'presentation') continue;

      const src = img.src || '';
      if (isStaticAssetUrl(src)) continue;
      if (!isFbCdnUrl(src)) continue;
      if (isAvatarUrl(src)) continue;

      const w = img.naturalWidth || parseInt(img.getAttribute('width'), 10) || 0;
      const h = img.naturalHeight || parseInt(img.getAttribute('height'), 10) || 0;
      if ((w > 0 && w <= 50) || (h > 0 && h <= 50)) continue;

      add(src);

      // 4. Check srcset and data-src for lazy-loaded higher-res
      const srcset = img.getAttribute('srcset');
      if (srcset) {
        const highRes = parseBestSrcset(srcset);
        if (highRes) add(highRes);
      }
      const dataSrc = img.getAttribute('data-src');
      if (dataSrc) add(dataSrc);
    }

    // 5. Background images (excluding decorative post style backgrounds)
    const bgEls = postEl.querySelectorAll('[style*="background-image"]');
    for (const el of bgEls) {
      if (isInsideComment(el)) continue;
      const style = el.getAttribute('style') || '';
      const match = style.match(
        /url\(["']?(https:\/\/[^"')]+(?:scontent|fbcdn)[^"')]+)["']?\)/
      );
      if (match && !isAvatarUrl(match[1]) && !isDecorativeBackground(match[1])) {
        add(match[1]);
      }
    }

    return urls;
  }

  /**
   * Parse a srcset attribute and return the highest-resolution CDN URL.
   */
  function parseBestSrcset(srcset) {
    if (!srcset) return null;
    let best = null;
    let bestW = 0;
    for (const entry of srcset.split(',')) {
      const parts = entry.trim().split(/\s+/);
      if (parts.length < 1) continue;
      const url = parts[0];
      if (!isFbCdnUrl(url)) continue;
      const wMatch = (parts[1] || '').match(/(\d+)w/);
      const w = wMatch ? parseInt(wMatch[1], 10) : 0;
      if (w > bestW || !best) {
        best = url;
        bestW = w;
      }
    }
    return best;
  }

  /* ────────── hidden photo gallery crawl ────────── */

  /**
   * Extract gallery entry-point links from a post element.
   * Looks for:
   * - Links with set=gm.<postId> (photo set links)
   * - Links with /photo/?fbid=... (individual photo gallery links)
   * Returns an array of { url, fbid, setId } objects.
   */
  function extractGalleryLinks(postEl) {
    const links = [];
    const seen = new Set();
    const anchors = postEl.querySelectorAll('a[href]');

    for (const a of anchors) {
      if (isInsideComment(a)) continue;
      const href = a.href || '';

      // Photo set links: /photo/?fbid=NNN&set=(gm|pcb|a).NNN
      const fbidMatch = href.match(/\/photo\/?\?fbid=(\d+)/);
      const setMatch = href.match(/set=(?:gm|pcb|a)\.(\d+)/);

      if (fbidMatch) {
        const fbid = fbidMatch[1];
        if (seen.has(fbid)) continue;
        seen.add(fbid);
        links.push({
          url: href,
          fbid,
          setId: setMatch ? setMatch[1] : null,
        });
      }
    }
    return links;
  }

  /**
   * Fetch a Facebook page via GM_xmlhttpRequest and return the HTML text.
   * Returns null if the fetch fails or is blocked.
   */
  function fetchFacebookPage(url) {
    return new Promise((resolve) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        headers: {
          'Accept': 'text/html,application/xhtml+xml',
        },
        timeout: CONFIG.GALLERY_CRAWL_TIMEOUT_MS,
        onload: (resp) => {
          if (resp.status >= 200 && resp.status < 300) {
            resolve(resp.responseText || null);
          } else {
            warn(`Gallery fetch HTTP ${resp.status} for ${url}`);
            resolve(null);
          }
        },
        onerror: () => {
          warn(`Gallery fetch network error for ${url}`);
          resolve(null);
        },
        ontimeout: () => {
          warn(`Gallery fetch timeout for ${url}`);
          resolve(null);
        },
      });
    });
  }

  /**
   * Parse high-resolution photo URLs from a Facebook photo gallery page HTML.
   * Facebook embeds image data in multiple ways:
   * 1. JSON data in scripts containing "image" objects with "uri" fields
   * 2. og:image meta tags
   * 3. Direct img tags with scontent/fbcdn URLs
   * Also extracts "next photo" links for pagination through the gallery set.
   */
  function parseGalleryPagePhotos(html) {
    const photos = [];
    const nextLinks = [];

    if (!html) return { photos, nextLinks };

    // Strategy 1: Extract high-res URIs from embedded JSON data
    // Facebook embeds photo data in script tags as JSON with patterns like
    // "image":{"uri":"https://scontent-..."}
    const uriPattern = /"(?:image|large_share_image|full_image|photo_image)":\s*\{\s*"uri"\s*:\s*"(https:\/\/[^"]*(?:scontent|fbcdn)[^"]*)"/g;
    let match;
    while ((match = uriPattern.exec(html)) !== null) {
      const url = match[1].replace(/\\\//g, '/');
      if (isFbCdnUrl(url) && !isAvatarUrl(url) && !isDecorativeBackground(url)) {
        photos.push(url);
      }
    }

    // Strategy 2: og:image meta tag (usually has the displayed photo)
    const ogMatch = html.match(/property="og:image"\s+content="([^"]+)"/);
    if (ogMatch) {
      const url = ogMatch[1].replace(/&amp;/g, '&');
      if (isFbCdnUrl(url)) {
        photos.push(url);
      }
    }

    // Strategy 3: data-src or src attributes on large images in the HTML
    const imgPattern = /(?:data-src|src)="(https:\/\/[^"]*(?:scontent|fbcdn)[^"]*)"/g;
    while ((match = imgPattern.exec(html)) !== null) {
      const url = match[1].replace(/&amp;/g, '&');
      if (isFbCdnUrl(url) && !isAvatarUrl(url) && !isStaticAssetUrl(url) && !isDecorativeBackground(url)) {
        photos.push(url);
      }
    }

    // Extract "next" photo links in the same set for pagination
    // Pattern: /photo/?fbid=NNN&set=(gm|pcb|a).NNN (different fbid than current)
    const nextPattern = /href="(\/photo\/?\?fbid=\d+[^"]*set=(?:gm|pcb|a)\.\d+[^"]*)"/g;
    while ((match = nextPattern.exec(html)) !== null) {
      let href = match[1].replace(/&amp;/g, '&');
      if (!href.startsWith('http')) {
        href = 'https://www.facebook.com' + href;
      }
      nextLinks.push(href);
    }

    return { photos, nextLinks };
  }

  /**
   * Resolve hidden photos for a post by crawling its photo gallery links.
   * Fetches gallery pages, extracts high-res photo URLs, and follows
   * "next photo" links up to the configured depth/page limits.
   *
   * Returns an array of newly discovered photo URLs (not in existingUrls).
   */
  async function resolveHiddenPhotos(postEl, existingUrls) {
    if (!CONFIG.GALLERY_CRAWL_ENABLED) return [];

    const galleryLinks = extractGalleryLinks(postEl);
    if (galleryLinks.length === 0) return [];

    const existingKeys = new Set(existingUrls.map(urlPathKey));
    const discoveredUrls = [];
    const visitedPages = new Set();
    const pagesToVisit = [];

    // Seed with the gallery entry points we found in the DOM
    for (const link of galleryLinks) {
      if (!visitedPages.has(link.url)) {
        pagesToVisit.push(link.url);
      }
    }

    let pagesVisited = 0;

    while (pagesToVisit.length > 0 && pagesVisited < CONFIG.GALLERY_CRAWL_MAX_PAGES_PER_POST) {
      const pageUrl = pagesToVisit.shift();
      if (visitedPages.has(pageUrl)) continue;
      visitedPages.add(pageUrl);
      pagesVisited++;

      // Rate limit
      if (pagesVisited > 1) {
        await sleep(CONFIG.GALLERY_CRAWL_DELAY_MS);
      }

      const html = await fetchFacebookPage(pageUrl);
      if (!html) {
        extractionStats.hidden_photo_fetch_failures++;
        continue;
      }

      const { photos, nextLinks } = parseGalleryPagePhotos(html);

      for (const photoUrl of photos) {
        const upgraded = upgradeToHighRes(photoUrl);
        const key = urlPathKey(upgraded);
        if (!existingKeys.has(key)) {
          existingKeys.add(key);
          discoveredUrls.push(upgraded);
          extractionStats.hidden_photos_discovered++;
        }
      }

      // Queue next photo links for traversal (within limits)
      if (discoveredUrls.length < CONFIG.GALLERY_CRAWL_MAX_PHOTOS_PER_POST) {
        for (const nextUrl of nextLinks) {
          if (!visitedPages.has(nextUrl) && !pagesToVisit.includes(nextUrl)) {
            pagesToVisit.push(nextUrl);
          }
        }
      }
    }

    if (discoveredUrls.length > 0) {
      log(`Gallery crawl discovered ${discoveredUrls.length} hidden photo(s) from ${pagesVisited} page(s).`);
    }

    return discoveredUrls.slice(0, CONFIG.GALLERY_CRAWL_MAX_PHOTOS_PER_POST);
  }

  /* ────────── carousel extraction from embedded script state ────────── */

  /**
   * Extract ALL carousel photo URLs for a post by scanning adjacent script
   * tags for the embedded JSON state. This is preferred over opening the
   * photo viewer because:
   *   - No interactive navigation required
   *   - No risk of Facebook's SPA routing destroying the feed
   *   - Captures hidden photos beyond the visible "+N" overlay
   *
   * Strategy: find the script tag containing the post ID, then pull every
   * "uri":"<scontent content-photo url>" and de-duplicate by the image's
   * middle fbid (the number between underscores in the filename).
   */
  function extractCarouselFromScripts(postEl, existingUrls) {
    const permalink = extractPermalink(postEl);
    const postIdMatch = permalink && permalink.match(/\/posts\/(\d+)/);
    const postId = postIdMatch ? postIdMatch[1] : null;
    if (!postId) return [];

    // Derive an allowed fbid prefix from the post's own visible photo
    // fbids — carousel siblings share a long common prefix because they're
    // minted sequentially. We use this to reject unrelated photos (commenter
    // avatars, link previews) that happen to live in the same script blob.
    //
    // Seeds: anchor links with fbid=, then img filenames (middle fbid),
    // then og:image-style img src fbids. Whichever yields fbids first wins.
    const seedFbids = new Set();
    for (const a of postEl.querySelectorAll('a[href*="/photo/"]')) {
      const m = (a.href || '').match(/fbid=(\d{12,18})/);
      if (m) seedFbids.add(m[1]);
    }
    if (seedFbids.size === 0) {
      for (const img of postEl.querySelectorAll('img[src*="scontent"], img[src*="fbcdn"]')) {
        const src = img.src || '';
        if (!/\/t\d+\.6435-\d+\//.test(src) && !/\/t\d+\.1997-\d+\//.test(src)) continue;
        const m = src.match(/\/[^/]*?_(\d{12,18})_/);
        if (m) seedFbids.add(m[1]);
      }
    }
    if (seedFbids.size === 0) return [];
    const seedList = [...seedFbids];
    const fbidLen = seedList[0].length;
    // Longest common prefix
    let commonPrefix = seedList[0];
    for (const f of seedList.slice(1)) {
      if (f.length !== fbidLen) { commonPrefix = ''; break; }
      let i = 0;
      while (i < commonPrefix.length && commonPrefix[i] === f[i]) i++;
      commonPrefix = commonPrefix.slice(0, i);
    }
    // Require at least 8 shared leading digits; otherwise bail (mixed bag)
    if (commonPrefix.length < 8) return [];

    const existingKeys = new Set(existingUrls.map(urlPathKey));
    const urisByFbid = new Map(); // middle-fbid → best URL (prefer non-thumbnail)

    // Walk all script tags; FB embeds state as serialized JSON inside them.
    for (const s of document.querySelectorAll('script')) {
      const txt = s.textContent || '';
      if (!txt.includes(postId)) continue;

      const uriPattern = /"uri":"(https:\\?\/\\?\/scontent[^"]+)"/g;
      let m;
      while ((m = uriPattern.exec(txt)) !== null) {
        let url = m[1].replace(/\\\//g, '/').replace(/\\u0026/g, '&');
        // Keep only content photos, reject avatars/static/decorative
        if (!isFbCdnUrl(url)) continue;
        if (isAvatarUrl(url) || isStaticAssetUrl(url)) continue;
        if (isDecorativeBackground(url)) continue;
        // Content photos live under t1.6435-* (group photos) or t39.1997-* (page photos)
        // Avatars use t39.30808-1 / t1.30497-1 which are already caught by isAvatarUrl.
        if (!/\/t\d+\.\d+-\d+\//.test(url)) continue;

        // Extract middle fbid from filename: <something>_<fbid>_<something>.ext
        const fb = (url.match(/\/[^/]*?_(\d{12,18})_[^/]*?\.(?:jpg|jpeg|png|webp|gif)/i) || [])[1];
        if (!fb) continue;
        // Must share a long prefix with the post's visible photo fbids —
        // carousel sibling fbids are allocated sequentially so they always
        // match within the first 8+ digits. This rejects unrelated photos
        // (commenter avatars, link preview thumbnails) that are bundled in
        // the same script state.
        if (fb.length !== fbidLen || !fb.startsWith(commonPrefix)) continue;

        const isThumb = /stp=(?:dst-jpg|cp0_dst-jpg|c\d+\.\d+\.\d+\.\d+)/i.test(url);
        const upgraded = upgradeToHighRes(url);

        if (!urisByFbid.has(fb)) {
          urisByFbid.set(fb, { url: upgraded, thumb: isThumb });
        } else if (urisByFbid.get(fb).thumb && !isThumb) {
          urisByFbid.set(fb, { url: upgraded, thumb: false });
        }
      }
    }

    const discovered = [];
    for (const [, entry] of urisByFbid) {
      const key = urlPathKey(entry.url);
      if (existingKeys.has(key)) continue;
      existingKeys.add(key);
      discovered.push(entry.url);
    }
    return discovered;
  }

  /* ────────── carousel (interactive photo viewer) crawl ────────── */

  /**
   * Detect the photo viewer overlay in the DOM.
   * Facebook renders the photo viewer as an overlay with role="dialog" or
   * a full-viewport container with a large image. We look for multiple
   * signals to stay resilient to DOM changes:
   * 1. role="dialog" containing a large fbcdn img
   * 2. A fixed/absolute overlay container with a large fbcdn img
   * 3. Any ancestor with [data-pagelet="MediaViewerPhoto"] or similar
   */
  function findPhotoViewerOverlay() {
    // Strategy 1: role="dialog" with a large image inside
    const dialogs = document.querySelectorAll('[role="dialog"]');
    for (const d of dialogs) {
      const img = d.querySelector('img[src*="scontent"], img[src*="fbcdn"]');
      if (img) return { container: d, img };
    }

    // Strategy 2: data-pagelet containing "Media" or "Photo"
    const pagelets = document.querySelectorAll('[data-pagelet*="Media"], [data-pagelet*="Photo"]');
    for (const p of pagelets) {
      const img = p.querySelector('img[src*="scontent"], img[src*="fbcdn"]');
      if (img) return { container: p, img };
    }

    // Strategy 3: any fixed/absolute positioned large container with a big image
    const allImgs = document.querySelectorAll('img[src*="scontent"], img[src*="fbcdn"]');
    for (const img of allImgs) {
      const w = img.naturalWidth || parseInt(img.getAttribute('width'), 10) || 0;
      const h = img.naturalHeight || parseInt(img.getAttribute('height'), 10) || 0;
      if (w > 400 || h > 400) {
        const parent = img.closest('[style*="position: fixed"], [style*="position:fixed"], [style*="position: absolute"]');
        if (parent) return { container: parent, img };
      }
    }

    return null;
  }

  /**
   * Extract the high-res image URL from the currently displayed photo viewer.
   */
  function extractViewerImageUrl() {
    const viewer = findPhotoViewerOverlay();
    if (!viewer) return null;

    const img = viewer.img;
    let bestUrl = img.src;

    // Check srcset for even higher-res
    const srcset = img.getAttribute('srcset');
    if (srcset) {
      const highRes = parseBestSrcset(srcset);
      if (highRes) bestUrl = highRes;
    }

    if (bestUrl && isFbCdnUrl(bestUrl) && !isAvatarUrl(bestUrl)) {
      return upgradeToHighRes(bestUrl);
    }
    return null;
  }

  /**
   * Wait for the currently displayed viewer image to become ready (non-empty,
   * high-res src). Handles lazy-loading where src/srcset may not be populated
   * immediately after navigation.
   *
   * @returns {{ url: string|null, waited_ms: number, timed_out: boolean }}
   */
  async function waitForImageReady() {
    const pollMs = CONFIG.CAROUSEL_CRAWL_IMAGE_READY_POLL_MS;
    const timeoutMs = CONFIG.CAROUSEL_CRAWL_IMAGE_READY_TIMEOUT_MS;
    let elapsed = 0;

    // First check — image might already be ready
    let url = extractViewerImageUrl();
    if (url) return { url, waited_ms: 0, timed_out: false };

    // Poll until ready or timeout
    while (elapsed < timeoutMs) {
      await sleep(pollMs);
      elapsed += pollMs;
      url = extractViewerImageUrl();
      if (url) {
        log(`Carousel: image became ready after ${elapsed}ms wait.`);
        return { url, waited_ms: elapsed, timed_out: false };
      }
    }

    log(`Carousel: image not ready after ${timeoutMs}ms, treating as pending.`);
    return { url: null, waited_ms: elapsed, timed_out: true };
  }

  /**
   * SVG path fingerprint for Facebook's carousel "next" arrow.
   * The path data starts with this prefix — used to positively identify
   * the correct next-image control inside the photo viewer overlay.
   */
  const NEXT_ARROW_PATH_PREFIX = 'M8.116 3.116a1.25 1.25 0 0 1 1.768 0';

  /**
   * Check if an element is visible, enabled, and interactable.
   */
  function isVisibleAndEnabled(el) {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    return true;
  }

  /**
   * Find the "next" navigation element in the photo viewer.
   *
   * SCOPED: only searches inside the active lightbox/dialog container.
   * Never returns generic page links or anchors outside the viewer.
   *
   * Strategy chain (most specific → least):
   * 1. SVG path fingerprint — match descendant svg > path whose d attribute
   *    starts with the known next-arrow prefix, then climb to clickable ancestor.
   * 2. Position-based — right-side role="button" with SVG, inside viewer,
   *    vertically centered.
   * 3. Aria-label fallback — multi-language "next" patterns.
   *
   * All candidates must be visible, enabled, and inside the viewer container.
   *
   * Returns { btn, strategy } or null.
   */
  function findNextButton() {
    const viewer = findPhotoViewerOverlay();
    if (!viewer) return null;
    const container = viewer.container;
    carouselDebug.next_selector_attempts++;

    // ── Strategy 1: SVG path fingerprint (most reliable) ──
    const allPaths = container.querySelectorAll('svg path[d]');
    for (const pathEl of allPaths) {
      const d = pathEl.getAttribute('d') || '';
      if (d.startsWith(NEXT_ARROW_PATH_PREFIX)) {
        // Climb from <path> → <svg> → clickable ancestor (button/[role="button"]/a)
        let candidate = pathEl.closest('[role="button"], button, a');
        if (!candidate) {
          // Try the SVG's parent chain
          candidate = pathEl.closest('svg');
          if (candidate) candidate = candidate.closest('[role="button"], button, a');
        }
        if (candidate && container.contains(candidate) && isVisibleAndEnabled(candidate)) {
          log('Carousel next: found via SVG path fingerprint.');
          return { btn: candidate, strategy: 'svg_path_fingerprint' };
        }
        carouselDebug.rejected_next_candidates++;
      }
    }

    // ── Strategy 2: viewBox="0 0 24 24" SVGs inside right-side buttons ──
    const buttons = container.querySelectorAll('[role="button"], button');
    const viewerRect = container.getBoundingClientRect();
    const midX = viewerRect.left + viewerRect.width / 2;
    const midY = viewerRect.top + viewerRect.height / 2;

    const rightButtons = [];
    for (const btn of buttons) {
      if (!container.contains(btn)) continue;
      if (!isVisibleAndEnabled(btn)) { carouselDebug.rejected_next_candidates++; continue; }
      const svg = btn.querySelector('svg[viewBox="0 0 24 24"]') || btn.querySelector('svg');
      if (!svg) continue;
      const btnRect = btn.getBoundingClientRect();
      // Must be in right half, vertically near center, reasonable icon size
      if (btnRect.left > midX && btnRect.height < 100 && btnRect.width < 100) {
        const distFromCenter = Math.abs((btnRect.top + btnRect.height / 2) - midY);
        rightButtons.push({ btn, distFromCenter });
      } else {
        carouselDebug.rejected_next_candidates++;
      }
    }

    if (rightButtons.length > 0) {
      rightButtons.sort((a, b) => a.distFromCenter - b.distFromCenter);
      log(`Carousel next: found via position (right-side, ${rightButtons.length} candidates).`);
      return { btn: rightButtons[0].btn, strategy: 'position_right_side' };
    }

    // ── Strategy 3: aria-label fallback (multi-language next patterns) ──
    const nextPatterns = /^(next|siguiente|suivant|n[äa]chste|avanti|berikutnya|tiếp|ถัดไป|التالي|अगला|次|다음|下一[个張]|next photo)$/i;
    for (const btn of buttons) {
      if (!container.contains(btn)) continue;
      if (!isVisibleAndEnabled(btn)) { carouselDebug.rejected_next_candidates++; continue; }
      const label = btn.getAttribute('aria-label') || '';
      if (nextPatterns.test(label.trim())) {
        log(`Carousel next: found via aria-label="${label.trim()}".`);
        return { btn, strategy: 'aria_label' };
      }
    }

    log('Carousel next: no valid next button found in viewer.');
    return null;
  }

  /**
   * Navigate to the next photo in the viewer.
   * Tries clicking the viewer-scoped next button first, then falls back
   * to keyboard "j" (FB shortcut). Never clicks links outside the viewer.
   *
   * Returns { clicked: true/false, strategy: string } for validation logging.
   */
  function navigateToNextPhoto() {
    const result = findNextButton();
    if (result) {
      result.btn.click();
      carouselDebug.next_clicks++;
      return { clicked: true, strategy: result.strategy };
    }

    // Fallback: dispatch "j" key event (FB keyboard shortcut for next photo)
    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'j', code: 'KeyJ', keyCode: 74, which: 74, bubbles: true,
    }));
    carouselDebug.next_clicks++;
    return { clicked: true, strategy: 'keyboard_j' };
  }

  /**
   * Close the photo viewer overlay.
   * Tries multiple strategies (resilient to localized labels):
   * 1. Press Escape key (universal keyboard shortcut)
   * 2. Click close/back button by position (top-left/top-right SVG buttons)
   * 3. Click elements with common close aria-labels (multi-language)
   */
  function closePhotoViewer() {
    // Strategy 1: Escape key (most reliable, works across all locales)
    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true,
    }));

    // Strategy 2: find a close button by position (top-left or top-right
    // corner of the viewer, with an SVG icon — avoids locale-dependent labels)
    const viewer = findPhotoViewerOverlay();
    if (viewer) {
      const container = viewer.container;
      const rect = container.getBoundingClientRect();
      const buttons = container.querySelectorAll('[role="button"]');
      for (const btn of buttons) {
        const svg = btn.querySelector('svg');
        if (!svg) continue;
        const btnRect = btn.getBoundingClientRect();
        // Close buttons are typically in the top-left or top-right corner
        const inTopStrip = btnRect.top - rect.top < 80;
        const inCorner = (btnRect.left - rect.left < 80) || (rect.right - btnRect.right < 80);
        if (inTopStrip && inCorner && btnRect.width < 60 && btnRect.height < 60) {
          try { btn.click(); } catch { /* ignore */ }
          return;
        }
      }

      // Strategy 3: aria-label patterns for close/back (multi-language)
      const closePatterns = /^(close|back|cerrar|volver|fermer|retour|schlie[ßs]en|zur[üu]ck|chiudi|indietro|tutup|kembali|đóng|quay lại|ปิด|إغلاق|बंद|閉じる|닫기|关闭|關閉)$/i;
      const allBtns = container.querySelectorAll('[role="button"][aria-label], [aria-label]');
      for (const btn of allBtns) {
        const label = btn.getAttribute('aria-label') || '';
        if (closePatterns.test(label.trim())) {
          try { btn.click(); } catch { /* ignore */ }
          return;
        }
      }
    }
  }

  /**
   * Crawl the carousel for a post by opening its first photo,
   * then navigating through all photos in the viewer.
   *
   * @param {Element} postEl - the post DOM element
   * @param {string[]} existingUrls - already-known photo URLs for dedup
   * @returns {string[]} newly discovered photo URLs
   */
  async function crawlCarousel(postEl, existingUrls) {
    if (!CONFIG.CAROUSEL_CRAWL_ENABLED) return [];

    // Find a clickable photo link in the post
    const photoLink = postEl.querySelector('a[href*="/photo/"]');
    if (!photoLink) return [];

    const existingKeys = new Set(existingUrls.map(urlPathKey));
    const discoveredUrls = [];
    const seenKeys = new Set();
    const navLog = []; // per-step validation log

    // Remember scroll position to restore after
    const savedScrollY = window.scrollY;

    try {
      // Scroll the photo link into view and click it
      photoLink.scrollIntoView({ block: 'center', behavior: 'instant' });
      await sleep(200);
      photoLink.click();
      await sleep(CONFIG.CAROUSEL_CRAWL_OPEN_WAIT_MS);

      // Verify the viewer opened
      if (!findPhotoViewerOverlay()) {
        log('Carousel: viewer did not open, skipping.');
        extractionStats.carousel_errors++;
        return [];
      }

      extractionStats.carousel_posts_crawled++;

      // Capture first image (starting image for loop detection)
      // Use readiness wait to handle lazy-loaded first frame
      const firstReady = await waitForImageReady();
      carouselDebug.image_ready_wait_ms_total += firstReady.waited_ms;
      if (firstReady.timed_out) carouselDebug.image_ready_timeouts++;
      const firstUrl = firstReady.url;
      const startingKey = firstUrl ? urlPathKey(firstUrl) : null;
      if (firstUrl) {
        seenKeys.add(startingKey);
        carouselDebug.carousel_images_collected++;
        if (!existingKeys.has(startingKey)) {
          discoveredUrls.push(firstUrl);
          extractionStats.carousel_photos_captured++;
        }
      }

      // Navigate through carousel
      let steps = 0;
      let consecutiveNextMissing = 0; // next control missing/disabled counter
      let consecutivePending = 0;     // consecutive lazy-load timeouts
      let maxConsecutivePending = 0;  // high-water mark for debug
      const MAX_NEXT_MISSING = 3;     // stop after N checks with no next control

      while (steps < CONFIG.CAROUSEL_CRAWL_MAX_PHOTOS) {
        // Attempt navigation — returns strategy info for validation
        const navResult = navigateToNextPhoto();
        extractionStats.carousel_nav_steps++;
        steps++;

        // Track strategy usage
        if (navResult.strategy) {
          carouselDebug.strategies_used[navResult.strategy] =
            (carouselDebug.strategies_used[navResult.strategy] || 0) + 1;
        }

        // Validation log entry
        const stepLog = {
          step: steps,
          strategy: navResult.strategy,
          viewer_scoped: navResult.strategy !== 'keyboard_j',
        };

        await sleep(CONFIG.CAROUSEL_CRAWL_NAV_DELAY_MS);

        // Stop condition: next control missing/disabled for N checks
        if (navResult.strategy === 'keyboard_j') {
          // keyboard_j is a blind fallback — count as "next missing"
          consecutiveNextMissing++;
          if (consecutiveNextMissing >= MAX_NEXT_MISSING) {
            log(`Carousel: next control missing/fallback for ${MAX_NEXT_MISSING} consecutive steps, stopping.`);
            extractionStats.carousel_next_missing_stops++;
            stepLog.stop_reason = 'next_control_missing';
            navLog.push(stepLog);
            break;
          }
        } else {
          consecutiveNextMissing = 0;
        }

        // Check if viewer is still open (may have closed at end of gallery)
        if (!findPhotoViewerOverlay()) {
          log(`Carousel: viewer closed after ${steps} steps (end of gallery).`);
          extractionStats.carousel_viewer_closed_naturally++;
          stepLog.stop_reason = 'viewer_closed';
          navLog.push(stepLog);
          break;
        }

        // Wait for image readiness (handles lazy-loading)
        const readyResult = await waitForImageReady();
        carouselDebug.image_ready_wait_ms_total += readyResult.waited_ms;
        stepLog.image_ready_wait_ms = readyResult.waited_ms;

        const currentUrl = readyResult.url;
        stepLog.image_captured = !!currentUrl;

        if (!currentUrl) {
          // Image still not ready after timeout — track as pending
          carouselDebug.image_ready_timeouts++;
          consecutivePending++;
          if (consecutivePending > maxConsecutivePending) {
            maxConsecutivePending = consecutivePending;
          }
          stepLog.pending = true;
          navLog.push(stepLog);

          // Only stop after exceeding consecutive pending threshold
          if (consecutivePending >= CONFIG.CAROUSEL_CRAWL_MAX_CONSECUTIVE_PENDING) {
            log(`Carousel: ${consecutivePending} consecutive images not ready (lazy-load timeout), stopping.`);
            extractionStats.carousel_lazy_load_stops =
              (extractionStats.carousel_lazy_load_stops || 0) + 1;
            stepLog.stop_reason = 'consecutive_pending_exceeded';
            break;
          }
          // Do NOT stop — allow more attempts
          continue;
        }

        // Image resolved — reset pending counter (and track recovery)
        if (consecutivePending > 0) {
          carouselDebug.recovered_after_pending++;
          log(`Carousel: recovered after ${consecutivePending} pending frame(s).`);
        }
        consecutivePending = 0;

        const currentKey = urlPathKey(currentUrl);

        // Stop condition: loop detected — image URL returns to already-seen image
        if (seenKeys.has(currentKey)) {
          // Immediate stop on loop back to starting image
          if (currentKey === startingKey) {
            log(`Carousel: loop complete — returned to starting image after ${steps} steps (${seenKeys.size} unique images).`);
            extractionStats.carousel_loop_detected++;
            carouselDebug.loop_detected++;
            stepLog.stop_reason = 'loop_to_start';
            navLog.push(stepLog);
            break;
          }
          // Seen a non-starting duplicate — likely navigated backwards or FB glitch
          // Allow one more try before stopping
          stepLog.duplicate = true;
          navLog.push(stepLog);
          // Check one more step to confirm it's a real loop
          const nextNavResult = navigateToNextPhoto();
          extractionStats.carousel_nav_steps++;
          steps++;
          await sleep(CONFIG.CAROUSEL_CRAWL_NAV_DELAY_MS);
          const retryReady = await waitForImageReady();
          carouselDebug.image_ready_wait_ms_total += retryReady.waited_ms;
          if (retryReady.timed_out) carouselDebug.image_ready_timeouts++;
          const retryUrl = retryReady.url;
          const retryKey = retryUrl ? urlPathKey(retryUrl) : null;
          if (!retryUrl || seenKeys.has(retryKey)) {
            log(`Carousel: loop confirmed after ${steps} steps (${seenKeys.size} unique images).`);
            extractionStats.carousel_loop_detected++;
            carouselDebug.loop_detected++;
            break;
          }
          // False alarm — continue with the new image
          seenKeys.add(retryKey);
          carouselDebug.carousel_images_collected++;
          if (!existingKeys.has(retryKey)) {
            existingKeys.add(retryKey);
            discoveredUrls.push(retryUrl);
            extractionStats.carousel_photos_captured++;
          }
          continue;
        }

        seenKeys.add(currentKey);
        carouselDebug.carousel_images_collected++;
        navLog.push(stepLog);

        if (!existingKeys.has(currentKey)) {
          existingKeys.add(currentKey);
          discoveredUrls.push(currentUrl);
          extractionStats.carousel_photos_captured++;
        }
      }

      // Update high-water mark for consecutive pending
      if (maxConsecutivePending > 0) {
        carouselDebug.consecutive_pending_hits = Math.max(
          carouselDebug.consecutive_pending_hits || 0,
          maxConsecutivePending
        );
      }

      // Stop condition: max step cap
      if (steps >= CONFIG.CAROUSEL_CRAWL_MAX_PHOTOS) {
        log(`Carousel: hit max photo cap (${CONFIG.CAROUSEL_CRAWL_MAX_PHOTOS}).`);
      }

      // Validation summary — proves correctness of next-button selection
      const strategyCounts = {};
      for (const entry of navLog) {
        strategyCounts[entry.strategy] = (strategyCounts[entry.strategy] || 0) + 1;
      }
      const viewerScopedClicks = navLog.filter((e) => e.viewer_scoped).length;
      const fallbackClicks = navLog.filter((e) => !e.viewer_scoped).length;
      const pendingSteps = navLog.filter((e) => e.pending).length;
      const totalWaitMs = navLog.reduce((sum, e) => sum + (e.image_ready_wait_ms || 0), 0);
      log(`Carousel validation: ${steps} steps, ${seenKeys.size} unique images, ${viewerScopedClicks} viewer-scoped clicks, ${fallbackClicks} keyboard fallbacks, ${pendingSteps} lazy-load waits (${totalWaitMs}ms total), recoveries=${carouselDebug.recovered_after_pending}, strategies=${JSON.stringify(strategyCounts)}`);

    } catch (err) {
      warn('Carousel crawl error:', err.message || err);
      extractionStats.carousel_errors++;
    } finally {
      // Close the viewer and restore scroll position
      closePhotoViewer();
      await sleep(CONFIG.CAROUSEL_CRAWL_CLOSE_WAIT_MS);
      // Double-check viewer is closed
      if (findPhotoViewerOverlay()) {
        closePhotoViewer();
        await sleep(300);
      }
      window.scrollTo(0, savedScrollY);
    }

    if (discoveredUrls.length > 0) {
      log(`Carousel crawl: ${discoveredUrls.length} new photo(s) from ${seenKeys.size} total in viewer.`);
    }

    return discoveredUrls;
  }

  /* ────────── post discovery ────────── */

  /**
   * Find post containers on /groups/<gid>/user/<uid> pages.
   *
   * Facebook uses a virtualized feed where each post lives inside a
   * div[data-virtualized="false"] container. Posts that have been scrolled
   * out may be replaced with data-virtualized="true" empty skeletons.
   *
   * Fallback: role="article" elements that are NOT comments (for older
   * layouts or non-virtualized pages).
   */
  function findPostElements() {
    // Primary: virtualized feed containers (modern FB layout)
    const virtualized = document.querySelectorAll('[data-virtualized="false"]');
    if (virtualized.length > 0) {
      return [...virtualized];
    }

    // Fallback: role="article" minus comments and loading skeletons
    const articles = document.querySelectorAll('[role="article"]');
    const posts = [];
    for (const el of articles) {
      const label = el.getAttribute('aria-label') || '';
      if (label.startsWith('Comment')) continue;
      if (label.startsWith('Loading')) continue;
      // Skip articles nested inside another article (reply threads)
      if (el.parentElement && el.parentElement.closest('[role="article"]')) continue;
      posts.push(el);
    }
    return posts;
  }

  /* ────────── collection state ────────── */

  const collectedPosts = new Map();
  const extractionStats = {
    posts_found: 0,
    posts_with_text: 0,
    posts_with_images: 0,
    total_images: 0,
    posts_with_permalink: 0,
    posts_with_timestamp: 0,
    see_more_expanded: 0,
    hidden_photos_discovered: 0,
    hidden_photo_fetch_failures: 0,
    carousel_posts_crawled: 0,
    carousel_photos_captured: 0,
    carousel_nav_steps: 0,
    carousel_errors: 0,
    carousel_loop_detected: 0,
    carousel_viewer_closed_naturally: 0,
    carousel_next_missing_stops: 0,
    carousel_lazy_load_stops: 0,
    discovery_method: 'unknown',
    end_of_feed_detected: false,
    end_of_feed_reason: '',
    scroll_hard_stop_idle_count: 0,
    scroll_hard_stop_dom_idle_count: 0,
    scroll_total_cycles: 0,
  };

  // Carousel control selection debug counters — included in validation summary
  const carouselDebug = {
    next_selector_attempts: 0,
    next_clicks: 0,
    rejected_next_candidates: 0,
    loop_detected: 0,
    carousel_images_collected: 0,
    strategies_used: {},  // { strategy_name: count }
    image_ready_wait_ms_total: 0,
    image_ready_timeouts: 0,
    consecutive_pending_hits: 0,   // high-water mark of consecutive pending frames
    recovered_after_pending: 0,
  };

  async function scanCurrentPosts() {
    const articles = findPostElements();
    extractionStats.discovery_method =
      articles.length > 0 && articles[0].hasAttribute('data-virtualized')
        ? 'data-virtualized'
        : 'role-article-fallback';

    // Expand collapsed "See more" text before extracting content
    await expandSeeMoreInPosts(articles);

    let newCount = 0;
    for (const article of articles) {
      const permalink = extractPermalink(article);
      const key = permalink || `no-link-${collectedPosts.size}-${Date.now()}`;
      if (collectedPosts.has(key)) continue;

      const text = extractText(article);
      const inlinePhotos = extractPhotos(article);
      const timestamp = extractTimestamp(article);

      // Attempt gallery crawl to discover hidden photos beyond visible thumbnails
      const hiddenPhotos = await resolveHiddenPhotos(article, inlinePhotos);

      // Extract carousel photos from embedded page state (preferred: no viewer,
      // no navigation risk). Falls back to interactive viewer crawl if disabled.
      const allKnownSoFar = [...inlinePhotos, ...hiddenPhotos];
      let carouselPhotos = [];
      if (CONFIG.CAROUSEL_SCRIPT_EXTRACT_ENABLED) {
        carouselPhotos = extractCarouselFromScripts(article, allKnownSoFar);
        if (carouselPhotos.length > 0) {
          extractionStats.carousel_posts_crawled++;
          extractionStats.carousel_photos_captured += carouselPhotos.length;
        }
      }
      if (CONFIG.CAROUSEL_CRAWL_ENABLED) {
        const viewerPhotos = await crawlCarousel(article, [...allKnownSoFar, ...carouselPhotos]);
        carouselPhotos = [...carouselPhotos, ...viewerPhotos];
      }

      // Merge inline + hidden + carousel photos, deduplicate by URL path key
      const mergedSeen = new Set();
      const photos = [];
      for (const url of [...inlinePhotos, ...hiddenPhotos, ...carouselPhotos]) {
        const key2 = urlPathKey(url);
        if (!mergedSeen.has(key2)) {
          mergedSeen.add(key2);
          photos.push(url);
        }
      }

      collectedPosts.set(key, {
        permalink: permalink || '(no permalink found)',
        timestamp: timestamp || '(no timestamp)',
        text,
        photos,
        image_urls: photos.length > 0 ? [...photos] : [],
        scraped_at: new Date().toISOString(),
      });
      newCount++;

      // Update stats
      extractionStats.posts_found = collectedPosts.size;
      if (text) extractionStats.posts_with_text++;
      if (photos.length > 0) extractionStats.posts_with_images++;
      extractionStats.total_images += photos.length;
      if (permalink) extractionStats.posts_with_permalink++;
      if (timestamp) extractionStats.posts_with_timestamp++;

      log(`Found post #${collectedPosts.size}: ${permalink || '(no link)'} [${photos.length} images (${hiddenPhotos.length} hidden, ${carouselPhotos.length} carousel), text=${text ? text.length + 'ch' : 'none'}]`);
    }
    return newCount;
  }

  /* ────────── scrolling with retry bursts ────────── */

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  /**
   * Compute a tail signature: the last N post keys joined, used to detect
   * when we keep re-observing the same tail posts across cycles.
   */
  function getTailSignature(n) {
    const keys = [...collectedPosts.keys()];
    return keys.slice(-n).join('|');
  }

  /**
   * Check if the viewport is at (or very near) the document bottom.
   */
  function isAtBottom(tolerance) {
    const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
    const viewportH = window.innerHeight;
    const docH = document.documentElement.scrollHeight;
    return scrollTop + viewportH >= docH - (tolerance || 5);
  }

  async function autoScroll(statusFn) {
    let attempts = 0;
    let idleCount = 0;
    let retryBudget = CONFIG.RETRY_BURSTS;
    let prevSize = collectedPosts.size;
    let prevHeight = document.documentElement.scrollHeight;

    // ── End-of-feed multi-signal state ──
    let eofCycleCount = 0;           // consecutive cycles where ALL hard-stop signals hold
    let prevTailSig = '';            // previous tail signature for re-observation check
    let tailSigRepeatCount = 0;      // how many times we've seen the same tail signature

    // ── Deterministic hard-stop: consecutive scroll cycles with zero new posts ──
    let zeroNewPostCycles = 0;       // increments every scroll cycle with no new unique posts
    let lastPostCount = collectedPosts.size;
    let lastDomNodeCount = findPostElements().length;  // raw DOM node count for independent tracking

    while (attempts < CONFIG.MAX_SCROLL_ATTEMPTS) {
      attempts++;
      extractionStats.scroll_total_cycles = attempts;
      window.scrollBy(0, CONFIG.SCROLL_STEP_PX);
      await sleep(CONFIG.SCROLL_INTERVAL_MS);

      await scanCurrentPosts();

      const currHeight = document.documentElement.scrollHeight;
      const currSize = collectedPosts.size;
      const heightGrew = currHeight > prevHeight;
      const postsGrew = currSize > prevSize;

      if (!heightGrew && !postsGrew) {
        idleCount++;
      } else {
        idleCount = 0;
        prevHeight = currHeight;
        prevSize = currSize;
      }

      // ── Deterministic hard-stop counter ──
      // Checks TWO independent signals per cycle:
      //   1. Zero growth in unique post keys (collectedPosts.size)
      //   2. Zero growth in raw post/article DOM nodes (findPostElements().length)
      // Both must be zero for the cycle to count as idle. This prevents
      // false positives when new DOM nodes appear (ads, spinners) without
      // being new posts, or vice versa.
      const currDomNodeCount = findPostElements().length;
      const noNewPostKeys = currSize <= lastPostCount;
      const noNewDomNodes = currDomNodeCount <= lastDomNodeCount;

      if (noNewPostKeys && noNewDomNodes) {
        zeroNewPostCycles++;
      } else {
        zeroNewPostCycles = 0;
      }
      lastPostCount = currSize;
      lastDomNodeCount = currDomNodeCount;

      if (zeroNewPostCycles >= CONFIG.EOF_HARD_STOP_IDLE_CYCLES) {
        const reason = `hard_stop_${zeroNewPostCycles}_idle_cycles_zero_dom_and_keys`;
        extractionStats.end_of_feed_detected = true;
        extractionStats.end_of_feed_reason = reason;
        extractionStats.scroll_hard_stop_idle_count = zeroNewPostCycles;
        extractionStats.scroll_hard_stop_dom_idle_count = zeroNewPostCycles;
        log(`Hard-stop: ${zeroNewPostCycles} consecutive scroll cycles with zero new post DOM nodes AND zero new unique post keys. Stopping.`);
        statusFn(`End of feed (hard-stop) — ${currSize} posts`);
        break;
      }

      statusFn(
        `Scrolling… ${currSize} posts, ${currDomNodeCount} DOM nodes (scroll ${attempts}, idle ${idleCount}, noNewPost ${zeroNewPostCycles}/${CONFIG.EOF_HARD_STOP_IDLE_CYCLES})`
      );

      // ── End-of-feed signal evaluation ──
      if (idleCount >= CONFIG.IDLE_THRESHOLD) {
        // Signal 1: no growth in unique post IDs
        const noPostGrowth = currSize === prevSize;

        // Signal 2: no scrollHeight increase (already tracked by idleCount)
        const noHeightGrowth = currHeight <= prevHeight;

        // Signal 3: viewport at bottom after forced bottom probes
        let atBottom = false;
        for (let p = 0; p < CONFIG.EOF_BOTTOM_PROBE_COUNT; p++) {
          window.scrollTo(0, document.documentElement.scrollHeight);
          await sleep(300);
          if (isAtBottom(10)) {
            atBottom = true;
            break;
          }
        }

        // Signal 4: tail post signatures unchanged
        const tailSig = getTailSignature(CONFIG.EOF_TAIL_SIGNATURE_COUNT);
        if (tailSig && tailSig === prevTailSig) {
          tailSigRepeatCount++;
        } else {
          tailSigRepeatCount = 0;
          prevTailSig = tailSig;
        }
        const tailRepeated = tailSigRepeatCount >= 1;

        const allSignals = noPostGrowth && noHeightGrowth && atBottom && tailRepeated;

        if (allSignals) {
          eofCycleCount++;
          log(`EOF signals all active — cycle ${eofCycleCount}/${CONFIG.EOF_CONSECUTIVE_CYCLES}`);
        } else {
          eofCycleCount = 0;
        }

        // Hard stop: all signals held for enough consecutive cycles
        if (eofCycleCount >= CONFIG.EOF_CONSECUTIVE_CYCLES) {
          const reasons = [
            'no_post_growth',
            'no_height_growth',
            'viewport_at_bottom',
            `tail_signature_repeated_${tailSigRepeatCount + 1}x`,
          ];
          const reason = reasons.join('+');
          extractionStats.end_of_feed_detected = true;
          extractionStats.end_of_feed_reason = reason;
          log(`End of feed detected: ${reason}. Stopping.`);
          statusFn(`End of feed reached — ${currSize} posts`);
          break;
        }

        // Retry burst (prevents premature stop)
        if (retryBudget > 0) {
          retryBudget--;
          const burstNum = CONFIG.RETRY_BURSTS - retryBudget;
          log(`Idle → retry burst ${burstNum}/${CONFIG.RETRY_BURSTS}…`);
          statusFn(
            `Retry ${burstNum}/${CONFIG.RETRY_BURSTS}… ${currSize} posts`
          );

          window.scrollTo(0, document.documentElement.scrollHeight);
          await sleep(CONFIG.RETRY_BURST_WAIT_MS);
          await scanCurrentPosts();

          const afterHeight = document.documentElement.scrollHeight;
          const afterSize = collectedPosts.size;

          if (afterHeight > prevHeight || afterSize > prevSize) {
            log('Retry burst found new content — resuming normal scroll.');
            idleCount = 0;
            eofCycleCount = 0;
            tailSigRepeatCount = 0;
            zeroNewPostCycles = 0;
            lastPostCount = afterSize;
            lastDomNodeCount = findPostElements().length;
            prevHeight = afterHeight;
            prevSize = afterSize;
          } else {
            log('Retry burst found nothing new.');
            idleCount = 0;
          }
        }
        // If no retry budget left but EOF cycles not yet met, continue looping
        // to accumulate consecutive EOF cycles before stopping
      }
    }

    // If we exhausted MAX_SCROLL_ATTEMPTS without EOF detection
    if (!extractionStats.end_of_feed_detected && attempts >= CONFIG.MAX_SCROLL_ATTEMPTS) {
      extractionStats.end_of_feed_reason = 'max_scroll_attempts_reached';
    }

    extractionStats.scroll_total_cycles = attempts;
    log(
      `Scrolling complete. ${attempts} scrolls, ${collectedPosts.size} posts collected (${findPostElements().length} DOM nodes), eof=${extractionStats.end_of_feed_detected} (reason=${extractionStats.end_of_feed_reason}), retries left=${retryBudget}, zeroNewPost=${zeroNewPostCycles}`
    );
  }

  /* ────────── JSZip loader ────────── */

  async function ensureJSZip() {
    if (typeof JSZip !== 'undefined') return JSZip;
    if (typeof unsafeWindow !== 'undefined' && unsafeWindow.JSZip) {
      return unsafeWindow.JSZip;
    }

    log('JSZip not pre-loaded, attempting dynamic CDN load…');
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = CONFIG.JSZIP_CDN;
      script.onload = () => {
        const ref =
          (typeof JSZip !== 'undefined' && JSZip) ||
          (typeof unsafeWindow !== 'undefined' && unsafeWindow.JSZip) ||
          null;
        if (ref) {
          log('JSZip loaded dynamically.');
          resolve(ref);
        } else {
          reject(new Error('JSZip script loaded but constructor not found'));
        }
      };
      script.onerror = () =>
        reject(new Error('Failed to load JSZip from CDN'));
      document.head.appendChild(script);
    });
  }

  /* ────────── image fetching ────────── */

  function fetchImageAsArrayBuffer(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url: url,
        responseType: 'arraybuffer',
        timeout: CONFIG.PHOTO_FETCH_TIMEOUT_MS,
        onload: (resp) => {
          if (resp.status >= 200 && resp.status < 300) {
            resolve(resp.response);
          } else {
            reject(new Error(`HTTP ${resp.status}`));
          }
        },
        onerror: () => reject(new Error('Network error')),
        ontimeout: () => reject(new Error('Timeout')),
      });
    });
  }

  function guessExtension(url) {
    const match = url.match(/\.(jpe?g|png|webp|gif)/i);
    if (match) return match[1].toLowerCase().replace('jpeg', 'jpg');
    return 'jpg';
  }

  /* ────────── download helpers ────────── */

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 1000);
  }

  function downloadJSON(posts) {
    const output = {
      meta: {
        group_id: groupId,
        user_id: userId,
        exported_at: new Date().toISOString(),
        post_count: posts.length,
        extraction_stats: { ...extractionStats },
        carousel_control_debug: { ...carouselDebug },
      },
      posts,
    };
    const blob = new Blob([JSON.stringify(output, null, 2)], {
      type: 'application/json',
    });
    downloadBlob(
      blob,
      `fb-group-${groupId}-user-${userId}-${Date.now()}.json`
    );
  }

  /* ────────── photo ZIP pipeline ────────── */

  async function buildPhotoZip(posts, statusFn) {
    let JSZipRef;
    try {
      JSZipRef = await ensureJSZip();
    } catch (e) {
      warn('Could not load JSZip:', e.message);
      return { zip: null, totalPhotos: 0, failures: [{ error: 'JSZip unavailable: ' + e.message }] };
    }

    const zip = new JSZipRef();
    const failures = [];
    let totalPhotos = 0;

    for (let i = 0; i < posts.length; i++) {
      const post = posts[i];
      if (!post.photos || post.photos.length === 0) continue;

      const postDir = `post-${String(i + 1).padStart(3, '0')}`;
      const photosToFetch = post.photos.slice(0, CONFIG.MAX_PHOTOS_PER_POST);

      for (let j = 0; j < photosToFetch.length; j++) {
        if (totalPhotos >= CONFIG.MAX_TOTAL_PHOTOS) {
          log(`Global photo cap (${CONFIG.MAX_TOTAL_PHOTOS}) reached.`);
          break;
        }

        const photoUrl = photosToFetch[j];
        const ext = guessExtension(photoUrl);
        const filename = `${postDir}/photo-${String(j + 1).padStart(2, '0')}.${ext}`;

        statusFn(
          `Downloading photos… ${totalPhotos + 1} (post ${i + 1}/${posts.length})`
        );

        try {
          const buf = await fetchImageAsArrayBuffer(photoUrl);
          zip.file(filename, buf);
          totalPhotos++;
        } catch (e) {
          failures.push({
            post_index: i + 1,
            photo_index: j + 1,
            url: photoUrl,
            error: e.message,
          });
          warn(`Failed to fetch photo: ${filename} — ${e.message}`);
        }
      }

      if (totalPhotos >= CONFIG.MAX_TOTAL_PHOTOS) break;
    }

    zip.file('manifest.json', JSON.stringify(posts, null, 2));
    if (failures.length > 0) {
      zip.file('photo-failures.json', JSON.stringify(failures, null, 2));
    }

    return { zip, totalPhotos, failures };
  }

  /* ────────── UI ────────── */

  let panelEl = null;
  let statusEl = null;

  function createPanel() {
    panelEl = document.createElement('div');
    panelEl.id = 'fb-export-panel';
    Object.assign(panelEl.style, {
      position: 'fixed',
      bottom: '20px',
      right: '20px',
      zIndex: '99999',
      background: '#1a1a2e',
      color: '#fff',
      padding: '14px 18px',
      borderRadius: '10px',
      fontFamily: 'Helvetica, Arial, sans-serif',
      fontSize: '13px',
      boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
      userSelect: 'none',
      maxWidth: '340px',
      display: 'flex',
      flexDirection: 'column',
      gap: '8px',
    });

    // Title
    const title = document.createElement('div');
    title.textContent = `Export: group ${groupId} / user ${userId}`;
    Object.assign(title.style, {
      fontSize: '11px',
      opacity: '0.7',
      marginBottom: '2px',
    });
    panelEl.appendChild(title);

    // Full Scan + Export button
    const fullBtn = makeButton('Full Scan + Export', '#1877f2', handleFullScan);
    fullBtn.id = 'fb-export-full-btn';
    panelEl.appendChild(fullBtn);

    // Export Loaded Now button
    const nowBtn = makeButton('Export Loaded Now', '#42b72a', handleExportNow);
    nowBtn.id = 'fb-export-now-btn';
    panelEl.appendChild(nowBtn);

    // Status line
    statusEl = document.createElement('div');
    statusEl.id = 'fb-export-status';
    Object.assign(statusEl.style, {
      fontSize: '11px',
      opacity: '0.8',
      minHeight: '16px',
    });
    panelEl.appendChild(statusEl);

    document.body.appendChild(panelEl);
  }

  function makeButton(text, color, handler) {
    const btn = document.createElement('div');
    btn.textContent = text;
    Object.assign(btn.style, {
      background: color,
      color: '#fff',
      padding: '10px 16px',
      borderRadius: '6px',
      fontWeight: 'bold',
      fontSize: '13px',
      cursor: 'pointer',
      textAlign: 'center',
      transition: 'opacity 0.2s',
    });
    btn.addEventListener('mouseenter', () => { btn.style.opacity = '0.85'; });
    btn.addEventListener('mouseleave', () => { btn.style.opacity = '1'; });
    btn.addEventListener('click', handler);
    return btn;
  }

  function updateStatus(text) {
    if (statusEl) statusEl.textContent = text;
  }

  function setButtonsEnabled(enabled) {
    const btns = panelEl ? panelEl.querySelectorAll('#fb-export-full-btn, #fb-export-now-btn') : [];
    for (const btn of btns) {
      btn.style.opacity = enabled ? '1' : '0.5';
      btn.style.pointerEvents = enabled ? 'auto' : 'none';
    }
  }

  /* ────────── export pipeline ────────── */

  let running = false;

  async function runExport(posts) {
    const total = posts.length;

    // Emit validation summary for every run (dry or real)
    const validation = {
      total_posts: total,
      posts_with_permalink: posts.filter((p) => p.permalink && !p.permalink.startsWith('(no')).length,
      posts_with_text: posts.filter((p) => p.text && p.text.length > 0).length,
      posts_with_photos: posts.filter((p) => p.photos && p.photos.length > 0).length,
      total_photo_urls: posts.reduce((n, p) => n + (p.photos ? p.photos.length : 0), 0),
      unique_photo_urls: new Set(posts.flatMap((p) => (p.photos || []).map(urlPathKey))).size,
      duplicate_photo_urls_removed: posts.reduce((n, p) => n + (p.photos ? p.photos.length : 0), 0) - new Set(posts.flatMap((p) => (p.photos || []).map(urlPathKey))).size,
      stats: { ...extractionStats },
      carousel_debug: { ...carouselDebug },
    };
    log('Validation summary:', JSON.stringify(validation, null, 2));

    if (CONFIG.DRY_RUN) {
      updateStatus(`DRY RUN: ${total} posts found.`);
      log('DRY_RUN — no files downloaded.');
      log('Posts:', posts.map((p) => p.permalink));
      return;
    }

    if (total === 0) {
      updateStatus('No posts found.');
      return;
    }

    updateStatus(`Exporting ${total} posts as JSON…`);
    downloadJSON(posts);

    if (CONFIG.DOWNLOAD_PHOTOS) {
      const totalPhotoUrls = posts.reduce(
        (n, p) => n + (p.photos ? p.photos.length : 0),
        0
      );
      if (totalPhotoUrls > 0) {
        updateStatus(`Building photo ZIP (${totalPhotoUrls} URLs found)…`);
        const result = await buildPhotoZip(posts, updateStatus);

        if (result.zip) {
          updateStatus('Generating ZIP file…');
          try {
            const content = await result.zip.generateAsync({ type: 'blob' });
            downloadBlob(
              content,
              `fb-photos-${groupId}-user-${userId}-${Date.now()}.zip`
            );
            const failMsg =
              result.failures.length > 0
                ? ` (${result.failures.length} failed)`
                : '';
            updateStatus(
              `Done! ${total} posts + ${result.totalPhotos} photos${failMsg}`
            );
          } catch (e) {
            warn('ZIP generation failed:', e);
            updateStatus(`Done! ${total} posts. ZIP failed: ${e.message}`);
          }
        } else {
          updateStatus(`Done! ${total} posts (photo URLs in JSON, ZIP unavailable).`);
        }
      } else {
        updateStatus(`Done! ${total} posts exported (no photos found).`);
      }
    } else {
      updateStatus(`Done! ${total} posts exported (JSON only).`);
    }
  }

  async function handleFullScan() {
    if (running) return;
    running = true;
    setButtonsEnabled(false);

    log('Full Scan + Export. Group:', groupId, 'User:', userId);
    updateStatus('Expanding & scanning visible posts…');

    await scanCurrentPosts();
    log(`After initial scan: ${collectedPosts.size} posts`);

    updateStatus(`Auto-scrolling… ${collectedPosts.size} posts so far`);
    await autoScroll(updateStatus);

    await scanCurrentPosts();
    const posts = [...collectedPosts.values()];
    log(`Done scrolling. Total posts: ${posts.length}`);

    await runExport(posts);

    running = false;
    setButtonsEnabled(true);
  }

  async function handleExportNow() {
    if (running) return;
    running = true;
    setButtonsEnabled(false);

    log('Export Loaded Now. Group:', groupId, 'User:', userId);
    updateStatus('Expanding & scanning loaded posts…');

    await scanCurrentPosts();
    const posts = [...collectedPosts.values()];
    log(`Found ${posts.length} loaded posts`);

    await runExport(posts);

    running = false;
    setButtonsEnabled(true);
  }

  /* ────────── init ────────── */

  log(`Detected group=${groupId}, user=${userId}. Injecting export panel.`);
  createPanel();
})();
