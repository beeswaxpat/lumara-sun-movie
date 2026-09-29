// The "nasa" brightness option: a fixed curve per colour channel (red, green,
// blue; 256 steps each) that makes a Helioviewer frame as bright as NASA's
// own SDO browse image of the same instant.
//
// Why a curve fits: both images come from the same AIA data and are coloured
// with the same AIA colour table. They differ in how the data is scaled to
// brightness before the table is applied, and each channel of the table only
// ever rises, so one fixed rising curve per channel carries one scaling to the
// other. The curve is fitted by histogram matching: for each input level, the
// level that sits at the same place in NASA's pixel distribution. Pixels of
// several instants are pooled, so no single moment decides the curve.
//
// The movie applies the curve with ffmpeg's lut1d filter, from a .cube file
// (the plain text format ffmpeg reads). This file is pure functions plus a
// JPEG to RGB decode through ffmpeg; Node built-ins only.
import { spawnSync } from 'node:child_process';
import { SIZE_PX } from './config.mjs';

export const LEVELS = 256;

/** Decode an image to raw 8 bit RGB with ffmpeg: {width, height, rgb}. */
export function decodeRgb(path, size = SIZE_PX) {
  const r = spawnSync('ffmpeg', ['-nostdin', '-v', 'error', '-i', path.split('\\').join('/'),
    '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  if (r.error || r.status !== 0) throw new Error(`ffmpeg could not decode ${path}: ${r.error?.message || String(r.stderr).trim()}`);
  if (r.stdout.length !== size * size * 3) throw new Error(`${path} is not ${size}x${size} (${r.stdout.length} bytes of RGB)`);
  return { width: size, height: size, rgb: r.stdout };
}

/** Per channel histograms over the rows above `rows` (default all). */
export function histograms(rgb, width, height, { rows = height } = {}) {
  const h = [new Float64Array(LEVELS), new Float64Array(LEVELS), new Float64Array(LEVELS)];
  const end = Math.min(rows, height) * width * 3;
  for (let i = 0; i < end; i += 3) {
    h[0][rgb[i]]++;
    h[1][rgb[i + 1]]++;
    h[2][rgb[i + 2]]++;
  }
  return h;
}

/** Add histograms b into a (in place) and return a. */
export function addHistograms(a, b) {
  for (let c = 0; c < 3; c++) for (let v = 0; v < LEVELS; v++) a[c][v] += b[c][v];
  return a;
}

function cdf(hist) {
  const out = new Float64Array(LEVELS);
  let total = 0;
  for (let v = 0; v < LEVELS; v++) total += hist[v];
  if (!(total > 0)) throw new Error('empty histogram');
  let acc = 0;
  for (let v = 0; v < LEVELS; v++) { acc += hist[v]; out[v] = acc / total; }
  return out;
}

/**
 * Histogram matching for one channel: out[v] is the reference level at the
 * same quantile as the middle of source level v, interpolated inside the
 * reference bin, clamped to 0..255. The result never falls as v rises.
 */
export function matchChannel(srcHist, refHist) {
  const cs = cdf(srcHist);
  const cr = cdf(refHist);
  const out = new Float64Array(LEVELS);
  let u = 0;
  for (let v = 0; v < LEVELS; v++) {
    const q = v === 0 ? cs[0] / 2 : (cs[v - 1] + cs[v]) / 2;
    while (u < LEVELS - 1 && cr[u] < q) u++;
    const below = u === 0 ? 0 : cr[u - 1];
    const span = cr[u] - below;
    const frac = span > 0 ? Math.min(1, Math.max(0, (q - below) / span)) : 0.5;
    out[v] = Math.min(LEVELS - 1, Math.max(0, u - 0.5 + frac));
  }
  for (let v = 1; v < LEVELS; v++) if (out[v] < out[v - 1]) out[v] = out[v - 1];
  return out;
}

/**
 * A fade to black at the dark end, the same for all three channels.
 *
 * Helioviewer's frames cut the faintest corona to 0 where NASA's still show
 * it, so a pure match sends Helioviewer level 1 straight to NASA's level 20
 * and draws a hard edge where the cut starts. Below the knee (the first level
 * where a channel's curve is no steeper than `maxSlope` on average, out[k]/k)
 * the matched colour is faded toward black instead.
 *
 * The fade has to be the same for the three channels at the same point of
 * the colour table, or the faint glow changes colour (a straight line per
 * channel turns it brown, because red leads green at the dark end of the AIA
 * table). The place in the source histogram (the quantile) is that common
 * position: every channel of the table only rises, so a pixel sits at about
 * the same quantile in all three. The fade runs smoothly (smoothstep) from 0
 * where every channel is still black to 1 at the knee's quantile, and
 * multiplies the matched curve, so the result still only rises.
 * Returns {curves, fade: {from, to}} (quantiles; from = to means no fade).
 */
export function withFade(curves, srcHists, maxSlope = 4) {
  const cdfs = srcHists.map(cdf);
  const knee = (curve) => {
    for (let k = 1; k < LEVELS; k++) if (curve[k] / k <= maxSlope) return k;
    return LEVELS - 1;
  };
  const from = Math.min(...cdfs.map((cs) => cs[0]));
  // Only a channel that jumps (knee above level 1) sets where the fade ends;
  // a channel that is simply dark for long (blue in AIA 171) does not.
  const ends = curves.map((curve, c) => ({ k: knee(curve), cs: cdfs[c] })).filter((e) => e.k > 1).map((e) => e.cs[e.k - 1]);
  const to = ends.length ? Math.max(...ends) : from;
  if (!(to > from)) return { curves: curves.map((c) => Float64Array.from(c)), fade: { from, to: from } };
  const out = curves.map((curve, c) => Float64Array.from(curve, (value, v) => {
    const q = v === 0 ? cdfs[c][0] / 2 : (cdfs[c][v - 1] + cdfs[c][v]) / 2;
    const t = Math.min(1, Math.max(0, (q - from) / (to - from)));
    return value * t * t * (3 - 2 * t); // smoothstep: no corner where the fade starts or ends
  }));
  return { curves: out, fade: { from, to } };
}

/** Three matched channels: [r, g, b], each 256 levels on the 0..255 scale, with the dark fade. */
export function matchCurves(srcHists, refHists, { maxSlope = 4 } = {}) {
  return withFade([0, 1, 2].map((c) => matchChannel(srcHists[c], refHists[c])), srcHists, maxSlope);
}

/** Apply curves to raw RGB (rounded to whole levels). */
export function applyCurves(rgb, curves) {
  const out = Buffer.alloc(rgb.length);
  const lut = curves.map((curve) => Uint8Array.from(curve, (x) => Math.round(x)));
  for (let i = 0; i < rgb.length; i += 3) {
    out[i] = lut[0][rgb[i]];
    out[i + 1] = lut[1][rgb[i + 1]];
    out[i + 2] = lut[2][rgb[i + 2]];
  }
  return out;
}

/** Mean BT.709 luma (0..255) over the rows above `rows`. */
export function meanLuma(rgb, width, height, { rows = height } = {}) {
  const end = Math.min(rows, height) * width * 3;
  let sum = 0;
  for (let i = 0; i < end; i += 3) sum += 0.2126 * rgb[i] + 0.7152 * rgb[i + 1] + 0.0722 * rgb[i + 2];
  return sum / (end / 3);
}

/** Mean absolute difference per channel value (0..255) over the rows above `rows`. */
export function meanAbsDiff(a, b, width, height, { rows = height } = {}) {
  const end = Math.min(rows, height) * width * 3;
  let sum = 0;
  for (let i = 0; i < end; i++) sum += Math.abs(a[i] - b[i]);
  return sum / end;
}

/** The .cube text for three curves (256 rows of "r g b", 0..1). */
export function cubeText(curves, commentLines = []) {
  if (curves.length !== 3 || curves.some((c) => c.length !== LEVELS)) throw new Error('need three 256 step curves');
  const lines = [
    ...commentLines.map((l) => `# ${l}`),
    'TITLE "Helioviewer to NASA SDO brightness"',
    `LUT_1D_SIZE ${LEVELS}`,
  ];
  for (let v = 0; v < LEVELS; v++) {
    lines.push([0, 1, 2].map((c) => (curves[c][v] / (LEVELS - 1)).toFixed(6)).join(' '));
  }
  return lines.join('\n') + '\n';
}

/**
 * Read a .cube file written by cubeText: returns the three curves on the
 * 0..255 scale. Throws unless it holds exactly 256 rising rows in 0..1.
 */
export function parseCube(text) {
  const rows = [];
  let size = 0;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('TITLE')) continue;
    if (line.startsWith('LUT_1D_SIZE')) { size = Number(line.split(/\s+/)[1]); continue; }
    if (/^[A-Z_]+\b/.test(line)) throw new Error(`unexpected .cube keyword: ${line.slice(0, 40)}`);
    const nums = line.split(/\s+/).map(Number);
    if (nums.length !== 3 || nums.some((n) => !Number.isFinite(n) || n < 0 || n > 1)) throw new Error(`bad .cube row: ${line.slice(0, 40)}`);
    rows.push(nums);
  }
  if (size !== LEVELS || rows.length !== LEVELS) throw new Error(`the .cube file needs LUT_1D_SIZE ${LEVELS} and ${LEVELS} rows (has ${size} and ${rows.length})`);
  const curves = [0, 1, 2].map((c) => Float64Array.from(rows, (r) => r[c] * (LEVELS - 1)));
  for (const curve of curves) {
    for (let v = 1; v < LEVELS; v++) if (curve[v] < curve[v - 1] - 1e-9) throw new Error('a .cube curve falls; it must only rise');
  }
  return curves;
}
