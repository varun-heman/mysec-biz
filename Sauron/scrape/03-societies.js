#!/usr/bin/env node
/**
 * Step 3: turn the raw OSM candidate polygons into an actual society list.
 *
 * Three jobs:
 *
 * 1. Throw out what is not a society. The raw pull is full of BBMP layouts
 *    ("Banashankari 6th Stage - 4th Block") and government housing (police
 *    quarters, HAL and ITI colonies, railway quarters). Neither is a customer.
 *
 * 2. Name the builder. A dictionary of the major Bengaluru developers is matched
 *    against the society name, and a second Overpass pass searches OSM by builder
 *    name so societies mapped as a single building or a point, rather than as a
 *    landuse polygon, are not missed.
 *
 * 3. Estimate unit count. Built area comes from OSM building footprints and
 *    floor counts inside each polygon. This is an estimate with a stated range,
 *    marked `derived`, and it is never presented as a fact. No size floor is
 *    applied: every apartment complex is kept, however small.
 *
 * Also joins each society to its Greater Bengaluru Authority ward and to the
 * nearest police station, fire station and hospital.
 *
 * Usage: node 03-societies.js  ->  ../data/societies.json
 */

const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, '..', 'data');
const ENDPOINT = 'https://overpass-api.de/api/interpreter';

/* ---------------------------------------------------------------- tuning */

/** Gross built area per dwelling, in square metres, including circulation and
 *  common area. Bengaluru mid market runs about 1,400 sq ft gross per flat. */
const SQM_PER_UNIT = { low: 165, mid: 130, high: 105 };

/** Share of the floor plate that is dwelling rather than lobby, shaft, parking. */
const EFFICIENCY = 0.82;

const MIN_UNITS = 150;

/* The developers worth naming. Order matters: longer, more specific names first
   so "Sattva" does not swallow "Salarpuria Sattva". */
const BUILDERS = [
  ['Salarpuria Sattva', /\b(salarpuria)\b/i],
  ['Shapoorji Pallonji', /\b(shapoorji|pallonji|joyville)\b/i],
  ['Total Environment', /\b(total\s+environment|in\s+that\s+quiet\s+earth|windmills\s+of\s+your\s+mind|after\s+the\s+rain)\b/i],
  ['Prestige Group', /\bprestige\b/i],
  ['Brigade Group', /\bbrigade\b/i],
  ['Sobha', /\bsobha\b/i],
  ['Puravankara', /\b(puravankara|purva|provident)\b/i],
  ['Godrej Properties', /\bgodrej\b/i],
  ['Embassy Group', /\bembassy\b/i],
  ['RMZ', /\brmz\b/i],
  ['Sattva Group', /\bsattva\b/i],
  ['Ozone Group', /\bozone\b/i],
  ['SNR', /\bsnr\b/i],
  ['DSR Infrastructure', /\bdsr\b/i],
  ['Confident Group', /\bconfident\b/i],
  ['Adarsh Developers', /\badarsh\b/i],
  ['Mantri Developers', /\bmantri\b/i],
  ['Century Real Estate', /\bcentury\b/i],
  ['Assetz Property', /\bassetz\b/i],
  ['Bhartiya City', /\b(bhartiya|nikoo)\b/i],
  ['L&T Realty', /\b(l\s*&\s*t|larsen)\b/i],
  ['Mahindra Lifespaces', /\bmahindra\b/i],
  ['Shriram Properties', /\bshriram\b/i],
  ['Nitesh Estates', /\bnitesh\b/i],
  ['Rohan Builders', /\brohan\b/i],
  ['Vaishnavi Group', /\bvaishnavi\b/i],
  ['Casagrand', /\bcasagrand\b/i],
  ['Republic of Whitefield', /\brepublic\s+of\s+whitefield\b/i],
  ['Divyasree', /\bdivyasree\b/i],
  ['Concorde Group', /\bconcorde\b/i],
  ['Golden Gate', /\bgolden\s+gate\b/i],
  ['Hiranandani', /\bhiranandani\b/i],
  ['Skyline', /\bskyline\b/i],
  ['Mana Projects', /\bmana\s/i],
  ['Arvind SmartSpaces', /\barvind\b/i],
  ['Rustomjee', /\brustomjee\b/i],
  ['Nambiar Builders', /\bnambiar\b/i],
  ['Ajmera Realty', /\bajmera\b/i],
  ['Century Sports Village', /\bsports\s+village\b/i],
  ['Klassik', /\bklassik\b/i],
  ['Gopalan Enterprises', /\bgopalan\b/i],
  ['Sumadhura', /\bsumadhura\b/i],
  ['Aratt', /\baratt\b/i],
  ['SJR Group', /\bsjr\b/i],
  ['Lodha', /\blodha\b/i],
  ['Phoenix Mills', /\bphoenix\b/i],
  ['DLF', /\bdlf\b/i],
  ['SNN Raj', /\bsnn\b/i],
  ['Mahaveer Group', /\bmahaveer\b/i],
  ['Candeur Landmark', /\bcandeur\b/i],
  ['Bren Corporation', /\bbren\b/i],
  ['Sterling Developers', /\bsterling\b/i],
  ['Vaswani Group', /\bvaswani\b/i],
  ['Oceanus', /\boceanus\b/i],
  ['Skylark Group', /\bskylark\b/i],
  ['DS Max Properties', /\bds\s*max\b/i],
  ['Janapriya', /\bjanapriya\b/i],
  ['Sowparnika', /\bsowparnika\b/i],
  ['Valmark', /\bvalmark\b/i],
  ['Tata Housing', /\btata\b/i],
  ['Akme Projects', /\bakme\b/i],
  ['Keerthi Estates', /\bkeerthi\b/i],
  ['GM Infinite', /\bgm\s+infinite\b/i],
  ['HM Group', /\bhm\s+(world|symphony|indigo|tropical)/i],
  ['Karle Infra', /\bkarle\b/i],
  ['Pashmina Developers', /\bpashmina\b/i],
  ['Alpine Housing', /\balpine\b/i],
  ['Raheja Developers', /\braheja\b/i],
  ['Unitech', /\bunitech\b/i],
  ['Spectra Group', /\bspectra\b/i],
  ['Renaissance Holdings', /\brenaissance\b/i],
  ['Shilpitha', /\bshilpitha\b/i],
  ['DNR Group', /\bdnr\b/i],
  ['Purva Riviera', /\belita\s+promenade\b/i],
  ['Nagarjuna Construction', /\bnagarjuna\b/i],
  ['Aparna Constructions', /\baparna\b/i],
  ['SMR Holdings', /\bsmr\b/i],
  ['Zonasha', /\bzonasha\b/i],
  ['Pride Group', /\bpride\b/i],
  ['Saket Engineers', /\bsaket\b/i],
  ['Ittina Properties', /\bittina\b/i],
  ['Jain Housing', /\bjain\s+heights\b/i],
  ['SLS Group', /\bsls\b/i],
  ['Sonestaa', /\bsonestaa\b/i],
  ['Krishvi', /\bkrishvi\b/i],
  ['UKN Properties', /\bukn\b/i],
  ['Incor Group', /\bincor\b/i],
  ['Habitat Ventures', /\bhabitat\b/i],
  ['Chartered Housing', /\bchartered\b/i],
  ['Rohan Corporation', /\brohan\b/i],
];

/** Government and institutional housing. Not customers, so they are dropped. */
const GOVERNMENT = new RegExp(
  [
    'quarters', 'police\\s+(quarters|colony|lines)', 'reserve\\s+police', 'ksrp',
    'army', 'military', 'defence', 'air\\s*force', 'navy', 'cantonment',
    'railway', 'bsnl', 'bhel', 'isro', 'drdo', 'ordnance', 'cpwd', 'hmt',
    '\\bhal\\b', '\\bbel\\b', '\\biti\\b', '\\bnal\\b', '\\blrde\\b',
    'housing\\s+board', 'slum\\s+(board|development|clearance)', 'kseb', 'kptcl',
    'bwssb', 'bmtc', 'ksrtc', '\\bbda\\b', '\\bkhb\\b', 'kendriya\\s+vihar',
    'jal\\s*vayu', 'cariapa', 'afnhb', 'vayu\\s+sena', 'sainik', 'ex-?servicemen',
    'government', 'govt', 'municipal', 'employees\\s+(quarters|colony|housing)',
    'staff\\s+(quarters|colony)', 'judicial\\s+layout', 'ews\\b', 'university',
    'campus', 'hostel', 'jail', 'prison',
  ].join('|'),
  'i'
);

/** BBMP layout and neighbourhood naming, as opposed to a society name. */
const LAYOUT_NAME = /\b(\d+(st|nd|rd|th)?\s+)?(stage|block|sector|cross|main|ward|extension|extn)\b/i;

/* ------------------------------------------------------------------ util */

/** Overpass mirrors, tried in turn. The main instance sheds load under
 *  pressure and answers 504, so a query is not finished until one of these
 *  returns JSON. Results are cached on disk, since these are slow queries. */
const MIRRORS = [
  ENDPOINT,
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function overpass(query, cacheKey) {
  const cache = cacheKey ? path.join(DATA, `.cache-${cacheKey}.json`) : null;
  if (cache && fs.existsSync(cache)) {
    console.log(`  cached: ${cacheKey}`);
    return JSON.parse(fs.readFileSync(cache, 'utf8'));
  }

  let lastErr;
  for (let attempt = 0; attempt < MIRRORS.length * 2; attempt++) {
    const url = MIRRORS[attempt % MIRRORS.length];
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ data: query }),
      });
      if (!res.ok) throw new Error(`${res.status} from ${new URL(url).host}`);
      const json = await res.json();
      if (cache) fs.writeFileSync(cache, JSON.stringify(json));
      return json;
    } catch (err) {
      lastErr = err;
      const wait = 5000 * (attempt + 1);
      console.log(`  ${err.message.split('\n')[0]}, retrying in ${wait / 1000}s`);
      await sleep(wait);
    }
  }
  throw lastErr;
}

const read = (f) => JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'));

function ringAreaSqm(ring) {
  const R = 6378137;
  let total = 0;
  for (let i = 0; i < ring.length; i++) {
    const [alat, alon] = ring[i];
    const [blat, blon] = ring[(i + 1) % ring.length];
    total += ((blon - alon) * Math.PI) / 180 *
      (2 + Math.sin((alat * Math.PI) / 180) + Math.sin((blat * Math.PI) / 180));
  }
  return Math.abs((total * R * R) / 2);
}

function inRing(lat, lon, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [yi, xi] = ring[i];
    const [yj, xj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function bbox(ring) {
  let s = 90, n = -90, w = 180, e = -180;
  for (const [lat, lon] of ring) {
    if (lat < s) s = lat; if (lat > n) n = lat;
    if (lon < w) w = lon; if (lon > e) e = lon;
  }
  return { s, n, w, e };
}

function metres(a, b) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}

const builderOf = (name) => {
  for (const [label, re] of BUILDERS) if (re.test(name)) return label;
  return null;
};

/* --------------------------------------------------------------- queries */

/** Every building in Bengaluru that has a floor count, plus every apartment
 *  block, with geometry so the footprint can be measured. */
const BUILDINGS = `
[out:json][timeout:300];
area["name"="Bengaluru"]["boundary"="administrative"]->.a;
(
  way["building"]["building:levels"](area.a);
  way["building"="apartments"](area.a);
);
out geom;
`;

/** Anything in Bengaluru named after one of the major builders, whatever its
 *  geometry, so societies mapped as a point or a single building still surface. */
const BY_BUILDER = `
[out:json][timeout:300];
area["name"="Bengaluru"]["boundary"="administrative"]->.a;
(
  nwr["name"~"${BUILDERS.map(([l]) => l.split(' ')[0]).join('|')}",i](area.a);
);
out tags center;
`;

/* ------------------------------------------------------------------ main */

(async () => {
  const candidates = read('osm-candidates.json').societies;
  const wards = read('gba-wards.json').ward_list;

  console.log('fetching building footprints...');
  const bdata = await overpass(BUILDINGS, "buildings");
  const buildings = [];
  for (const el of bdata.elements) {
    if (!el.geometry || el.geometry.length < 4) continue;
    const ring = el.geometry.map((p) => [p.lat, p.lon]);
    const t = el.tags || {};
    const levels = Number(t['building:levels']) || (t.building === 'apartments' ? 4 : 1);
    buildings.push({
      lat: ring.reduce((s, p) => s + p[0], 0) / ring.length,
      lon: ring.reduce((s, p) => s + p[1], 0) / ring.length,
      area: ringAreaSqm(ring),
      levels: Math.min(levels, 60),
      apartments: t.building === 'apartments',
      name: t.name || null,
      id: `osm:way/${el.id}`,
    });
  }
  console.log(`  ${buildings.length} buildings with height or apartment tagging`);

  console.log('searching OSM by builder name...');
  const namedata = await overpass(BY_BUILDER, "by-builder");
  console.log(`  ${namedata.elements.length} named matches`);

  /* ---- measure each candidate ---- */

  const rows = [];
  for (const c of candidates) {
    const ring = c.polygon;
    const box = bbox(ring);
    const inside = buildings.filter(
      (b) => b.lat >= box.s && b.lat <= box.n && b.lon >= box.w && b.lon <= box.e &&
             inRing(b.lat, b.lon, ring)
    );

    const builtArea = inside.reduce((s, b) => s + b.area * b.levels, 0);
    const aptBlocks = inside.filter((b) => b.apartments || b.levels >= 3);
    const meanLevels = inside.length
      ? +(inside.reduce((s, b) => s + b.levels, 0) / inside.length).toFixed(1)
      : 0;

    const est = (per) => Math.round((builtArea * EFFICIENCY) / per);

    rows.push({
      ...c,
      builder: builderOf(c.name),
      buildings_inside: inside.length,
      apartment_blocks: aptBlocks.length,
      mean_levels: meanLevels,
      built_area_sqm: Math.round(builtArea),
      units_estimated: builtArea
        ? { mid: est(SQM_PER_UNIT.mid), low: est(SQM_PER_UNIT.low), high: est(SQM_PER_UNIT.high) }
        : null,
      tower_names: inside.filter((b) => b.name).map((b) => b.name).slice(0, 40),
    });
  }

  /* ---- classify ---- */

  const kept = [];
  const dropped = { government: 0, layout: 0, no_signal: 0 };

  for (const r of rows) {
    if (GOVERNMENT.test(r.name)) { dropped.government++; continue; }

    const builder = !!r.builder;
    const gated = r.osm_tags.landuse === null || r.osm_tags.building === 'apartments';
    const vertical = r.mean_levels >= 3 && r.apartment_blocks >= 2;
    const looksLikeLayout = LAYOUT_NAME.test(r.name);

    // A layout name only survives if the built form clearly says otherwise.
    if (looksLikeLayout && !builder && !vertical) { dropped.layout++; continue; }

    // Nothing vertical, no builder, no apartment tagging: not an apartment society.
    if (!builder && !vertical && !gated && r.apartment_blocks < 2) { dropped.no_signal++; continue; }

    // No size floor: every apartment complex is kept, however small.
    kept.push(r);
  }

  /* ---- builder name pass, for societies with no landuse polygon ---- */

  const seen = new Set(kept.map((k) => k.name.toLowerCase()));
  // Anything inside a kept polygon is a tower of that society, not a society of
  // its own. Snapshot the polygons before the loop starts adding point matches.
  const footprints = kept
    .filter((k) => k.polygon?.length > 2)
    .map((k) => ({ ring: k.polygon, box: bbox(k.polygon) }));

  const insideKept = (lat, lon) =>
    footprints.some(({ ring, box }) =>
      lat >= box.s && lat <= box.n && lon >= box.w && lon <= box.e && inRing(lat, lon, ring)
    );

  let added = 0;
  for (const el of namedata.elements) {
    const t = el.tags || {};
    const name = t.name;
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    if (!name || lat == null) continue;
    if (GOVERNMENT.test(name)) continue;
    if (seen.has(name.toLowerCase())) continue;

    const builder = builderOf(name);
    if (!builder) continue;

    // Only residential things. Offices and malls carry the same builder names.
    const residential =
      t.building === 'apartments' || t.landuse === 'residential' ||
      t.residential || t.place === 'neighbourhood' ||
      /apartment|residen|towers?|enclave|habitat|heights|meadows|county|park|city|layout|homes?/i.test(name);
    if (!residential) continue;
    if (/mall|tech\s*park|office|business\s*park|it\s*park|hospital|school|college|hotel/i.test(name)) continue;
    if (insideKept(lat, lon)) continue;

    seen.add(name.toLowerCase());
    added++;
    kept.push({
      id: `osm:${el.type}/${el.id}`,
      name,
      source: { spatial: `https://www.openstreetmap.org/${el.type}/${el.id}`, licence: 'ODbL, OpenStreetMap contributors' },
      city: 'Bengaluru',
      location: {
        lat: +lat.toFixed(6), lon: +lon.toFixed(6),
        street: t['addr:street'] || null,
        locality: t['addr:suburb'] || t['addr:neighbourhood'] || null,
        postcode: t['addr:postcode'] || null,
        address_full: null,
      },
      plot: null,
      osm_tags: { landuse: t.landuse || null, building: t.building || null, levels: Number(t['building:levels']) || null, operator: t.operator || null },
      polygon: null,
      builder,
      buildings_inside: 0, apartment_blocks: 0, mean_levels: Number(t['building:levels']) || 0,
      built_area_sqm: 0, units_estimated: null, tower_names: [],
      units_total: null, unit_types: null, avg_unit_sqft: null, units_by_bedrooms: null,
      income_band: null, amenities: null, year_built: null, incidents: null,
      confidence: 'candidate: builder name match, no footprint',
    });
  }

  /* ---- fold enclaves into their township ----
     Adarsh Palm Retreat contains Daffodils, Gulmohar and Hibiscus, each mapped
     as its own polygon. Drawing all four gives boxes inside boxes, and counting
     all four counts the same flats several times. The inner ones become
     enclaves of the outer one, which keeps them searchable without double
     counting or clutter. */

  const polyRows = kept.filter((k) => k.polygon?.length > 2)
    .map((k) => ({ k, box: bbox(k.polygon), area: k.plot?.area_sqm || 0 }));

  for (const child of polyRows) {
    let smallest = null;
    for (const parent of polyRows) {
      if (parent === child || parent.area <= child.area) continue;
      const b = parent.box;
      const { lat, lon } = child.k.location;
      if (lat < b.s || lat > b.n || lon < b.w || lon > b.e) continue;
      if (!inRing(lat, lon, parent.k.polygon)) continue;
      if (!smallest || parent.area < smallest.area) smallest = parent;
    }
    if (smallest) {
      child.k.part_of = smallest.k.id;
      (smallest.k.enclaves ||= []).push(child.k.name);
    }
  }
  const enclosed = kept.filter((k) => k.part_of).length;
  console.log(`  ${enclosed} enclaves folded into a larger society`);

  /* ---- ward and emergency response join ---- */

  const wardBoxes = wards.map((w) => ({ w, rings: w.rings, boxes: w.rings.map(bbox) }));

  for (const k of kept) {
    const { lat, lon } = k.location;

    const hit = wardBoxes.find(({ rings, boxes }) =>
      rings.some((r, i) => {
        const b = boxes[i];
        return lat >= b.s && lat <= b.n && lon >= b.w && lon <= b.e && inRing(lat, lon, r);
      })
    );

    k.ward = hit
      ? {
          ward_no: hit.w.ward_no,
          name: hit.w.name,
          corporation: `Bengaluru ${hit.w.corporation}`,
          assembly: hit.w.assembly,
        }
      : null;

    // Nearest facility of each kind, measured from the society itself.
    const pool = hit
      ? [...hit.w.facilities.inside,
         ...hit.w.facilities.nearest_outside.police,
         ...hit.w.facilities.nearest_outside.fire,
         ...hit.w.facilities.nearest_outside.hospital]
      : [];
    const nearest = {};
    for (const kind of ['police', 'fire', 'hospital']) {
      const best = pool
        .filter((p) => p.kind === kind)
        .map((p) => ({ name: p.name, distance_m: metres({ lat, lon }, p), osm: p.osm }))
        .sort((a, b) => a.distance_m - b.distance_m)[0];
      nearest[kind] = best || null;
    }
    k.nearest = nearest;

    k.units_estimated_note = k.units_estimated
      ? 'derived from OSM footprint area x floors / 130 sqm per dwelling'
      : null;
    k.confidence = k.units_estimated ? 'estimated from built form' : k.confidence;
  }

  kept.sort((a, b) => (b.units_estimated?.mid || 0) - (a.units_estimated?.mid || 0));

  const standalone = kept.filter((k) => !k.part_of);
  const over150 = standalone.filter((k) => (k.units_estimated?.mid || 0) >= MIN_UNITS);
  const unknown = kept.filter((k) => !k.units_estimated);

  fs.writeFileSync(
    path.join(DATA, 'societies.json'),
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        method: {
          spatial: 'OpenStreetMap via Overpass (ODbL)',
          units: `footprint area x floors x ${EFFICIENCY} efficiency, divided by ${SQM_PER_UNIT.mid} sqm per dwelling. Range uses ${SQM_PER_UNIT.low} to ${SQM_PER_UNIT.high} sqm`,
          wards: 'Government of Karnataka GBA ward notification, 7 March 2026, via OpenCity',
          excluded: 'government and institutional housing, BBMP layouts, non residential builder matches',
        },
        counts: {
          raw_candidates: candidates.length,
          kept: kept.length,
          added_by_builder_name: added,
          standalone: standalone.length,
          enclaves: kept.length - standalone.length,
          estimated_150_plus: over150.length,
          units_unknown: unknown.length,
          dropped,
        },
        societies: kept,
      },
      null,
      2
    )
  );

  console.log('\n--- society count check ---');
  console.log(`raw candidates          ${candidates.length}`);
  console.log(`dropped government      ${dropped.government}`);
  console.log(`dropped layouts         ${dropped.layout}`);
  console.log(`dropped no signal       ${dropped.no_signal}`);
  console.log(`added by builder name   ${added}`);
  console.log(`kept                    ${kept.length}`);
  console.log(`  estimated 150+ units  ${over150.length}`);
  console.log(`  unit count unknown    ${unknown.length}`);
})();
