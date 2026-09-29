// The brightness curves: histogram matching, the dark fade, the .cube files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CHANNELS, BRIGHTNESS_DIR, brightnessLut } from '../src/config.mjs';
import {
  LEVELS, histograms, addHistograms, matchChannel, matchCurves, withFade, applyCurves, meanLuma, meanAbsDiff, cubeText, parseCube,
} from '../src/brightness.mjs';

const ramp = (f) => Float64Array.from({ length: LEVELS }, (_, v) => f(v));

test('matching an image to itself changes nothing', () => {
  const h = ramp((v) => 1000 - 3 * v);
  const out = matchChannel(h, h);
  for (let v = 0; v < LEVELS; v++) assert.ok(Math.abs(out[v] - v) < 0.51, `level ${v} -> ${out[v]}`);
});

test('matching a darker image to a brighter one lifts it and never falls', () => {
  // Source: levels 0..127 used evenly. Reference: the same pixels at twice the level.
  const src = ramp((v) => (v < 128 ? 10 : 0));
  const ref = ramp((v) => (v % 2 === 0 ? 10 : 0));
  const out = matchChannel(src, ref);
  for (let v = 1; v < LEVELS; v++) assert.ok(out[v] >= out[v - 1]);
  assert.ok(Math.abs(out[64] - 128) <= 2, `64 -> ${out[64]}`);
  assert.ok(out[127] >= 250);
});

test('the dark end fades to black by the same factor in every channel, so the faint glow keeps its colour', () => {
  // 400 black pixels, then 10 pixels at each level 1 to 100, in all three channels.
  const hist = ramp((v) => (v === 0 ? 400 : v <= 100 ? 10 : 0));
  const steep = ramp((v) => (v === 0 ? 0 : Math.min(255, 20 + 3 * v))); // 0 -> 23 jump, like AIA 171
  const half = ramp((v) => steep[v] / 2);
  const { curves, fade } = withFade([steep, half, steep], [hist, hist, hist], 4);
  // The knee: (20 + 3k) / k <= 4 first at k = 20; the fade ends at the quantile of level 19.
  assert.ok(Math.abs(fade.from - 400 / 1400) < 1e-12);
  assert.ok(Math.abs(fade.to - 590 / 1400) < 1e-12);
  assert.equal(curves[0][0], 0, 'black stays black');
  assert.ok(curves[0][1] < 1, `level 1 now ${curves[0][1].toFixed(2)}, not 23: no hard edge`);
  for (let v = 1; v < 30; v++) {
    assert.ok(curves[0][v] >= curves[0][v - 1], 'still only rises');
    assert.ok(Math.abs(curves[0][v] - 2 * curves[1][v]) < 1e-9, `level ${v}: red and green faded by the same factor`);
  }
  assert.equal(curves[0][20], steep[20], 'from the knee up, the match is untouched');
  assert.equal(curves[0][200], steep[200]);
  const gentle = ramp((v) => v);
  const none = withFade([gentle, gentle, gentle], [hist, hist, hist], 4);
  assert.equal(none.fade.to, none.fade.from, 'nothing to fade');
  assert.deepEqual([...none.curves[0]], [...gentle]);
});

test('histograms leave out the rows below the limit; curves apply per channel', () => {
  const w = 2, h = 2;
  const rgb = Buffer.from([10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120]);
  const top = histograms(rgb, w, h, { rows: 1 });
  assert.equal(top[0][10], 1);
  assert.equal(top[0][70], 0, 'row 1 left out');
  const all = addHistograms(histograms(rgb, w, h), histograms(rgb, w, h));
  assert.equal(all[2][120], 2);
  const doubled = applyCurves(rgb, [0, 1, 2].map(() => ramp((v) => Math.min(255, v * 2))));
  assert.deepEqual([...doubled.subarray(0, 3)], [20, 40, 60]);
  assert.ok(Math.abs(meanLuma(Buffer.from([255, 255, 255]), 1, 1) - 255) < 1e-9);
  assert.equal(meanAbsDiff(Buffer.from([0, 0, 0]), Buffer.from([3, 6, 9]), 1, 1), 6);
});

test('.cube text round trips and bad files are refused', () => {
  const curves = [ramp((v) => v), ramp((v) => Math.min(255, v * 1.5)), ramp((v) => v / 2)];
  const text = cubeText(curves, ['a comment line']);
  assert.match(text, /^# a comment line\nTITLE "[^"]+"\nLUT_1D_SIZE 256\n0\.000000 0\.000000 0\.000000\n/);
  const back = parseCube(text);
  for (let c = 0; c < 3; c++) for (let v = 0; v < LEVELS; v++) assert.ok(Math.abs(back[c][v] - curves[c][v]) < 0.001);
  assert.throws(() => parseCube(text.replace('LUT_1D_SIZE 256', 'LUT_1D_SIZE 255')), /256/);
  assert.throws(() => parseCube(text.replace(/\n1\.000000 1\.000000 0\.500000\n$/, '\n')), /256/);
  const falling = cubeText([ramp((v) => 255 - v), ramp((v) => v), ramp((v) => v)]);
  assert.throws(() => parseCube(falling), /falls/);
  assert.throws(() => parseCube(text.replace('LUT_1D_SIZE', 'LUT_3D_SIZE')), /LUT_3D_SIZE|256/);
});

test('the committed curves read, rise, keep black black and land on the NASA brightness', () => {
  const fit = JSON.parse(readFileSync(join(BRIGHTNESS_DIR, 'fit.json'), 'utf8'));
  for (const c of CHANNELS) {
    const curves = parseCube(readFileSync(brightnessLut(c.code), 'utf8'));
    for (const curve of curves) assert.ok(curve[0] < 0.5, `${c.code}: black stays black`);
    // Red, the strongest channel in both colour tables, is lifted in the middle.
    assert.ok(curves[0][100] > 100, `${c.code}: mid levels lifted`);
    const f = fit.channels[c.code];
    assert.ok(f.pairs.length >= 4, `${c.code}: fitted on at least 4 pairs`);
    for (const p of f.pairs) {
      assert.ok(Math.abs(p.deltaSeconds) <= 30, `${c.code}: pair ${p.nasaUtc} is the same instant`);
      assert.ok(p.meanDifferenceFromNasa.after < p.meanDifferenceFromNasa.before, `${c.code}: pair ${p.nasaUtc} closer to NASA`);
    }
    assert.ok(Math.abs(f.average.meanLuma.after - f.average.meanLuma.nasa) < 2, `${c.code}: as bright as NASA`);
  }
});
