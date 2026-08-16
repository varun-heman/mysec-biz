#!/usr/bin/env node
/**
 * Step 2: the 369 Greater Bengaluru Authority wards, and the emergency
 * infrastructure in and around each one.
 *
 * Ward boundaries come from OpenCity's publication of the Government of
 * Karnataka final ward notification of 7 March 2026, released as public domain:
 *   https://data.opencity.in/dataset/gba-ward-wise-reservations-2026
 * The KML carries ward number, ward name in English and Kannada, which of the
 * five corporations runs it, and the assembly constituency.
 *
 * Police stations, fire stations and hospitals come from OpenStreetMap via
 * Overpass. Each ward gets the ones inside it, and the nearest few outside, so
 * a society on a ward edge still shows a sensible response picture.
 *
 * Usage: node 02-gba-wards.js  ->  ../data/gba-wards.json
 */

const fs = require('fs');
const path = require('path');

const KML_URL =
  'https://data.opencity.in/dataset/e6356d29-ce41-4bc7-8292-bbd790070e14/resource/' +
  'aa77fba2-689b-43f2-a3d6-a737a42d63bd/download/gba-369-wards-december-2025-appended.kml';

const CACHE = path.join(__dirname, '..', 'data', '.cache-gba-wards.kml');
const OUT = path.join(__dirname, '..', 'data', 'gba-wards.json');
const ENDPOINT = 'https://overpass-api.de/api/interpreter';

const NEAREST_PER_KIND = 3; // extra facilities listed beyond the ward boundary

/* ------------------------------------------------------------------ fetch */

async function kml() {
  if (fs.existsSync(CACHE)) return fs.readFileSync(CACHE, 'utf8');
  console.log('downloading ward KML...');
  const res = await fetch(KML_URL);
  if (!res.ok) throw new Error(`KML ${res.status}`);
  const text = await res.text();
  fs.writeFileSync(CACHE, text);
  return text;
}

async function overpass(query) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ data: query }),
  });
  if (!res.ok) throw new Error(`Overpass ${res.status}: ${await res.text()}`);
  return res.json();
}

/* -------------------------------------------------------------- KML parse */

/** Minimal KML reader. The file is machine generated and flat, so regex is enough. */
function parseWards(xml) {
  const wards = [];
  const placemarks = xml.match(/<Placemark>[\s\S]*?<\/Placemark>/g) || [];

  for (const pm of placemarks) {
    const field = (name) => {
      const m = pm.match(
        new RegExp(`<SimpleData name="${name}">\\s*([\\s\\S]*?)\\s*</SimpleData>`)
      );
      return m ? m[1].trim() : null;
    };

    // Outer rings only. A few wards are multipolygons.
    const rings = [];
    for (const block of pm.match(/<outerBoundaryIs>[\s\S]*?<\/outerBoundaryIs>/g) || []) {
      const coords = block.match(/<coordinates>\s*([\s\S]*?)\s*<\/coordinates>/);
      if (!coords) continue;
      const ring = coords[1]
        .trim()
        .split(/\s+/)
        .map((p) => p.split(',').map(Number))
        .filter((p) => p.length >= 2 && !Number.isNaN(p[0]))
        .map(([lon, lat]) => [lat, lon]);
      if (ring.length > 3) rings.push(ring);
    }
    if (!rings.length) continue;

    wards.push({
      ward_no: Number(field('ward_id')),
      name: field('ward_name'),
      name_kn: field('ward_name_kn'),
      corporation: field('Corporation'),          // North, South, East, West, Central
      corporation_kn: field('corporation_kn'),
      corporation_id: Number(field('corporation_id')),
      assembly_no: Number(field('ac_no')),
      assembly: field('ac'),
      rings,
    });
  }
  return wards;
}

/* ------------------------------------------------------------- geometry */

function bbox(rings) {
  let s = 90, n = -90, w = 180, e = -180;
  for (const r of rings) for (const [lat, lon] of r) {
    if (lat < s) s = lat; if (lat > n) n = lat;
    if (lon < w) w = lon; if (lon > e) e = lon;
  }
  return { s, n, w, e };
}

function inRing(lat, lon, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [yi, xi] = ring[i];
    const [yj, xj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

const inWard = (lat, lon, w) =>
  lat >= w.box.s && lat <= w.box.n && lon >= w.box.w && lon <= w.box.e &&
  w.rings.some((r) => inRing(lat, lon, r));

function centroid(rings) {
  const pts = rings.flat();
  return {
    lat: +(pts.reduce((s, p) => s + p[0], 0) / pts.length).toFixed(6),
    lon: +(pts.reduce((s, p) => s + p[1], 0) / pts.length).toFixed(6),
  };
}

/** Great circle distance in metres. */
function metres(a, b) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}

/* ------------------------------------------------------------------ main */

const AMENITY_QUERY = `
[out:json][timeout:180];
(
  nwr["amenity"="police"](12.6,77.25,13.35,77.95);
  nwr["amenity"="fire_station"](12.6,77.25,13.35,77.95);
  nwr["amenity"="hospital"](12.6,77.25,13.35,77.95);
);
out tags center;
`;

(async () => {
  const wards = parseWards(await kml());
  console.log(`${wards.length} wards parsed`);
  wards.forEach((w) => { w.box = bbox(w.rings); });

  console.log('querying Overpass for police, fire and hospitals...');
  const data = await overpass(AMENITY_QUERY);

  const KIND = { police: 'police', fire_station: 'fire', hospital: 'hospital' };
  const places = [];
  for (const el of data.elements) {
    const t = el.tags || {};
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    if (lat == null || !KIND[t.amenity]) continue;
    places.push({
      kind: KIND[t.amenity],
      name: t.name || t['name:en'] || '(unnamed)',
      lat: +lat.toFixed(6),
      lon: +lon.toFixed(6),
      phone: t.phone || t['contact:phone'] || null,
      emergency: t.emergency || null,
      beds: t.beds ? Number(t.beds) : null,
      operator: t.operator || null,
      osm: `https://www.openstreetmap.org/${el.type}/${el.id}`,
    });
  }
  const tally = places.reduce((a, p) => ((a[p.kind] = (a[p.kind] || 0) + 1), a), {});
  console.log(`  ${places.length} facilities`, tally);

  for (const w of wards) {
    const c = centroid(w.rings);
    w.centre = c;

    const inside = places.filter((p) => inWard(p.lat, p.lon, w));
    const insideSet = new Set(inside.map((p) => p.osm));

    const near = {};
    for (const kind of ['police', 'fire', 'hospital']) {
      near[kind] = places
        .filter((p) => p.kind === kind && !insideSet.has(p.osm))
        .map((p) => ({ ...p, distance_m: metres(c, p) }))
        .sort((a, b) => a.distance_m - b.distance_m)
        .slice(0, NEAREST_PER_KIND);
    }

    w.facilities = {
      inside: inside.map((p) => ({ ...p, distance_m: metres(c, p) })),
      nearest_outside: near,
    };
    delete w.box;
  }

  fs.writeFileSync(
    OUT,
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        wards: wards.length,
        boundaries: {
          source: 'Government of Karnataka final ward notification, 7 March 2026',
          via: 'https://data.opencity.in/dataset/gba-ward-wise-reservations-2026',
          licence: 'Public domain',
        },
        facilities: {
          source: 'OpenStreetMap via Overpass API',
          licence: 'ODbL, OpenStreetMap contributors',
          counts: tally,
          caveat:
            'OSM coverage of police and fire stations is good but not complete. ' +
            'Cross check against the Bengaluru City Police and Karnataka Fire and ' +
            'Emergency Services station lists before relying on it.',
        },
        ward_list: wards,
      },
      null,
      2
    )
  );
  console.log(`wrote ${OUT}`);
})();
