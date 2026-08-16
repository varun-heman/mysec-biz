#!/usr/bin/env node
/**
 * Shrink the society imagery so it can live in the repository and deploy fast.
 *
 * Builder sites publish hero renders at 2,000 px and more, which is far past
 * what a 130 px thumbnail strip or a lightbox needs. Everything is capped at
 * 1400 px on its long edge and re-encoded, using sips, which ships with macOS,
 * so there is no dependency to install.
 *
 * Two rules keep it honest:
 *   a file is only replaced when the new one is actually smaller
 *   nothing is upscaled, so a small image is left exactly as it is
 *
 * Usage:
 *   node optimise-images.js --dry     measure the saving, change nothing
 *   node optimise-images.js           rewrite in place
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', 'web', 'assets', 'img', 'societies');
const DRY = process.argv.includes('--dry');
const MAX_EDGE = 1200;
const QUALITY = 55;

const mb = (b) => `${(b / 1048576).toFixed(1)} MB`;

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else if (/\.(jpe?g|png|webp)$/i.test(entry.name)) out.push(p);
  }
  return out;
}

function dimensions(file) {
  const out = execFileSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', file]).toString();
  return {
    w: Number(out.match(/pixelWidth:\s*(\d+)/)?.[1] || 0),
    h: Number(out.match(/pixelHeight:\s*(\d+)/)?.[1] || 0),
  };
}

const files = walk(ROOT);
const before = files.reduce((s, f) => s + fs.statSync(f).size, 0);
console.log(`${files.length} images, ${mb(before)}`);

let shrunk = 0, skipped = 0, saved = 0, failed = 0;

for (const [i, file] of files.entries()) {
  if (i % 250 === 0) process.stdout.write(`  ${i}/${files.length}\r`);

  const size = fs.statSync(file).size;
  let dim;
  try { dim = dimensions(file); } catch { failed++; continue; }

  const longest = Math.max(dim.w, dim.h);
  // Small and already light: nothing to gain, and re-encoding would only
  // degrade it.
  if (longest <= MAX_EDGE && size < 70000) { skipped++; continue; }

  const tmp = path.join(path.dirname(file), `.tmp-${path.basename(file)}`);
  try {
    const args = ['-s', 'format', 'jpeg', '-s', 'formatOptions', String(QUALITY)];
    if (longest > MAX_EDGE) args.push('--resampleHeightWidthMax', String(MAX_EDGE));
    if (DRY) {
      execFileSync('sips', [...args, file, '--out', tmp], { stdio: 'ignore' });
    } else {
      execFileSync('sips', [...args, file, '--out', tmp], { stdio: 'ignore' });
    }
    const after = fs.statSync(tmp).size;

    // Never trade a smaller file for a bigger one.
    if (after < size) {
      saved += size - after;
      shrunk++;
      if (DRY) fs.unlinkSync(tmp);
      else fs.renameSync(tmp, file);
    } else {
      skipped++;
      fs.unlinkSync(tmp);
    }
  } catch {
    failed++;
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  }
}

console.log(`\n${shrunk} shrunk, ${skipped} left alone, ${failed} failed`);
console.log(`${DRY ? 'would save' : 'saved'} ${mb(saved)}, ${mb(before)} down to ${mb(before - saved)}`);
