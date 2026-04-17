#!/usr/bin/env node

/**
 * CDP debug runner for the FB Group Post Exporter userscript.
 *
 * Approach: keep `export-group-posts-by-user.user.js` as a pure Tampermonkey
 * userscript. To debug it via CDP, inject a thin shim that:
 *   - defines GM_xmlhttpRequest (backed by fetch in the page context)
 *   - intercepts the blob downloads so we can collect them as files
 *   - auto-clicks "Full Scan + Export" once the panel mounts
 *
 * The userscript itself is evaluated unmodified.
 *
 * Usage:
 *   1. Launch Chrome with remote debugging:
 *      /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
 *        --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-debug
 *
 *   2. Log in to Facebook in that Chrome window.
 *
 *   3. Run this script:
 *      node run.mjs <url>
 *      # or: FB_EXPORT_URL=<url> node run.mjs
 *
 *   URL format: https://www.facebook.com/groups/<gid>/user/<uid>/
 */

import puppeteer from 'puppeteer-core';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import readline from 'readline';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TARGET_URL = process.argv[2] || process.env.FB_EXPORT_URL;
if (!TARGET_URL) {
  console.error(
    'Usage: node run.mjs <url>\n' +
    '   or: FB_EXPORT_URL=<url> node run.mjs\n\n' +
    'URL format: https://www.facebook.com/groups/<gid>/user/<uid>/'
  );
  process.exit(1);
}

const OUTPUT_DIR = path.join(__dirname, 'output');

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

/**
 * Shim that runs in the page BEFORE the userscript is evaluated.
 * Provides GM_xmlhttpRequest (fetch-backed) and intercepts blob downloads
 * so the CDP runner can collect them via window.__FB_EXPORT_FILES.
 */
const PRELUDE_SHIM = `
(function () {
  // ── GM_xmlhttpRequest shim, backed by fetch (same-origin on facebook.com) ──
  window.GM_xmlhttpRequest = function (opts) {
    // Same-origin fetches (facebook.com pages) need cookies, but cross-origin
    // CDN fetches (scontent/fbcdn) fail CORS with credentials:'include' because
    // the CDN returns Access-Control-Allow-Origin:*. Real Tampermonkey bypasses
    // CORS entirely; our in-page shim cannot, so route accordingly.
    let creds = 'same-origin';
    try {
      const targetOrigin = new URL(opts.url, location.href).origin;
      if (targetOrigin === location.origin) creds = 'include';
      else creds = 'omit';
    } catch { /* fall through */ }
    const init = {
      method: opts.method || 'GET',
      headers: opts.headers || {},
      credentials: creds,
    };

    const controller = new AbortController();
    init.signal = controller.signal;

    let timeoutId = null;
    if (opts.timeout) {
      timeoutId = setTimeout(() => {
        controller.abort();
        if (opts.ontimeout) opts.ontimeout({ readyState: 4, status: 0 });
      }, opts.timeout);
    }

    fetch(opts.url, init)
      .then(async (resp) => {
        if (timeoutId) clearTimeout(timeoutId);
        const wantBuffer = opts.responseType === 'arraybuffer';
        let body;
        try {
          body = wantBuffer ? await resp.arrayBuffer() : await resp.text();
        } catch (err) {
          if (opts.onerror) opts.onerror({ error: err.message });
          return;
        }
        if (opts.onload) {
          opts.onload({
            status: resp.status,
            statusText: resp.statusText,
            response: body,
            responseText: wantBuffer ? '' : body,
            readyState: 4,
          });
        }
      })
      .catch((err) => {
        if (timeoutId) clearTimeout(timeoutId);
        if (err.name === 'AbortError') return; // ontimeout already fired
        if (opts.onerror) opts.onerror({ error: err.message });
      });

    return { abort: () => controller.abort() };
  };

  // ── Intercept blob downloads ──
  // The userscript calls downloadBlob() which creates an <a download> and
  // clicks it. We monkey-patch <a>.click() to detect download attempts and
  // capture the blob bytes onto window.__FB_EXPORT_FILES.
  window.__FB_EXPORT_FILES = [];
  window.__FB_EXPORT_STATUS = 'starting';

  // Snapshot original click before userscript runs
  const _origClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (this.download && this.href && this.href.startsWith('blob:')) {
      // Capture this blob asynchronously
      const filename = this.download;
      const blobUrl = this.href;
      fetch(blobUrl)
        .then((r) => r.arrayBuffer())
        .then((buf) => {
          window.__FB_EXPORT_FILES.push({
            filename,
            data: Array.from(new Uint8Array(buf)),
          });
          console.log('[FB-Export] CDP captured download: ' + filename + ' (' + buf.byteLength + ' bytes)');
        })
        .catch((err) => {
          console.warn('[FB-Export] CDP failed to capture blob ' + filename + ': ' + err.message);
        });
      // Skip the actual download
      return;
    }
    return _origClick.call(this);
  };

  // ── Auto-click Full Scan + Export once the panel appears ──
  const autoStartObserver = new MutationObserver(() => {
    const btn = document.getElementById('fb-export-full-btn');
    if (btn) {
      autoStartObserver.disconnect();
      console.log('[FB-Export] CDP: auto-clicking Full Scan + Export button.');
      window.__FB_EXPORT_STATUS = 'running';
      // Slight delay so the script's own initialization finishes
      setTimeout(() => btn.click(), 500);

      // Mark done when the JSON download lands
      const doneCheck = setInterval(() => {
        const hasJson = window.__FB_EXPORT_FILES.some((f) => f.filename.endsWith('.json'));
        if (hasJson) {
          // Wait an extra few seconds for the photo zip to also land
          setTimeout(() => {
            window.__FB_EXPORT_STATUS = 'done';
            clearInterval(doneCheck);
          }, 4000);
        }
      }, 1000);
    }
  });
  autoStartObserver.observe(document.body || document.documentElement, {
    childList: true,
    subtree: true,
  });
})();
`;

async function main() {
  console.log('Connecting to Chrome on port 9222...');

  let browser;
  try {
    browser = await puppeteer.connect({
      browserURL: 'http://127.0.0.1:9222',
      defaultViewport: null,
    });
  } catch (err) {
    console.error(
      '\nCould not connect to Chrome. Launch it with:\n\n' +
      '  /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome \\\n' +
      '    --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-debug\n'
    );
    process.exit(1);
  }
  console.log('Connected.');

  const pages = await browser.pages();
  let page = pages[0] || (await browser.newPage());

  // Forward useful console output from the page
  page.on('console', (msg) => {
    const text = msg.text();
    const type = msg.type();
    if (text.includes('[FB-Export]') || text.includes('Carousel') || type === 'error' || type === 'warning') {
      console.log(`  PAGE[${type}]:`, text);
    }
  });
  page.on('pageerror', (err) => {
    console.error('  PAGE ERROR:', err.message);
  });

  // Navigate to target
  console.log(`\nNavigating to: ${TARGET_URL}`);
  try {
    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  } catch (err) {
    console.warn('Navigation warning:', err.message);
  }

  // Check login state
  const currentUrl = page.url();
  if (
    currentUrl.includes('login') ||
    currentUrl.includes('checkpoint') ||
    !currentUrl.includes('/groups/')
  ) {
    console.log('\n================================================');
    console.log('  Please log in to Facebook in the Chrome window.');
    console.log('  Then navigate to the target URL if needed.');
    console.log('================================================\n');

    await ask('Press ENTER when you are logged in and on the target page...');

    if (!page.url().includes('/groups/')) {
      console.log('Navigating to target URL after login...');
      await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    }
  }

  console.log('\nWaiting for page to settle...');
  await new Promise((r) => setTimeout(r, 4000));

  // Read the unmodified userscript
  const userscriptPath = path.join(__dirname, 'export-group-posts-by-user.user.js');
  const userscript = fs.readFileSync(userscriptPath, 'utf-8');

  // The userscript needs JSZip. FB pages have AMD `define` on window, so JSZip's
  // UMD wrapper would register as an AMD module instead of a global. We
  // temporarily shadow `define` so JSZip falls through to the global branch.
  console.log('\nInjecting JSZip (local copy)...');
  const jszipSource = fs.readFileSync(path.join(__dirname, 'jszip.min.js'), 'utf-8');
  const wrappedJszip =
    '(function(){var _origDefine=window.define;window.define=undefined;try{' +
    jszipSource +
    '\n}finally{window.define=_origDefine;}})();';
  await page.evaluate(wrappedJszip);
  const jszipOk = await page.evaluate(() => typeof window.JSZip !== 'undefined');
  if (!jszipOk) {
    throw new Error('JSZip failed to load into page context.');
  }
  console.log('  JSZip loaded.');

  console.log('Injecting prelude shim (GM_xmlhttpRequest + download interceptor)...');
  await page.evaluate(PRELUDE_SHIM);

  console.log('Injecting userscript (unmodified)...');
  // Strip the // ==UserScript== ... // ==/UserScript== block so it's just plain JS
  const stripped = userscript.replace(
    /\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==\s*/,
    ''
  );

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUTPUT_DIR, '_injected-userscript.js'), stripped);

  await page.evaluate(stripped);
  console.log('\nUserscript injected. Auto-start will trigger when panel mounts.\n');

  // Poll for completion
  const startTime = Date.now();
  const maxRunMs = 30 * 60 * 1000; // 30 minutes hard cap

  while (true) {
    const status = await page.evaluate(() => window.__FB_EXPORT_STATUS);
    const elapsed = Math.floor((Date.now() - startTime) / 1000);

    if (status === 'done') {
      console.log(`\n[${elapsed}s] Export complete.`);
      break;
    }
    if (Date.now() - startTime > maxRunMs) {
      console.warn(`\n[${elapsed}s] Hit max runtime. Collecting whatever was captured.`);
      break;
    }

    await new Promise((r) => setTimeout(r, 3000));
  }

  // Collect captured files
  const files = await page.evaluate(() => window.__FB_EXPORT_FILES || []);

  console.log(`\nCaptured ${files.length} file(s):`);
  for (const f of files) {
    const buf = Buffer.from(f.data);
    const outPath = path.join(OUTPUT_DIR, f.filename);
    fs.writeFileSync(outPath, buf);
    console.log(`  → ${outPath} (${buf.length} bytes)`);
  }

  // If we got the JSON, print summary stats
  const jsonFile = files.find((f) => f.filename.endsWith('.json'));
  if (jsonFile) {
    try {
      const data = JSON.parse(Buffer.from(jsonFile.data).toString('utf-8'));
      console.log('\n── Extraction summary ──');
      console.log('Posts:', data.meta.post_count);
      console.log('Stats:', JSON.stringify(data.meta.extraction_stats, null, 2));
      console.log('Carousel debug:', JSON.stringify(data.meta.carousel_control_debug, null, 2));
    } catch (err) {
      console.warn('Could not parse JSON for summary:', err.message);
    }
  }

  console.log('\nLeaving browser open for inspection. Disconnect with Ctrl+C.');
  // browser.disconnect();  // intentionally not closing
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
