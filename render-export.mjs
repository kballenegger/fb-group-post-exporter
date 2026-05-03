#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

const inputPath = process.argv[2];
const isZipInput = inputPath && /\.zip$/i.test(inputPath);
const maybeZipPath = isZipInput
  ? inputPath
  : process.argv[3] && /\.zip$/i.test(process.argv[3])
    ? process.argv[3]
    : '';
const outputArg = isZipInput ? process.argv[3] : maybeZipPath ? process.argv[4] : process.argv[3];
const outputPath =
  outputArg ||
  (inputPath
    ? inputPath.replace(/\.(json|zip)$/i, '') + '.html'
    : '');

if (!inputPath || !outputPath) {
  console.error('Usage: node render-export.mjs <export.json> [export.zip] [output.html]');
  console.error('   or: node render-export.mjs <export.zip> [output.html]');
  process.exit(1);
}

const outputDir = path.dirname(path.resolve(outputPath));
const outputBase = path.basename(outputPath, path.extname(outputPath));
const assetDir = path.join(outputDir, `${outputBase}_files`);
let zipPhotoCount = 0;

if (maybeZipPath) {
  fs.mkdirSync(assetDir, { recursive: true });
  const unzip = spawnSync('unzip', ['-q', '-o', path.resolve(maybeZipPath), '-d', assetDir], {
    encoding: 'utf8'
  });
  if (unzip.status !== 0) {
    console.error(unzip.stderr || unzip.stdout || `Failed to extract ${maybeZipPath}`);
    process.exit(unzip.status || 1);
  }
}

let data;
if (isZipInput) {
  const exportJsonPath = path.join(assetDir, 'export.json');
  const manifestJsonPath = path.join(assetDir, 'manifest.json');
  if (fs.existsSync(exportJsonPath)) {
    data = JSON.parse(fs.readFileSync(exportJsonPath, 'utf8'));
  } else if (fs.existsSync(manifestJsonPath)) {
    data = { meta: {}, posts: JSON.parse(fs.readFileSync(manifestJsonPath, 'utf8')) };
  } else {
    console.error(`Could not find export.json inside ${inputPath}`);
    process.exit(1);
  }
} else {
  data = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
}
const posts = Array.isArray(data.posts) ? data.posts : [];
const meta = data.meta || {};

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function attr(value) {
  return escapeHtml(value);
}

function isTimestampLike(value) {
  return /\b(\d{1,2}\s*(sec|min|hour|day|week|month|year|y|mo|d|h|m)s?\b|yesterday|today|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|\d{4})/i.test(
    String(value || '')
  );
}

const allPhotos = posts.flatMap((post) => post.photos || []);
const uniquePhotos = new Set(allPhotos);
const linkPosts = posts.filter((post) => (post.external_links || []).length > 0);
const badTimestamps = posts.filter((post) => !isTimestampLike(post.timestamp));
const exactFivePhotoPosts = posts.filter((post) => (post.photos || []).length === 5);
const overFivePhotoPosts = posts.filter((post) => (post.photos || []).length > 5);
const missingZipPhotos = [];

function localZipPhotoPath(postIndex, photoIndex) {
  if (!maybeZipPath) return '';
  const postDirName = `post-${String(postIndex + 1).padStart(3, '0')}`;
  const postDir = path.join(assetDir, postDirName);
  if (!fs.existsSync(postDir)) return '';
  const prefix = `photo-${String(photoIndex + 1).padStart(2, '0')}.`;
  const fileName = fs.readdirSync(postDir).find((name) => name.startsWith(prefix));
  if (!fileName) return '';
  zipPhotoCount += 1;
  return `${outputBase}_files/${postDirName}/${fileName}`;
}

function localZipPhotoFromEntry(entry, postIndex, photoIndex) {
  if (!maybeZipPath) return '';
  const raw = String(entry || '').trim();
  if (/^https?:\/\//i.test(raw) || raw.startsWith('data:')) return '';
  const normalized = raw.replace(/^\.?\//, '');
  const onDisk = path.join(assetDir, normalized);
  if (fs.existsSync(onDisk)) {
    zipPhotoCount += 1;
    return `${outputBase}_files/${normalized}`;
  }
  return localZipPhotoPath(postIndex, photoIndex);
}

const cards = posts
  .map((post, index) => {
    const links = post.external_links || [];
    const photos = post.photos || [];
    const photoGrid = photos.length
      ? `<div class="photos">${photos
          .map(
            (url, photoIndex) => `
              ${(() => {
                const localPath = localZipPhotoFromEntry(url, index, photoIndex);
                if (maybeZipPath && !localPath) {
                  missingZipPhotos.push({ post: index + 1, photo: photoIndex + 1, url });
                }
                const imageSrc = localPath || url;
                return `<a class="photo" href="${attr(imageSrc)}" target="_blank" rel="noreferrer">
                <img src="${attr(imageSrc)}" loading="lazy" alt="Post ${index + 1} photo ${photoIndex + 1}">
              </a>`;
              })()}`
          )
          .join('')}</div>`
      : '';
    const linkList = links.length
      ? `<div class="links">${links
          .map(
            (url) =>
              `<a href="${attr(url)}" target="_blank" rel="noreferrer">${escapeHtml(url)}</a>`
          )
          .join('')}</div>`
      : '';
    const timestampClass = isTimestampLike(post.timestamp) ? '' : ' suspect';
    return `
      <article class="post">
        <header>
          <div>
            <a class="permalink" href="${attr(post.permalink)}" target="_blank" rel="noreferrer">Post ${index + 1}</a>
            <span class="type">${escapeHtml(post.post_type || 'post')}</span>
          </div>
          <div class="timestamp${timestampClass}">${escapeHtml(post.timestamp || '')}</div>
        </header>
        <p class="text">${escapeHtml(post.text || '').replaceAll('\n', '<br>')}</p>
        ${linkList}
        ${photoGrid}
      </article>`;
  })
  .join('\n');

const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Facebook group export ${escapeHtml(meta.group_id || '')}</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f5f7f8;
      --panel: #ffffff;
      --text: #1f2933;
      --muted: #65727f;
      --line: #d9e0e6;
      --accent: #1b74e4;
      --warn: #9a5b00;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      line-height: 1.45;
    }
    main {
      width: min(1120px, calc(100% - 32px));
      margin: 28px auto 56px;
    }
    h1 {
      margin: 0 0 6px;
      font-size: 26px;
      line-height: 1.2;
      letter-spacing: 0;
    }
    .meta {
      color: var(--muted);
      margin-bottom: 18px;
    }
    .summary {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: 10px;
      margin-bottom: 18px;
    }
    .stat, .warning, .post {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
    }
    .stat {
      padding: 12px;
    }
    .stat strong {
      display: block;
      font-size: 22px;
      line-height: 1.1;
    }
    .stat span, .timestamp, .type {
      color: var(--muted);
      font-size: 13px;
    }
    .warnings {
      display: grid;
      gap: 8px;
      margin-bottom: 18px;
    }
    .warning {
      padding: 10px 12px;
      color: var(--warn);
      background: #fff8e8;
      border-color: #f0d28a;
    }
    .post {
      padding: 14px;
      margin-bottom: 12px;
    }
    .post header {
      display: flex;
      gap: 12px;
      justify-content: space-between;
      align-items: baseline;
      border-bottom: 1px solid var(--line);
      padding-bottom: 8px;
      margin-bottom: 10px;
    }
    .permalink {
      color: var(--accent);
      font-weight: 700;
      text-decoration: none;
    }
    .type {
      margin-left: 8px;
      text-transform: uppercase;
      font-weight: 700;
      font-size: 11px;
    }
    .timestamp.suspect {
      color: var(--warn);
    }
    .text {
      white-space: normal;
      margin: 0 0 10px;
    }
    .links {
      display: grid;
      gap: 6px;
      margin: 10px 0;
      overflow-wrap: anywhere;
    }
    .links a {
      color: var(--accent);
    }
    .photos {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
      gap: 8px;
      margin-top: 10px;
    }
    .photo {
      display: block;
      aspect-ratio: 1 / 1;
      background: #e8edf2;
      border: 1px solid var(--line);
      border-radius: 6px;
      overflow: hidden;
    }
    .photo img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }
    @media (max-width: 680px) {
      main { width: min(100% - 20px, 1120px); margin-top: 18px; }
      .post header { display: block; }
      .timestamp { margin-top: 4px; }
    }
  </style>
</head>
<body>
  <main>
    <h1>Facebook Group Export</h1>
    <div class="meta">
      Group ${escapeHtml(meta.group_id || '')} / User ${escapeHtml(meta.user_id || '')}
      · Exported ${escapeHtml(meta.exported_at || '')}
    </div>
    <section class="summary">
      <div class="stat"><strong>${posts.length}</strong><span>posts</span></div>
      <div class="stat"><strong>${allPhotos.length}</strong><span>photo URLs</span></div>
      <div class="stat"><strong>${uniquePhotos.size}</strong><span>unique photos</span></div>
      <div class="stat"><strong>${linkPosts.length}</strong><span>link posts</span></div>
      <div class="stat"><strong>${overFivePhotoPosts.length}</strong><span>posts with >5 photos</span></div>
      ${maybeZipPath ? `<div class="stat"><strong>${zipPhotoCount}</strong><span>local ZIP photos</span></div>` : ''}
    </section>
    <section class="warnings">
      ${badTimestamps.length ? `<div class="warning">${badTimestamps.length} posts have suspicious timestamp values.</div>` : ''}
      ${exactFivePhotoPosts.length ? `<div class="warning">${exactFivePhotoPosts.length} posts have exactly 5 photos; these may be capped multi-photo posts.</div>` : ''}
      ${missingZipPhotos.length ? `<div class="warning">${missingZipPhotos.length} JSON photos were not found in the ZIP extraction.</div>` : ''}
    </section>
    ${cards}
  </main>
</body>
</html>
`;

fs.writeFileSync(outputPath, html);
console.log(`Wrote ${path.resolve(outputPath)}`);
if (maybeZipPath) {
  console.log(`Extracted ZIP assets to ${assetDir}`);
  console.log(`Mapped ${zipPhotoCount}/${allPhotos.length} JSON photos to local ZIP files`);
  if (missingZipPhotos.length) {
    console.log(`Missing ZIP photos: ${JSON.stringify(missingZipPhotos.slice(0, 10))}`);
  }
}
