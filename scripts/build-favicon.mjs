#!/usr/bin/env node
// Regenerates the Guessless favicon set (site/guessless/favicon*, apple-touch-icon).
//
//   node scripts/build-favicon.mjs
//
// Reproducible and offline: the logo ships in the repo, nothing is fetched at
// build time, and reruns are byte-identical (every output is -strip'd and the
// PNG compression level is pinned).
//
// Outputs, all referenced from the static <head> of site/guessless/index.html
// with root-absolute /guessless/... hrefs. That is not optional here: the page
// is served under a path prefix, and a browser's implicit favicon probe only
// ever hits the *origin* root, which belongs to a different project. An
// undeclared favicon.ico would never be requested.
//
//   favicon.ico            multi-resolution: 16, 32, 48
//   favicon-16x16.png
//   favicon-32x32.png
//   apple-touch-icon.png   180x180
//
// --- two design decisions, and why -----------------------------------------
//
// 1. Dark plate, not transparency. The mark is a near-black hooded figure whose
//    only bright features are the white eyes and the red inner glow; its
//    silhouette is carried by a light-gray sticker outline. Composited onto
//    transparency it would vanish into a light browser tab strip. Every size is
//    therefore composited onto the site's own #0a0a0a field (site/guessless/
//    index.html sets `background: #0a0a0a` on html and body), so the icon reads
//    as a dark plate in a light tab bar and as the mark's own field in a dark
//    one. The favicon plates get rounded corners; the Apple touch icon is left
//    square because iOS applies its own mask.
//
// 2. The small sizes are cropped to the face. Measured on the source, the mark's
//    solid alpha bounding box is 969x1127+144+34 and each eye is only ~75x165
//    source pixels. Reduced to 16px the whole figure puts well under one pixel
//    through each eye: rendered out, the eyes come back as dim grey smudges and
//    the mark is an undifferentiated dark blob. Cropping to an 880px square
//    around the hood opening -- shoulders, both eyes, the collar V -- roughly
//    doubles the eyes' share of the frame, and they survive to 16px as white
//    with the red glow still under them, which is the entire identity of the
//    mark. 16/32/48 share that crop so the ICO is internally consistent; the
//    180px Apple icon has resolution to spare and shows the whole figure.
//
//    A 1000px crop was also tried and is visibly worse at 16px (the eyes go
//    pink); the 880 number is the widest crop that still holds them white.

import { execFileSync } from 'node:child_process';
import { existsSync, statSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SRC = path.join(ROOT, 'site/guessless/uploads/pasted-1786572735264-0.png');
const OUT_DIR = path.join(ROOT, 'site/guessless');

const MAGICK = ['/opt/homebrew/bin/magick', '/usr/local/bin/magick', 'magick'].find(
  (p) => p === 'magick' || existsSync(p),
);

if (!existsSync(SRC)) {
  console.error(`missing source logo: ${SRC}`);
  process.exit(1);
}

const magick = (args) => execFileSync(MAGICK, args, { stdio: ['ignore', 'pipe', 'inherit'] });

// --- palette -----------------------------------------------------------------
const BG = '#0a0a0a'; // the page's own background, same value build-og.mjs uses

// --- source geometry (source is 1254x1254) -----------------------------------
// Solid mark, i.e. the alpha>50% bounding box. The default -trim box is larger
// (1134x1184+0+30) because the PNG carries a faint sub-1% alpha halo well
// outside the visible artwork; measuring off that would mis-centre everything.
//   magick <src> -alpha extract -threshold 50% -format "%@" info:  -> 969x1127+144+34
const MARK = { x: 144, y: 34, w: 969, h: 1127 };

// Centre of the hood opening: horizontally the mark's own centre, vertically the
// eye line, which sits a little above the figure's mid-height.
const FACE_CX = Math.round(MARK.x + MARK.w / 2); // 628
const FACE_CY = 650; // the eye line, a little above the figure's mid-height
const FACE_SIDE = 880; // hood shoulders + both eyes + the collar V

const FACE_CROP =
  `${FACE_SIDE}x${FACE_SIDE}` +
  `+${Math.round(FACE_CX - FACE_SIDE / 2)}+${Math.round(FACE_CY - FACE_SIDE / 2)}`;

const ROUND_PCT = 0.22; // corner radius as a fraction of the icon edge
const SS = 4; // supersample factor

// Downscaling this hard costs local contrast, and the eyes are the first thing
// to go. A light unsharp afterwards puts them back; the gain is deliberately low
// because a heavier pass rings the red glow into visible cyan fringes.
const SHARPEN = ['-unsharp', '0x0.6+0.9+0'];

/**
 * Square face crop of the source, flattened onto the dark field, at `px`,
 * with rounded corners.
 *
 * The corner mask is built separately at SS scale and box-filtered down, then
 * copied in as alpha, so the sharpening pass only ever sees artwork -- running
 * it after a mask composite would sharpen the corner arc into a bright ring.
 */
function facePlate(px, out) {
  const big = px * SS;
  const r = Math.round(px * ROUND_PCT) * SS;
  magick([
    SRC,
    '-background', BG, '-alpha', 'remove', '-alpha', 'off',
    '-crop', FACE_CROP, '+repage',
    // Lanczos to 4x, then a box average down: supersampling keeps the eyes from
    // dissolving the way a single Lanczos pass straight to 16px does.
    '-filter', 'Lanczos', '-resize', `${big}x${big}!`,
    '-filter', 'Box', '-resize', `${px}x${px}!`,
    ...SHARPEN,

    '(', '-size', `${big}x${big}`, 'xc:black',
    '-fill', 'white', '-draw', `roundrectangle 0,0,${big - 1},${big - 1},${r},${r}`,
    '-alpha', 'off', '-filter', 'Box', '-resize', `${px}x${px}!`,
    ')',
    '-alpha', 'off', '-compose', 'CopyOpacity', '-composite',

    '-strip', '-define', 'png:compression-level=9', '-define', 'png:exclude-chunk=date',
    out,
  ]);
}

/**
 * The whole figure, inset on a square dark plate, for the Apple touch icon.
 *
 * Left square on purpose: iOS applies its own corner mask, and rounding here
 * would show as a double radius. The 86% inset is what keeps the mark's points
 * clear of that mask -- it is a diamond, so it reads optically smaller than a
 * square at the same fraction, and a tighter fit put the top point under the
 * mask's arc.
 */
function fullPlate(px, out) {
  const inset = Math.round(px * 0.86);
  magick([
    '-size', `${px}x${px}`, `xc:${BG}`,
    '(', SRC,
    '-background', BG, '-alpha', 'remove', '-alpha', 'off',
    '-crop', `${MARK.w}x${MARK.h}+${MARK.x}+${MARK.y}`, '+repage',
    '-filter', 'Lanczos', '-resize', `${inset}x${inset}`,
    ')',
    '-gravity', 'center', '-compose', 'over', '-composite',
    '-alpha', 'off',
    // Truecolour this costs ~76KB, most of it spent encoding the source's film
    // grain across the hood. A 256-colour palette, undithered, measures 47dB
    // PSNR against it -- no visible banding at any size iOS renders it -- for a
    // little over half the bytes. It ships on every page view, so take the deal.
    '+dither', '-colors', '256',
    '-strip', '-define', 'png:compression-level=9', '-define', 'png:exclude-chunk=date',
    out,
  ]);
}

// --- build -------------------------------------------------------------------
const scratch = mkdtempSync(path.join(tmpdir(), 'guessless-favicon-'));
const written = [];

try {
  const png16 = path.join(OUT_DIR, 'favicon-16x16.png');
  const png32 = path.join(OUT_DIR, 'favicon-32x32.png');
  const apple = path.join(OUT_DIR, 'apple-touch-icon.png');
  const ico = path.join(OUT_DIR, 'favicon.ico');

  facePlate(16, png16);
  facePlate(32, png32);
  fullPlate(180, apple);

  // The .ico carries the same three plates. 48 is what Windows reaches for on
  // the desktop and in the taskbar; 16 and 32 are reused verbatim from the PNGs.
  const ico48 = path.join(scratch, 'ico-48.png');
  facePlate(48, ico48);
  magick([png16, png32, ico48, '-strip', ico]);

  written.push(ico, png16, png32, apple);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

// --- self-check --------------------------------------------------------------
const BUDGET = 100 * 1024; // these load on every page view
let failed = false;

const expect = [
  ['favicon-16x16.png', '16x16'],
  ['favicon-32x32.png', '32x32'],
  ['apple-touch-icon.png', '180x180'],
];
for (const [name, want] of expect) {
  const got = magick(['identify', '-format', '%wx%h', path.join(OUT_DIR, name)]).toString();
  if (got !== want) {
    console.error(`${name}: expected ${want}, got ${got}`);
    failed = true;
  }
}

const icoSizes = magick(['identify', '-format', '%wx%h ', path.join(OUT_DIR, 'favicon.ico')])
  .toString()
  .trim()
  .split(/\s+/);
for (const want of ['16x16', '32x32', '48x48']) {
  if (!icoSizes.includes(want)) {
    console.error(`favicon.ico is missing ${want} (has: ${icoSizes.join(', ')})`);
    failed = true;
  }
}

for (const f of written) {
  const bytes = statSync(f).size;
  if (bytes > BUDGET) {
    console.error(`${path.basename(f)} is ${bytes} bytes, over the ${BUDGET} byte budget`);
    failed = true;
  }
}

if (failed) process.exit(1);

const report = written
  .map((f) => `${path.basename(f)} ${statSync(f).size}B`)
  .join(', ');
console.log(`wrote ${path.relative(ROOT, OUT_DIR)}/: ${report} (ico: ${icoSizes.join(', ')})`);
