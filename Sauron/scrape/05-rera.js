#!/usr/bin/env node
/**
 * Step 5: Karnataka RERA, the official project register.
 *
 * rera.karnataka.gov.in itself is slow and often unreachable, so this reads a
 * mirror of it: github.com/Vonter/karnataka-rera-projects, which scrapes the
 * portal into 8,791 rows and publishes them under ODbL. Fields used here are
 * the promoter, the unit count, tower count, land area, project type, the
 * completion date and, where the filing has it, latitude and longitude.
 *
 * Bengaluru only. Mysore, Mangalore, Hubli and the rest of Karnataka are
 * dropped.
 *
 * A RERA row is attached to an existing society when the names match after
 * normalising, or when the coordinates are within 400 m and the names are
 * close. Anything left over with a coordinate is added as a society in its
 * own right, which is how projects that OSM never mapped get in. No size
 * floor: a filing with no unit count in the mirror still gets added, just
 * with units left unknown rather than dropped for lacking a number.
 *
 * Usage: node 05-rera.js  ->  rewrites ../data/societies.json
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

const DATA = path.join(__dirname, '..', 'data');
const CSV_URL = 'https://raw.githubusercontent.com/Vonter/karnataka-rera-projects/main/data/rera-projects.csv.zip';
const CACHE = path.join(DATA, '.cache-rera.csv');

const MIN_UNITS = 150;
const MATCH_METRES = 400;

/* Bengaluru Urban and Rural. Everything else in Karnataka is out of scope. */
const IN_SCOPE = /bengaluru|bangalore/i;

/* Plotted developments and commercial filings are not apartment societies. */
const RESIDENTIAL = /apartment|group\s*housing|residential|villa|row\s*house/i;

/* --------------------------------------------------------- name cleaning */

/** Words that stay upper case because they are abbreviations, not words. */
const ABBREVIATIONS = new Set([
  'SNN', 'SJR', 'DSR', 'SNR', 'RMZ', 'DLF', 'HM', 'GM', 'SMR', 'DNR', 'BM', 'SLS',
  'NCC', 'UKN', 'VDB', 'SV', 'GRC', 'RNS', 'DS', 'ELV', 'CLPD', 'MBR', 'VSR',
  'BSCPL', 'SSVR', 'AKME', 'ATZ', 'LGCL', 'SBR', 'TGS', 'KVR', 'NR', 'SRK', 'JK',
  'MTB', 'BHK', 'LLP', 'RWA', 'AOA', 'PVT', 'LTD', 'HSR', 'BTM', 'RMV', 'ITPL',
  'SLV', 'GK', 'ND', 'JR', 'KG', 'PSR', 'SNS', 'SPR', 'TVS', 'UB', 'VBHC', 'AL',
  'II', 'III', 'IV', 'VI', 'VII', 'VIII', 'IX', 'XI', 'XII',
]);

const SMALL_WORDS = new Set(['a', 'an', 'and', 'at', 'by', 'de', 'for', 'in', 'of', 'on', 'or', 'the', 'to']);

/**
 * RERA names arrive as "PRESTIGE SHANTINIKETAN" or "sobha dream acres". Put
 * them in title case, leave real abbreviations alone, and do not touch a name
 * that is already mixed case, since that one was typed by a person.
 */
function normaliseName(raw) {
  if (!raw) return raw;
  let s = String(raw).replace(/\s+/g, ' ').trim().replace(/[.,\s]+$/, '');

  const letters = s.replace(/[^A-Za-z]/g, '');
  const shouty = letters.length > 3 && letters === letters.toUpperCase();
  const whispered = letters.length > 3 && letters === letters.toLowerCase();
  if (!shouty && !whispered) return s;

  return s
    .split(' ')
    .map((word, i) => {
      const bare = word.replace(/[^A-Za-z0-9&']/g, '');
      if (!bare) return word;
      if (ABBREVIATIONS.has(bare.toUpperCase())) return word.replace(bare, bare.toUpperCase());
      // A short all consonant token is an initialism: SNN, DSR, RMZ.
      if (bare.length <= 4 && !/[aeiou]/i.test(bare)) return word.replace(bare, bare.toUpperCase());
      const lower = bare.toLowerCase();
      if (i > 0 && SMALL_WORDS.has(lower)) return word.replace(bare, lower);
      return word.replace(bare, lower.charAt(0).toUpperCase() + lower.slice(1));
    })
    .join(' ');
}

/** A key for comparing two names: lower case, no punctuation, no filler. */
const nameKey = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\b(apartments?|apts?|residency|residences?|enclave|phase\s*\d*|block\s*\w?|project|the|a|an|by|at|and|pvt|private|ltd|limited|llp)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

function metres(a, b) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}

/* ------------------------------------------------------------- CSV input */

async function csv() {
  if (fs.existsSync(CACHE)) return fs.readFileSync(CACHE, 'utf8');
  console.log('downloading RERA mirror...');
  const res = await fetch(CSV_URL);
  if (!res.ok) throw new Error(`RERA mirror ${res.status}`);
  const zip = Buffer.from(await res.arrayBuffer());
  const tmp = path.join(DATA, '.cache-rera.zip');
  fs.writeFileSync(tmp, zip);
  // The archive holds one CSV. unzip is on every Mac, and avoids a dependency.
  const name = execFileSync('unzip', ['-Z1', tmp]).toString().trim().split('\n')[0];
  const text = execFileSync('unzip', ['-p', tmp, name], { maxBuffer: 512 * 1024 * 1024 }).toString();
  fs.writeFileSync(CACHE, text);
  fs.unlinkSync(tmp);
  return text;
}

/** RFC 4180 enough for this file: quoted fields, doubled quotes, embedded newlines. */
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }

  const head = rows.shift();
  return rows
    .filter((r) => r.length === head.length)
    .map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}

const num = (v) => {
  const n = Number(String(v ?? '').replace(/[, ]/g, ''));
  return Number.isFinite(n) && n !== 0 ? n : null;
};

/* ------------------------------------------------------------------ main */

(async () => {
  const file = JSON.parse(fs.readFileSync(path.join(DATA, 'societies.json'), 'utf8'));
  const societies = file.societies;

  console.log('reading RERA mirror...');
  const all = parseCsv(await csv());
  console.log(`  ${all.length} Karnataka projects`);

  const blr = all.filter((r) =>
    IN_SCOPE.test(`${r.district} ${r.project_district}`) &&
    RESIDENTIAL.test(`${r.project_type} ${r.project_type_full} ${r.project_sub_type}`)
  );
  console.log(`  ${blr.length} residential projects in Bengaluru`);

  /* ---- index the societies we already have ---- */

  const byName = new Map();
  for (const s of societies) {
    const k = nameKey(s.name);
    if (k) byName.set(k, s);
  }

  let joined = 0, added = 0, filledUnits = 0;
  const leftovers = [];

  for (const r of blr) {
    const name = normaliseName(r.project_name_full || r.project_name);
    const key = nameKey(name);
    const lat = num(r.latitude), lon = num(r.longitude);

    let match = byName.get(key) || null;

    // No name hit: try coordinates, and only accept when the names share a word.
    if (!match && lat && lon && lat > 12 && lat < 14 && lon > 77 && lon < 78.5) {
      const words = new Set(key.split(' ').filter((w) => w.length > 3));
      let best = null;
      for (const s of societies) {
        const d = metres({ lat, lon }, s.location);
        if (d > MATCH_METRES) continue;
        const shares = nameKey(s.name).split(' ').some((w) => words.has(w));
        if (!shares) continue;
        if (!best || d < best.d) best = { s, d };
      }
      if (best) match = best.s;
    }

    const units = num(r.total_units) || num(r.total_units_from_listing);
    const rera = {
      reg_number: r.reg_number || null,
      project_id: r.project_id || null,
      status: r.project_status || r.status || null,
      registered: r.registration_date || null,
      promoter: normaliseName(r.promoter_name_detail || r.promoter_name),
      promoter_website: r.promoter_website || null,
      address: r.project_address || null,
      pin: r.project_pin_code || null,
      land_area_sqm: num(r.land_area_sqm),
      covered_area_sqm: num(r.covered_area_sqm),
      builtup_area_sqm: num(r.builtup_area_sqm),
      total_units: units,
      towers: num(r.number_of_towers),
      inventory_types: num(r.num_inventory_types),
      far: num(r.far_sanctioned),
      parking_covered: num(r.covered_parking_count),
      parking_open: num(r.open_parking_count),
      completion: r.project_completion_date || r.proposed_completion_date || null,
      project_cost_inr: num(r.total_project_cost),
      fire_fighting: r.infra_fire_fighting || null,
      source: 'Karnataka RERA via github.com/Vonter/karnataka-rera-projects (ODbL)',
    };

    if (match) {
      joined++;
      match.rera = rera;
      match.builder = match.builder || rera.promoter;
      if (units) { match.units_total = units; filledUnits++; }
      if (rera.towers) match.towers = rera.towers;
      if (rera.completion) match.year_built = Number(String(rera.completion).slice(0, 4)) || match.year_built;
      if (rera.land_area_sqm && !match.plot) {
        match.plot = {
          area_sqm: Math.round(rera.land_area_sqm),
          area_acres: +(rera.land_area_sqm / 4046.86).toFixed(2),
          source: 'Karnataka RERA filing',
        };
      }
      if (!match.location.address_full && rera.address) match.location.address_full = rera.address;
      match.confidence = units ? 'RERA filing' : match.confidence;
    } else if (lat && lon) {
      added++;
      leftovers.push({
        id: `rera:${r.project_id || r.reg_number}`,
        name,
        source: { record: 'Karnataka RERA', licence: 'ODbL, via Vonter/karnataka-rera-projects' },
        city: 'Bengaluru',
        location: {
          lat: +lat.toFixed(6), lon: +lon.toFixed(6),
          street: null, locality: r.project_taluk || null,
          postcode: r.project_pin_code || null, address_full: r.project_address || null,
        },
        plot: rera.land_area_sqm
          ? { area_sqm: Math.round(rera.land_area_sqm), area_acres: +(rera.land_area_sqm / 4046.86).toFixed(2), source: 'Karnataka RERA filing' }
          : null,
        polygon: null,
        builder: rera.promoter,
        towers: rera.towers,
        units_total: units,
        units_estimated: null,
        year_built: rera.completion ? Number(String(rera.completion).slice(0, 4)) : null,
        unit_types: null, avg_unit_sqft: null, units_by_bedrooms: null,
        income_band: null, amenities: null, incidents: null,
        buildings_inside: 0, apartment_blocks: 0, mean_levels: 0, built_area_sqm: 0,
        osm_tags: {}, tower_names: [],
        ward: null, nearest: { police: null, fire: null, hospital: null },
        rera,
        confidence: 'RERA filing, not yet mapped',
      });
    }
  }

  /* ---- normalise every name in the file, RERA or not ---- */

  let renamed = 0;
  for (const s of [...societies, ...leftovers]) {
    const clean = normaliseName(s.name);
    if (clean !== s.name) { s.name = clean; renamed++; }
    if (s.builder) s.builder = normaliseName(s.builder);
    if (s.location.locality) s.location.locality = normaliseName(s.location.locality);
    if (s.enclaves) s.enclaves = s.enclaves.map(normaliseName);
  }

  /* ---- ward join for the newcomers ---- */

  const wards = JSON.parse(fs.readFileSync(path.join(DATA, 'gba-wards.json'), 'utf8')).ward_list;
  const inRing = (lat, lon, ring) => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [yi, xi] = ring[i], [yj, xj] = ring[j];
      if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };

  /* The March 2026 GBA notification is a boundary, not a market definition:
     Sarjapur, Attibele and Anekal outskirts carry real Bengaluru apartment
     launches that simply sit past the drawn line. A RERA filing that misses
     every ward polygon still gets the nearest one, as long as it is close
     enough to be the same metro rather than a different Karnataka city (a
     15 km slack is generous for the edge of the notified area, and nowhere
     near enough to reach Mysuru or Hubli). A padded bounding box per ward
     keeps this from comparing every leftover against every ring vertex. */
  const NEAR_KM = 15;
  const PAD_DEG = 0.25;
  const wardBoxes = wards.map((w) => {
    let s = 90, n = -90, e = 180, wst = -180;
    for (const ring of w.rings) for (const [lat, lon] of ring) {
      if (lat < s) s = lat; if (lat > n) n = lat;
      if (lon < e) e = lon; if (lon > wst) wst = lon;
    }
    return { ward: w, s, n, w_: e, e_: wst };
  });
  function nearestWard(lat, lon) {
    let best = null;
    for (const b of wardBoxes) {
      if (lat < b.s - PAD_DEG || lat > b.n + PAD_DEG || lon < b.w_ - PAD_DEG || lon > b.e_ + PAD_DEG) continue;
      for (const ring of b.ward.rings) for (const [plat, plon] of ring) {
        const km = metres({ lat, lon }, { lat: plat, lon: plon }) / 1000;
        if (!best || km < best.km) best = { ward: b.ward, km };
      }
    }
    return best && best.km <= NEAR_KM ? best.ward : null;
  }

  let placed = 0, nearBoundary = 0;
  for (const s of leftovers) {
    const { lat, lon } = s.location;
    let w = wards.find((x) => x.rings.some((r) => inRing(lat, lon, r)));
    let approx = false;
    if (!w) { w = nearestWard(lat, lon); approx = !!w; }
    if (!w) continue;
    placed++;
    if (approx) nearBoundary++;
    s.ward = { ward_no: w.ward_no, name: w.name, corporation: `Bengaluru ${w.corporation}`, assembly: w.assembly, approx };
    const pool = [...w.facilities.inside, ...w.facilities.nearest_outside.police,
                  ...w.facilities.nearest_outside.fire, ...w.facilities.nearest_outside.hospital];
    for (const kind of ['police', 'fire', 'hospital']) {
      s.nearest[kind] = pool.filter((p) => p.kind === kind)
        .map((p) => ({ name: p.name, distance_m: metres({ lat, lon }, p), osm: p.osm }))
        .sort((a, b) => a.distance_m - b.distance_m)[0] || null;
    }
  }

  // Still nothing within 15 km of the notified area is a different city, not our market.
  const keep = leftovers.filter((s) => s.ward);
  const merged = [...societies, ...keep];

  const standalone = merged.filter((s) => !s.part_of);
  const over150 = standalone.filter((s) => (s.units_total ?? s.units_estimated?.mid ?? 0) >= MIN_UNITS);
  const sourced = standalone.filter((s) => s.units_total != null);

  merged.sort((a, b) =>
    (b.units_total ?? b.units_estimated?.mid ?? 0) - (a.units_total ?? a.units_estimated?.mid ?? 0));

  file.societies = merged;
  file.counts = {
    ...file.counts,
    rera_joined: joined,
    rera_added: keep.length,
    units_from_rera: filledUnits,
    names_normalised: renamed,
    standalone: standalone.length,
    estimated_150_plus: over150.length,
    sourced_unit_counts: sourced.length,
  };
  file.method = {
    ...file.method,
    rera: 'Karnataka RERA register via github.com/Vonter/karnataka-rera-projects, ODbL. Bengaluru Urban and Rural only, residential project types only.',
  };

  fs.writeFileSync(path.join(DATA, 'societies.json'), JSON.stringify(file, null, 2));

  console.log('\n--- RERA join ---');
  console.log(`joined to an existing society   ${joined}`);
  console.log(`  of which gave a unit count    ${filledUnits}`);
  console.log(`added as new societies          ${keep.length} (${nearBoundary} within 15 km of the notified boundary, ${added - keep.length} further than that)`);
  console.log(`names normalised                ${renamed}`);
  console.log(`\ntotal societies                 ${standalone.length}`);
  console.log(`  with a sourced unit count     ${sourced.length}`);
  console.log(`  at 150 units or more          ${over150.length}`);
})();
