#!/usr/bin/env node
// Fits the "nasa" brightness curves in brightness/ from pairs of images of
// the same instant: NASA's own SDO browse image and Helioviewer's frame.
//
//   node tools/fit-brightness.mjs [--channels 171,304] [--pairs 8] [--days 3] [--work DIR]
//
// For each channel: list NASA's browse images of the last few days, keep the
// newest one aside (never used in the fit, so tools/compare-brightness.mjs
// can judge the curve on an instant it has not seen), pick `pairs` images
// spread evenly over the rest, fetch the Helioviewer frame within 30 seconds
// of each, pool the pixels (NASA's printed label along the bottom left out)
// and match the histograms per colour channel. Writes
// brightness/aia-<channel>.cube and brightness/fit.json.
// Run by hand when the curves need refreshing; the movie never runs this.
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CHANNELS, BRIGHTNESS_DIR, NASA_LABEL_TOP_PX, brightnessLut, ROOT } from '../src/config.mjs';
import { HelioviewerClient } from '../src/helioviewer.mjs';
import { iso } from '../src/frames.mjs';
import {
  decodeRgb, histograms, addHistograms, matchCurves, applyCurves, meanLuma, meanAbsDiff, cubeText,
} from '../src/brightness.mjs';
import { listBrowse, twinFor, fetchPair, browseUrl, MAX_PAIR_SECONDS } from './nasa.mjs';

function parseArgs(argv) {
  const o = { channels: CHANNELS.map((c) => c.code).join(','), pairs: 8, days: 3, work: join(ROOT, 'out', 'brightness-fit') };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => argv[++i];
    if (a === '--channels') o.channels = val();
    else if (a === '--pairs') o.pairs = Number(val());
    else if (a === '--days') o.days = Number(val());
    else if (a === '--work') o.work = val();
    else throw new Error(`unknown argument ${a}`);
  }
  if (!(o.pairs >= 2)) throw new Error('--pairs needs 2 or more');
  o.channels = CHANNELS.filter((c) => o.channels.split(',').map((s) => s.trim()).includes(c.code));
  o.work = resolve(o.work);
  return o;
}

/** `n` items spread evenly over `list` (first and last included). */
function spread(list, n) {
  if (list.length <= n) return list.slice();
  const out = [];
  for (let k = 0; k < n; k++) out.push(list[Math.round((k * (list.length - 1)) / (n - 1))]);
  return [...new Set(out)];
}

const r2 = (x) => Math.round(x * 100) / 100;

async function fitChannel({ channel, client, pairs, days, work, listings, log }) {
  const files = await listBrowse(client, channel.code, { days, listings });
  if (files.length < pairs + 1) throw new Error(`only ${files.length} NASA browse images found for ${channel.code}`);
  const heldOut = files[files.length - 1];
  const chosen = spread(files.slice(0, -1), pairs);
  log(`[${channel.code}] ${files.length} NASA browse images from ${iso(files[0].date)} to ${iso(heldOut.date)}; fitting on ${chosen.length}, holding out ${heldOut.name}`);

  const srcHist = [new Float64Array(256), new Float64Array(256), new Float64Array(256)];
  const refHist = [new Float64Array(256), new Float64Array(256), new Float64Array(256)];
  const used = [];
  for (const f of chosen) {
    const pair = await twinFor(client, channel, f);
    if (Math.abs(pair.deltaSeconds) > MAX_PAIR_SECONDS) {
      log(`  skip ${f.name}: nearest Helioviewer frame is ${pair.deltaSeconds} s away`);
      continue;
    }
    const paths = await fetchPair(client, pair, join(work, channel.code));
    const hv = decodeRgb(paths.hvPath);
    const nasa = decodeRgb(paths.nasaPath);
    addHistograms(srcHist, histograms(hv.rgb, hv.width, hv.height, { rows: NASA_LABEL_TOP_PX }));
    addHistograms(refHist, histograms(nasa.rgb, nasa.width, nasa.height, { rows: NASA_LABEL_TOP_PX }));
    used.push({ file: f, pair, hv, nasa });
    log(`  pair ${f.name} with Helioviewer ${iso(pair.hv.date)} (${pair.deltaSeconds} s)`);
  }
  if (used.length < 2) throw new Error(`only ${used.length} usable pairs for ${channel.code}`);

  const { curves, fade } = matchCurves(srcHist, refHist);
  const rows = NASA_LABEL_TOP_PX;
  const pairsOut = used.map(({ file, pair, hv, nasa }) => {
    const after = applyCurves(hv.rgb, curves);
    return {
      nasaImage: browseUrl(file),
      nasaUtc: iso(file.date),
      helioviewerUtc: iso(pair.hv.date),
      helioviewerId: pair.hv.id,
      deltaSeconds: pair.deltaSeconds,
      meanLuma: {
        nasa: r2(meanLuma(nasa.rgb, 1024, 1024, { rows })),
        before: r2(meanLuma(hv.rgb, 1024, 1024, { rows })),
        after: r2(meanLuma(after, 1024, 1024, { rows })),
      },
      meanDifferenceFromNasa: {
        before: r2(meanAbsDiff(hv.rgb, nasa.rgb, 1024, 1024, { rows })),
        after: r2(meanAbsDiff(after, nasa.rgb, 1024, 1024, { rows })),
      },
    };
  });
  const fittedUtc = iso(new Date());
  writeFileSync(brightnessLut(channel.code), cubeText(curves, [
    `Lumara Sun movie, ${channel.name}: Helioviewer frame brightness to NASA SDO browse image brightness.`,
    `One curve per colour channel (red, green, blue), 256 steps, input and output 0 to 1. Applied with ffmpeg lut1d.`,
    fade.to > fade.from ? `The darkest levels fade to black together (source quantiles ${fade.from.toFixed(4)} to ${fade.to.toFixed(4)}).` : "No dark fade needed.",
    `Fitted ${fittedUtc} by tools/fit-brightness.mjs from ${used.length} pairs of the same instant,`,
    `${pairsOut[0].nasaUtc} to ${pairsOut[pairsOut.length - 1].nasaUtc}; details in brightness/fit.json.`,
  ]));
  const avg = (k, s) => r2(pairsOut.reduce((t, p) => t + p[k][s], 0) / pairsOut.length);
  log(`  mean luma: NASA ${avg('meanLuma', 'nasa')}, before ${avg('meanLuma', 'before')}, after ${avg('meanLuma', 'after')}; mean difference from NASA ${avg('meanDifferenceFromNasa', 'before')} before, ${avg('meanDifferenceFromNasa', 'after')} after`);
  return {
    channel: channel.code,
    name: channel.name,
    fittedUtc,
    darkFade: { fromQuantile: Number(fade.from.toFixed(5)), toQuantile: Number(fade.to.toFixed(5)) },
    heldOut: { nasaImage: browseUrl(heldOut), nasaUtc: iso(heldOut.date) },
    average: {
      meanLuma: { nasa: avg('meanLuma', 'nasa'), before: avg('meanLuma', 'before'), after: avg('meanLuma', 'after') },
      meanDifferenceFromNasa: { before: avg('meanDifferenceFromNasa', 'before'), after: avg('meanDifferenceFromNasa', 'after') },
    },
    pairs: pairsOut,
  };
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const log = (...a) => console.log(...a);
  mkdirSync(BRIGHTNESS_DIR, { recursive: true });
  const client = new HelioviewerClient({ log });
  const listings = new Map();
  const channels = {};
  for (const channel of o.channels) {
    channels[channel.code] = await fitChannel({ channel, client, pairs: o.pairs, days: o.days, work: o.work, listings, log });
  }
  const fit = {
    about: 'Brightness curves for the "nasa" option: Helioviewer frames made as bright as NASA SDO browse images of the same instant. Values are 0 to 255; the curve arrays are red, green, blue.',
    method: 'Histogram matching per colour channel on pooled pixels of several same-instant pairs, NASA label rows (y >= 940) left out, then below the first level where a curve is no steeper than 4 the matched colour fades to black by the same factor in all three channels (the source quantile is the common position), so the faint corona Helioviewer cuts to black does not start with a hard edge or change colour; applied with ffmpeg lut1d, linear interpolation.',
    meanLuma: 'BT.709 luma, 0 to 255, over rows 0 to 939',
    meanDifferenceFromNasa: 'mean absolute difference per colour value, 0 to 255, over rows 0 to 939',
    requests: client.stats.requests,
    channels,
  };
  writeFileSync(join(BRIGHTNESS_DIR, 'fit.json'), JSON.stringify(fit, null, 1) + '\n');
  log(`Wrote ${Object.keys(channels).map((c) => `brightness/aia-${c}.cube`).join(', ')} and brightness/fit.json (${client.stats.requests} requests).`);
}

main().catch((err) => { console.error(`fit-brightness: ${err.message}`); process.exitCode = 1; });
