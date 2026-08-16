#!/usr/bin/env node
/**
 * Step 6: a picture of every society, from sources that cost nothing and need
 * no key.
 *
 * Three layers, five images at most per society:
 *
 * 1. Site aerial, from the Esri World Imagery export endpoint, framed on the
 *    society's own polygon. Free, keyless, and it works for every society we
 *    have a boundary for, which is the point: coverage first.
 * 2. Context aerial, the same view pulled back, so the approach roads, the
 *    neighbours and the perimeter are visible. Useful when sizing a deployment.
 * 3. Ground photographs from Wikimedia Commons, found by geosearch within
 *    400 m and kept only when the file name or its description mentions the
 *    society or its builder. CC licensed, credited in the index.
 *
 * Google's listing photos are not used: that needs a billed Places key. The
 * script for it is parked in scrape/optional/google-images.js if that changes.
 *
 * Usage:
 *   node 06-images.js                      # every society at 150 units or more
 *   node 06-images.js --min-units 0        # all of them
 *   node 06-images.js --limit 25           # a trial batch
 *   node 06-images.js --refresh            # redo ones already done
 *
 * Resumable. Anything already in the index is skipped unless --refresh.
 */

const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, '..', 'data');
const IMG = path.join(__dirname, '..', 'web', 'assets', 'img', 'societies');
const INDEX = path.join(IMG, 'index.json');

const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export';
const COMMONS = 'https://commons.wikimedia.org/w/api.php';
const UA = 'sauron-mysecurity/0.1 (society research; contact varun@agami.in)';

const MAX_PHOTOS = 5;
const COMMONS_RADIUS = 400;      // metres
const PAUSE_MS = 320;            // polite to both services

function arg(flag, fallback = null) {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] : fallback;
}
const MIN_UNITS = Number(arg('--min-units', 150));
const LIMIT = Number(arg('--limit', 0)) || Infinity;
const REFRESH = process.argv.includes('--refresh');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

/* ---------------------------------------------------------------- framing */

/** A box around the society, in degrees, with a margin so the wall is inside
 *  the frame rather than on its edge. */
function frame(society, pad) {
  const poly = society.polygon;
  if (poly?.length > 2) {
    let s = 90, n = -90, w = 180, e = -180;
    for (const [lat, lon] of poly) {
      if (lat < s) s = lat; if (lat > n) n = lat;
      if (lon < w) w = lon; if (lon > e) e = lon;
    }
    const dLat = (n - s) * pad, dLon = (e - w) * pad;
    return { s: s - dLat, n: n + dLat, w: w - dLon, e: e + dLon };
  }
  // No boundary, so fall back to a fixed box: 300 m either way at this latitude.
  const { lat, lon } = society.location;
  const d = 0.0027 * (1 + pad);
  return { s: lat - d, n: lat + d, w: lon - d / Math.cos((lat * Math.PI) / 180), e: lon + d / Math.cos((lat * Math.PI) / 180) };
}

/** Keep the request's aspect ratio matched to the box, so nothing is stretched. */
function size(box, wide = 900) {
  const ratio = ((box.n - box.s) / (box.e - box.w)) * Math.cos((((box.n + box.s) / 2) * Math.PI) / 180);
  const h = Math.round(Math.min(Math.max(wide * ratio, 320), 900));
  return `${wide},${h}`;
}

async function aerial(society, pad, file) {
  const box = frame(society, pad);
  const url = `${ESRI}?bbox=${box.w},${box.s},${box.e},${box.n}` +
    `&bboxSR=4326&imageSR=3857&size=${size(box)}&format=jpg&f=image`;
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`Esri ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 5000) throw new Error('Esri returned an empty tile');
  fs.writeFileSync(file, buf);
  return buf.length;
}

/* --------------------------------------------------------------- commons */

/** Does this Commons file actually show the society, or just sit near it? */
function relevant(title, description, society) {
  const hay = `${title} ${description}`.toLowerCase();
  const words = `${society.name} ${society.builder || ''}`
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 4 &&
      !['apartment', 'apartments', 'residency', 'residential', 'complex', 'phase', 'group', 'bengaluru', 'bangalore', 'private', 'limited', 'properties', 'developers', 'builders'].includes(w));
  return words.some((w) => hay.includes(w));
}

async function commons(society) {
  const { lat, lon } = society.location;
  const url = `${COMMONS}?action=query&format=json&origin=*` +
    `&generator=geosearch&ggsnamespace=6&ggslimit=20` +
    `&ggsradius=${COMMONS_RADIUS}&ggscoord=${lat}%7C${lon}` +
    `&prop=imageinfo&iiprop=url%7Cextmetadata&iiurlwidth=1400`;

  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) return [];
  const pages = (await res.json())?.query?.pages || {};

  const out = [];
  for (const p of Object.values(pages)) {
    const info = p.imageinfo?.[0];
    if (!info) continue;
    const meta = info.extmetadata || {};
    const strip = (v) => String(v?.value || '').replace(/<[^>]*>/g, '').trim();
    const description = strip(meta.ImageDescription);
    if (!relevant(p.title, description, society)) continue;
    out.push({
      url: info.thumburl || info.url,
      page: info.descriptionurl,
      title: p.title.replace(/^File:/, ''),
      author: strip(meta.Artist) || 'unknown',
      licence: strip(meta.LicenseShortName) || 'see file page',
    });
  }
  return out;
}

async function download(url, file) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`${res.status}`);
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
}

/**
 * Step 8 writes this same file. Holding a copy in memory and writing the whole
 * thing back wipes whatever the other run added in between, so the file is
 * re-read and merged on every write.
 */
function writeIndex(index, id) {
  let onDisk = {};
  try { onDisk = JSON.parse(fs.readFileSync(INDEX, 'utf8')); } catch { /* first write */ }
  const prior = onDisk[id];
  const mine = index[id];
  if (prior) {
    const seen = new Set();
    index[id] = {
      ...prior,
      ...mine,
      files: [...new Set([...(prior.files || []), ...(mine.files || [])])],
      credits: [...(prior.credits || []), ...(mine.credits || [])]
        .filter((c) => !seen.has(c.file) && seen.add(c.file)),
    };
  }
  onDisk[id] = index[id];
  fs.writeFileSync(INDEX, JSON.stringify(onDisk, null, 2));
}

/* ------------------------------------------------------------------ main */

(async () => {
  fs.mkdirSync(IMG, { recursive: true });
  const index = fs.existsSync(INDEX) ? JSON.parse(fs.readFileSync(INDEX, 'utf8')) : {};

  const file = JSON.parse(fs.readFileSync(path.join(DATA, 'societies.json'), 'utf8'));
  const queue = file.societies
    .filter((s) => !s.part_of)
    .filter((s) => (s.units_total ?? s.units_estimated?.mid ?? 0) >= MIN_UNITS)
    .filter((s) => REFRESH || !index[s.id])
    .sort((a, b) => (b.units_total ?? b.units_estimated?.mid ?? 0) - (a.units_total ?? a.units_estimated?.mid ?? 0))
    .slice(0, LIMIT);

  console.log(`${queue.length} societies to do, ${Object.keys(index).length} already in the index`);

  let aerials = 0, ground = 0, failed = 0;

  for (const [i, s] of queue.entries()) {
    const dir = path.join(IMG, slug(s.name));
    fs.mkdirSync(dir, { recursive: true });
    const rel = (n) => `assets/img/societies/${slug(s.name)}/${n}`;
    const files = [], credits = [];

    process.stdout.write(`[${i + 1}/${queue.length}] ${s.name.slice(0, 42).padEnd(42)} `);

    // 1 and 2: the site, then the same view pulled back.
    for (const [name, pad] of [['1-site.jpg', 0.12], ['2-context.jpg', 1.1]]) {
      try {
        await aerial(s, pad, path.join(dir, name));
        files.push(rel(name));
        credits.push({ file: rel(name), source: 'Esri World Imagery', licence: 'free to display with attribution' });
        aerials++;
      } catch (err) {
        process.stdout.write(`aerial failed (${err.message}) `);
        failed++;
      }
      await sleep(PAUSE_MS);
    }

    // 3: ground photographs, when Commons has any that are actually of this place.
    try {
      const photos = (await commons(s)).slice(0, MAX_PHOTOS - files.length);
      for (const [n, photo] of photos.entries()) {
        const name = `${n + 3}-photo.jpg`;
        try {
          await download(photo.url, path.join(dir, name));
          files.push(rel(name));
          credits.push({
            file: rel(name), source: 'Wikimedia Commons',
            title: photo.title, author: photo.author, licence: photo.licence, page: photo.page,
          });
          ground++;
        } catch { /* a single bad file is not worth stopping for */ }
        await sleep(PAUSE_MS);
      }
    } catch { /* Commons is a bonus, never a blocker */ }

    if (!files.length) { console.log('nothing'); continue; }

    index[s.id] = {
      name: s.name,
      files,
      credits,
      has_ground_photo: credits.some((c) => c.source === 'Wikimedia Commons'),
      fetched: new Date().toISOString().slice(0, 10),
    };
    writeIndex(index, s.id);
    console.log(`${files.length} images`);
  }

  console.log(`\naerials ${aerials}, ground photos ${ground}, failures ${failed}`);
  console.log(`index: ${INDEX}`);
})();
