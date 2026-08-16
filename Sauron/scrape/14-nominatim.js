#!/usr/bin/env node
/**
 * Step 14: locality and postal address, from Nominatim.
 *
 * OSM tags addr:suburb or addr:neighbourhood on the society polygon itself,
 * which covers about a fifth of the file. RERA fills a further slice with the
 * project taluk. Everyone else has a GPS point and nothing to say where it is.
 *
 * Nominatim's usage policy caps this at one request a second and asks for a
 * real contact in the User-Agent, so the run is slow by design: about 900
 * societies is fifteen to twenty minutes. Every response is cached by society
 * id in .cache-nominatim.json before it touches societies.json, so a kill or a
 * network drop loses at most the one request in flight, and a second run only
 * fetches what the first one did not finish.
 *
 * Only fields that are still null get written. Nothing here overwrites a
 * value that OSM or RERA already supplied.
 *
 * Usage:
 *   node 14-nominatim.js                # every society with no locality
 *   node 14-nominatim.js --limit 25     # a trial batch
 *   node 14-nominatim.js --refresh      # redo ones already in the cache
 */

const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, '..', 'data');
const SOCIETIES = path.join(DATA, 'societies.json');
const CACHE = path.join(DATA, '.cache-nominatim.json');

const ENDPOINT = 'https://nominatim.openstreetmap.org/reverse';
const UA = 'sauron-mysecurity/0.1 (society research; contact varun@agami.in)';

const PAUSE_MS = 1100; // Nominatim usage policy: max 1 request/second
const FLUSH_EVERY = 20; // societies.json writes, so a kill loses little
const MAX_RETRIES = 3;

function arg(flag, fallback = null) {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] : fallback;
}
const LIMIT = Number(arg('--limit', 0)) || Infinity;
const REFRESH = process.argv.includes('--refresh');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const normName = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** True when an address part is really just the society's own OSM name coming
 *  back at us, which happens because reverse geocoding starts from the
 *  society's own polygon or building. Not a locality. */
function isSelfReferential(candidate, societyName) {
  const c = normName(candidate), n = normName(societyName);
  if (!c || !n) return false;
  return c === n || (n.length > 5 && c.includes(n)) || (c.length > 5 && n.includes(c));
}

/** address parts roughly nearest to "locality", most specific first. Suburb
 *  in Bengaluru's Nominatim data is usually the GBA ward name, which doubles
 *  as the well known locality name (Gunjur, Hoodi, Varthur), so it is a good
 *  fallback once the finer grained parts are ruled out. */
function pickLocality(address, societyName) {
  const candidates = [address.neighbourhood, address.quarter, address.suburb, address.residential, address.city_district];
  return candidates.find((c) => c && !isSelfReferential(c, societyName)) || null;
}

async function reverseGeocode(lat, lon) {
  const url = `${ENDPOINT}?format=jsonv2&lat=${lat}&lon=${lon}&addressdetails=1&zoom=18&accept-language=en`;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA } });
      if (res.status === 429 || res.status === 503) {
        await sleep(PAUSE_MS * attempt * 3);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      return { ok: true, address: body.address || {}, display_name: body.display_name || null };
    } catch (err) {
      if (attempt === MAX_RETRIES) return { ok: false, error: err.message };
      await sleep(PAUSE_MS * attempt * 2);
    }
  }
  return { ok: false, error: 'exhausted retries' };
}

/* ------------------------------------------------------------------ main */

(async () => {
  const file = JSON.parse(fs.readFileSync(SOCIETIES, 'utf8'));
  const societies = file.societies;
  const cache = fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, 'utf8')) : {};

  const queue = societies
    .filter((s) => !s.location.locality)
    .filter((s) => REFRESH || !cache[s.id])
    .filter((s) => Number.isFinite(s.location.lat) && Number.isFinite(s.location.lon))
    .slice(0, LIMIT);

  console.log(`${societies.filter((s) => !s.location.locality).length} societies with no locality, ${queue.length} to fetch this run`);

  let fetched = 0, failed = 0, sinceFlush = 0;

  for (const [i, s] of queue.entries()) {
    process.stdout.write(`[${i + 1}/${queue.length}] ${s.name.slice(0, 42).padEnd(42)} `);

    const result = await reverseGeocode(s.location.lat, s.location.lon);
    cache[s.id] = { ...result, fetched: new Date().toISOString() };
    fs.writeFileSync(CACHE, JSON.stringify(cache, null, 2));

    if (result.ok) {
      fetched++;
      console.log(pickLocality(result.address, s.name) || '(no locality in response)');
    } else {
      failed++;
      console.log(`failed: ${result.error}`);
    }

    sinceFlush++;
    if (sinceFlush >= FLUSH_EVERY) { applyCache(societies, cache); fs.writeFileSync(SOCIETIES, JSON.stringify(file, null, 2)); sinceFlush = 0; }

    await sleep(PAUSE_MS);
  }

  const filled = applyCache(societies, cache);
  fs.writeFileSync(SOCIETIES, JSON.stringify(file, null, 2));

  const stillMissing = societies.filter((s) => !s.location.locality).length;
  console.log(`\nfetched ${fetched}, failed ${failed}`);
  console.log(`localities filled this run: ${filled}`);
  console.log(`still missing a locality: ${stillMissing} of ${societies.length}`);
  console.log(`wrote ${SOCIETIES}`);
})();

/** Copies cached Nominatim results onto societies that still have gaps.
 *  Returns how many localities it filled. */
function applyCache(societies, cache) {
  let filled = 0;
  for (const s of societies) {
    const c = cache[s.id];
    if (!c || !c.ok) continue;
    const { address, display_name } = c;

    const locality = pickLocality(address, s.name);
    if (locality && !s.location.locality) { s.location.locality = locality; filled++; }
    if (!s.location.street && address.road) s.location.street = address.road;
    if (!s.location.postcode && address.postcode) s.location.postcode = address.postcode;
    if (!s.location.address_full && display_name) s.location.address_full = display_name;

    if (locality || address.road || address.postcode || display_name) {
      s.source = s.source || {};
      s.source.address = 'Nominatim reverse geocode, (c) OpenStreetMap contributors, ODbL';
    }
  }
  return filled;
}
