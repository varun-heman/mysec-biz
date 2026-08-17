#!/usr/bin/env node
/**
 * Step 13: news, per society and per builder.
 *
 * Three free, keyless sources, queried the same way for every society name and
 * every builder name, both scoped to Bengaluru:
 *
 * 1. Bing News RSS. The primary daily source. Its result links are unwrapped
 *    to the publisher URL before storage.
 * 2. GDELT 2.0 Document API. Full text search back to 2017, JSON, no key.
 *    Rate limited to one request every 5 seconds in practice.
 * 3. Google News RSS. A second opinion alongside GDELT, since a single source
 *    of name matching against a common word produces false positives either
 *    way.
 *
 * None of the sources knows what a society or a builder is: each performs an
 * exact-name search scoped to Bengaluru. Results are attached to the entity
 * whose query found them only when the name is visible in the headline or RSS
 * snippet. The match location is stored for audit. Headlines are tagged as crime,
 * accident, award, legal, civic or general news.
 *
 * What survives both is stored with its publisher, date, link, a category and
 * the exact query that found it, and marked unreviewed. Nothing here is a
 * confirmed incident until a person reads the article and says so. See
 * SOURCES.md.
 *
 * Each surviving article also gets a link preview image, the way a chat app
 * builds a card: the publisher page's og:image, read from its HTML and stored
 * as a URL only. Nothing is downloaded or kept; the browser fetches it
 * straight from the publisher when the card is on screen. A publisher with no
 * og:image falls back to the first photo-sized <img> in the article body,
 * skipping logos, icons and tracking pixels by size and by filename.
 *
 * Society and builder news are stored separately in data/news.json, since a
 * builder query (e.g. "Prestige Group") is shared by every society that
 * builder built rather than repeated per society.
 *
 * Meant to be run periodically (a weekly cron is enough): rerunning merges in
 * whatever is new and leaves already seen articles, their reviewed flag and
 * their image, alone.
 *
 * Usage:
 *   node 13-news.js                     # every society and every builder
 *   node 13-news.js --societies-only    # skip builder queries
 *   node 13-news.js --builders-only     # skip society queries
 *   node 13-news.js --gdelt-only        # use only GDELT
 *   node 13-news.js --google-only       # use only Google News RSS
 *   node 13-news.js --bing-only         # use only Bing News RSS
 *   node 13-news.js --bing-first        # use GDELT only when Bing fails
 *   node 13-news.js --google-first      # use GDELT only when Google fails
 *   node 13-news.js --no-images         # skip the og:image lookup
 *   node 13-news.js --retries 3         # retry each source on transient errors (default 2)
 *   node 13-news.js --failure-limit 3   # disable an unavailable source for the rest of this run
 *   node 13-news.js --start 200 --limit 100   # a batch, for splitting a run
 *   node 13-news.js --since 2y          # widen the search window (default 1y)
 *
 * Full run, all sources, all 1116 societies plus ~260 builders: a couple of
 * hours, almost all of it GDELT's 5 second throttle. Split it with
 * --start/--limit across cron windows if that is too long in one sitting.
 */

const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, '..', 'data');
const OUT = path.join(DATA, 'news.json');
const UA = 'sauron-mysecurity/0.1 (society research; contact varun@agami.in)';

const GDELT = 'https://api.gdeltproject.org/api/v2/doc/doc';
const GOOGLE_NEWS = 'https://news.google.com/rss/search';
const BING_NEWS = 'https://www.bing.com/news/search';

const GDELT_PAUSE_MS = 5200;   // "one request every 5 seconds" per SOURCES.md
const GOOGLE_PAUSE_MS = 500;
const BING_PAUSE_MS = 750;
const MAX_PER_QUERY = 20;
const REQUEST_TIMEOUT_MS = 10000;

function arg(flag, fallback = null) {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] : fallback;
}
const START = Number(arg('--start', 0)) || 0;
const LIMIT = Number(arg('--limit', 0)) || Infinity;
const SOCIETIES_ONLY = process.argv.includes('--societies-only');
const BUILDERS_ONLY = process.argv.includes('--builders-only');
const GDELT_ONLY = process.argv.includes('--gdelt-only');
const GOOGLE_ONLY = process.argv.includes('--google-only');
const BING_ONLY = process.argv.includes('--bing-only');
const GOOGLE_FIRST = process.argv.includes('--google-first');
const BING_FIRST = process.argv.includes('--bing-first');
const SINCE = arg('--since', '1y'); // GDELT timespan syntax: 1y, 6m, 30d
const WITH_IMAGES = !process.argv.includes('--no-images');
const RETRIES = Math.max(1, Number(arg('--retries', 2)) || 2);
const FAILURE_LIMIT = Math.max(1, Number(arg('--failure-limit', 3)) || 3);

const MODES = [GDELT_ONLY, GOOGLE_ONLY, BING_ONLY, GOOGLE_FIRST, BING_FIRST].filter(Boolean).length;
if (MODES > 1) throw new Error('choose only one source mode flag');

let RUN_GDELT = true;
let RUN_GOOGLE = true;
let RUN_BING = true;
if (GDELT_ONLY) { RUN_GOOGLE = false; RUN_BING = false; }
if (GOOGLE_ONLY) { RUN_GDELT = false; RUN_BING = false; }
if (BING_ONLY) { RUN_GDELT = false; RUN_GOOGLE = false; }
if (GOOGLE_FIRST) { RUN_BING = false; }
if (BING_FIRST) { RUN_GOOGLE = false; }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sourceHealth = {
  gdelt: { consecutiveFailures: 0, disabled: false },
  'google-news': { consecutiveFailures: 0, disabled: false },
  'bing-news': { consecutiveFailures: 0, disabled: false },
};

/* -------------------------------------------------------------- helpers */

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decodeEntities(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/, '$1')
    .replace(/&(#(\d+)|#x([0-9a-f]+)|(\w+));/gi, (m, _all, dec, hex, name) => {
      if (dec) return String.fromCodePoint(Number(dec));
      if (hex) return String.fromCodePoint(parseInt(hex, 16));
      return ENTITIES[name.toLowerCase()] ?? m;
    })
    .replace(/<[^>]+>/g, '')
    .trim();
}

function domain(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return null; }
}

/** Keep the entity name exact while making the city a separate required term.
 *  Headlines rarely contain the unnatural exact phrase "<name> Bengaluru". */
function scopedQuery(query) {
  const city = ' Bengaluru';
  if (query.endsWith(city)) return `"${query.slice(0, -city.length)}" Bengaluru`;
  return `"${query}"`;
}

/** News feeds surface "Headline - Publisher" style titles and
 *  different URLs for the same story; this key catches most cross-source
 *  duplicates without needing to resolve redirects. */
function dedupeKey(a) {
  const title = a.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 80);
  return `${a.domain || a.source || domain(a.link) || ''}|${title}`;
}

/* ---------------------------------------------------------- relevance */

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

// Trailing words that describe the kind of place rather than naming it, so
// they rarely survive into a headline: "Prestige Shantiniketan Residential
// Complex" is "Prestige Shantiniketan" in every story about it.
const GENERIC_SUFFIX = new Set([
  'apartments', 'apartment', 'residency', 'residencies', 'residences', 'residence',
  'enclave', 'layout', 'society', 'complex', 'homes', 'home', 'gardens', 'garden',
  'county', 'towers', 'tower', 'city', 'park', 'phase', 'block', 'villa', 'villas',
  'heights', 'residential', 'address', 'greens', 'meadows', 'woods', 'residencia',
  'group', 'developers', 'developer', 'builders', 'builder', 'realty', 'estates',
  'properties', 'projects', 'constructions', 'infra', 'infrastructure', 'ltd', 'limited',
]);

function coreName(name) {
  const words = norm(name).split(' ').filter(Boolean);
  while (words.length > 2 && GENERIC_SUFFIX.has(words[words.length - 1])) words.pop();
  return words;
}

/** True only if the headline itself names the place, not just its body text.
 *  This is what filters out "senior citizen wins tax case" stories that
 *  mention a society once, deep in an unrelated article, as the location of
 *  the property in question. */
function titleMentions(title, name) {
  const words = coreName(name);
  if (!words.length) return false;
  const t = ` ${norm(title)} `;
  if (t.includes(` ${words.join(' ')} `)) return true;
  return words.length >= 2 && t.includes(` ${words.slice(0, 2).join(' ')} `);
}

/* What actually concerns the people living there: crime and safety, accidents
 * and disasters, recognition, and the legal or civic disputes that show up at
 * an RWA meeting. Market commentary, launches and generic real estate news do
 * not qualify on their own. */
const TOPICS = [
  { key: 'crime', label: 'Crime', re: /\b(crime|theft|stolen|steal|robbery|robbed|burgl(?:ar|e)|murder|killed|kill(?:ing|ed)?|stabb\w*|assault\w*|molest\w*|harass\w*|rape\w*|fraud\w*|cheat(?:ed|ing)?|scam\w*|extort\w*|arrest\w*|police complaint|FIR filed|kidnap\w*|shoot\w*|firing|attack\w*|vandal\w*|break-?in|intruder|trespass\w*|watchman|security guard)\b/i },
  { key: 'accident', label: 'Accident', re: /\b(fire\b|blaze|gutted|caught fire|collapse\w*|flood\w*|waterlogg\w*|drown\w*|electrocut\w*|gas leak|explosion|blast\b|short circuit|elevator|lift trapped|wall collapse|mishap|accident\w*|injured|casualt\w*|died|death|fatal\w*)\b/i },
  { key: 'award', label: 'Award', re: /\b(award\w*|felicitat\w*|recogni[sz]\w*|ranking|ranked|best society|honou?red|wins? (?:the|an|a)?\s*award|title of)\b/i },
  { key: 'legal', label: 'Legal', re: /\b(RERA|court|lawsuit|litigation|violat\w*|illegal\w*|demoli\w*|BBMP notice|BDA notice|eviction\w*|penalty|fined|fine of)\b/i },
  { key: 'civic', label: 'Civic', re: /\b(water shortage|water crisis|power cut|outage|garbage|sewage|drainage|pothole\w*|encroach\w*|protest\w*|stir\b|agitation|dispute\w*|RWA)\b/i },
];
const classify = (title) => TOPICS.find((t) => t.re.test(title))?.key || null;

// Exact Bing queries for these names still collide with a common place, car,
// person, or company. Suppress society-level attachment rather than present a
// confident but wrong tag. Builder-level queries remain unaffected.
const AMBIGUOUS_SOCIETY_NAMES = new Set([
  'phase 2',
  'aura',
  'golden star',
  'adarsh nagar',
  'puravankara',
  'the embassy',
]);

const isAmbiguousSocietyName = (name) => AMBIGUOUS_SOCIETY_NAMES.has(norm(name));

/* --------------------------------------------------------- link preview */

const OG_META_RE = [
  /<meta[^>]+(?:property|name)=["'](?:og:image(?::secure_url)?|twitter:image)["'][^>]+content=["']([^"']+)["']/i,
  /<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:image(?::secure_url)?|twitter:image)["']/i,
];

/** Filenames and classes that mark an <img> as UI chrome (logo, icon, avatar,
 *  ad slot, tracking pixel) rather than a photo from the article itself. */
const CHROME_IMAGE_RE = /logo|sprite|icon(?!-\d)|avatar|placeholder|1x1|blank\.gif|spacer|badge|advert|banner-ad|tracking|pixel\.|favicon/i;

/** The first photo-sized image in the article body: not a logo, icon or
 *  tracking pixel, and not so small it is obviously a UI element. Images
 *  without a width/height attribute are kept, since most publishers omit
 *  them for responsive markup rather than for small chrome. */
function firstBodyImage(html, baseUrl) {
  for (const [tag] of html.matchAll(/<img\b[^>]*>/gi)) {
    if (CHROME_IMAGE_RE.test(tag)) continue;
    const w = Number((tag.match(/\bwidth=["']?(\d+)/i) || [])[1]);
    const h = Number((tag.match(/\bheight=["']?(\d+)/i) || [])[1]);
    if ((w && w < 150) || (h && h < 150)) continue;
    const src = (tag.match(/\bsrc=["']([^"'\s]+)["']/i)
      || tag.match(/\bdata-src=["']([^"'\s]+)["']/i)
      || tag.match(/\bsrcset=["']([^"'\s,]+)/i) || [])[1];
    if (!src || src.startsWith('data:') || CHROME_IMAGE_RE.test(src)) continue;
    try { return new URL(src, baseUrl).href; } catch { continue; }
  }
  return null;
}

/** The url an og:image / twitter:image points to, the way a chat app builds a
 *  link preview, or the first real photo in the article body when a
 *  publisher sets neither. Never downloaded or stored, just linked; the
 *  browser fetches it directly from the publisher when the card is on
 *  screen. */
async function ogImage(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow', signal: controller.signal });
    if (!res.ok || !res.body) return null;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let html = '';
    let headSeen = false;
    // Most publishers set og:image, so the fast path stops at </head>. Only
    // a publisher with no meta tag pays for reading further into the body.
    while (html.length < 400000) {
      const { done, value } = await reader.read();
      if (done) break;
      html += decoder.decode(value, { stream: true });
      if (!headSeen && /<\/head>/i.test(html)) {
        headSeen = true;
        const meta = OG_META_RE[0].exec(html) || OG_META_RE[1].exec(html);
        if (meta) { reader.cancel().catch(() => {}); return new URL(meta[1], res.url).href; }
      }
      if (headSeen && /<\/body>/i.test(html)) break;
    }
    reader.cancel().catch(() => {});
    if (!headSeen) {
      const meta = OG_META_RE[0].exec(html) || OG_META_RE[1].exec(html);
      if (meta) return new URL(meta[1], res.url).href;
    }
    return firstBodyImage(html, res.url);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/* ---------------------------------------------------------------- GDELT */

async function gdelt(query) {
  const url = `${GDELT}?query=${encodeURIComponent(scopedQuery(query))}` +
    `&mode=artlist&maxrecords=${MAX_PER_QUERY}&format=json&timespan=${SINCE}&sort=hybridrel`;
  const res = await fetch(url, {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`gdelt ${res.status}`);
  const text = await res.text();
  if (!text.trim()) return [];
  let json;
  try { json = JSON.parse(text); } catch { throw new Error('gdelt: non-json response (likely rate limited)'); }
  return (json.articles || []).map((a) => ({
    title: decodeEntities(a.title),
    link: a.url,
    domain: a.domain || domain(a.url),
    published_at: /^\d{8}T\d{6}Z$/.test(a.seendate)
      ? `${a.seendate.slice(0, 4)}-${a.seendate.slice(4, 6)}-${a.seendate.slice(6, 8)}T${a.seendate.slice(9, 11)}:${a.seendate.slice(11, 13)}:${a.seendate.slice(13, 15)}Z`
      : null,
    snippet: null,
    found_via: 'gdelt',
  }));
}

/* --------------------------------------------------------- Google News */

async function googleNews(query) {
  const url = `${GOOGLE_NEWS}?q=${encodeURIComponent(`${scopedQuery(query)} when:${SINCE}`)}&hl=en-IN&gl=IN&ceid=IN:en`;
  const res = await fetch(url, {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`google-news ${res.status}`);
  const xml = await res.text();
  const items = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
  return items.slice(0, MAX_PER_QUERY).map((item) => {
    const tag = (name) => item.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`))?.[1];
    const sourceTag = item.match(/<source url="([^"]*)">([\s\S]*?)<\/source>/);
    const rawTitle = decodeEntities(tag('title') || '');
    const link = decodeEntities(tag('link') || '');
    const pubDate = tag('pubDate');
    return {
      title: rawTitle,
      link,
      domain: sourceTag ? domain(sourceTag[1]) : domain(link),
      published_at: pubDate && !Number.isNaN(Date.parse(pubDate)) ? new Date(pubDate).toISOString() : null,
      snippet: null,
      found_via: 'google-news',
    };
  });
}

/* ----------------------------------------------------------- Bing News */

function bingInterval(since) {
  const match = String(since).toLowerCase().match(/^(\d+)(d|w|m|y)$/);
  if (!match) return null;
  const [, amount, unit] = match;
  const days = Number(amount) * ({ d: 1, w: 7, m: 30, y: 365 }[unit]);
  if (days <= 1) return '7';
  if (days <= 7) return '8';
  if (days <= 30) return '9';
  return null;
}

function unwrapBingLink(link) {
  try {
    const parsed = new URL(link);
    if (parsed.hostname.endsWith('bing.com') && parsed.pathname === '/news/apiclick.aspx') {
      return parsed.searchParams.get('url') || link;
    }
  } catch {}
  return link;
}

function parseBingRss(xml) {
  const items = String(xml).match(/<item>[\s\S]*?<\/item>/g) || [];
  return items.slice(0, MAX_PER_QUERY).map((item) => {
    const tag = (name) => item.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'))?.[1];
    const title = decodeEntities(tag('title') || '');
    const rssLink = decodeEntities(tag('link') || '');
    const link = unwrapBingLink(rssLink);
    const pubDate = tag('pubDate');
    return {
      title,
      link,
      domain: domain(link),
      published_at: pubDate && !Number.isNaN(Date.parse(pubDate)) ? new Date(pubDate).toISOString() : null,
      snippet: decodeEntities(tag('description') || '') || null,
      found_via: 'bing-news',
    };
  }).filter((article) => article.title && article.link);
}

async function bingNews(query) {
  const qft = [`sortbydate="1"`];
  const interval = bingInterval(SINCE);
  if (interval) qft.push(`interval="${interval}"`);
  const params = new URLSearchParams({
    q: scopedQuery(query),
    qft: qft.join(' '),
    format: 'rss',
    cc: 'IN',
    setlang: 'en',
  });
  const res = await fetch(`${BING_NEWS}?${params}`, {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`bing-news ${res.status}`);
  const xml = await res.text();
  if (!/<rss(?:\s|>)/i.test(xml)) throw new Error('bing-news returned a non-RSS response');
  return parseBingRss(xml);
}

/* ------------------------------------------------------------------ run */

async function withRetries(source, request) {
  const health = sourceHealth[source];
  if (health.disabled) {
    throw new Error(`${source}: disabled after ${FAILURE_LIMIT} consecutive failed queries`);
  }

  let lastError;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      const result = await request();
      health.consecutiveFailures = 0;
      return result;
    } catch (err) {
      lastError = err;
      if (attempt < RETRIES) await sleep(1000 * (2 ** (attempt - 1)));
    }
  }
  health.consecutiveFailures++;
  if (health.consecutiveFailures >= FAILURE_LIMIT) health.disabled = true;
  throw new Error(`${source}: ${lastError?.message || 'request failed'}`);
}

async function runQuery(query, name, type) {
  const results = [];
  const succeeded = [];
  const errors = [];

  async function tryGdelt() {
    try {
      results.push(...await withRetries('gdelt', () => gdelt(query)));
      succeeded.push('gdelt');
    } catch (err) {
      errors.push(err.message);
      process.stdout.write(`${err.message} `);
    }
    await sleep(GDELT_PAUSE_MS);
  }

  async function tryGoogle() {
    try {
      results.push(...await withRetries('google-news', () => googleNews(query)));
      succeeded.push('google-news');
    } catch (err) {
      errors.push(err.message);
      process.stdout.write(`${err.message} `);
    }
    await sleep(GOOGLE_PAUSE_MS);
  }

  async function tryBing() {
    try {
      results.push(...await withRetries('bing-news', () => bingNews(query)));
      succeeded.push('bing-news');
    } catch (err) {
      errors.push(err.message);
      process.stdout.write(`${err.message} `);
    }
    await sleep(BING_PAUSE_MS);
  }

  if (BING_FIRST) {
    await tryBing();
    if (!succeeded.length) await tryGdelt();
  } else if (GOOGLE_FIRST) {
    await tryGoogle();
    if (!succeeded.length) await tryGdelt();
  } else {
    if (RUN_GDELT) await tryGdelt();
    if (RUN_GOOGLE) await tryGoogle();
    if (RUN_BING) await tryBing();
  }
  const articles = results
    .map((a) => ({
      ...a,
      category: classify(a.title) || 'general',
      matched_by: titleMentions(a.title, name)
        ? 'headline'
        : titleMentions(a.snippet || '', name) ? 'snippet' : null,
    }))
    .filter((a) => a.matched_by);
  return { articles: type === 'society' && isAmbiguousSocietyName(name) ? [] : articles, succeeded, errors };
}

/** Merge freshly fetched articles into whatever is already on file for this
 *  key, keeping first_seen_at, reviewed and image for anything already known,
 *  and unioning found_via across sources and runs. Fetches a link preview
 *  image only for articles genuinely new this run. */
async function merge(existing, fresh, query, now) {
  const byKey = new Map((existing || []).map((a) => [dedupeKey(a), a]));
  for (const a of fresh) {
    const k = dedupeKey(a);
    const prior = byKey.get(k);
    if (prior) {
      prior.found_via = [...new Set([...prior.found_via, a.found_via])];
      prior.category ||= a.category;
      if (a.matched_by === 'headline') prior.matched_by = 'headline';
    } else {
      byKey.set(k, {
        title: a.title,
        link: a.link,
        source: a.domain,
        published_at: a.published_at,
        snippet: a.snippet,
        category: a.category,
        matched_by: a.matched_by,
        image: WITH_IMAGES ? await ogImage(a.link) : null,
        query,
        found_via: [a.found_via],
        first_seen_at: now,
        reviewed: false,
      });
    }
  }
  return [...byKey.values()].sort((x, y) => (y.published_at || '').localeCompare(x.published_at || ''));
}

async function main() {
  const runStartedAt = new Date().toISOString();
  const societiesFile = JSON.parse(fs.readFileSync(path.join(DATA, 'societies.json'), 'utf8'));
  const news = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : { societies: {}, builders: {} };
  news.societies ||= {};
  news.builders ||= {};

  // Migrate prior Bing results to the same observable match rule used for
  // fresh results. Search-index-only hits cannot be audited and are dropped.
  for (const [type, store] of [['society', news.societies], ['builder', news.builders]]) {
    for (const entry of Object.values(store)) {
      entry.articles = (entry.articles || []).filter((article) => {
        if (type === 'society' && isAmbiguousSocietyName(entry.name)) return false;
        if (titleMentions(article.title, entry.name)) {
          article.matched_by = 'headline';
          return true;
        }
        if (titleMentions(article.snippet || '', entry.name)) {
          article.matched_by = 'snippet';
          return true;
        }
        return false;
      });
    }
  }

  const societies = societiesFile.societies.filter((s) => s.name);
  const builders = [...new Set(societies.map((s) => s.builder).filter(Boolean))].sort();

  const queue = [];
  if (!BUILDERS_ONLY) for (const s of societies) queue.push({ type: 'society', key: s.id, label: s.name, query: `${s.name} Bengaluru` });
  if (!SOCIETIES_ONLY) for (const b of builders) queue.push({ type: 'builder', key: b, label: b, query: `${b} Bengaluru` });

  const batch = queue.slice(START, START + LIMIT === Infinity ? undefined : START + LIMIT);
  console.log(`${batch.length} queries (${queue.length} total, starting at ${START}), sources: ${[RUN_BING && 'bing-news', RUN_GDELT && 'gdelt', RUN_GOOGLE && 'google-news'].filter(Boolean).join(' + ')}`);

  let withNew = 0, totalNew = 0;
  let succeeded = 0;
  const failures = [];

  for (const [i, item] of batch.entries()) {
    process.stdout.write(`[${START + i + 1}/${queue.length}] ${item.type[0]} ${item.label.slice(0, 40).padEnd(40)} `);
    const now = new Date().toISOString();
    const store = item.type === 'society' ? news.societies : news.builders;
    const before = store[item.key]?.articles || [];
    const result = await runQuery(item.query, item.label, item.type);
    if (!result.succeeded.length) {
      const message = result.errors.join('; ') || 'all configured sources failed';
      failures.push({ type: item.type, key: item.key, name: item.label, error: message });
      store[item.key] = {
        ...(store[item.key] || { name: item.label, articles: before }),
        last_error_at: now,
        last_error: message,
      };
      console.log(`FAILED (${message})`);
      if ((i + 1) % 20 === 0) writeNews(withMeta(news));
      continue;
    }

    succeeded++;
    const merged = await merge(before, result.articles, item.query, now);
    const added = merged.length - before.length;
    if (added > 0) { withNew++; totalNew += added; }
    store[item.key] = {
      name: item.label,
      articles: merged,
      last_checked_at: now,
      last_checked_sources: result.succeeded,
    };
    console.log(`${merged.length} articles${added > 0 ? ` (+${added} new)` : ''}`);

    if ((i + 1) % 20 === 0) writeNews(withMeta(news));
  }

  writeNews(withMeta(news));
  console.log(`\n${withNew} of ${batch.length} queries turned up new articles, ${totalNew} new articles total`);
  console.log(`${succeeded} succeeded, ${failures.length} failed`);
  console.log(`wrote ${OUT}`);

  if (failures.length) process.exitCode = 1;

  function writeNews(value) {
    const temp = `${OUT}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
    fs.renameSync(temp, OUT);
  }

  function withMeta(n) {
    const socArticles = Object.values(n.societies).reduce((s, v) => s + v.articles.length, 0);
    const bldArticles = Object.values(n.builders).reduce((s, v) => s + v.articles.length, 0);
    const lastRun = batch.length ? {
      started_at: runStartedAt,
      completed_at: new Date().toISOString(),
      start: START,
      requested: batch.length,
      succeeded,
      failed: failures.length,
      new_articles: totalNew,
      failures,
    } : n.last_run;
    if (lastRun) lastRun.retained_articles = socArticles + bldArticles;
    return {
      generated_at: new Date().toISOString(),
      method: 'Bing News RSS, GDELT Doc API and Google News RSS, queried per society name and per builder name, scoped to Bengaluru with "<name> Bengaluru". Keyword matching, not confirmed identification: every article carries its query and stays unreviewed until a person reads it. See SOURCES.md.',
      sources: [...new Set([...(n.sources || []), RUN_BING && 'bing-news-rss', RUN_GDELT && 'gdelt', RUN_GOOGLE && 'google-news-rss'].filter(Boolean))],
      window: SINCE,
      counts: {
        societies_queried: Object.keys(n.societies).length,
        builders_queried: Object.keys(n.builders).length,
        society_articles: socArticles,
        builder_articles: bldArticles,
      },
      last_run: lastRun,
      societies: n.societies,
      builders: n.builders,
    };
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}

module.exports = { bingInterval, classify, coreName, decodeEntities, dedupeKey, isAmbiguousSocietyName, norm, parseBingRss, scopedQuery, titleMentions, unwrapBingLink };
