#!/usr/bin/env node
/**
 * Step 7: street level photographs from Mapillary.
 *
 * The aerials in step 6 show the site. This shows the gate, the compound wall
 * and the approach, which is what you actually want when sizing a deployment or
 * walking into a pitch.
 *
 * Free, but it needs a token. Two minutes, no billing:
 *   1. sign in at https://www.mapillary.com
 *   2. https://www.mapillary.com/dashboard/developers, register an application
 *   3. copy the client token, then:  export MAPILLARY_TOKEN=MLY|...
 *
 * Usage:
 *   node 07-mapillary.js --society "Prestige Lakeside Habitat"   # just one
 *   node 07-mapillary.js --min-units 150 --limit 25              # a batch
 *
 * Images are added to the same folder and index as step 6, never replacing the
 * aerials, and capped so a society holds five files in total. Licence is
 * CC-BY-SA, recorded per file with a link back to the image on Mapillary.
 */

const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, '..', 'data');
const IMG = path.join(__dirname, '..', 'web', 'assets', 'img', 'societies');
const INDEX = path.join(IMG, 'index.json');

const TOKEN = process.env.MAPILLARY_TOKEN || arg('--token');
const GRAPH = 'https://graph.mapillary.com/images';
const UA = 'sauron-mysecurity/0.1';

const MAX_TOTAL = 5;        // files per society, aerials included
const RADIUS_M = 220;       // how far from the society centre to look
const PAUSE_MS = 250;

function arg(flag, fallback = null) {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] : fallback;
}
const ONE = arg('--society');
const MIN_UNITS = Number(arg('--min-units', 150));
const LIMIT = Number(arg('--limit', 0)) || Infinity;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

function metres(a, b) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}

/** A box of roughly RADIUS_M around the society, in degrees. */
function bbox({ lat, lon }) {
  const dLat = RADIUS_M / 111320;
  const dLon = dLat / Math.cos((lat * Math.PI) / 180);
  return [lon - dLon, lat - dLat, lon + dLon, lat + dLat].join(',');
}

async function nearby(society) {
  const url = `${GRAPH}?access_token=${encodeURIComponent(TOKEN)}` +
    `&fields=id,thumb_1024_url,captured_at,compass_angle,geometry,is_pano` +
    `&bbox=${bbox(society.location)}&limit=60`;

  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (res.status === 401) throw new Error('token rejected, check MAPILLARY_TOKEN');
  if (!res.ok) throw new Error(`Mapillary ${res.status}: ${(await res.text()).slice(0, 140)}`);

  const { data = [] } = await res.json();

  return data
    .filter((im) => im.thumb_1024_url && im.geometry?.coordinates)
    .map((im) => {
      const [lon, lat] = im.geometry.coordinates;
      return { ...im, lat, lon, distance_m: metres(society.location, { lat, lon }) };
    })
    // Closest first, and a flat photo beats a 360 for reading a gate.
    .sort((a, b) => (a.is_pano === b.is_pano ? a.distance_m - b.distance_m : a.is_pano ? 1 : -1));
}

/** Keep views that face different ways, so five shots are not one spot five times. */
function spread(images, want) {
  const out = [];
  for (const im of images) {
    const clash = out.some((k) =>
      metres(k, im) < 35 &&
      Math.abs(((k.compass_angle ?? 0) - (im.compass_angle ?? 0) + 540) % 360 - 180) < 45);
    if (clash) continue;
    out.push(im);
    if (out.length >= want) break;
  }
  return out;
}

async function download(url, file) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`${res.status}`);
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
}

(async () => {
  if (!TOKEN) {
    console.error(
      'No token. Set MAPILLARY_TOKEN, or pass --token.\n' +
      'Free, no billing: sign in at mapillary.com, open the developer dashboard,\n' +
      'register an application and copy the client token (it starts with MLY|).'
    );
    process.exit(1);
  }

  const index = fs.existsSync(INDEX) ? JSON.parse(fs.readFileSync(INDEX, 'utf8')) : {};
  const file = JSON.parse(fs.readFileSync(path.join(DATA, 'societies.json'), 'utf8'));

  const queue = ONE
    ? file.societies.filter((s) => s.name.toLowerCase().includes(ONE.toLowerCase())).slice(0, 1)
    : file.societies
        .filter((s) => !s.part_of)
        .filter((s) => (s.units_total ?? s.units_estimated?.mid ?? 0) >= MIN_UNITS)
        .filter((s) => !(index[s.id]?.credits || []).some((c) => c.source === 'Mapillary'))
        .sort((a, b) => (b.units_total ?? b.units_estimated?.mid ?? 0) - (a.units_total ?? a.units_estimated?.mid ?? 0))
        .slice(0, LIMIT);

  if (!queue.length) { console.log('nothing to do'); return; }
  console.log(`${queue.length} societies`);

  let saved = 0;

  for (const s of queue) {
    const entry = index[s.id] || { name: s.name, files: [], credits: [] };
    const room = MAX_TOTAL - entry.files.length;
    process.stdout.write(`${s.name.slice(0, 44).padEnd(44)} `);

    if (room <= 0) { console.log('already full'); continue; }

    let images;
    try {
      images = await nearby(s);
    } catch (err) {
      console.log(err.message);
      continue;
    }
    if (!images.length) { console.log('no street imagery within 220 m'); continue; }

    const dir = path.join(IMG, slug(s.name));
    fs.mkdirSync(dir, { recursive: true });

    const picks = spread(images, room);
    let n = 0;
    for (const im of picks) {
      const name = `${entry.files.length + 1}-street.jpg`;
      try {
        await download(im.thumb_1024_url, path.join(dir, name));
        const rel = `assets/img/societies/${slug(s.name)}/${name}`;
        entry.files.push(rel);
        entry.credits.push({
          file: rel,
          source: 'Mapillary',
          licence: 'CC-BY-SA 4.0',
          page: `https://www.mapillary.com/app/?pKey=${im.id}`,
          captured: im.captured_at ? new Date(im.captured_at).toISOString().slice(0, 10) : null,
          distance_m: im.distance_m,
          pano: !!im.is_pano,
        });
        n++; saved++;
      } catch (err) {
        process.stdout.write(`(one failed: ${err.message}) `);
      }
      await sleep(PAUSE_MS);
    }

    entry.has_street_photo = n > 0;
    index[s.id] = entry;
    fs.writeFileSync(INDEX, JSON.stringify(index, null, 2));
    console.log(`${n} street photos, nearest ${picks[0]?.distance_m} m`);
  }

  console.log(`\n${saved} street photographs saved`);
})();
