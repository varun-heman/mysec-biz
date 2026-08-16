#!/usr/bin/env node
/**
 * Step 11: street lighting per ward, moved onto the new ward map.
 *
 * BBMP published street light counts against its own 198 wards. Those wards no
 * longer exist: the Greater Bengaluru Authority replaced them with 369. So the
 * counts have to be moved across, and the honest way to do that is by area.
 *
 * For each new GBA ward, points are sampled inside it, each point is located in
 * the old BBMP ward map, and the new ward takes its share of each old ward's
 * lights in proportion to how much of that old ward it covers. Sampling rather
 * than exact polygon intersection keeps this to plain JavaScript, and 4,000
 * samples a ward is well inside the noise of the source data.
 *
 * A new ward outside the old BBMP limits, which is most of the added area, gets
 * no figure at all rather than a guess. That is a real answer: BBMP never
 * counted lights there.
 *
 * Usage: node 11-streetlights.js  ->  ../data/streetlights.json
 */

const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, '..', 'data');
const OUT = path.join(DATA, 'streetlights.json');

const COUNTS_CSV = 'https://data.opencity.in/dataset/68bab2e1-a94b-4ad5-b1b5-dc9658e462e4/resource/17cafe43-76ac-47fb-b893-fd2d2f0ebd0c/download/streetlights-in-bengaluru-wards.csv';
/* The 198 ward map, which is the one the light counts were recorded against.
   The 2022 file on the same dataset is a later 243 ward delimitation: its ward
   3 is Someshwara where the counts' ward 3 is Atturu, so joining to it attaches
   every figure to the wrong place. */
const OLD_WARDS_KML = 'https://data.opencity.in/dataset/87b978d1-352e-4b90-aa2c-9991e55d3425/resource/a0329df6-2924-43f4-8fe4-7a6ffcc1d53d/download/806d6b9c-e8d9-4eb0-a3a3-b2ba68ec3cda.kml';

const SAMPLES = 4000;

async function cached(url, file) {
  const p = path.join(DATA, file);
  if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${file}: ${res.status}`);
  const text = await res.text();
  fs.writeFileSync(p, text);
  return text;
}

/* ------------------------------------------------------------ geometry */

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

function ringAreaSqm(ring) {
  const R = 6378137;
  let total = 0;
  for (let i = 0; i < ring.length; i++) {
    const [alat, alon] = ring[i], [blat, blon] = ring[(i + 1) % ring.length];
    total += ((blon - alon) * Math.PI) / 180 *
      (2 + Math.sin((alat * Math.PI) / 180) + Math.sin((blat * Math.PI) / 180));
  }
  return Math.abs((total * R * R) / 2);
}

/** Placemarks from a KML, with their outer rings and whatever names they carry. */
function parseKml(xml) {
  const out = [];
  for (const pm of xml.match(/<Placemark[\s\S]*?<\/Placemark>/g) || []) {
    const name = (pm.match(/<name>\s*([\s\S]*?)\s*<\/name>/) || [])[1] || '';
    const fields = {};
    for (const m of pm.matchAll(/<SimpleData name="([^"]+)">\s*([\s\S]*?)\s*<\/SimpleData>/g)) fields[m[1]] = m[2];
    const rings = [];
    for (const b of pm.match(/<outerBoundaryIs>[\s\S]*?<\/outerBoundaryIs>/g) || []) {
      const c = b.match(/<coordinates>\s*([\s\S]*?)\s*<\/coordinates>/);
      if (!c) continue;
      const ring = c[1].trim().split(/\s+/)
        .map((p) => p.split(',').map(Number))
        .filter((p) => p.length >= 2 && !Number.isNaN(p[0]))
        .map(([lon, lat]) => [lat, lon]);
      if (ring.length > 3) rings.push(ring);
    }
    if (rings.length) out.push({ name: name.trim(), fields, rings });
  }
  return out;
}

const norm = (s) => String(s || '').toLowerCase().replace(/ward/g, ' ').replace(/[^a-z0-9]/g, '');

/* ---------------------------------------------------------------- main */

(async () => {
  console.log('reading street light counts and the old ward map...');
  const csv = await cached(COUNTS_CSV, '.cache-streetlights.csv');
  const oldKml = await cached(OLD_WARDS_KML, '.cache-bbmp-wards.kml');

  const counts = csv.trim().split('\n').slice(1).map((line) => {
    const cells = line.match(/("([^"]*)"|[^,]+)/g) || [];
    const clean = cells.map((c) => c.replace(/^"|"$/g, '').trim());
    return { no: Number(clean[0]), name: clean[1], lights: Number(String(clean[2]).replace(/[^\d]/g, '')) };
  }).filter((r) => r.lights > 0);
  console.log(`  ${counts.length} old wards with a light count`);

  const oldWards = parseKml(oldKml).map((w) => ({
    ...w,
    // Names in these files run from "1-Kempegowda Ward" to "Ward\u00a01", so the
    // number is taken from wherever it appears rather than from the start.
    no: Number(w.fields.WardNo || w.fields.WARD_NO || w.fields.ward_no || w.name.match(/(\d+)/)?.[1] || 0),
    box: bbox(w.rings),
    area: w.rings.reduce((s, r) => s + ringAreaSqm(r), 0),
  }));
  console.log(`  ${oldWards.length} old ward polygons`);

  // Join the counts to the polygons, by ward number first, then by name.
  const byNo = new Map(oldWards.map((w) => [w.no, w]));
  const byName = new Map(oldWards.map((w) => [norm(w.fields.WardName || w.fields.WARD_NAME || w.name), w]));

  let byNameHits = 0, byNoHits = 0;
  for (const row of counts) {
    const nameHit = byName.get(norm(row.name));
    const w = nameHit || byNo.get(row.no);
    if (!w) continue;
    if (nameHit) byNameHits++; else byNoHits++;
    w.lights = row.lights;
    w.sourceName = row.name;
  }
  console.log(`  matched by name ${byNameHits}, by number ${byNoHits}`);

  /* This boundary file names its wards "Ward 1" and nothing else, so a number
     join cannot be checked against a name. It is checked against the ground
     instead: where a ward name survived into the GBA map, the old polygon and
     the new one of that name should be in the same place. If the numbering
     belonged to a different delimitation they would be scattered. */
  const wardsForCheck = JSON.parse(fs.readFileSync(path.join(DATA, 'gba-wards.json'), 'utf8')).ward_list;
  const centre = (rings) => {
    const pts = rings.flat();
    return [pts.reduce((a, p) => a + p[0], 0) / pts.length, pts.reduce((a, p) => a + p[1], 0) / pts.length];
  };
  const newByName = new Map();
  for (const w of wardsForCheck) {
    const k = norm(w.name);
    if (!newByName.has(k)) newByName.set(k, []);
    newByName.get(k).push(centre(w.rings));
  }
  let checked = 0, agreed = 0;
  for (const w of oldWards) {
    if (!w.lights) continue;
    const same = newByName.get(norm(w.sourceName));
    if (!same) continue;
    checked++;
    const [alat, alon] = centre(w.rings);
    const km = Math.min(...same.map(([blat, blon]) =>
      Math.hypot((alat - blat) * 111, (alon - blon) * 109)));
    if (km < 3) agreed++;
  }
  console.log(`  placement check: ${agreed} of ${checked} wards that kept their name are within 3 km of it`);
  if (checked > 20 && agreed / checked < 0.8) {
    console.error('\nStop: the counts and the boundary file look like different delimitations.');
    process.exit(1);
  }

  const lit = oldWards.filter((w) => w.lights);
  const totalLights = lit.reduce((s, w) => s + w.lights, 0);

  /* ---- move the counts onto the new wards ---- */

  const wards = JSON.parse(fs.readFileSync(path.join(DATA, 'gba-wards.json'), 'utf8')).ward_list;
  const results = [];

  for (const nw of wards) {
    const box = bbox(nw.rings);
    const area = nw.rings.reduce((s, r) => s + ringAreaSqm(r), 0);

    let inside = 0;
    const share = new Map(); // old ward -> samples landing in it

    for (let i = 0; i < SAMPLES; i++) {
      // Halton style spread beats Math.random here, and it is reproducible.
      const u = ((i * 0.6180339887) % 1);
      const v = ((i * 0.7548776662) % 1);
      const lat = box.s + u * (box.n - box.s);
      const lon = box.w + v * (box.e - box.w);
      if (!nw.rings.some((r) => inRing(lat, lon, r))) continue;
      inside++;
      const hit = lit.find((w) =>
        lat >= w.box.s && lat <= w.box.n && lon >= w.box.w && lon <= w.box.e &&
        w.rings.some((r) => inRing(lat, lon, r)));
      if (hit) share.set(hit, (share.get(hit) || 0) + 1);
    }

    if (!inside) { results.push({ ward_no: nw.ward_no, name: nw.name, lights: null, covered: 0, reason: 'no samples landed inside' }); continue; }

    // Each old ward contributes its lights in proportion to the area of it that
    // this new ward covers: samples here / that ward's own area, scaled.
    const sampleArea = area / inside;
    let lights = 0;
    for (const [ow, n] of share) lights += ow.lights * ((n * sampleArea) / ow.area);

    const covered = [...share.values()].reduce((a, b) => a + b, 0) / inside;
    results.push({
      ward_no: nw.ward_no,
      name: nw.name,
      corporation: `Bengaluru ${nw.corporation}`,
      area_sqkm: +(area / 1e6).toFixed(2),
      lights: covered > 0.05 ? Math.round(lights) : null,
      lights_per_sqkm: covered > 0.05 ? Math.round(lights / (area / 1e6)) : null,
      covered: +covered.toFixed(2),
      reason: covered > 0.05 ? null : 'outside the area BBMP counted',
    });
  }

  const withData = results.filter((r) => r.lights != null);
  const moved = withData.reduce((s, r) => s + r.lights, 0);

  fs.writeFileSync(OUT, JSON.stringify({
    generated_at: new Date().toISOString(),
    source: {
      counts: 'BBMP street lights by ward, via OpenCity',
      counts_url: 'https://data.opencity.in/dataset/bengaluru-streetlights',
      old_boundaries: 'BBMP Ward Map 2022, via OpenCity',
      new_boundaries: 'Government of Karnataka GBA ward notification, 7 March 2026',
    },
    method: `area apportionment by ${SAMPLES} samples per new ward. A new ward keeps a figure only where more than 5 percent of it falls inside the old BBMP wards that were counted.`,
    caveat: 'BBMP counted 198 wards. The GBA area is larger, so wards in the added belt have no source figure and are left null rather than estimated.',
    old_wards_counted: lit.length,
    lights_in_source: totalLights,
    lights_placed: moved,
    new_wards_with_a_figure: withData.length,
    new_wards_without: results.length - withData.length,
    wards: results.sort((a, b) => a.ward_no - b.ward_no),
  }, null, 2));

  console.log(`\nold wards counted        ${lit.length}`);
  console.log(`lights in the source     ${totalLights.toLocaleString('en-IN')}`);
  console.log(`lights placed on new map ${moved.toLocaleString('en-IN')} (${Math.round((moved / totalLights) * 100)} percent)`);
  console.log(`new wards with a figure  ${withData.length} of ${results.length}`);
  console.log(`\nwrote ${OUT}`);
})();
