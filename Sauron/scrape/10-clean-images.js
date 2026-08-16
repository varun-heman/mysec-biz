#!/usr/bin/env node
/**
 * Step 10: throw out the images that are not of the society.
 *
 * A builder's project page carries the project's photographs alongside the
 * brand mark, the awards strip and a hero shot of some other development. Those
 * are byte for byte identical on every page of the site, so they are found by
 * content rather than by guessing at file names: any image that appears under
 * more than one society is site furniture, not that society.
 *
 * Aerials and Wikimedia photographs are left alone. They are unique by
 * construction.
 *
 * Usage:
 *   node 10-clean-images.js --dry     report only
 *   node 10-clean-images.js           delete and rewrite the index
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const WEB = path.join(__dirname, '..', 'web');
const INDEX = path.join(WEB, 'assets', 'img', 'societies', 'index.json');
const DRY = process.argv.includes('--dry');

const sha1 = (file) => crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex');

const index = JSON.parse(fs.readFileSync(INDEX, 'utf8'));

/* ---- hash every builder image, and note which societies carry it ---- */

const owners = new Map(); // hash -> Set of society ids
const hashOf = new Map(); // file -> hash

for (const [id, entry] of Object.entries(index)) {
  for (const credit of entry.credits || []) {
    if (!credit.domain) continue;                     // builder images only
    const abs = path.join(WEB, credit.file);
    if (!fs.existsSync(abs)) continue;
    const h = sha1(abs);
    hashOf.set(credit.file, h);
    if (!owners.has(h)) owners.set(h, new Set());
    owners.get(h).add(id);
  }
}

const shared = new Set([...owners.entries()].filter(([, ids]) => ids.size > 1).map(([h]) => h));

console.log(`${hashOf.size} builder images, ${owners.size} distinct`);
console.log(`${shared.size} appear under more than one society, so they are site furniture`);

/* ---- drop them ---- */

let removed = 0, societiesTouched = 0, emptied = 0;

for (const [id, entry] of Object.entries(index)) {
  const doomed = (entry.credits || [])
    .filter((c) => c.domain && shared.has(hashOf.get(c.file)))
    .map((c) => c.file);
  if (!doomed.length) continue;

  societiesTouched++;
  removed += doomed.length;

  if (!DRY) {
    for (const file of doomed) {
      const abs = path.join(WEB, file);
      if (fs.existsSync(abs)) fs.unlinkSync(abs);
    }
    entry.files = (entry.files || []).filter((f) => !doomed.includes(f));
    entry.credits = (entry.credits || []).filter((c) => !doomed.includes(c.file));
    entry.has_builder_photo = (entry.credits || []).some((c) => c.domain);
    if (!entry.has_builder_photo) emptied++;
  }
}

if (!DRY) fs.writeFileSync(INDEX, JSON.stringify(index, null, 2));

const left = Object.values(index).filter((v) => (v.credits || []).some((c) => c.domain));
console.log(`\n${DRY ? 'would remove' : 'removed'} ${removed} images across ${societiesTouched} societies`);
console.log(`${left.length} societies still have builder photographs`);
if (emptied) console.log(`${emptied} were left with none, and are now aerial only`);
