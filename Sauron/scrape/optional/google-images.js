#!/usr/bin/env node
/**
 * Step 6: photographs of each society, from its Google business listing.
 *
 * Uses the Places API (New): a text search to find the listing, then the photo
 * media endpoint for up to five images, saved under
 * web/assets/img/societies/<slug>/ with an index the app reads.
 *
 * Needs a key with the Places API enabled and billing on:
 *
 *   export GOOGLE_MAPS_API_KEY=...
 *   node 06-images.js --min-units 150 --limit 50      # try a batch first
 *   node 06-images.js --min-units 150                 # then the rest
 *
 * Note on terms: Google's Places policy allows caching place ids indefinitely
 * but treats photo bytes as content you may not store beyond what the service
 * permits. Keeping these files is a call for whoever runs it, not something the
 * script decides. Nothing here bypasses the API or scrapes a page.
 *
 * Resumable. A society that already has images is skipped, so a rate limit or a
 * dropped connection costs nothing on the next run.
 */

const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, '..', 'data');
const IMG = path.join(__dirname, '..', 'web', 'assets', 'img', 'societies');
const INDEX = path.join(IMG, 'index.json');

const KEY = process.env.GOOGLE_MAPS_API_KEY || arg('--key');
const MAX_PHOTOS = 5;
const MAX_WIDTH = 1200;
const MATCH_METRES = 800;      // a listing further than this is a different place
const PAUSE_MS = 220;          // gentle on the quota

function arg(flag, fallback = null) {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] : fallback;
}

const MIN_UNITS = Number(arg('--min-units', 150));
const LIMIT = Number(arg('--limit', 0)) || Infinity;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const slug = (s) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

function metres(a, b) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lng - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}

/** Do the two names share a distinctive word? Guards against a listing for the
 *  cafe across the road being attached to the society. */
function namesAgree(a, b) {
  const words = (s) => new Set(
    s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/)
      .filter((w) => w.length > 3 && !['apartment', 'apartments', 'residency', 'phase', 'block', 'bengaluru', 'bangalore'].includes(w))
  );
  const A = words(a), B = words(b);
  for (const w of A) if (B.has(w)) return true;
  return false;
}

async function searchPlace(society) {
  const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': KEY,
      'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location,places.photos,places.rating,places.userRatingCount',
    },
    body: JSON.stringify({
      textQuery: `${society.name}, Bengaluru`,
      maxResultCount: 3,
      locationBias: {
        circle: {
          center: { latitude: society.location.lat, longitude: society.location.lon },
          radius: 2000,
        },
      },
    }),
  });

  if (res.status === 429) throw Object.assign(new Error('rate limited'), { retry: true });
  if (!res.ok) throw new Error(`searchText ${res.status}: ${(await res.text()).slice(0, 160)}`);

  const { places = [] } = await res.json();
  for (const p of places) {
    if (!p.location) continue;
    const d = metres(society.location, p.location);
    if (d > MATCH_METRES) continue;
    if (!namesAgree(society.name, p.displayName?.text || '')) continue;
    return { ...p, distance_m: d };
  }
  return null;
}

async function download(photoName, file) {
  const url = `https://places.googleapis.com/v1/${photoName}/media` +
    `?maxWidthPx=${MAX_WIDTH}&skipHttpRedirect=false&key=${KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`photo ${res.status}`);
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  return fs.statSync(file).size;
}

(async () => {
  if (!KEY) {
    console.error(
      'No key. Set GOOGLE_MAPS_API_KEY, or pass --key <key>.\n' +
      'The key needs the Places API (New) enabled and billing switched on.\n' +
      'Rough cost at current list price: about $32 per 1,000 text searches ' +
      'and $7 per 1,000 photos, so around $0.06 per society at five photos each.'
    );
    process.exit(1);
  }

  fs.mkdirSync(IMG, { recursive: true });
  const index = fs.existsSync(INDEX) ? JSON.parse(fs.readFileSync(INDEX, 'utf8')) : {};

  const file = JSON.parse(fs.readFileSync(path.join(DATA, 'societies.json'), 'utf8'));
  const queue = file.societies
    .filter((s) => !s.part_of)
    .filter((s) => (s.units_total ?? s.units_estimated?.mid ?? 0) >= MIN_UNITS)
    .filter((s) => !index[s.id])
    .sort((a, b) => (b.units_total ?? b.units_estimated?.mid ?? 0) - (a.units_total ?? a.units_estimated?.mid ?? 0))
    .slice(0, LIMIT);

  console.log(`${queue.length} societies to try, ${Object.keys(index).length} already done`);

  let found = 0, missed = 0, photos = 0;

  for (const [i, s] of queue.entries()) {
    process.stdout.write(`[${i + 1}/${queue.length}] ${s.name.slice(0, 44).padEnd(44)} `);

    let place;
    try {
      place = await searchPlace(s);
    } catch (err) {
      if (err.retry) { console.log('rate limited, waiting 30s'); await sleep(30000); continue; }
      console.log(`search failed: ${err.message}`);
      continue;
    }

    if (!place) { missed++; console.log('no matching listing'); await sleep(PAUSE_MS); continue; }

    const dir = path.join(IMG, slug(s.name));
    fs.mkdirSync(dir, { recursive: true });

    const files = [];
    for (const [n, photo] of (place.photos || []).slice(0, MAX_PHOTOS).entries()) {
      const out = path.join(dir, `${n + 1}.jpg`);
      try {
        await download(photo.name, out);
        files.push(`assets/img/societies/${slug(s.name)}/${n + 1}.jpg`);
        photos++;
      } catch (err) {
        console.log(`\n  photo ${n + 1} failed: ${err.message}`);
      }
      await sleep(PAUSE_MS);
    }

    if (!files.length) { missed++; console.log('listing found, no photos'); continue; }

    found++;
    index[s.id] = {
      place_id: place.id,
      listing: place.displayName?.text || null,
      address: place.formattedAddress || null,
      rating: place.rating ?? null,
      ratings_count: place.userRatingCount ?? null,
      distance_m: place.distance_m,
      files,
      fetched: new Date().toISOString().slice(0, 10),
      source: 'Google Places API (New), photo media endpoint',
    };
    fs.writeFileSync(INDEX, JSON.stringify(index, null, 2));
    console.log(`${files.length} photos`);
    await sleep(PAUSE_MS);
  }

  console.log(`\nlistings matched ${found}, no match ${missed}, photos saved ${photos}`);
  console.log(`index: ${INDEX}`);
})();
