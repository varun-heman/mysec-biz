#!/usr/bin/env node
/**
 * Step 1: pull candidate apartment societies in Bengaluru from OpenStreetMap
 * via the public Overpass API. Free, no key, ODbL licensed.
 *
 * This gives us the spatial spine only:
 *   name, GPS centroid, polygon, plot area (computed), address parts,
 *   building levels where mapped.
 *
 * Everything else (unit count, unit mix, unit sizes, income band, amenities,
 * year built, incidents) comes from later steps and stays null until then.
 *
 * Usage: node 01-osm-candidates.js  ->  writes ../data/osm-candidates.json
 */

const fs = require('fs');
const path = require('path');

const ENDPOINT = 'https://overpass-api.de/api/interpreter';

const QUERY = `
[out:json][timeout:180];
area["name"="Bengaluru"]["boundary"="administrative"]->.blr;
(
  way["landuse"="residential"]["name"](area.blr);
  relation["landuse"="residential"]["name"](area.blr);
  way["building"="apartments"]["name"](area.blr);
  way["residential"="gated"]["name"](area.blr);
  relation["residential"="gated"]["name"](area.blr);
);
out geom;
`;

// Minimum plot footprint we care about. A 150-unit society is essentially
// never smaller than this. 4000 sq m ~ 1 acre.
const MIN_AREA_SQM = 4000;

async function overpass(query) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ data: query }),
  });
  if (!res.ok) throw new Error(`Overpass ${res.status}: ${await res.text()}`);
  return res.json();
}

/** Spherical excess area of a lat/lon ring, in square metres. */
function ringAreaSqm(ring) {
  const R = 6378137;
  let total = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    total +=
      ((b.lon - a.lon) * Math.PI) / 180 *
      (2 + Math.sin((a.lat * Math.PI) / 180) + Math.sin((b.lat * Math.PI) / 180));
  }
  return Math.abs((total * R * R) / 2);
}

function geometryOf(el) {
  if (el.type === 'way' && el.geometry) return [el.geometry];
  if (el.type === 'relation' && el.members) {
    return el.members
      .filter((m) => m.role === 'outer' && m.geometry)
      .map((m) => m.geometry);
  }
  return [];
}

function centroid(rings) {
  const pts = rings.flat();
  const lat = pts.reduce((s, p) => s + p.lat, 0) / pts.length;
  const lon = pts.reduce((s, p) => s + p.lon, 0) / pts.length;
  return { lat: +lat.toFixed(6), lon: +lon.toFixed(6) };
}

(async () => {
  console.log('querying Overpass...');
  const data = await overpass(QUERY);
  console.log(`  ${data.elements.length} raw elements`);

  const rows = [];
  for (const el of data.elements) {
    const t = el.tags || {};
    const rings = geometryOf(el);
    if (!rings.length) continue;

    const areaSqm = Math.round(rings.reduce((s, r) => s + ringAreaSqm(r), 0));
    if (areaSqm < MIN_AREA_SQM) continue;

    const c = centroid(rings);
    rows.push({
      id: `osm:${el.type}/${el.id}`,
      name: t.name,
      source: {
        spatial: `https://www.openstreetmap.org/${el.type}/${el.id}`,
        licence: 'ODbL, OpenStreetMap contributors',
      },
      city: 'Bengaluru',
      location: {
        lat: c.lat,
        lon: c.lon,
        street: t['addr:street'] || null,
        locality: t['addr:suburb'] || t['addr:neighbourhood'] || null,
        postcode: t['addr:postcode'] || null,
        address_full: null, // filled by reverse geocode in step 2
      },
      plot: {
        area_sqm: areaSqm,
        area_acres: +(areaSqm / 4046.86).toFixed(2),
        source: 'computed from OSM polygon',
      },
      osm_tags: {
        landuse: t.landuse || null,
        building: t.building || null,
        levels: t['building:levels'] ? Number(t['building:levels']) : null,
        operator: t.operator || null,
      },
      polygon: rings[0].map((p) => [p.lat, p.lon]),

      // ---- everything below is unfilled until a sourced step populates it ----
      units_total: null,
      unit_types: null,
      avg_unit_sqft: null,
      units_by_bedrooms: null,
      income_band: null,
      amenities: null,
      year_built: null,
      incidents: null,
      confidence: 'candidate: spatial only',
    });
  }

  rows.sort((a, b) => b.plot.area_sqm - a.plot.area_sqm);
  const out = path.join(__dirname, '..', 'data', 'osm-candidates.json');
  fs.writeFileSync(
    out,
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        source: 'OpenStreetMap via Overpass API (ODbL)',
        query: QUERY.trim(),
        min_area_sqm: MIN_AREA_SQM,
        count: rows.length,
        societies: rows,
      },
      null,
      2
    )
  );
  console.log(`  ${rows.length} candidates >= ${MIN_AREA_SQM} sqm -> ${out}`);
})();
