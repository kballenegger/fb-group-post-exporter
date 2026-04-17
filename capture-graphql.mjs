import puppeteer from 'puppeteer-core';
import fs from 'fs';

const browser = await puppeteer.connect({
  browserURL: 'http://127.0.0.1:9222',
  defaultViewport: null,
});
const pages = await browser.pages();
const page = pages.find(p => p.url().includes('facebook.com')) || pages[0];

// Intercept GraphQL POSTs so we can study which ones carry attachment/media data
const captured = [];
page.on('request', (req) => {
  const url = req.url();
  if (!url.includes('/api/graphql')) return;
  if (req.method() !== 'POST') return;
  const post = req.postData() || '';
  captured.push({ url, postData: post });
});
page.on('response', async (resp) => {
  const req = resp.request();
  if (!req.url().includes('/api/graphql')) return;
  if (req.method() !== 'POST') return;
  try {
    const txt = await resp.text();
    // Match this response to its request by postData
    const reqPost = req.postData() || '';
    const entry = captured.find(c => c.postData === reqPost && !c.responseSample);
    if (entry) entry.responseSample = txt.slice(0, 20000);
  } catch { /* ignore */ }
});

// Navigate to the feed
const TARGET_URL = process.argv[2] || process.env.FB_EXPORT_URL;
if (!TARGET_URL) {
  console.error(
    'Usage: node capture-graphql.mjs <url>\n' +
    '   or: FB_EXPORT_URL=<url> node capture-graphql.mjs\n\n' +
    'URL format: https://www.facebook.com/groups/<gid>/user/<uid>/'
  );
  process.exit(1);
}
await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded' });
await new Promise(r => setTimeout(r, 3000));

// Scroll to a +X post
console.log('Finding multi-photo +X post to trigger the media load...');
const found = await page.evaluate(async () => {
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
  for (let i = 0; i < 30; i++) {
    window.scrollBy(0, 900);
    await sleep(900);
    const posts = [...document.querySelectorAll('[data-virtualized="false"]')];
    for (const p of posts) {
      const plus = [...p.querySelectorAll('span, div')].find(e => /^\+[3-9]\d*$/.test((e.textContent || '').trim()));
      if (plus) {
        p.scrollIntoView({ block: 'center' });
        const link = p.querySelector('a[href*="/photo/"]');
        const postLink = [...p.querySelectorAll('a[href*="/posts/"]')].find(a => /\/posts\/\d+/.test(a.href));
        const postId = postLink?.href.match(/\/posts\/(\d+)/)?.[1];
        return { postId, photoHref: link?.href?.slice(0, 180), plus: plus.textContent };
      }
    }
  }
  return null;
});
console.log('Target post:', found);

// Click the photo link to open viewer — this will trigger the hidden-photos fetch
if (found?.photoHref) {
  await page.evaluate(() => {
    const posts = [...document.querySelectorAll('[data-virtualized="false"]')];
    for (const p of posts) {
      const plus = [...p.querySelectorAll('span, div')].find(e => /^\+[3-9]\d*$/.test((e.textContent || '').trim()));
      if (plus) {
        const link = p.querySelector('a[href*="/photo/"]');
        if (link) { link.click(); return; }
      }
    }
  });
  await new Promise(r => setTimeout(r, 3000));

  // Now navigate through the viewer a few times — this forces FB to fetch each slide
  for (let i = 0; i < 8; i++) {
    await page.evaluate(() => {
      const dialog = document.querySelector('[role="dialog"][aria-label*="Photo"]');
      const paths = [...(dialog?.querySelectorAll('svg path[d]') || [])];
      const np = paths.find(p => (p.getAttribute('d') || '').startsWith('M8.116 3.116a1.25 1.25 0 0 1 1.768 0'));
      const btn = np?.closest('[role="button"], button, a');
      btn?.click();
    });
    await new Promise(r => setTimeout(r, 1500));
  }
}

// Dump captured requests summary
console.log('\nCaptured', captured.length, 'GraphQL POSTs');
const summary = captured
  .map(c => {
    const params = new URLSearchParams(c.postData);
    return {
      fb_api_req_friendly_name: params.get('fb_api_req_friendly_name'),
      doc_id: params.get('doc_id'),
      variables_len: (params.get('variables') || '').length,
      variables_snippet: (params.get('variables') || '').slice(0, 200),
      hasResponse: !!c.responseSample,
      responseSnippet: c.responseSample?.slice(0, 500),
    };
  })
  .filter(s => s.hasResponse || /Photo|Media|attachment|story/i.test(s.fb_api_req_friendly_name || ''));

// Full raw capture for the CometPhotoRootContentQuery
const full = captured.filter(c => (new URLSearchParams(c.postData).get('fb_api_req_friendly_name')) === 'CometPhotoRootContentQuery');
fs.writeFileSync('graphql-photo-raw.json', JSON.stringify(full, null, 2));
fs.writeFileSync('graphql-captured.json', JSON.stringify(summary, null, 2));
console.log(`Wrote ${summary.length} interesting entries to graphql-captured.json`);
console.log('Friendly names seen:');
const names = {};
for (const c of captured) {
  const name = new URLSearchParams(c.postData).get('fb_api_req_friendly_name') || '?';
  names[name] = (names[name] || 0) + 1;
}
for (const [n, v] of Object.entries(names).sort((a,b)=>b[1]-a[1])) {
  console.log('  ' + String(v).padStart(3) + 'x ' + n);
}

browser.disconnect();
