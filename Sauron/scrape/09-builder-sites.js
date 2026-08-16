#!/usr/bin/env node
/**
 * Step 9: work out which website belongs to which builder, from the register
 * rather than from guesswork.
 *
 * Every RERA filing carries a promoter website field. 428 Bengaluru promoters
 * filled it in, which is a far better source of a developer's own domain than
 * me typing what I think it is. This reads those, folds the many corporate
 * spellings of one developer into a single key, and writes the map that
 * step 8 uses to find project pages.
 *
 * Usage: node 09-builder-sites.js  ->  ../data/builder-sites.json
 */

const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, '..', 'data');
const CSV = path.join(DATA, '.cache-rera.csv');
const OUT = path.join(DATA, 'builder-sites.json');

/* Words that say nothing about which developer this is. */
const NOISE = new Set(['private', 'pvt', 'limited', 'ltd', 'llp', 'inc', 'company', 'co',
  'developers', 'developer', 'builders', 'builder', 'projects', 'project', 'constructions',
  'construction', 'estates', 'estate', 'group', 'india', 'realty', 'realtors', 'infra',
  'infrastructure', 'housing', 'properties', 'property', 'ventures', 'venture', 'holdings',
  'enterprises', 'enterprise', 'developments', 'development', 'shelters', 'shelthers',
  'homes', 'and', 'the', 'of', 'associates', 'corporation', 'corp', 'partners', 'firm',
  'buildcon', 'buildtech', 'landmarks', 'promoters', 'town', 'city', 'space', 'spaces']);

/** The one or two words that identify a developer: "Prestige Estates Projects
 *  Ltd" and "Prestige Acres Private Limited" both key on "prestige". */
function key(name) {
  const words = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !NOISE.has(w));
  return words.slice(0, 2).join(' ') || null;
}
const firstWord = (name) => key(name)?.split(' ')[0] || null;

/** Minimal CSV reader: quoted fields, doubled quotes, embedded newlines. */
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const head = rows.shift();
  return rows.filter((r) => r.length === head.length)
    .map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}

function domainOf(raw) {
  const m = String(raw || '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '')
    .match(/^([a-z0-9-]+(?:\.[a-z0-9-]+)+)/);
  if (!m) return null;
  const d = m[1].replace(/\.$/, '');
  if (!/\.(com|in|co\.in|org|net|io|biz)$/.test(d)) return null;
  if (/gmail|yahoo|facebook|instagram|linkedin|twitter|youtube|google|magicbricks|99acres|housing|nobroker|indiamart|justdial|blogspot|wordpress\.com/.test(d)) return null;
  return d;
}

(async () => {
  if (!fs.existsSync(CSV)) {
    console.error('Run 05-rera.js first: it caches the register this reads.');
    process.exit(1);
  }

  const rows = parseCsv(fs.readFileSync(CSV, 'utf8'))
    .filter((r) => /bengaluru|bangalore/i.test(`${r.district} ${r.project_district}`));

  // Count how often each promoter states each domain, and take the majority.
  const tally = new Map();
  for (const r of rows) {
    const promoter = r.promoter_name_detail || r.promoter_name;
    const domain = domainOf(r.promoter_website);
    const k = key(promoter);
    if (!k || !domain) continue;
    if (!tally.has(k)) tally.set(k, { promoters: new Set(), domains: new Map() });
    const t = tally.get(k);
    t.promoters.add(promoter.trim());
    t.domains.set(domain, (t.domains.get(domain) || 0) + 1);
  }

  const map = {};
  for (const [k, t] of tally) {
    const [domain, n] = [...t.domains.entries()].sort((a, b) => b[1] - a[1])[0];
    map[k] = {
      domain,
      filings: n,
      competing_domains: t.domains.size > 1 ? [...t.domains.keys()].filter((d) => d !== domain) : undefined,
      promoters: [...t.promoters].slice(0, 6),
      source: 'promoter website as filed with Karnataka RERA',
    };
  }

  // A single word key as well, so "sobha" finds the entry filed as "sobha limited".
  for (const [k, v] of Object.entries(map)) {
    const first = k.split(' ')[0];
    if (first !== k && !map[first]) map[first] = { ...v, via: `first word of "${k}"` };
  }

  fs.writeFileSync(OUT, JSON.stringify({
    generated_at: new Date().toISOString(),
    source: 'Karnataka RERA promoter website field, Bengaluru filings only',
    keys: Object.keys(map).length,
    map,
  }, null, 2));

  /* ---- how much of the society list this now covers ---- */

  const file = JSON.parse(fs.readFileSync(path.join(DATA, 'societies.json'), 'utf8'));
  const societies = file.societies.filter((s) => !s.part_of)
    .filter((s) => (s.units_total ?? s.units_estimated?.mid ?? 0) >= 150);

  let hit = 0, noBuilder = 0, noDomain = [];
  for (const s of societies) {
    const names = [s.rera?.promoter, s.builder].filter(Boolean);
    if (!names.length) { noBuilder++; continue; }
    const found = names.some((n) => map[key(n)] || map[firstWord(n)]);
    if (found) hit++; else noDomain.push(names[0]);
  }

  console.log(`${Object.keys(map).length} builder keys with a domain -> ${OUT}`);
  console.log(`\nof ${societies.length} societies at 150 units or more:`);
  console.log(`  ${hit} now have a builder domain`);
  console.log(`  ${noBuilder} have no builder at all`);
  console.log(`  ${noDomain.length} have a builder whose site is still unknown`);

  const counts = noDomain.reduce((a, n) => ((a[n] = (a[n] || 0) + 1), a), {});
  console.log('\nbiggest builders still without a site:');
  Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 12)
    .forEach(([n, c]) => console.log(`  ${String(c).padStart(3)}  ${n}`));
})();
