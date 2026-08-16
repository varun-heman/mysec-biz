#!/usr/bin/env node
/**
 * Step 13: news, per society and per builder.
 *
 * Two free, keyless sources, queried the same way for every society name and
 * every builder name, both scoped to Bengaluru:
 *
 * 1. GDELT 2.0 Document API. Full text search back to 2017, JSON, no key.
 *    Rate limited to one request every 5 seconds in practice.
 * 2. Google News RSS. A second opinion alongside GDELT, since a single source
 *    of name matching against a common word produces false positives either
 *    way.
 *
 * Neither source knows what a society or a builder is: it is keyword search
 * against a name. "Prestige" and "Brigade" are also English words, and a lot
 * of society names repeat across cities. Two filters cut that down before
 * anything is kept:
 *
 * 1. The headline itself has to name the place, not just the article body.
 *    That is what drops the "senior citizen wins tax case" story that
 *    mentions a society once, deep in the text, as the address of the plot in
 *    question.
 * 2. The story has to be about something a resident would actually care
 *    about: crime and safety, accidents and disasters, awards and
 *    recognition, or the legal and civic disputes that show up at an RWA
 *    meeting. Generic real estate market coverage, launches and price
 *    commentary do not qualify on their own.
 *
 * What survives both is stored with its publisher, date, link, a category and
 * the exact query that found it, and marked unreviewed. Nothing here is a
 * confirmed incident until a person reads the article and says so. See
 * SOURCES.md.
 *
 * Each surviving article also gets a link preview image, the way a chat app
 * builds a card: the publisher page's og:image, read from its HTML and stored
 * as a URL only. Nothing is downloaded or kept; the browser fetches it
 * straight from the publisher when the card is on screen.
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
 *   node 13-news.js --gdelt-only        # skip Google News RSS
 *   node 13-news.js --google-only       # skip GDELT
 *   node 13-news.js --no-images         # skip the og:image lookup
 *   node 13-news.js --start 200 --limit 100   # a batch, for splitting a run
 *   node 13-news.js --since 2y          # widen the GDELT/Google window (default 1y)
 *
 * Full run, both sources, all 1116 societies plus ~260 builders: a couple of
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

const GDELT_PAUSE_MS = 5200;   // "one request every 5 seconds" per SOURCES.md
const GOOGLE_PAUSE_MS = 500;
const MAX_PER_QUERY = 20;

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
const SINCE = arg('--since', '1y'); // GDELT timespan syntax: 1y, 6m, 30d
const WITH_IMAGES = !process.argv.includes('--no-images');

const RUN_GDELT = !GOOGLE_ONLY;
const RUN_GOOGLE = !GDELT_ONLY;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

/** GDELT and Google News both surface "Headline - Publisher" style titles and
 *  different URLs for the same story; this key catches most cross-source
 *  duplicates without needing to resolve redirects. */
function dedupeKey(a) {
  const title = a.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 80);
  return `${a.domain || ''}|${title}`;
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

/* --------------------------------------------------------- link preview */

/** The url an og:image / twitter:image points to, the way a chat app builds a
 *  link preview. Never downloaded or stored, just linked; the browser fetches
 *  it directly from the publisher when the card is on screen. */
async function ogImage(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow', signal: controller.signal });
    if (!res.ok || !res.body) return null;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let html = '';
    while (html.length < 150000) {
      const { done, value } = await reader.read();
      if (done) break;
      html += decoder.decode(value, { stream: true });
      if (/<\/head>/i.test(html)) break;
    }
    reader.cancel().catch(() => {});
    const meta = html.match(/<meta[^>]+(?:property|name)=["'](?:og:image(?::secure_url)?|twitter:image)["'][^>]+content=["']([^"']+)["']/i)
      || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:image(?::secure_url)?|twitter:image)["']/i);
    if (!meta) return null;
    return new URL(meta[1], res.url).href;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/* ---------------------------------------------------------------- GDELT */

async function gdelt(query) {
  const url = `${GDELT}?query=${encodeURIComponent(`"${query}"`)}` +
    `&mode=artlist&maxrecords=${MAX_PER_QUERY}&format=json&timespan=${SINCE}&sort=hybridrel`;
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
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
  const url = `${GOOGLE_NEWS}?q=${encodeURIComponent(`"${query}" when:${SINCE}`)}&hl=en-IN&gl=IN&ceid=IN:en`;
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
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

/* ------------------------------------------------------------------ run */

async function runQuery(query, name) {
  const results = [];
  if (RUN_GDELT) {
    try { results.push(...await gdelt(query)); }
    catch (err) { process.stdout.write(`gdelt: ${err.message} `); }
    await sleep(GDELT_PAUSE_MS);
  }
  if (RUN_GOOGLE) {
    try { results.push(...await googleNews(query)); }
    catch (err) { process.stdout.write(`google: ${err.message} `); }
    await sleep(GOOGLE_PAUSE_MS);
  }
  // Keyword search turns up plenty that is not actually about the place, or
  // not the kind of thing anyone living there needs to know: require the
  // headline to name it, and require the story to be about something a
  // resident would care about.
  return results
    .filter((a) => titleMentions(a.title, name))
    .map((a) => ({ ...a, category: classify(a.title) }))
    .filter((a) => a.category);
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
    } else {
      byKey.set(k, {
        title: a.title,
        link: a.link,
        source: a.domain,
        published_at: a.published_at,
        category: a.category,
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

(async () => {
  const societiesFile = JSON.parse(fs.readFileSync(path.join(DATA, 'societies.json'), 'utf8'));
  const news = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : { societies: {}, builders: {} };
  news.societies ||= {};
  news.builders ||= {};

  const societies = societiesFile.societies.filter((s) => s.name);
  const builders = [...new Set(societies.map((s) => s.builder).filter(Boolean))].sort();

  const queue = [];
  if (!BUILDERS_ONLY) for (const s of societies) queue.push({ type: 'society', key: s.id, label: s.name, query: `${s.name} Bengaluru` });
  if (!SOCIETIES_ONLY) for (const b of builders) queue.push({ type: 'builder', key: b, label: b, query: `${b} Bengaluru` });

  const batch = queue.slice(START, START + LIMIT === Infinity ? undefined : START + LIMIT);
  console.log(`${batch.length} queries (${queue.length} total, starting at ${START}), sources: ${[RUN_GDELT && 'gdelt', RUN_GOOGLE && 'google-news'].filter(Boolean).join(' + ')}`);

  let withNew = 0, totalNew = 0;

  for (const [i, item] of batch.entries()) {
    process.stdout.write(`[${START + i + 1}/${queue.length}] ${item.type[0]} ${item.label.slice(0, 40).padEnd(40)} `);
    const now = new Date().toISOString();
    const store = item.type === 'society' ? news.societies : news.builders;
    const before = store[item.key]?.articles || [];
    const fresh = await runQuery(item.query, item.label);
    const merged = await merge(before, fresh, item.query, now);
    const added = merged.length - before.length;
    if (added > 0) { withNew++; totalNew += added; }
    store[item.key] = { name: item.label, articles: merged, last_checked_at: now };
    console.log(`${merged.length} articles${added > 0 ? ` (+${added} new)` : ''}`);

    if ((i + 1) % 20 === 0) fs.writeFileSync(OUT, JSON.stringify(withMeta(news), null, 2));
  }

  fs.writeFileSync(OUT, JSON.stringify(withMeta(news), null, 2));
  console.log(`\n${withNew} of ${batch.length} queries turned up new articles, ${totalNew} new articles total`);
  console.log(`wrote ${OUT}`);

  function withMeta(n) {
    const socArticles = Object.values(n.societies).reduce((s, v) => s + v.articles.length, 0);
    const bldArticles = Object.values(n.builders).reduce((s, v) => s + v.articles.length, 0);
    return {
      generated_at: new Date().toISOString(),
      method: 'GDELT Doc API and Google News RSS, queried per society name and per builder name, both scoped to Bengaluru with "<name> Bengaluru". Keyword matching, not confirmed identification: every article carries its query and stays unreviewed until a person reads it. See SOURCES.md.',
      sources: [RUN_GDELT && 'gdelt', RUN_GOOGLE && 'google-news-rss'].filter(Boolean),
      window: SINCE,
      counts: {
        societies_queried: Object.keys(n.societies).length,
        builders_queried: Object.keys(n.builders).length,
        society_articles: socArticles,
        builder_articles: bldArticles,
      },
      societies: n.societies,
      builders: n.builders,
    };
  }
})();
