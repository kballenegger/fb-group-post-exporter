#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

const DEFAULT_API_URL =
  process.env.LIJIANG_OPENAI_API_URL ||
  process.env.OPENAI_CHAT_COMPLETIONS_URL ||
  'http://100.99.209.82:8080/v1/chat/completions';
const DEFAULT_MODEL =
  process.env.LIJIANG_OPENAI_MODEL || 'qwen36-heretic-q4km.gguf';
const DEFAULT_TRAVEL_API_URL =
  process.env.KLAW_TRAVEL_API_URL || 'http://100.80.44.63:3030/api/travel';

function printUsage() {
  console.error(`Usage: node filter-hotel-reviews.mjs <export.json|export.zip> [options]

Options:
  --api-url <url>       OpenAI-compatible /v1/chat/completions URL
                        (default: ${DEFAULT_API_URL})
  --model <id>          Model id (default: ${DEFAULT_MODEL})
  --output <path>       JSON output path
                        (default: output/<input>-hotel-review-filter.json)
  --limit <n>           Classify at most n photo posts
  --offset <n>          Skip the first n photo posts before classifying
  --threshold <n>       Minimum confidence to include in hotel_reviews (default: 0.6)
  --max-tokens <n>      Max completion tokens for each classification (default: 800)
  --timeout-ms <n>      Per-request timeout (default: 120000)
  --retries <n>         Retry failed LLM calls (default: 1)
  --delay-ms <n>        Delay between LLM calls (default: 250)
  --from-filter <path>  Reuse a previous filter JSON instead of classifying
  --from-matches <path> Reuse previous stay-match JSON, useful for posting
  --match-stays         Match hotel reviews to travel stays
  --travel-api-url <url> Travel API base URL (default: ${DEFAULT_TRAVEL_API_URL})
  --travel-session <s>  klaw_session cookie value (or KLAW_SESSION env)
  --candidate-count <n> Stay candidates to send to the matcher (default: 30)
  --match-threshold <n> Minimum stay-match confidence (default: 0.55)
  --post-slack          Send matched reviews to Slack. Default is dry-run only.
  --slack-webhook-url <url> Slack incoming webhook URL (or SLACK_WEBHOOK_URL env)
  --slack-bot-token <xoxb> Slack bot token for local image uploads
                        (or SLACK_BOT_TOKEN env)
  --slack-channel-id <id> Slack channel id for bot file uploads
                        (or SLACK_CHANNEL_ID env)
  --slack-thread-ts <ts> Slack thread_ts for threaded webhook posting
  --slack-max-images <n> Max image blocks per Slack message (default: 10)
  --photo-zip <path>    ZIP containing local post photo paths for bot uploads
  --allow-text-only-local-images
                        Permit Slack posting when photos are local ZIP paths.
                        Local images cannot be uploaded by incoming webhooks.
  --no-llm              Only list posts with photos; do not call the API
  --no-output           Print summary only; do not write JSON
  --help                Show this help
`);
}

function parseArgs(argv) {
  const positional = [];
  const options = {};

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }

    const [rawKey, inlineValue] = arg.slice(2).split(/=(.*)/s, 2);
    if (!rawKey) continue;

    if (inlineValue !== undefined) {
      options[rawKey] = inlineValue;
    } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
      options[rawKey] = argv[i + 1];
      i += 1;
    } else {
      options[rawKey] = true;
    }
  }

  return { positional, options };
}

function numberOption(options, key, defaultValue) {
  if (options[key] === undefined || options[key] === true) return defaultValue;
  const value = Number(options[key]);
  if (!Number.isFinite(value)) {
    throw new Error(`--${key} must be a number`);
  }
  return value;
}

function readExport(inputPath) {
  if (/\.zip$/i.test(inputPath)) {
    const exportJson = spawnSync('unzip', ['-p', inputPath, 'export.json'], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024 * 100
    });

    if (exportJson.status === 0 && exportJson.stdout.trim()) {
      return JSON.parse(exportJson.stdout);
    }

    const manifestJson = spawnSync('unzip', ['-p', inputPath, 'manifest.json'], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024 * 100
    });

    if (manifestJson.status === 0 && manifestJson.stdout.trim()) {
      return { meta: {}, posts: JSON.parse(manifestJson.stdout) };
    }

    const details =
      exportJson.stderr || exportJson.stdout || manifestJson.stderr || manifestJson.stdout;
    throw new Error(`Could not read export.json from ${inputPath}${details ? `: ${details}` : ''}`);
  }

  return JSON.parse(fs.readFileSync(inputPath, 'utf8'));
}

function defaultOutputPath(inputPath) {
  const baseName = path.basename(inputPath).replace(/\.(json|zip)$/i, '');
  return path.join('output', `${baseName}-hotel-review-filter.json`);
}

function defaultMatchedOutputPath(inputPath) {
  const baseName = path.basename(inputPath).replace(/\.(json|zip)$/i, '');
  return path.join('output', `${baseName}-hotel-review-stay-matches.json`);
}

function postPhotoCount(post) {
  return Array.isArray(post.photos) ? post.photos.length : 0;
}

function photoPostSummary(post, index) {
  return {
    post_index: index + 1,
    permalink: post.permalink || '',
    timestamp: post.timestamp || '',
    text: post.text || '',
    post_type: post.post_type || '',
    external_links: Array.isArray(post.external_links) ? post.external_links : [],
    photos: Array.isArray(post.photos) ? post.photos : [],
    photo_count: postPhotoCount(post)
  };
}

function buildMessages(item) {
  const text = String(item.text || '').slice(0, 5000);
  const links = item.external_links.length ? item.external_links.join('\n') : '(none)';

  return [
    {
      role: 'system',
      content:
        'You classify Facebook group posts for a travel/hotel archive. A hotel review must be either: (1) a first-hand past/current hotel or lodging stay/property assessment, recommendation, complaint, or experience, including rooms, amenities, service, elite benefits, breakfast, lounge, internet, pool, value, or location; or (2) a short attached-photo post that explicitly names a hotel/lodging property and has no other non-hotel topic. First-hand hotel reviews can be very short and may omit the hotel name when the text clearly evaluates a property or stay, e.g. "lovely property", "new go-to", "solid", "good spot", or specific hotel benefits/amenities. Exclude questions/planning/options, even when a hotel is mentioned; airline fare deals; loyalty/status chatter by itself; Slack/admin posts; restaurant/drink/champagne-only posts; and vague captions. Never infer hotel context from travel-adjacent brands, cities, photo count, or photos alone. If uncertain, classify false with confidence below 0.6. Return only minified JSON with keys: is_hotel_review boolean, confidence number from 0 to 1, hotel_name string or null, location string or null, reason short string.'
    },
    {
      role: 'user',
      content: `Classify this post.

Post number: ${item.post_index}
Post type: ${item.post_type || '(unknown)'}
Photo count: ${item.photo_count}
Permalink: ${item.permalink || '(none)'}
External links:
${links}

Text:
${text || '(empty)'}

/no_think`
    }
  ];
}

function extractJsonObject(text) {
  const trimmed = String(text || '').trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');

  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`No JSON object found in model response: ${trimmed.slice(0, 240)}`);
  }

  return JSON.parse(candidate.slice(start, end + 1));
}

function normalizeClassification(raw) {
  return {
    is_hotel_review: Boolean(raw.is_hotel_review),
    confidence: Math.max(0, Math.min(1, Number(raw.confidence) || 0)),
    hotel_name: raw.hotel_name ? String(raw.hotel_name) : null,
    location: raw.location ? String(raw.location) : null,
    reason: raw.reason ? String(raw.reason) : ''
  };
}

function normalizeMatch(raw) {
  return {
    stay_id: raw.stay_id === null || raw.stay_id === undefined ? null : Number(raw.stay_id),
    confidence: Math.max(0, Math.min(1, Number(raw.confidence) || 0)),
    reason: raw.reason ? String(raw.reason) : ''
  };
}

function contentFromMessageContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (typeof part?.text === 'string') return part.text;
        if (typeof part?.content === 'string') return part.content;
        return '';
      })
      .join('');
  }
  return '';
}

function extractResponseContent(payload) {
  const choice = payload?.choices?.[0];
  return (
    contentFromMessageContent(choice?.message?.content) ||
    contentFromMessageContent(choice?.delta?.content) ||
    contentFromMessageContent(choice?.text) ||
    contentFromMessageContent(choice?.content) ||
    contentFromMessageContent(payload?.message?.content) ||
    contentFromMessageContent(payload?.content) ||
    contentFromMessageContent(payload?.response) ||
    contentFromMessageContent(payload?.completion) ||
    contentFromMessageContent(payload?.output_text)
  );
}

function attachRawResponse(error, rawResponse) {
  error.rawResponse = rawResponse;
  return error;
}

function safeResponseDiagnostics(responseText) {
  try {
    const payload = JSON.parse(responseText);
    for (const choice of payload.choices || []) {
      if (choice.message?.reasoning_content) {
        choice.message.reasoning_content = '[redacted reasoning_content]';
      }
      if (choice.delta?.reasoning_content) {
        choice.delta.reasoning_content = '[redacted reasoning_content]';
      }
    }
    return JSON.stringify(payload);
  } catch {
    return responseText.slice(0, 1000);
  }
}

function buildStayMatchMessages(review, candidates) {
  const text = String(review.text || '').slice(0, 5000);
  const candidateLines = candidates
    .map((stay) =>
      JSON.stringify({
        stay_id: stay.id,
        chain: stay.chain,
        property_name: stay.property_name,
        city: stay.city,
        checkin: stay.checkin,
        checkout: stay.checkout,
        nights: stay.nights,
        room_type: stay.room_type,
        rate_type: stay.rate_type,
        booking_notes: stay.booking_notes,
        upgrade: stay.upgrade
      })
    )
    .join('\n');

  return [
    {
      role: 'system',
      content:
        'You match a Facebook hotel review to one hotel stay record. Use explicit property names, city/location hints, chain/loyalty hints, amenities, benefits, room/rate notes, and review content. If multiple stays are equally plausible, choose the one with the oldest checkout date. If no candidate is a reasonable match, return stay_id null with confidence below 0.55. Return only minified JSON with keys: stay_id number or null, confidence number from 0 to 1, reason short string.'
    },
    {
      role: 'user',
      content: `Hotel review:
${JSON.stringify({
  post_index: review.post_index,
  text,
  classification: review.classification || null,
  photo_count: review.photo_count,
  permalink: review.permalink
})}

Candidate stays, sorted with stronger deterministic candidates first and older checkout dates preferred on ties:
${candidateLines || '(none)'}

/no_think`
    }
  ];
}

async function callJsonLlm(messages, options, maxTokens = 800) {
  const headers = {
    'content-type': 'application/json'
  };
  const apiKey = options['api-key'] || process.env.OPENAI_API_KEY || process.env.LIJIANG_OPENAI_API_KEY;
  if (apiKey) {
    headers.authorization = `Bearer ${apiKey}`;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);

  try {
    const response = await fetch(options.apiUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: options.model,
        messages,
        temperature: 0,
        max_tokens: maxTokens,
        chat_template_kwargs: {
          enable_thinking: false
        }
      }),
      signal: controller.signal
    });

    const responseText = await response.text();
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${responseText.slice(0, 500)}`);
    }

    const payload = JSON.parse(responseText);
    const content = extractResponseContent(payload);
    if (!content) {
      const diagnostics = safeResponseDiagnostics(responseText);
      throw attachRawResponse(
        new Error(`No message content found in API response: ${diagnostics.slice(0, 1000)}`),
        diagnostics
      );
    }

    try {
      return {
        parsed: extractJsonObject(content),
        raw_response: content
      };
    } catch (error) {
      throw attachRawResponse(error, content || responseText);
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function classifyWithLlm(item, options) {
  const result = await callJsonLlm(buildMessages(item), options, options.maxTokens);
  return {
    classification: normalizeClassification(result.parsed),
    raw_response: result.raw_response
  };
}

async function classifyWithRetries(item, options) {
  let lastError;

  for (let attempt = 0; attempt <= options.retries; attempt += 1) {
    try {
      return await classifyWithLlm(item, options);
    } catch (error) {
      lastError = error;
      if (attempt < options.retries) {
        await sleep(500 * (attempt + 1));
      }
    }
  }

  return {
    classification: {
      is_hotel_review: false,
      confidence: 0,
      hotel_name: null,
      location: null,
      reason: `classification failed: ${lastError.message}`
    },
    error: lastError.message,
    raw_response: lastError.rawResponse || ''
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeDateValue(value) {
  return String(value || '9999-99-99');
}

function splitUsefulWords(value) {
  const stop = new Set([
    'the',
    'hotel',
    'resort',
    'and',
    'at',
    'by',
    'a',
    'an',
    'of',
    'in',
    'hk',
    'sg'
  ]);
  return normalizeText(value)
    .split(' ')
    .filter((word) => word.length >= 3 && !stop.has(word));
}

function contentHints(review) {
  const pieces = [
    review.text,
    review.classification?.hotel_name,
    review.classification?.location
  ];
  const text = normalizeText(pieces.filter(Boolean).join(' '));
  const hints = new Set();

  if (/\bic\b/.test(text) || text.includes('intercontinental')) hints.add('ihg');
  if (text.includes('spire') || text.includes('ambassador') || text.includes('holiday inn')) hints.add('ihg');
  if (text.includes('shangri')) hints.add('shangrila');
  if (text.includes('hilton') || text.includes('conrad')) hints.add('hilton');
  if (text.includes('hyatt')) hints.add('hyatt');
  if (text.includes('marriott') || text.includes('st regis') || text.includes('meridien')) hints.add('marriott');
  if (/\bsf\b/.test(text)) hints.add('san francisco');
  if (text.includes('dtla')) hints.add('los angeles');
  if (text.includes('taipei')) hints.add('taipei');
  if (text.includes('sgd') || text.includes('singapore')) hints.add('singapore');

  return { text, hints };
}

function scoreStayCandidate(review, stay) {
  const { text, hints } = contentHints(review);
  const property = normalizeText(stay.property_name);
  const city = normalizeText(stay.city);
  const chain = normalizeText(stay.chain);
  const program = normalizeText(stay.program);
  const notes = normalizeText(stay.booking_notes);
  let score = 0;
  const reasons = [];

  if (property && text.includes(property)) {
    score += 15;
    reasons.push('property exact');
  }

  const propertyWords = splitUsefulWords(stay.property_name);
  const matchedPropertyWords = propertyWords.filter((word) => text.includes(word));
  if (matchedPropertyWords.length) {
    score += matchedPropertyWords.length * 2;
    reasons.push(`property words: ${matchedPropertyWords.join(', ')}`);
  }

  if (city && text.includes(city)) {
    score += 5;
    reasons.push('city exact');
  }
  if (city === 'sf' && hints.has('san francisco')) {
    score += 5;
    reasons.push('SF alias');
  }
  if ((city === 'sg' || city === 'singapore') && hints.has('singapore')) {
    score += 5;
    reasons.push('Singapore hint');
  }
  if ((city === 'la' || city === 'los angeles') && hints.has('los angeles')) {
    score += 5;
    reasons.push('Los Angeles hint');
  }

  if (chain && hints.has(chain)) {
    score += 4;
    reasons.push('chain hint');
  }
  if (program && hints.has(program)) {
    score += 4;
    reasons.push('program hint');
  }
  if ((chain === 'ihg' || program === 'ihg') && hints.has('ihg')) {
    score += 5;
    reasons.push('IHG status hint');
  }
  if (notes && splitUsefulWords(notes).some((word) => text.includes(word))) {
    score += 2;
    reasons.push('booking note overlap');
  }

  return { score, reasons };
}

function compareStayChronology(a, b) {
  const checkout = normalizeDateValue(a.checkout).localeCompare(normalizeDateValue(b.checkout));
  if (checkout !== 0) return checkout;
  const checkin = normalizeDateValue(a.checkin).localeCompare(normalizeDateValue(b.checkin));
  if (checkin !== 0) return checkin;
  return Number(a.id) - Number(b.id);
}

function selectStayCandidates(review, stays, count) {
  const scored = stays
    .map((stay) => {
      const candidate = scoreStayCandidate(review, stay);
      return { ...stay, candidate_score: candidate.score, candidate_reasons: candidate.reasons };
    })
    .filter((stay) => stay.candidate_score > 0)
    .sort((a, b) => b.candidate_score - a.candidate_score || compareStayChronology(a, b));

  if (scored.length >= count) return scored.slice(0, count);

  const already = new Set(scored.map((stay) => stay.id));
  const oldestBackfill = stays
    .filter((stay) => !already.has(stay.id))
    .sort(compareStayChronology)
    .slice(0, Math.max(0, count - scored.length))
    .map((stay) => ({ ...stay, candidate_score: 0, candidate_reasons: ['oldest backfill'] }));

  return [...scored, ...oldestBackfill];
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${url}: ${text.slice(0, 500)}`);
  }
  return JSON.parse(text);
}

function travelHeaders(options) {
  const session = options.travelSession || process.env.KLAW_SESSION;
  if (!session) {
    throw new Error('Missing travel API session. Pass --travel-session or set KLAW_SESSION.');
  }
  return {
    cookie: `klaw_session=${session}`
  };
}

async function fetchAllStays(options) {
  const baseUrl = String(options.travelApiUrl || DEFAULT_TRAVEL_API_URL).replace(/\/+$/, '');
  const headers = travelHeaders(options);
  const limit = 100;
  let offset = 0;
  let total = Infinity;
  const stays = [];

  while (offset < total) {
    const url = `${baseUrl}/stays?limit=${limit}&offset=${offset}`;
    const payload = await fetchJson(url, { headers });
    if (!payload.ok || !Array.isArray(payload.stays)) {
      throw new Error(`Unexpected stays response from ${url}`);
    }
    stays.push(...payload.stays);
    total = Number(payload.total) || stays.length;
    if (payload.stays.length === 0) break;
    offset += payload.stays.length;
  }

  return stays;
}

async function fetchStayDetail(stayId, options) {
  const baseUrl = String(options.travelApiUrl || DEFAULT_TRAVEL_API_URL).replace(/\/+$/, '');
  const payload = await fetchJson(`${baseUrl}/stays/${stayId}`, {
    headers: travelHeaders(options)
  });
  return payload.stay || null;
}

async function matchReviewToStay(review, stays, options) {
  const candidates = selectStayCandidates(review, stays, options.candidateCount);
  const result = await callJsonLlm(
    buildStayMatchMessages(review, candidates),
    options,
    options.maxTokens
  );
  const match = normalizeMatch(result.parsed);
  const stay = match.stay_id === null ? null : stays.find((item) => Number(item.id) === match.stay_id) || null;
  return {
    match,
    stay,
    candidates: candidates.map((candidate) => ({
      id: candidate.id,
      property_name: candidate.property_name,
      city: candidate.city,
      chain: candidate.chain,
      checkin: candidate.checkin,
      checkout: candidate.checkout,
      candidate_score: candidate.candidate_score,
      candidate_reasons: candidate.candidate_reasons
    })),
    raw_response: result.raw_response
  };
}

function loadFilterOutput(filterPath) {
  const data = JSON.parse(fs.readFileSync(filterPath, 'utf8'));
  if (!Array.isArray(data.hotel_reviews)) {
    throw new Error(`${filterPath} does not look like a hotel review filter output`);
  }
  return data;
}

function loadMatchedOutput(matchPath) {
  const data = JSON.parse(fs.readFileSync(matchPath, 'utf8'));
  if (!Array.isArray(data.matched_reviews)) {
    throw new Error(`${matchPath} does not look like a stay-match output`);
  }
  return data;
}

function readZipEntry(zipPath, entryPath) {
  const result = spawnSync('unzip', ['-p', zipPath, entryPath], {
    encoding: 'buffer',
    maxBuffer: 1024 * 1024 * 100
  });
  if (result.status !== 0 || !result.stdout?.length) {
    const details = result.stderr?.toString('utf8') || result.stdout?.toString('utf8') || '';
    throw new Error(`Could not read ${entryPath} from ${zipPath}${details ? `: ${details}` : ''}`);
  }
  return result.stdout;
}

function mimeTypeForPath(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  return 'image/jpeg';
}

function slackSafeText(value, maxLength = 2900) {
  const text = String(value || '').trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1)}…`;
}

function remoteImageUrls(review) {
  return (review.photos || []).filter((photo) => /^https:\/\//i.test(String(photo)));
}

function localImageRefs(review) {
  return (review.photos || []).filter((photo) => !/^https:\/\//i.test(String(photo)));
}

function buildSlackPayloads(matchedReview, options) {
  const { review, stay, match } = matchedReview;
  const checkout = stay?.checkout || 'unknown checkout date';
  const remoteImages = remoteImageUrls(review);
  const localImages = localImageRefs(review);
  const maxImages = options.slackMaxImages;
  const chunks = [];
  const imageChunks = remoteImages.length ? remoteImages : [null];

  for (let i = 0; i < imageChunks.length; i += maxImages) {
    chunks.push(imageChunks.slice(i, i + maxImages));
  }

  return chunks.map((imageChunk, index) => {
    const blocks = [];
    const partLabel = chunks.length > 1 ? ` (${index + 1}/${chunks.length})` : '';
    const title = `Imported hotel review by Kenneth from ${checkout}${partLabel}`;
    const details = stay
      ? `${stay.property_name || 'Unknown property'}${stay.city ? `, ${stay.city}` : ''} · ${stay.checkin || '?'} to ${stay.checkout || '?'} · stay ${stay.id}`
      : `No matched stay · confidence ${match.confidence.toFixed(2)}`;

    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${slackSafeText(title, 250)}*\n${slackSafeText(details, 500)}`
      }
    });

    if (index === 0) {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: slackSafeText(review.text)
        }
      });
      if (review.permalink) {
        blocks.push({
          type: 'context',
          elements: [{ type: 'mrkdwn', text: `<${review.permalink}|Facebook post> · match confidence ${match.confidence.toFixed(2)}` }]
        });
      }
      if (localImages.length) {
        blocks.push({
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: `Local ZIP photos not uploaded by webhook: ${slackSafeText(localImages.join(', '), 2500)}`
            }
          ]
        });
      }
    }

    for (const imageUrl of imageChunk.filter(Boolean)) {
      blocks.push({
        type: 'image',
        image_url: imageUrl,
        alt_text: `Hotel review photo for post ${review.post_index}`
      });
    }

    const payload = {
      text: `${title}\n${review.text || ''}`,
      blocks
    };
    if (options.slackThreadTs) {
      payload.thread_ts = options.slackThreadTs;
    }
    return payload;
  });
}

async function postSlackPayload(payload, options) {
  const webhookUrl = options.slackWebhookUrl || process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) {
    throw new Error('Missing Slack webhook URL. Pass --slack-webhook-url or set SLACK_WEBHOOK_URL.');
  }
  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const text = await response.text();
  if (!response.ok || text.trim() !== 'ok') {
    throw new Error(`Slack webhook failed with HTTP ${response.status}: ${text.slice(0, 500)}`);
  }
}

async function slackAuthTest(token) {
  const response = await fetch('https://slack.com/api/auth.test', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json; charset=utf-8'
    },
    body: '{}'
  });
  const text = await response.text();
  const payload = JSON.parse(text);
  if (!response.ok || !payload.ok) {
    throw new Error(`auth.test failed: ${text.slice(0, 1000)}`);
  }
  return payload;
}

async function slackApi(method, token, body) {
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(body || {})) {
    form.set(key, typeof value === 'string' ? value : JSON.stringify(value));
  }

  const response = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/x-www-form-urlencoded; charset=utf-8'
    },
    body: form
  });
  const text = await response.text();
  const payload = JSON.parse(text);
  if (!response.ok || !payload.ok) {
    throw new Error(`${method} failed: ${text.slice(0, 1000)}`);
  }
  return payload;
}

async function uploadFileBytesToSlack({ token, bytes, filename, title, altText }) {
  const ticket = await slackApi('files.getUploadURLExternal', token, {
    filename,
    length: bytes.length,
    alt_txt: altText
  });

  const uploadResponse = await fetch(ticket.upload_url, {
    method: 'POST',
    headers: {
      'content-type': mimeTypeForPath(filename)
    },
    body: bytes
  });
  const uploadText = await uploadResponse.text();
  if (!uploadResponse.ok) {
    throw new Error(`Slack file byte upload failed for ${filename}: ${uploadText.slice(0, 500)}`);
  }

  return {
    id: ticket.file_id,
    title
  };
}

function buildInitialComment(matchedReview, imageChunkIndex, imageChunkCount) {
  const { review, stay, match } = matchedReview;
  const checkout = stay?.checkout || 'unknown checkout date';
  const partLabel = imageChunkCount > 1 ? ` (${imageChunkIndex + 1}/${imageChunkCount})` : '';
  const stayLine = stay
    ? `${stay.property_name || 'Unknown property'}${stay.city ? `, ${stay.city}` : ''} · ${stay.checkin || '?'} to ${stay.checkout || '?'} · stay ${stay.id}`
    : `No matched stay · confidence ${match.confidence.toFixed(2)}`;
  const linkLine = review.permalink ? `\n${review.permalink}` : '';

  return slackSafeText(
    `Imported hotel review by Kenneth from ${checkout}${partLabel}\n${stayLine}\n\n${review.text || ''}${linkLine}`,
    3900
  );
}

async function postSlackReviewWithBot(matchedReview, options) {
  const token = options.slackBotToken || process.env.SLACK_BOT_TOKEN;
  const channelId = options.slackChannelId || process.env.SLACK_CHANNEL_ID;
  if (!token) {
    throw new Error('Missing Slack bot token. Pass --slack-bot-token or set SLACK_BOT_TOKEN.');
  }
  if (!channelId) {
    throw new Error('Missing Slack channel id. Pass --slack-channel-id or set SLACK_CHANNEL_ID.');
  }
  if (!options.photoZip) {
    throw new Error('Missing photo ZIP for local image uploads. Pass --photo-zip <export.zip>.');
  }

  const localImages = localImageRefs(matchedReview.review);
  const remoteImages = remoteImageUrls(matchedReview.review);
  if (remoteImages.length) {
    throw new Error('Bot upload path currently expects local ZIP image paths, not remote image URLs.');
  }

  const chunks = [];
  for (let i = 0; i < localImages.length; i += options.slackMaxImages) {
    chunks.push(localImages.slice(i, i + options.slackMaxImages));
  }
  if (!chunks.length) chunks.push([]);

  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
    const files = [];
    const chunk = chunks[chunkIndex];
    for (let i = 0; i < chunk.length; i += 1) {
      const photoPath = chunk[i];
      const bytes = readZipEntry(options.photoZip, photoPath);
      const filename = path.basename(photoPath);
      files.push(
        await uploadFileBytesToSlack({
          token,
          bytes,
          filename,
          title: `${matchedReview.stay?.property_name || `post-${matchedReview.review.post_index}`} ${filename}`,
          altText: `Hotel review photo ${i + 1} for post ${matchedReview.review.post_index}`
        })
      );
    }

    if (files.length) {
      await slackApi('files.completeUploadExternal', token, {
        files,
        channel_id: channelId,
        thread_ts: options.slackThreadTs,
        initial_comment: buildInitialComment(matchedReview, chunkIndex, chunks.length)
      });
    } else {
      await slackApi('chat.postMessage', token, {
        channel: channelId,
        thread_ts: options.slackThreadTs,
        text: buildInitialComment(matchedReview, chunkIndex, chunks.length)
      });
    }
  }
}

async function main() {
  const { positional, options: rawOptions } = parseArgs(process.argv.slice(2));

  if (rawOptions.help || (positional.length === 0 && !rawOptions['from-filter'] && !rawOptions['from-matches'])) {
    printUsage();
    process.exit(positional.length === 0 && !rawOptions['from-filter'] && !rawOptions['from-matches'] ? 1 : 0);
  }

  const inputPath = positional[0] || rawOptions['from-filter'] || rawOptions['from-matches'];
  const threshold = numberOption(rawOptions, 'threshold', 0.6);
  const limit = Math.max(0, Math.floor(numberOption(rawOptions, 'limit', Infinity)));
  const offset = Math.max(0, Math.floor(numberOption(rawOptions, 'offset', 0)));
  const delayMs = Math.max(0, Math.floor(numberOption(rawOptions, 'delay-ms', 250)));
  const outputPath = rawOptions.output || defaultOutputPath(inputPath);
  const matchOutputPath = rawOptions['match-output'] || defaultMatchedOutputPath(inputPath);
  const options = {
    ...rawOptions,
    apiUrl: rawOptions['api-url'] || DEFAULT_API_URL,
    model: rawOptions.model || DEFAULT_MODEL,
    maxTokens: Math.max(1, Math.floor(numberOption(rawOptions, 'max-tokens', 800))),
    timeoutMs: Math.max(1000, Math.floor(numberOption(rawOptions, 'timeout-ms', 120000))),
    retries: Math.max(0, Math.floor(numberOption(rawOptions, 'retries', 1))),
    travelApiUrl: rawOptions['travel-api-url'] || DEFAULT_TRAVEL_API_URL,
    travelSession: rawOptions['travel-session'] || process.env.KLAW_SESSION,
    candidateCount: Math.max(1, Math.floor(numberOption(rawOptions, 'candidate-count', 30))),
    matchThreshold: numberOption(rawOptions, 'match-threshold', 0.55),
    slackWebhookUrl: rawOptions['slack-webhook-url'] || process.env.SLACK_WEBHOOK_URL,
    slackBotToken: rawOptions['slack-bot-token'] || process.env.SLACK_BOT_TOKEN,
    slackChannelId: rawOptions['slack-channel-id'] || process.env.SLACK_CHANNEL_ID,
    slackThreadTs: rawOptions['slack-thread-ts'] || process.env.SLACK_THREAD_TS,
    slackMaxImages: Math.max(1, Math.floor(numberOption(rawOptions, 'slack-max-images', 10))),
    photoZip: rawOptions['photo-zip'] || process.env.PHOTO_ZIP
  };

  if (rawOptions['from-matches']) {
    const matchedOutput = loadMatchedOutput(rawOptions['from-matches']);
    const acceptedReviews = matchedOutput.matched_reviews.filter((item) => item.accepted);
    const localImageReviewCount = acceptedReviews.filter((item) => localImageRefs(item.review).length).length;
    console.log(`Loaded ${acceptedReviews.length} accepted stay matches from ${rawOptions['from-matches']}`);

    if (rawOptions['post-slack']) {
      const canUploadLocalImages = Boolean(options.slackBotToken);
      if (localImageReviewCount && !canUploadLocalImages && !rawOptions['allow-text-only-local-images']) {
        throw new Error(
          `${localImageReviewCount} matched reviews only have local ZIP photo paths. Incoming webhooks cannot upload local images; pass --allow-text-only-local-images to post text with local image references, or use a Slack bot token/public image URLs.`
        );
      }

      if (canUploadLocalImages) {
        const auth = await slackAuthTest(options.slackBotToken);
        console.log(`Slack auth ok for ${auth.user} in team ${auth.team}`);
        for (let i = 0; i < acceptedReviews.length; i += 1) {
          await postSlackReviewWithBot(acceptedReviews[i], options);
          console.log(`Posted Slack review ${i + 1}/${acceptedReviews.length} with bot file upload`);
        }
      } else {
        const payloads = matchedOutput.slack_payloads || acceptedReviews.flatMap((item) => buildSlackPayloads(item, options));
        for (let i = 0; i < payloads.length; i += 1) {
          await postSlackPayload(payloads[i], options);
          console.log(`Posted Slack message ${i + 1}/${payloads.length}`);
        }
      }

      matchedOutput.meta = matchedOutput.meta || {};
      matchedOutput.meta.slack_posted = true;
      matchedOutput.meta.slack_posted_at = new Date().toISOString();
      if (!rawOptions['no-output']) {
        fs.writeFileSync(rawOptions['from-matches'], `${JSON.stringify(matchedOutput, null, 2)}\n`);
      }
    } else {
      console.log(`Dry run only. Use --post-slack to send ${acceptedReviews.length} Slack review(s).`);
      if (localImageReviewCount) {
        console.log(`${localImageReviewCount} accepted reviews have local ZIP photo paths.`);
      }
    }
    return;
  }

  let output;

  if (rawOptions['from-filter']) {
    output = loadFilterOutput(rawOptions['from-filter']);
    console.log(`Loaded ${output.hotel_reviews.length} hotel reviews from ${rawOptions['from-filter']}`);
  } else {
    const data = readExport(inputPath);
    const posts = Array.isArray(data.posts) ? data.posts : [];
    const photoPosts = posts
      .map((post, index) => ({ post, index }))
      .filter(({ post }) => postPhotoCount(post) > 0)
      .map(({ post, index }) => photoPostSummary(post, index));
    const selectedPhotoPosts = photoPosts.slice(offset, Number.isFinite(limit) ? offset + limit : undefined);

    console.log(`Loaded ${posts.length} posts from ${inputPath}`);
    console.log(`Skipping ${posts.length - photoPosts.length} posts without photos`);
    console.log(`Classifying ${selectedPhotoPosts.length}/${photoPosts.length} posts with photos`);

    const results = [];

    for (let i = 0; i < selectedPhotoPosts.length; i += 1) {
      const item = selectedPhotoPosts[i];
      let result;

      if (rawOptions['no-llm']) {
        result = {
          classification: {
            is_hotel_review: null,
            confidence: 0,
            hotel_name: null,
            location: null,
            reason: 'LLM disabled by --no-llm'
          },
          raw_response: ''
        };
      } else {
        result = await classifyWithRetries(item, options);
      }

      const classification = result.classification;
      results.push({
        ...item,
        classification,
        error: result.error || null,
        raw_response: result.raw_response
      });

      const label =
        classification.is_hotel_review === true
          ? 'HOTEL'
          : classification.is_hotel_review === false
            ? 'skip'
            : 'photo';
      const confidence = classification.confidence.toFixed(2);
      console.log(
        `[${i + 1}/${selectedPhotoPosts.length}] post ${item.post_index}: ${label} (${confidence}) ${classification.reason}`
      );

      if (delayMs && i + 1 < selectedPhotoPosts.length && !rawOptions['no-llm']) {
        await sleep(delayMs);
      }
    }

    const hotelReviews = results.filter(
      (item) => item.classification.is_hotel_review && item.classification.confidence >= threshold
    );
    output = {
      meta: {
        created_at: new Date().toISOString(),
        input: inputPath,
        api_url: rawOptions['no-llm'] ? null : options.apiUrl,
        model: rawOptions['no-llm'] ? null : options.model,
        threshold,
        total_posts: posts.length,
        skipped_without_photos: posts.length - photoPosts.length,
        photo_posts: photoPosts.length,
        classified_posts: results.length,
        hotel_review_count: hotelReviews.length
      },
      hotel_reviews: hotelReviews,
      classified_photo_posts: results
    };

    console.log(`Hotel reviews at confidence >= ${threshold}: ${hotelReviews.length}`);

    if (!rawOptions['no-output']) {
      fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
      fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
      console.log(`Wrote ${path.resolve(outputPath)}`);
    }
  }

  if (rawOptions['match-stays'] || rawOptions['post-slack']) {
    const hotelReviews = output.hotel_reviews || [];
    console.log(`Fetching travel stays for ${hotelReviews.length} hotel reviews`);
    const stays = await fetchAllStays(options);
    console.log(`Fetched ${stays.length} stays`);

    const matchedReviews = [];
    for (let i = 0; i < hotelReviews.length; i += 1) {
      const review = hotelReviews[i];
      const result = await matchReviewToStay(review, stays, options);
      let detail = result.stay;
      const accepted =
        result.stay &&
        result.match.stay_id !== null &&
        result.match.confidence >= options.matchThreshold;

      if (accepted) {
        detail = (await fetchStayDetail(result.stay.id, options)) || result.stay;
      }

      matchedReviews.push({
        review,
        match: result.match,
        stay: detail,
        accepted,
        candidates: result.candidates,
        raw_match_response: result.raw_response
      });

      const label = accepted ? 'MATCH' : 'no match';
      const stayLabel = detail
        ? `${detail.id} ${detail.property_name || ''} ${detail.city || ''} ${detail.checkout || ''}`.trim()
        : 'none';
      console.log(
        `[${i + 1}/${hotelReviews.length}] post ${review.post_index}: ${label} (${result.match.confidence.toFixed(2)}) ${stayLabel} - ${result.match.reason}`
      );
    }

    const acceptedReviews = matchedReviews.filter((item) => item.accepted);
    const localImageReviewCount = acceptedReviews.filter((item) => localImageRefs(item.review).length).length;
    const matchedOutput = {
      meta: {
        created_at: new Date().toISOString(),
        input: inputPath,
        filter_input: rawOptions['from-filter'] || null,
        travel_api_url: options.travelApiUrl,
        total_stays: stays.length,
        hotel_review_count: hotelReviews.length,
        accepted_match_count: acceptedReviews.length,
        match_threshold: options.matchThreshold,
        slack_posted: false
      },
      matched_reviews: matchedReviews,
      slack_payloads: acceptedReviews.flatMap((item) => buildSlackPayloads(item, options))
    };

    if (!rawOptions['no-output']) {
      fs.mkdirSync(path.dirname(path.resolve(matchOutputPath)), { recursive: true });
      fs.writeFileSync(matchOutputPath, `${JSON.stringify(matchedOutput, null, 2)}\n`);
      console.log(`Wrote ${path.resolve(matchOutputPath)}`);
    }

    if (rawOptions['post-slack']) {
      const canUploadLocalImages = Boolean(options.slackBotToken);
      if (localImageReviewCount && !canUploadLocalImages && !rawOptions['allow-text-only-local-images']) {
        throw new Error(
          `${localImageReviewCount} matched reviews only have local ZIP photo paths. Incoming webhooks cannot upload local images; pass --allow-text-only-local-images to post text with local image references, or use a Slack bot token/public image URLs.`
        );
      }

      if (canUploadLocalImages) {
        for (let i = 0; i < acceptedReviews.length; i += 1) {
          await postSlackReviewWithBot(acceptedReviews[i], options);
          console.log(`Posted Slack review ${i + 1}/${acceptedReviews.length} with bot file upload`);
        }
      } else {
        for (let i = 0; i < matchedOutput.slack_payloads.length; i += 1) {
          await postSlackPayload(matchedOutput.slack_payloads[i], options);
          console.log(`Posted Slack message ${i + 1}/${matchedOutput.slack_payloads.length}`);
        }
      }
      matchedOutput.meta.slack_posted = true;
      if (!rawOptions['no-output']) {
        fs.writeFileSync(matchOutputPath, `${JSON.stringify(matchedOutput, null, 2)}\n`);
      }
    } else {
      console.log(
        `Dry run only. Use --post-slack to send ${matchedOutput.slack_payloads.length} Slack message(s).`
      );
      if (localImageReviewCount) {
        console.log(
          `Note: ${localImageReviewCount} matched reviews have local ZIP photo paths; incoming webhooks cannot upload those images.`
        );
      }
    }
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
