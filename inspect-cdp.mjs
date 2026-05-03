#!/usr/bin/env node

import puppeteer from 'puppeteer-core';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TARGET_URL = process.argv[2];
const POST_IDS = (process.argv[3] || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const OUTPUT_DIR = path.join(__dirname, 'output', 'cdp-debug');

if (!TARGET_URL || POST_IDS.length === 0) {
  console.error(
    'Usage: node inspect-cdp.mjs <group-user-url> <post-id[,post-id...]>\n\n' +
      'Example: node inspect-cdp.mjs "https://www.facebook.com/groups/<gid>/user/<uid>/" "123,456"'
  );
  process.exit(1);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function findPost(page, postId) {
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(1200);
  for (let cycle = 0; cycle < 80; cycle++) {
    const found = await page.evaluate((id) => {
      const anchors = [...document.querySelectorAll(`a[href*="${id}"]`)];
      for (const a of anchors) {
        const post =
          a.closest('[data-virtualized="false"]') ||
          a.closest('[role="article"]') ||
          a.closest('div');
        if (post) {
          post.setAttribute('data-fb-export-debug-target', id);
          post.scrollIntoView({ block: 'center' });
          return {
            href: a.href,
            text: (post.innerText || '').slice(0, 500),
            rect: post.getBoundingClientRect().toJSON(),
          };
        }
      }
      window.scrollBy(0, Math.floor(window.innerHeight * 0.82));
      return null;
    }, postId);
    if (found) {
      await sleep(1200);
      return found;
    }
    await sleep(900);
  }
  return null;
}

async function inspectPost(page, postId) {
  return await page.evaluate(async (id) => {
    const post = document.querySelector(`[data-fb-export-debug-target="${id}"]`);
    if (!post) return { postId: id, found: false };

    function clean(value) {
      return String(value || '').replace(/\s+/g, ' ').trim();
    }

    function uniq(values) {
      return [...new Set(values.filter(Boolean))];
    }

    function attr(el, name) {
      return el.getAttribute(name) || '';
    }

    const anchors = [...post.querySelectorAll('a[href]')].map((a) => ({
      href: a.href,
      text: clean(a.innerText).slice(0, 180),
      ariaLabel: attr(a, 'aria-label'),
      role: attr(a, 'role'),
      imgCount: a.querySelectorAll('img').length,
      hasBackground: !!a.querySelector('[style*="background-image"]'),
    }));

    const imgs = [...post.querySelectorAll('img')].map((img) => ({
      src: img.currentSrc || img.src,
      attrSrc: attr(img, 'src'),
      srcset: attr(img, 'srcset'),
      dataSrc: attr(img, 'data-src'),
      alt: attr(img, 'alt'),
      role: attr(img, 'role'),
      perf: attr(img, 'data-imgperflogname'),
      naturalWidth: img.naturalWidth,
      naturalHeight: img.naturalHeight,
      rect: (() => {
        const r = img.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      })(),
    }));

    const bgEls = [...post.querySelectorAll('[style*="background-image"]')].map((el) => ({
      style: attr(el, 'style').slice(0, 1000),
      text: clean(el.innerText).slice(0, 120),
      ariaLabel: attr(el, 'aria-label'),
      role: attr(el, 'role'),
    }));

    const plusLike = [...post.querySelectorAll('*')]
      .map((el) => ({
        text: clean(el.innerText),
        ariaLabel: attr(el, 'aria-label'),
        role: attr(el, 'role'),
        href: el.href || '',
      }))
      .filter((item) => /(^|\s)\+\d+($|\s)/.test(item.text) || /(^|\s)\+\d+($|\s)/.test(item.ariaLabel))
      .slice(0, 50);

    const scripts = [...document.querySelectorAll('script')]
      .map((s, index) => ({ index, text: s.textContent || '' }))
      .filter((s) => s.text.includes(id))
      .map((s) => {
        const txt = s.text;
        const uris = uniq(
          [...txt.matchAll(/"uri":"(https:\\?\/\\?\/[^"]+)"/g)].map((m) =>
            m[1].replace(/\\\//g, '/').replace(/\\u0026/g, '&')
          )
        );
        const photoUris = uris.filter((u) => /(?:scontent|fbcdn)/.test(u));
        const photoLinks = uniq(
          [...txt.matchAll(/(?:href|url|uri)":"([^"]*(?:photo|photos|media|video)[^"]*)"/g)].map((m) =>
            m[1].replace(/\\\//g, '/').replace(/\\u0026/g, '&')
          )
        );
        return {
          index: s.index,
          length: txt.length,
          uriCount: uris.length,
          photoUriCount: photoUris.length,
          photoUriSamples: photoUris.slice(0, 30),
          mediaLinkCount: photoLinks.length,
          mediaLinkSamples: photoLinks.slice(0, 50),
        };
      });

    return {
      postId: id,
      found: true,
      url: location.href,
      text: clean(post.innerText).slice(0, 1200),
      linkCount: anchors.length,
      photoAnchorCount: anchors.filter((a) => /\/photo\/|\bfbid=|\/photos\//.test(a.href)).length,
      mediaAnchorCount: anchors.filter((a) => /\/photo\/|\bfbid=|\/photos\/|\/videos\/|\/watch\//.test(a.href)).length,
      imageCount: imgs.length,
      bgCount: bgEls.length,
      anchors: anchors.slice(0, 120),
      imgs,
      bgEls,
      plusLike,
      scripts,
      outerHTML: post.outerHTML.slice(0, 180000),
    };
  }, postId);
}

async function inspectGalleryFetch(page, postId) {
  return await page.evaluate(async (id) => {
    const post = document.querySelector(`[data-fb-export-debug-target="${id}"]`);
    if (!post) return { postId: id, found: false };
    const links = [...post.querySelectorAll('a[href*="/photo/"]')].map((a) => ({
      href: a.href,
      text: (a.innerText || '').replace(/\s+/g, ' ').trim(),
      ariaLabel: a.getAttribute('aria-label') || '',
    }));
    const plusLink =
      links.find((l) => /\+\d+/.test(l.text) || /remaining items/i.test(l.ariaLabel)) ||
      links[links.length - 1] ||
      links[0];
    if (!plusLink) return { postId: id, found: true, error: 'no photo links' };

    const resp = await fetch(plusLink.href, {
      method: 'GET',
      credentials: 'include',
      headers: { accept: 'text/html,application/xhtml+xml' },
    });
    const html = await resp.text();

    function uniq(values) {
      return [...new Set(values.filter(Boolean))];
    }

    const uriMatches = uniq(
      [...html.matchAll(/"uri":"(https:\\?\/\\?\/[^"]+)"/g)].map((m) =>
        m[1].replace(/\\\//g, '/').replace(/\\u0026/g, '&')
      )
    );
    const scontentUris = uriMatches.filter((u) => /(?:scontent|fbcdn)/.test(u));
    const fbidLinks = uniq(
      [
        ...html.matchAll(/\/photo\/\?fbid=\d+[^"'<>\s]*/g),
        ...html.matchAll(/\\\/photo\\\/\?fbid=\d+[^"']*/g),
      ].map((m) => m[0].replace(/\\\//g, '/').replace(/\\u0026/g, '&').replace(/&amp;/g, '&'))
    );
    const feedbackEdges = uniq([...html.matchAll(/"feedback_id":"([^"]+)"/g)].map((m) => m[1]));
    const fbidNumbers = uniq([...html.matchAll(/\bfbid[=\\":]+(\d{12,18})/g)].map((m) => m[1]));
    const postIdMentions = (html.match(new RegExp(id, 'g')) || []).length;
    const mediaSetMentions = (html.match(new RegExp(`(?:gm|pcb)\\\\?.${id}|(?:gm|pcb)\\.${id}`, 'g')) || []).length;

    return {
      postId: id,
      found: true,
      url: plusLink.href,
      status: resp.status,
      redirected: resp.redirected,
      finalUrl: resp.url,
      htmlLength: html.length,
      htmlStart: html.slice(0, 500),
      photoLinkCount: links.length,
      photoLinks: links,
      uriCount: uriMatches.length,
      scontentUriCount: scontentUris.length,
      scontentUriSamples: scontentUris.slice(0, 50),
      fbidLinkCount: fbidLinks.length,
      fbidLinks: fbidLinks.slice(0, 80),
      fbidNumbers: fbidNumbers.slice(0, 80),
      feedbackEdges: feedbackEdges.slice(0, 20),
      postIdMentions,
      mediaSetMentions,
      hasLogin: /login|Log in to Facebook|checkpoint/i.test(html),
      containsNext: /next|Next|CometPhotoViewer|PhotoViewer|next_media/i.test(html),
    };
  }, postId);
}

async function crawlViewer(page, postId) {
  return await page.evaluate(async (id) => {
    const post = document.querySelector(`[data-fb-export-debug-target="${id}"]`);
    if (!post) return { postId: id, found: false };

    function sleepLocal(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }

    function urlKey(url) {
      try {
        const u = new URL(url, location.href);
        return u.pathname;
      } catch {
        return url || '';
      }
    }

    function isContentImage(url) {
      return /(?:scontent|fbcdn)\.net/.test(url || '') && !/\/t\d+\.\d+-1\//.test(url || '');
    }

    function findViewer() {
      const dialogs = [...document.querySelectorAll('[role="dialog"]')].filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > window.innerWidth * 0.5 && r.height > window.innerHeight * 0.5;
      });
      return dialogs[dialogs.length - 1] || document.body;
    }

    function currentImage() {
      const viewer = findViewer();
      const imgs = [...viewer.querySelectorAll('img')]
        .map((img) => {
          const r = img.getBoundingClientRect();
          return {
            src: img.currentSrc || img.src,
            width: r.width,
            height: r.height,
            area: r.width * r.height,
          };
        })
        .filter((img) => isContentImage(img.src) && img.width > 80 && img.height > 80)
        .sort((a, b) => b.area - a.area);
      return imgs[0] || null;
    }

    function clickNext() {
      const viewer = findViewer();
      const candidates = [...viewer.querySelectorAll('[aria-label], [role="button"], a[href]')]
        .map((el) => {
          const r = el.getBoundingClientRect();
          const label = el.getAttribute('aria-label') || '';
          const text = (el.innerText || '').trim();
          return { el, r, label, text };
        })
        .filter((c) => c.r.width > 0 && c.r.height > 0);

      const labelled = candidates.find((c) => /^(next|next photo|下一|次へ|siguiente|suivant|weiter)/i.test(c.label));
      if (labelled) {
        labelled.el.click();
        return { clicked: true, strategy: `label:${labelled.label}` };
      }

      const rightSide = candidates
        .filter((c) => c.r.left > window.innerWidth * 0.55 && c.r.height >= 24 && c.r.width >= 24)
        .sort((a, b) => b.r.width * b.r.height - a.r.width * a.r.height)[0];
      if (rightSide) {
        rightSide.el.click();
        return { clicked: true, strategy: 'right-side-button' };
      }

      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', code: 'ArrowRight', bubbles: true }));
      document.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', code: 'ArrowRight', bubbles: true }));
      return { clicked: true, strategy: 'keyboard' };
    }

    const photoLinks = [...post.querySelectorAll('a[href*="/photo/"]')];
    const plusLink =
      photoLinks.find((a) => /\+\d+/.test(a.innerText || '') || /remaining items/i.test(a.getAttribute('aria-label') || '')) ||
      photoLinks[0];
    if (!plusLink) return { postId: id, found: true, error: 'no photo link' };

    plusLink.scrollIntoView({ block: 'center' });
    plusLink.click();
    await sleepLocal(2000);

    const seen = new Set();
    const images = [];
    const steps = [];

    for (let i = 0; i < 18; i++) {
      let img = null;
      for (let wait = 0; wait < 20; wait++) {
        img = currentImage();
        if (img && !seen.has(urlKey(img.src))) break;
        await sleepLocal(150);
      }
      if (img) {
        const key = urlKey(img.src);
        if (!seen.has(key)) {
          seen.add(key);
          images.push(img.src);
        }
      }

      const before = img ? urlKey(img.src) : '';
      const nav = clickNext();
      await sleepLocal(900);
      const afterImg = currentImage();
      const after = afterImg ? urlKey(afterImg.src) : '';
      steps.push({ i, before, after, strategy: nav.strategy });
      if (after && after === before && i > 1) {
        // Try one more iteration before deciding it is stuck.
        await sleepLocal(700);
      }
    }

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', code: 'Escape', bubbles: true }));
    await sleepLocal(500);

    return { postId: id, found: true, clickedHref: plusLink.href, images, imageCount: images.length, steps };
  }, postId);
}

async function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const browser = await puppeteer.connect({
    browserURL: 'http://127.0.0.1:9222',
    defaultViewport: null,
  });

  const pages = await browser.pages();
  let page = pages.find((p) => p.url().includes('facebook.com')) || pages[0] || (await browser.newPage());
  page.on('console', (msg) => {
    const text = msg.text();
    if (text.includes('[FB-Export]')) console.log(`PAGE[${msg.type()}] ${text}`);
  });

  const targetPath = new URL(TARGET_URL).pathname.replace(/\/+$/, '');
  const currentPath = new URL(page.url()).pathname.replace(/\/+$/, '');
  if (currentPath !== targetPath) {
    console.log(`Navigating to ${TARGET_URL}`);
    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  }

  await sleep(3500);
  console.log(`Current page: ${page.url()}`);

  if (page.url().includes('/login') || page.url().includes('/checkpoint')) {
    console.log('Browser is not logged in or is checkpointed. Log in, then rerun this script.');
    await browser.disconnect();
    return;
  }

  for (const postId of POST_IDS) {
    console.log(`\nFinding post ${postId}...`);
    const found = await findPost(page, postId);
    if (!found) {
      console.log(`  Not found after scrolling.`);
      continue;
    }
    console.log(`  Found via ${found.href}`);
    const result = await inspectPost(page, postId);
    const out = path.join(OUTPUT_DIR, `post-${postId}.json`);
    fs.writeFileSync(out, JSON.stringify(result, null, 2));
    console.log(
      `  images=${result.imageCount} photoAnchors=${result.photoAnchorCount} mediaAnchors=${result.mediaAnchorCount} bg=${result.bgCount} scripts=${result.scripts.length}`
    );
    console.log(`  wrote ${out}`);

    const gallery = await inspectGalleryFetch(page, postId);
    const galleryOut = path.join(OUTPUT_DIR, `post-${postId}-gallery.json`);
    fs.writeFileSync(galleryOut, JSON.stringify(gallery, null, 2));
    console.log(
      `  gallery status=${gallery.status} html=${gallery.htmlLength} scontent=${gallery.scontentUriCount} fbidLinks=${gallery.fbidLinkCount} setMentions=${gallery.mediaSetMentions}`
    );
    console.log(`  wrote ${galleryOut}`);

    const viewer = await crawlViewer(page, postId);
    const viewerOut = path.join(OUTPUT_DIR, `post-${postId}-viewer.json`);
    fs.writeFileSync(viewerOut, JSON.stringify(viewer, null, 2));
    console.log(`  viewer images=${viewer.imageCount} clicked=${viewer.clickedHref || ''}`);
    console.log(`  wrote ${viewerOut}`);
  }

  await browser.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
