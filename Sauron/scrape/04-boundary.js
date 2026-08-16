#!/usr/bin/env node
/**
 * Step 4: the outline of Greater Bengaluru, for the map.
 *
 * The 369 ward polygons tile the city exactly, so any edge shared by two wards
 * is interior and any edge that appears once is on the outside. Cancel the
 * shared ones, chain what is left into closed rings, and that is the city
 * boundary, derived from the same official notification as the wards.
 *
 * Usage: node 04-boundary.js  ->  ../data/gba-boundary.json
 */

const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, '..', 'data');
const P = (lat, lon) => `${lat.toFixed(7)},${lon.toFixed(7)}`;

const wards = JSON.parse(fs.readFileSync(path.join(DATA, 'gba-wards.json'), 'utf8')).ward_list;

/* ---- cancel every edge that two wards share ---- */

const count = new Map();
for (const w of wards) {
  for (const ring of w.rings) {
    for (let i = 0; i < ring.length - 1; i++) {
      const a = P(...ring[i]);
      const b = P(...ring[i + 1]);
      if (a === b) continue;
      const key = a < b ? `${a}|${b}` : `${b}|${a}`;
      count.set(key, (count.get(key) || 0) + 1);
    }
  }
}

const outer = [...count.entries()].filter(([, n]) => n === 1).map(([k]) => k.split('|'));
console.log(`${count.size} edges, ${outer.length} on the outside`);

/* ---- chain the survivors into closed rings ---- */

/* Walking greedily through junctions is what produced lines shooting across the
   city: at a node where three boundary edges meet, "any unused neighbour" can
   be the wrong one. So runs only ever continue through a node of degree two,
   and a junction ends the run. Nothing is ever joined that is not adjacent. */

const graph = new Map();
const push = (a, b) => {
  if (!graph.has(a)) graph.set(a, []);
  graph.get(a).push(b);
};
for (const [a, b] of outer) { push(a, b); push(b, a); }

const used = new Set();
const edgeKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
const rings = [];

function walk(start) {
  const run = [start];
  let node = start;
  let prev = null;

  while (true) {
    const nbrs = graph.get(node) || [];
    const next = nbrs.find((n) => n !== prev && !used.has(edgeKey(node, n)));
    if (next === undefined) break;
    used.add(edgeKey(node, next));
    run.push(next);
    if (next === start) break;                    // closed loop
    if ((graph.get(next) || []).length !== 2) break; // junction, stop here
    prev = node;
    node = next;
  }
  return run;
}

// Junctions first, so the runs between them come out whole, then any loop left.
const starts = [...graph.keys()].sort((a, b) => (graph.get(a).length === 2) - (graph.get(b).length === 2));

for (const start of starts) {
  let guard = 0;
  while ((graph.get(start) || []).some((n) => !used.has(edgeKey(start, n))) && guard++ < 8) {
    const run = walk(start);
    if (run.length > 3) rings.push(run.map((p) => p.split(',').map(Number)));
  }
}

rings.sort((a, b) => b.length - a.length);
console.log(`${rings.length} runs, longest ${rings[0]?.length} points`);

/** Drop points that barely move the line, so the map draws fewer of them. */
function thin(ring, tolerance = 0.00012) {
  const out = [ring[0]];
  for (const p of ring.slice(1)) {
    const q = out[out.length - 1];
    if (Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) > tolerance) out.push(p);
  }
  // Close the line only if it was closed to begin with. Closing an open run
  // would draw a line straight back across the city to where it started.
  const closed = ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1];
  const last = out[out.length - 1];
  if (closed) out.push(ring[0]);
  else if (last !== ring[ring.length - 1]) out.push(ring[ring.length - 1]);
  return out;
}

const thinned = rings.map((r) => thin(r));

fs.writeFileSync(
  path.join(DATA, 'gba-boundary.json'),
  JSON.stringify({
    generated_at: new Date().toISOString(),
    source: 'derived from the Government of Karnataka GBA ward notification, 7 March 2026',
    note: 'outer edges of the 369 ward polygons, shared edges cancelled',
    points_before: rings.reduce((s, r) => s + r.length, 0),
    points_after: thinned.reduce((s, r) => s + r.length, 0),
    rings: thinned,
  })
);
console.log(`wrote gba-boundary.json, ${thinned.reduce((s, r) => s + r.length, 0)} points`);
