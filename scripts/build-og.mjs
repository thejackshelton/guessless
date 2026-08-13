#!/usr/bin/env node
// Regenerates the Guessless social preview image (site/guessless/og.png).
//
//   node scripts/build-og.mjs
//
// Reproducible and offline: the logo ships in the repo and the typeface ships in
// scripts/fonts/. Nothing is fetched at build time.
//
// Design language is lifted from site/guessless/index.html:
//   background #0a0a0a, primary text #ededed, secondary #b5b5b5, dim #666
//   accent oklch(0.72 0.19 12) -> #ff6885 in sRGB (naive clip; the value is
//   marginally outside the sRGB gamut, a gamut-mapped browser lands on ~#ff6f83)
//
// Typeface: Unbounded, the same display face the page loads from Google Fonts,
// vendored here as static per-weight TrueType so the real 600/700 outlines are
// available. This ImageMagick build has no fontconfig or Pango delegate, so a
// variable font would only ever render at weight 400 and the semibold would have
// to be faked with a stroke; static instances avoid that entirely.
//
// Unbounded is much wider per character than a grotesque at the same point size,
// so the sizes here are fitted to the right column rather than carried over from
// the earlier Helvetica setting. Tracking follows the page's own intent:
// 0.02em on the wordmark (site header), -0.01em on the tagline (site h1).

import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SRC = path.join(ROOT, 'site/guessless/uploads/pasted-1786572735264-0.png');
const OUT = path.join(ROOT, 'site/guessless/og.png');
const FONT_DIR = path.join(HERE, 'fonts');

const MAGICK = ['/opt/homebrew/bin/magick', '/usr/local/bin/magick', 'magick'].find(
  (p) => p === 'magick' || existsSync(p),
);

// Static Unbounded instances, committed to the repo. These are the exact files
// the Google Fonts CSS API serves for the corresponding weights:
//   curl -sH "User-Agent: Mozilla/4.0" \
//     "https://fonts.googleapis.com/css2?family=Unbounded:wght@400;600"
// Unbounded is licensed under the SIL OFL 1.1; see scripts/fonts/OFL.txt.
const FONT_REGULAR = path.join(FONT_DIR, 'Unbounded-Regular.ttf');
const FONT_SEMIBOLD = path.join(FONT_DIR, 'Unbounded-SemiBold.ttf');

if (!existsSync(SRC)) {
  console.error(`missing source logo: ${SRC}`);
  process.exit(1);
}
for (const f of [FONT_REGULAR, FONT_SEMIBOLD]) {
  if (!existsSync(f)) {
    console.error(
      `missing font: ${f}\n` +
        'Restore the vendored Unbounded statics (they are tracked in git):\n' +
        `  git checkout -- ${path.relative(ROOT, FONT_DIR)}\n` +
        'or re-fetch them from the Google Fonts CSS API:\n' +
        '  curl -sH "User-Agent: Mozilla/4.0" \\\n' +
        '    "https://fonts.googleapis.com/css2?family=Unbounded:wght@400;600"',
    );
    process.exit(1);
  }
}

// --- palette -----------------------------------------------------------------
const BG = '#0a0a0a';
const TEXT = '#ededed';
const TEXT_DIM = '#b5b5b5';
const TEXT_FAINT = '#666666';
const ACCENT = '#ff6885';
const HALO = 'rgb(190,190,195)'; // from the header's drop-shadow(0 0 14px rgba(190,190,195,0.28))

// --- geometry ----------------------------------------------------------------
const W = 1200;
const H = 630;
const LOGO = 330; // rendered logo edge
const GLOW = 560; // canvas the halo is blurred into, so it is not clipped
const LOGO_CX = 280; // logo centre x  -> 115px left margin
const LOGO_CY = 300; // logo centre y
const COL_X = 508; // text column left edge

const off = (size, cx, cy) => `+${Math.round(cx - size / 2)}+${Math.round(cy - size / 2)}`;

// --- type --------------------------------------------------------------------
// With -gravity NorthWest, -annotate positions the top of the rendered ink, so
// the y values below are ink tops and the block is balanced on the logo centre.
// Widest run is the wordmark at ~552px of ink, ending near x=1060: that holds the
// ~110px right margin against the logo's 115px left margin.
const WORDMARK = 'Guessless';
const LINE_1 = 'Grep tells you what it matched.'; // the sentence break is the line break
const LINE_2 = 'Not what it missed.';
const FOOTER = 'compiled.run/guessless';

const WORDMARK_PT = 84;
const TAGLINE_PT = 30;
const FOOTER_PT = 21;

const em = (pt, value) => (pt * value).toFixed(2); // letter-spacing in em -> ImageMagick kerning px

const Y_WORDMARK = 157;
const Y_RULE = 271;
const Y_LINE_1 = 319;
const Y_LINE_2 = 358; // 1.3 line-height on 30pt, matching the page h1
const Y_FOOTER = 424;

const args = [
  '-size', `${W}x${H}`, 'xc:' + BG,

  // soft light halo behind the mark (mirrors the header's outer drop-shadow)
  '(', SRC,
  '-resize', `${LOGO}x${LOGO}`,
  '-background', 'none', '-gravity', 'center', '-extent', `${GLOW}x${GLOW}`,
  '-channel', 'A', '-blur', '0x24', '-evaluate', 'multiply', '2.4', '+channel',
  '-fill', HALO, '-colorize', '100',
  '-channel', 'A', '-evaluate', 'multiply', '0.30', '+channel',
  ')',
  '-gravity', 'NorthWest', '-geometry', off(GLOW, LOGO_CX, LOGO_CY), '-composite',

  // the mark itself, alpha preserved, composited straight onto the dark field
  '(', SRC, '-resize', `${LOGO}x${LOGO}`, ')',
  '-gravity', 'NorthWest', '-geometry', off(LOGO, LOGO_CX, LOGO_CY), '-composite',

  '-gravity', 'NorthWest', '-stroke', 'none',

  // wordmark -- real Unbounded SemiBold, no stroke-faked weight
  '-font', FONT_SEMIBOLD,
  '-fill', TEXT,
  '-pointsize', String(WORDMARK_PT), '-kerning', em(WORDMARK_PT, 0.02),
  '-annotate', `+${COL_X}+${Y_WORDMARK}`, WORDMARK,

  // accent rule
  '-fill', ACCENT,
  '-draw', `rectangle ${COL_X},${Y_RULE} ${COL_X + 62},${Y_RULE + 3}`,

  // tagline (the page's own h1), weight carrying the emphasis instead of a stroke
  '-pointsize', String(TAGLINE_PT), '-kerning', em(TAGLINE_PT, -0.01),
  '-font', FONT_REGULAR, '-fill', TEXT_DIM,
  '-annotate', `+${COL_X}+${Y_LINE_1}`, LINE_1,
  '-font', FONT_SEMIBOLD, '-fill', TEXT,
  '-annotate', `+${COL_X}+${Y_LINE_2}`, LINE_2,

  // footer
  '-font', FONT_REGULAR, '-fill', TEXT_FAINT,
  '-pointsize', String(FOOTER_PT), '-kerning', em(FOOTER_PT, 0.08),
  '-annotate', `+${COL_X}+${Y_FOOTER}`, FOOTER,

  '-alpha', 'off',
  '-strip',
  '-define', 'png:compression-level=9',
  OUT,
];

execFileSync(MAGICK, args, { stdio: 'inherit' });

const size = statSync(OUT).size;
const dims = execFileSync(MAGICK, ['identify', '-format', '%wx%h', OUT]).toString();
if (dims !== `${W}x${H}`) {
  console.error(`expected ${W}x${H}, got ${dims}`);
  process.exit(1);
}
if (size > 1024 * 1024) {
  console.error(`og.png is ${size} bytes, over the 1MB budget`);
  process.exit(1);
}
console.log(`wrote ${path.relative(ROOT, OUT)} ${dims} ${size} bytes (font: Unbounded 400/600)`);
