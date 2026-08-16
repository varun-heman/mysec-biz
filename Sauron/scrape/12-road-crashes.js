#!/usr/bin/env node
/**
 * Step 12: road crashes and deaths, by police jurisdiction.
 *
 * The crime figures the police publish are city wide, so they cannot be mapped.
 * Bengaluru Traffic Police publish something better: crashes and fatalities per
 * traffic police station, every year from 2018, and the matching jurisdiction
 * polygons. That is a real spatial layer, at the level a station covers.
 *
 * It is road safety, not crime. Say so wherever it is shown. It is still the
 * only official, geographic, per year risk series available for the city, and
 * fatal crashes per square kilometre is a decent read on how hard a place is to
 * move around at night.
 *
 * Every society is joined to the jurisdiction it sits in.
 *
 * Usage: node 12-road-crashes.js  ->  ../data/road-crashes.json
 */

const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, '..', 'data');
const OUT = path.join(DATA, 'road-crashes.json');
const API = 'https://data.opencity.in/api/3/action/package_show?id=';

const CRASHES = 'bengaluru-road-crashes-data';
const JURISDICTIONS = 'bengaluru-traffic-police-jurisdictions';

async function cached(url, file) {
  const p = path.join(DATA, file);
  if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${file}: ${res.status}`);
  const text = await res.text();
  fs.writeFileSync(p, text);
  return text;
}

const resources = async (id) => (await (await fetch(API + id)).json()).result.resources;

/* ------------------------------------------------------------------ csv */

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
  const head = rows.shift().map((h) => h.trim());
  return rows.filter((r) => r.length === head.length && r.some((c) => c.trim()))
    .map((r) => Object.fromEntries(head.map((h, i) => [h, r[i].trim()])));
}

const num = (v) => {
  const n = Number(String(v ?? '').replace(/[, ]/g, ''));
  return Number.isFinite(n) ? n : null;
};

/** "Cubbon Park Traffic PS", "Cubbon Park PS" and "Cubbon Park" all key alike. */
const key = (s) => String(s || '').toLowerCase()
  .replace(/traffic/g, ' ').replace(/\bps\b/g, ' ').replace(/police station/g, ' ')
  .replace(/[^a-z0-9]/g, '');

/* ----------------------------------------------------------------- kml */

function parseKml(xml) {
  const out = [];
  for (const pm of xml.match(/<Placemark[\s\S]*?<\/Placemark>/g) || []) {
    const fields = {};
    for (const m of pm.matchAll(/<SimpleData name="([^"]+)">\s*([\s\S]*?)\s*<\/SimpleData>/g)) fields[m[1]] = m[2];
    const rings = [];
    for (const b of pm.match(/<outerBoundaryIs>[\s\S]*?<\/outerBoundaryIs>/g) || []) {
      const c = b.match(/<coordinates>\s*([\s\S]*?)\s*<\/coordinates>/);
      if (!c) continue;
      const ring = c[1].trim().split(/\s+/).map((p) => p.split(',').map(Number))
        .filter((p) => p.length >= 2 && !Number.isNaN(p[0])).map(([lon, lat]) => [lat, lon]);
      if (ring.length > 3) rings.push(ring);
    }
    if (rings.length) out.push({ fields, rings });
  }
  return out;
}

function ringAreaSqm(ring) {
  const R = 6378137;
  let t = 0;
  for (let i = 0; i < ring.length; i++) {
    const [alat, alon] = ring[i], [blat, blon] = ring[(i + 1) % ring.length];
    t += ((blon - alon) * Math.PI) / 180 *
      (2 + Math.sin((alat * Math.PI) / 180) + Math.sin((blat * Math.PI) / 180));
  }
  return Math.abs((t * R * R) / 2);
}

function inRing(lat, lon, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [yi, xi] = ring[i], [yj, xj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function bbox(rings) {
  let s = 90, n = -90, w = 180, e = -180;
  for (const r of rings) for (const [lat, lon] of r) {
    if (lat < s) s = lat; if (lat > n) n = lat;
    if (lon < w) w = lon; if (lon > e) e = lon;
  }
  return { s, n, w, e };
}

/* ---------------------------------------------------------------- main */

(async () => {
  console.log('reading crash tables and jurisdiction polygons...');

  const crashRes = (await resources(CRASHES)).filter((r) => r.format === 'CSV' && /station/i.test(r.name));
  const jurRes = (await resources(JURISDICTIONS)).find((r) => /2022/.test(r.name));

  /* ---- crashes per station per year ---- */

  const series = new Map(); // station key -> { name, zone, years: { 2018: {...} } }

  for (const res of crashRes) {
    const rows = parseCsv(await cached(res.url, `.cache-crash-${res.id.slice(0, 8)}.csv`));
    for (const row of rows) {
      const station = row.Station || row.station;
      if (!station || /total/i.test(station)) continue;
      const k = key(station);
      if (!series.has(k)) series.set(k, { station, zone: row.Zone || null, sub_division: row['Sub-division'] || null, years: {} });
      const entry = series.get(k);

      // Column names carry the year: "2023 - Fatal Cases", "2024-Total crashes".
      for (const [col, value] of Object.entries(row)) {
        const year = col.match(/^(20\d\d)/)?.[1];
        if (!year) continue;
        const v = num(value);
        if (v == null) continue;
        const y = (entry.years[year] ||= {});
        const c = col.toLowerCase();
        if (/fatal cases|fatal crashes|- fatal$/.test(c) || /^\d{4}\s*-\s*fatal$/.test(c)) y.fatal = v;
        else if (/killed/.test(c)) y.killed = v;
        else if (/non.?fatal/.test(c)) y.non_fatal = v;
        else if (/injured/.test(c)) y.injured = v;
        else if (/total/.test(c)) y.total = v;
      }
    }
    console.log(`  ${res.name.slice(0, 52)}: ${rows.length} rows`);
  }
  console.log(`  ${series.size} distinct stations across the tables`);

  /* ---- jurisdiction polygons ---- */

  const polys = parseKml(await cached(jurRes.url, '.cache-btp-jurisdictions.kml')).map((p) => ({
    name: p.fields.Traffic_PS || p.fields.PS_BOUNDName,
    key: key(p.fields.Traffic_PS || p.fields.PS_BOUNDName),
    rings: p.rings,
    box: bbox(p.rings),
    area_sqkm: +(p.rings.reduce((s, r) => s + ringAreaSqm(r), 0) / 1e6).toFixed(2),
  }));
  console.log(`  ${polys.length} jurisdiction polygons`);

  /* The tables abbreviate and the map spells things its own way: "H.Grounds"
     against "High Grounds", "U.Gate" against "Ulsoor Gate", "Halasooru" against
     "Ulsoor", "Bellanduru" against "Bellandur". So the join runs through an
     alias list for the ones that are genuinely different words, then a set of
     progressively looser rules, and reports whatever is left. */
  const ALIAS = {
    hgrounds: 'highgrounds', ugate: 'ulsooorgate', wgarden: 'wilsongarden',
    ftown: 'frazertown', bpura: 'byatarayanapura', ypura: 'yeshwanthpura',
    kswamylyt: 'kumaraswamylayout', kslayout: 'kumaraswamylayout',
    ssnagar: 'sampangiramnagar', halasooru: 'ulsoor', halasuru: 'ulsoor',
    madivala: 'madiwala', bellanduru: 'bellandur', yalahanka: 'yelahanka',
    chikjala: 'chikkajala', chikjla: 'chikkajala', hennuru: 'hennur',
    intaiport: 'airport', airport: 'airport', bytarayanapura: 'byatarayanapura',
    jnanabharathi: 'jnanabharathi', kghalli: 'kghalli',
  };

  /** Levenshtein, capped: two names that differ by a vowel are the same place. */
  const near = (a, b) => {
    if (Math.abs(a.length - b.length) > 3) return false;
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 0; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
    }
    return d[a.length][b.length] <= 2;
  };

  let matched = 0;
  const unmatchedStations = [];
  for (const [k0, entry] of series) {
    const k = ALIAS[k0] || k0;
    const poly =
      polys.find((p) => p.key === k) ||
      polys.find((p) => p.key === ALIAS[k] ) ||
      polys.find((p) => p.key.startsWith(k) || k.startsWith(p.key)) ||
      polys.find((p) => p.key.includes(k) || k.includes(p.key)) ||
      polys.find((p) => near(p.key, k));
    if (!poly) { unmatchedStations.push(entry.station); continue; }
    if (poly.crashes) {
      // A later table wins, since the newer tables use the current station list.
      poly.crashes.years = { ...poly.crashes.years, ...entry.years };
      continue;
    }
    matched++;
    poly.crashes = entry;
  }
  console.log(`  ${matched} stations matched to a polygon`);
  if (unmatchedStations.length) console.log(`  unmatched: ${unmatchedStations.join(', ')}`);

  /* ---- rates, so a big quiet jurisdiction is not mistaken for a safe one ---- */

  const jurisdictions = polys.map((p) => {
    const years = p.crashes?.years || {};
    const latest = Object.keys(years).sort().pop();
    const y = latest ? years[latest] : null;
    return {
      station: p.name,
      zone: p.crashes?.zone || null,
      sub_division: p.crashes?.sub_division || null,
      area_sqkm: p.area_sqkm,
      years,
      latest_year: latest || null,
      total_crashes: y?.total ?? null,
      fatal_crashes: y?.fatal ?? null,
      crashes_per_sqkm: y?.total != null ? +(y.total / p.area_sqkm).toFixed(1) : null,
      fatal_per_sqkm: y?.fatal != null ? +(y.fatal / p.area_sqkm).toFixed(2) : null,
      polygon: p.rings[0].map(([lat, lon]) => [+lat.toFixed(5), +lon.toFixed(5)]),
    };
  });

  /* ---- every society gets the jurisdiction it stands in ---- */

  const file = JSON.parse(fs.readFileSync(path.join(DATA, 'societies.json'), 'utf8'));
  let placed = 0;
  for (const s of file.societies) {
    const { lat, lon } = s.location;
    const hit = polys.find((p) =>
      lat >= p.box.s && lat <= p.box.n && lon >= p.box.w && lon <= p.box.e &&
      p.rings.some((r) => inRing(lat, lon, r)));
    if (!hit) { s.traffic_jurisdiction = null; continue; }
    placed++;
    const years = hit.crashes?.years || {};
    const latest = Object.keys(years).sort().pop();
    s.traffic_jurisdiction = {
      station: hit.name,
      area_sqkm: hit.area_sqkm,
      latest_year: latest || null,
      total_crashes: latest ? years[latest].total ?? null : null,
      fatal_crashes: latest ? years[latest].fatal ?? null : null,
      source: 'Bengaluru Traffic Police station wise crash tables, via OpenCity',
    };
  }
  fs.writeFileSync(path.join(DATA, 'societies.json'), JSON.stringify(file, null, 2));

  fs.writeFileSync(OUT, JSON.stringify({
    generated_at: new Date().toISOString(),
    source: 'Bengaluru Traffic Police, via OpenCity',
    datasets: [
      'https://data.opencity.in/dataset/bengaluru-road-crashes-data',
      'https://data.opencity.in/dataset/bengaluru-traffic-police-jurisdictions',
    ],
    licence: 'Public domain',
    note: 'Road crashes and deaths, not crime. The only official per year figures published below city level for Bengaluru.',
    jurisdictions: jurisdictions.sort((a, b) => (b.fatal_per_sqkm || 0) - (a.fatal_per_sqkm || 0)),
  }, null, 2));

  const withData = jurisdictions.filter((j) => j.total_crashes != null);
  console.log(`\n${withData.length} of ${jurisdictions.length} jurisdictions have a crash series`);
  console.log(`${placed} of ${file.societies.length} societies sit inside one`);
  console.log('\nworst by fatal crashes per sq km, latest year:');
  for (const j of jurisdictions.slice(0, 8)) {
    if (j.fatal_per_sqkm == null) continue;
    console.log(`  ${j.fatal_per_sqkm.toFixed(2)}  ${j.station.slice(0, 30).padEnd(30)} ${j.fatal_crashes} deaths, ${j.total_crashes} crashes in ${j.latest_year}`);
  }
  console.log(`\nwrote ${OUT}`);
})();
