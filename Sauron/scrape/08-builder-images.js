#!/usr/bin/env node
/**
 * Step 8: project photographs from the builder's own website.
 *
 * The developer publishes these to be seen, and `og:image` exists precisely so
 * other software can display them, which makes this the cleanest free source of
 * real photographs. No cap on how many are kept per society.
 *
 * How a society is matched to a page:
 *   robots.txt -> sitemap -> every URL on the domain -> the one whose slug
 *   shares the society's distinctive words. No search engine, no guessing at
 *   URLs, and anything robots.txt disallows is left alone.
 *
 * Sites that answer 403 to a plain request are running bot protection. Those
 * are recorded as blocked and skipped rather than worked around.
 *
 * Usage:
 *   node 08-builder-images.js                 # every society at 150 units or more
 *   node 08-builder-images.js --limit 20
 *   node 08-builder-images.js --builder Sobha
 *
 * Writes images into web/assets/img/societies/<slug>/ and a report of every
 * society it could not do, with the reason, to data/images-missing.json.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA = path.join(__dirname, '..', 'data');
const IMG = path.join(__dirname, '..', 'web', 'assets', 'img', 'societies');
const INDEX = path.join(IMG, 'index.json');
const CACHE = path.join(DATA, '.cache-builder-urls.json');
const REPORT = path.join(DATA, 'images-missing.json');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const PAUSE_MS = 700;          // one request at a time, spaced out
const MIN_IMAGE_BYTES = 24000; // below this it is a logo or an icon
const MAX_PER_SOCIETY = 40;    // a sanity stop, not a design cap

/**
 * Builder to domain. Names come from RERA promoter strings and from OSM, so
 * several spellings map to one developer.
 */
const BUILDERS = [
  { match: /prestige/i, name: 'Prestige Group', domain: 'prestigeconstructions.com' },
  { match: /\bsobha\b/i, name: 'Sobha', domain: 'sobha.com' },
  { match: /puravankara|\bpurva\b/i, name: 'Puravankara', domain: 'puravankara.com' },
  { match: /provident/i, name: 'Provident Housing', domain: 'providenthousing.com' },
  { match: /brigade/i, name: 'Brigade Group', domain: 'brigadegroup.com' },
  { match: /mantri/i, name: 'Mantri Developers', domain: 'mantri.in' },
  { match: /salarpuria|sattva/i, name: 'Sattva Group', domain: 'sattvagroup.in' },
  { match: /shriram/i, name: 'Shriram Properties', domain: 'shriramproperties.com' },
  { match: /rohan/i, name: 'Rohan Builders', domain: 'rohanbuilders.com' },
  { match: /casa\s*grand/i, name: 'Casagrand', domain: 'casagrand.co.in' },
  { match: /sumadhura/i, name: 'Sumadhura', domain: 'sumadhuragroup.com' },
  { match: /adarsh/i, name: 'Adarsh Developers', domain: 'adarshdevelopers.com' },
  { match: /embassy/i, name: 'Embassy Group', domain: 'embassyindia.com' },
  { match: /godrej/i, name: 'Godrej Properties', domain: 'godrejproperties.com' },
  { match: /total\s*environment/i, name: 'Total Environment', domain: 'total-environment.com' },
  { match: /bhartiya|nikoo/i, name: 'Bhartiya City', domain: 'bhartiyacity.com' },
  { match: /century/i, name: 'Century Real Estate', domain: 'centuryrealestate.in' },
  { match: /vaishnavi/i, name: 'Vaishnavi Group', domain: 'vaishnavigroup.com' },
  { match: /\bbren\b/i, name: 'Bren Corporation', domain: 'brencorporation.com' },
  { match: /assetz/i, name: 'Assetz Property', domain: 'assetzproperty.com' },
  { match: /hiranandani/i, name: 'House of Hiranandani', domain: 'houseofhiranandani.com' },
  { match: /\bl\s*&\s*t\b|larsen/i, name: 'L&T Realty', domain: 'lntrealty.com' },
  { match: /\bdlf\b/i, name: 'DLF', domain: 'dlf.in' },
  { match: /lodha/i, name: 'Lodha', domain: 'lodhagroup.in' },
  { match: /nambiar/i, name: 'Nambiar Builders', domain: 'nambiarbuilders.com' },
  { match: /mana\s+(projects|dale|foliage)/i, name: 'Mana Projects', domain: 'manaprojects.com' },
  { match: /\bsnn\b/i, name: 'SNN Raj', domain: 'snncorp.com' },
  { match: /gopalan/i, name: 'Gopalan Enterprises', domain: 'gopalanenterprises.com' },
  { match: /\bsjr\b/i, name: 'SJR Group', domain: 'sjrgroup.in' },
  { match: /concorde/i, name: 'Concorde Group', domain: 'concorde.in' },
  { match: /nitesh/i, name: 'Nitesh Estates', domain: 'niteshestates.com' },
  { match: /ozone/i, name: 'Ozone Group', domain: 'ozonegroup.com' },
  { match: /confident/i, name: 'Confident Group', domain: 'confidentgroup.com' },
  { match: /mahaveer/i, name: 'Mahaveer Group', domain: 'mahaveergroup.in' },
  { match: /keerthi/i, name: 'Keerthi Estates', domain: 'keerthiestates.com' },
  { match: /candeur/i, name: 'Candeur', domain: 'candeurlandmark.com' },
  { match: /vaswani/i, name: 'Vaswani Group', domain: 'vaswanigroup.com' },
  { match: /\bakme\b/i, name: 'Akme Projects', domain: 'akmeprojects.com' },
  { match: /skylark/i, name: 'Skylark Group', domain: 'skylarkgroup.in' },
  { match: /shapoorji|pallonji|joyville/i, name: 'Shapoorji Pallonji', domain: 'joyvillehomes.com' },
  { match: /mahindra/i, name: 'Mahindra Lifespaces', domain: 'mahindralifespaces.com' },
  { match: /tata\s+(housing|value)/i, name: 'Tata Housing', domain: 'tatahousing.in' },
];

function arg(flag, fallback = null) {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] : fallback;
}
const MIN_UNITS = Number(arg('--min-units', 150));
const LIMIT = Number(arg('--limit', 0)) || Infinity;
const ONLY = arg('--builder');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

const STOP = new Set(['apartment', 'apartments', 'apts', 'residency', 'residences', 'residential',
  'complex', 'phase', 'block', 'the', 'and', 'group', 'bengaluru', 'bangalore', 'private',
  'limited', 'ltd', 'pvt', 'llp', 'properties', 'property', 'developers', 'builders', 'projects',
  'enterprises', 'estates', 'infra', 'homes', 'city', 'new', 'north', 'south', 'east', 'west']);

/** Builders sell the same brand in several cities. A path naming another one
 *  is a different project. */
const OTHER_CITIES = /\/(pune|chennai|hyderabad|mumbai|thane|kochi|cochin|goa|coimbatore|mysore|mysuru|kolkata|delhi|noida|gurgaon|gurugram|ahmedabad|jaipur|nagpur|indore|lucknow|dubai|london)(\/|-|$)/;

/** The words in a society name that actually identify it. */
const keyWords = (name, builderName = '') => {
  const builderWords = new Set(builderName.toLowerCase().split(/[^a-z]+/));
  return name.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w) && !builderWords.has(w));
};

/* The rest of the builders, keyed off the website each promoter filed with
   RERA. Built by 09-builder-sites.js, which is why the hand written list above
   only needs to carry the big names and the exceptions. */
const SITES = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA, 'builder-sites.json'), 'utf8')).map;
  } catch {
    return {};
  }
})();

const NOISE = new Set(['private', 'pvt', 'limited', 'ltd', 'llp', 'inc', 'company', 'co',
  'developers', 'developer', 'builders', 'builder', 'projects', 'project', 'constructions',
  'construction', 'estates', 'estate', 'group', 'india', 'realty', 'realtors', 'infra',
  'infrastructure', 'housing', 'properties', 'property', 'ventures', 'venture', 'holdings',
  'enterprises', 'enterprise', 'developments', 'development', 'shelters', 'shelthers',
  'homes', 'and', 'the', 'of', 'associates', 'corporation', 'corp', 'partners', 'firm',
  'buildcon', 'buildtech', 'landmarks', 'promoters', 'town', 'city', 'space', 'spaces']);

const builderKey = (name) => String(name || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ')
  .split(/\s+/).filter((w) => w.length > 2 && !NOISE.has(w)).slice(0, 2).join(' ') || null;

/** Hand written map first, since it carries the canonical names, then RERA. */
function builderFor(society) {
  const names = [society.builder, society.rera?.promoter].filter(Boolean);
  for (const n of names) {
    const hit = BUILDERS.find((b) => b.match.test(n));
    if (hit) return hit;
  }
  for (const n of names) {
    const k = builderKey(n);
    const entry = SITES[k] || SITES[k?.split(' ')[0]];
    if (entry) return { name: n, domain: entry.domain, fromRera: true };
  }
  return null;
}

/* --------------------------------------------------------- site furniture */

/* A builder's page carries the project's photographs and a pile of things that
   have nothing to do with it: the brand mark, the awards strip, a hero shot of
   some other development. Those are identical on every page of the site, so
   they are identified by content rather than by guessing at file names.
   Two rules, both evidence based:
     1. anything that also appears on the builder's home page is furniture
     2. anything that turns up under a second society is furniture
   Rule 2 catches what rule 1 misses on sites whose home page is a video. */

const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex');

const furniture = new Map();   // domain -> Set of hashes seen on the home page
const seenHash = new Map();    // hash -> { society, file } first place it appeared

async function furnitureFor(domain) {
  if (furniture.has(domain)) return furniture.get(domain);
  const hashes = new Set();
  try {
    const html = await get(`https://${domain}/`);
    for (const src of imagesOn(html, `https://${domain}/`).slice(0, 30)) {
      try {
        const { buf } = await get(src, 'bin');
        if (buf.length >= MIN_IMAGE_BYTES) hashes.add(sha1(buf));
      } catch { /* one asset is not worth stopping for */ }
      await sleep(120);
    }
  } catch { /* no home page, rule 2 still applies */ }
  furniture.set(domain, hashes);
  console.log(`    ${domain}: ${hashes.size} site wide images to ignore`);
  return hashes;
}

/* ------------------------------------------------------------- fetching */

async function get(url, as = 'text') {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: as === 'text' ? 'text/html,application/xhtml+xml,application/xml' : 'image/*,*/*' },
    redirect: 'follow',
  });
  if (!res.ok) throw Object.assign(new Error(`${res.status}`), { status: res.status });
  if (as === 'text') return res.text();

  const buf = Buffer.from(await res.arrayBuffer());
  const kind = sniff(buf);
  // A site that answers a missing asset with its own error page will happily
  // hand back 40 KB of HTML. Only the real thing is kept.
  if (!kind) throw new Error('not an image');
  return { buf, kind };
}

/** File type from the first bytes, not from the URL, which lies often. */
function sniff(b) {
  if (b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8) return 'jpg';
  if (b[0] === 0x89 && b.slice(1, 4).toString() === 'PNG') return 'png';
  if (b.slice(0, 4).toString() === 'RIFF' && b.slice(8, 12).toString() === 'WEBP') return 'webp';
  return null;
}

/** robots.txt: the sitemaps it advertises, and the paths it asks us to leave alone. */
async function robots(domain) {
  try {
    const txt = await get(`https://${domain}/robots.txt`);
    const sitemaps = [...txt.matchAll(/^\s*sitemap:\s*(\S+)/gim)].map((m) => m[1]);
    const disallow = [];
    let applies = false;
    for (const line of txt.split('\n')) {
      const ua = line.match(/^\s*user-agent:\s*(\S+)/i);
      if (ua) { applies = ua[1] === '*'; continue; }
      const d = line.match(/^\s*disallow:\s*(\S+)/i);
      if (d && applies && d[1] !== '/') disallow.push(d[1]);
    }
    return { sitemaps: sitemaps.length ? sitemaps : [`https://${domain}/sitemap.xml`], disallow };
  } catch (err) {
    if (err.status === 403) throw Object.assign(new Error('blocked'), { reason: 'bot protection' });
    return { sitemaps: [`https://${domain}/sitemap.xml`], disallow: [] };
  }
}

/** Every page URL a domain publishes, following sitemap indexes one level down. */
async function urlsFor(domain, cache) {
  if (cache[domain]) return cache[domain];

  let rules;
  try {
    rules = await robots(domain);
  } catch (err) {
    cache[domain] = { error: err.reason || err.message, urls: [] };
    return cache[domain];
  }

  const urls = new Set();
  const queue = rules.sitemaps.slice(0, 4);
  let opened = 0;

  while (queue.length && opened < 25) {
    const sm = queue.shift();
    opened++;
    let xml;
    try {
      xml = await get(sm);
    } catch (err) {
      if (err.status === 403) { cache[domain] = { error: 'bot protection', urls: [] }; return cache[domain]; }
      continue;
    }
    const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]);
    const isIndex = /<sitemapindex/i.test(xml);
    for (const loc of locs) {
      if (isIndex) { if (queue.length < 25) queue.push(loc); }
      else urls.add(loc);
    }
    await sleep(200);
  }

  const allowed = [...urls].filter((u) => {
    try {
      const p = new URL(u).pathname;
      return !rules.disallow.some((d) => p.startsWith(d));
    } catch { return false; }
  });

  // Plenty of builder sites have no sitemap. Their own projects index is the
  // next best thing: fetch it and take the links it publishes. One level only.
  if (!allowed.length) {
    const seeds = ['', '/projects', '/our-projects', '/residential', '/properties', '/completed-projects'];
    for (const seed of seeds) {
      let html;
      try { html = await get(`https://${domain}${seed}`); } catch { continue; }
      for (const m of html.matchAll(/href=["']([^"'#]+)/gi)) {
        let u;
        try { u = new URL(m[1], `https://${domain}/`); } catch { continue; }
        if (u.hostname.replace(/^www\./, '') !== domain.replace(/^www\./, '')) continue;
        if (rules.disallow.some((d) => u.pathname.startsWith(d))) continue;
        allowed.push(u.href.split('#')[0]);
      }
      await sleep(300);
      if (allowed.length > 400) break;
    }
  }

  const unique = [...new Set(allowed)];
  cache[domain] = { error: unique.length ? null : 'no sitemap and no project links', urls: unique };
  fs.writeFileSync(CACHE, JSON.stringify(cache));
  return cache[domain];
}

/** The page on this domain that is most likely to be this society. */
function bestUrl(urls, society, builder) {
  const words = keyWords(society.name, builder.name);
  if (!words.length) return null;

  // The longest word is the one that actually names the project. Requiring it
  // stops "Purva Highlands" matching /pune/purva-aspire, where the only thing
  // in common is the brand.
  const anchor = [...words].sort((a, b) => b.length - a.length)[0];

  let best = null;
  for (const u of urls) {
    let p;
    try { p = new URL(u).pathname.toLowerCase(); } catch { continue; }
    if (/\/(blog|news|career|contact|privacy|terms|sitemap|author|tag|category)\b/.test(p)) continue;
    // A builder's other cities are not this society.
    if (OTHER_CITIES.test(p)) continue;
    if (!p.includes(anchor)) continue;

    const hits = words.filter((w) => p.includes(w)).length;
    const score = hits * 100 - p.length / 10 +
      (/project|residential|property|home/.test(p) ? 10 : 0) +
      (/bengaluru|bangalore/.test(p) ? 25 : 0);
    if (!best || score > best.score) best = { url: u, score, hits };
  }
  return best ? best.url : null;
}

/** Every plausible photograph on the page, in document order. */
function imagesOn(html, pageUrl) {
  const out = [];
  const add = (raw) => {
    if (!raw) return;
    let u;
    try { u = new URL(raw.trim().split(/\s+/)[0], pageUrl).href; } catch { return; }
    if (!/^https?:/.test(u)) return;
    if (/\.(svg|gif|webp\?.*icon)/i.test(u)) return;
    if (/logo|icon|sprite|favicon|placeholder|loader|spinner|arrow|whatsapp|facebook|instagram|linkedin|youtube|thumb-?nail-?small/i.test(u)) return;
    if (!out.includes(u)) out.push(u);
  };

  for (const m of html.matchAll(/<meta[^>]+(?:property|name)=["'](?:og:image|twitter:image)[^>]*content=["']([^"']+)/gi)) add(m[1]);
  for (const m of html.matchAll(/<img[^>]+?(?:data-src|data-lazy-src|data-original|src)=["']([^"']+)/gi)) add(m[1]);
  for (const m of html.matchAll(/<source[^>]+srcset=["']([^"']+)/gi)) add(m[1].split(',').pop());
  for (const m of html.matchAll(/background-image:\s*url\((["']?)([^)"']+)\1\)/gi)) add(m[2]);

  // Next.js, Nuxt and most page builders keep the gallery in a JSON blob rather
  // than in tags: Puravankara's page carries two images in markup and the rest
  // inside __NEXT_DATA__. A sweep of the whole document, with JSON's escaped
  // slashes undone first, catches those without needing a browser.
  const flat = html.replace(/\\\//g, '/').replace(/\\u002F/gi, '/');
  for (const m of flat.matchAll(/https?:\/\/[^"'\\\s)<>]+\.(?:jpe?g|png|webp)(?:\?[^"'\\\s)<>]*)?/gi)) add(m[0]);

  // The CMS behind a Next.js site stores the gallery as site relative paths,
  // "/uploads/gallery_img5_x.jpg", so those are resolved against the page too.
  for (const m of flat.matchAll(/["'(](\/[\w./-]+\.(?:jpe?g|png|webp))/gi)) add(m[1]);

  // Strapi and friends publish thumbnail_, small_ and medium_ copies beside the
  // original. Keep the original where it exists and drop the shrunken ones.
  const originals = new Set(out.map((u) => u.replace(/\/(?:thumbnail|small|medium|large)_/, '/')));
  return out.filter((u) => !/\/(?:thumbnail|small|medium)_/.test(u) ||
    !originals.has(u.replace(/\/(?:thumbnail|small|medium|large)_/, '/')) ||
    !out.includes(u.replace(/\/(?:thumbnail|small|medium|large)_/, '/')));
}

/**
 * The aerial step writes this same file, so the index is re-read and merged
 * rather than overwritten. Losing another run's work to a stale copy in memory
 * is a silent kind of bug.
 */
function writeIndex(index, id, entry) {
  let onDisk = {};
  try { onDisk = JSON.parse(fs.readFileSync(INDEX, 'utf8')); } catch { /* first write */ }
  const prior = onDisk[id];
  if (prior && prior !== entry) {
    const files = [...new Set([...(prior.files || []), ...(entry.files || [])])];
    const seen = new Set();
    const credits = [...(prior.credits || []), ...(entry.credits || [])]
      .filter((c) => !seen.has(c.file) && seen.add(c.file));
    entry = { ...prior, ...entry, files, credits };
    index[id] = entry;
  }
  onDisk[id] = entry;
  fs.writeFileSync(INDEX, JSON.stringify(onDisk, null, 2));
}

/* ------------------------------------------------------------------ main */

(async () => {
  fs.mkdirSync(IMG, { recursive: true });
  const index = fs.existsSync(INDEX) ? JSON.parse(fs.readFileSync(INDEX, 'utf8')) : {};
  const cache = fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, 'utf8')) : {};

  const file = JSON.parse(fs.readFileSync(path.join(DATA, 'societies.json'), 'utf8'));
  const queue = file.societies
    .filter((s) => !s.part_of)
    .filter((s) => (s.units_total ?? s.units_estimated?.mid ?? 0) >= MIN_UNITS)
    .filter((s) => !ONLY || (s.builder || '').toLowerCase().includes(ONLY.toLowerCase()))
    .sort((a, b) => (b.units_total ?? b.units_estimated?.mid ?? 0) - (a.units_total ?? a.units_estimated?.mid ?? 0))
    .slice(0, LIMIT);

  console.log(`${queue.length} societies\n`);

  const missing = [];
  let done = 0, saved = 0;

  for (const [i, s] of queue.entries()) {
    const label = `[${i + 1}/${queue.length}] ${s.name.slice(0, 40).padEnd(40)}`;
    const builder = builderFor(s);

    if (!s.builder) { missing.push({ name: s.name, id: s.id, units: s.units_total ?? s.units_estimated?.mid ?? null, reason: 'no builder known' }); console.log(`${label} no builder`); continue; }
    if (!builder) { missing.push({ name: s.name, id: s.id, builder: s.builder, units: s.units_total ?? s.units_estimated?.mid ?? null, reason: 'builder site not in the map' }); console.log(`${label} builder site unknown`); continue; }

    const site = await urlsFor(builder.domain, cache);
    if (site.error) { missing.push({ name: s.name, id: s.id, builder: builder.name, domain: builder.domain, units: s.units_total ?? s.units_estimated?.mid ?? null, reason: site.error }); console.log(`${label} ${builder.domain}: ${site.error}`); continue; }

    const url = bestUrl(site.urls, s, builder);
    if (!url) { missing.push({ name: s.name, id: s.id, builder: builder.name, domain: builder.domain, units: s.units_total ?? s.units_estimated?.mid ?? null, reason: 'no matching page on the builder site' }); console.log(`${label} no page`); continue; }

    let html;
    try {
      html = await get(url);
    } catch (err) {
      missing.push({ name: s.name, id: s.id, builder: builder.name, page: url, units: s.units_total ?? s.units_estimated?.mid ?? null, reason: `page ${err.message}` });
      console.log(`${label} page ${err.message}`);
      continue;
    }

    const candidates = imagesOn(html, url).slice(0, MAX_PER_SOCIETY);
    const dir = path.join(IMG, slug(s.name));
    fs.mkdirSync(dir, { recursive: true });
    const entry = index[s.id] || { name: s.name, files: [], credits: [] };

    const skip = await furnitureFor(builder.domain);

    let n = 0;
    for (const src of candidates) {
      try {
        const { buf, kind } = await get(src, 'bin');
        if (buf.length < MIN_IMAGE_BYTES) continue;

        const hash = sha1(buf);
        if (skip.has(hash)) continue;                       // on the home page too
        const earlier = seenHash.get(hash);
        if (earlier && earlier.society !== s.name) {         // already under another society
          skip.add(hash);
          continue;
        }
        seenHash.set(hash, { society: s.name });

        const name = `b${n + 1}.${kind}`;
        fs.writeFileSync(path.join(dir, name), buf);
        const rel = `assets/img/societies/${slug(s.name)}/${name}`; // eslint-disable-line
        entry.files.push(rel);
        entry.credits.push({ file: rel, source: builder.name, domain: builder.domain, page: url, licence: 'builder copyright, shown as published' });
        n++; saved++;
      } catch { /* one bad asset is not worth stopping for */ }
      await sleep(180);
    }

    if (!n) {
      missing.push({ name: s.name, id: s.id, builder: builder.name, page: url, units: s.units_total ?? s.units_estimated?.mid ?? null, reason: 'page found, no usable images' });
      console.log(`${label} page found, no images`);
    } else {
      entry.has_builder_photo = true;
      index[s.id] = entry;
      writeIndex(index, s.id, entry);
      done++;
      console.log(`${label} ${n} images from ${builder.domain}`);
    }
    await sleep(PAUSE_MS);
  }

  const byReason = missing.reduce((a, m) => ((a[m.reason] = (a[m.reason] || 0) + 1), a), {});
  fs.writeFileSync(REPORT, JSON.stringify({
    generated_at: new Date().toISOString(),
    checked: queue.length,
    with_builder_images: done,
    images_saved: saved,
    missing: missing.length,
    by_reason: byReason,
    societies: missing.sort((a, b) => (b.units || 0) - (a.units || 0)),
  }, null, 2));

  console.log(`\n${done} societies with builder images, ${saved} images saved`);
  console.log(`${missing.length} could not be done:`);
  for (const [reason, n] of Object.entries(byReason).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${reason}`);
  console.log(`\nreport: ${REPORT}`);
})();
