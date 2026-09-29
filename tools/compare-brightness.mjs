#!/usr/bin/env node
// Before and after picture for the brightness option, on an instant the
// curve was not fitted on.
//
//   node tools/compare-brightness.mjs --out compare.png [--channels 171,304] [--work DIR]
//
// For each channel: the newest NASA browse image that is not in
// brightness/fit.json, the Helioviewer frame of the same instant (the closest
// of a few candidates), and three panels side by side:
//   1. that frame through the movie's own picture chain, brightness off
//   2. the same frame through the same chain, brightness nasa
//   3. NASA's own image of that instant, unchanged
// Each panel's caption gives its mean luma and how far it is from NASA's.
// The numbers also go to <out>.json.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { CHANNELS, NASA_LABEL_TOP_PX, FONT_FILE, brightnessLut, BRIGHTNESS_DIR, ROOT } from '../src/config.mjs';
import { HelioviewerClient } from '../src/helioviewer.mjs';
import { iso } from '../src/frames.mjs';
import { stillArgs, concatList, run, filterValue } from '../src/encode.mjs';
import { decodeRgb, meanLuma, meanAbsDiff } from '../src/brightness.mjs';
import { listBrowse, twinFor, fetchPair, browseUrl } from './nasa.mjs';

const PANEL = 640;
const CAPTION_H = 72;
const TITLE_H = 52;
const fwd = (p) => p.split('\\').join('/');
const r1 = (x) => Math.round(x * 10) / 10;

function parseArgs(argv) {
  const o = { channels: CHANNELS.map((c) => c.code).join(','), work: join(ROOT, 'out', 'brightness-compare'), out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => argv[++i];
    if (a === '--channels') o.channels = val();
    else if (a === '--work') o.work = val();
    else if (a === '--out') o.out = val();
    else throw new Error(`unknown argument ${a}`);
  }
  if (!o.out) throw new Error('--out FILE.png is required');
  o.channels = CHANNELS.filter((c) => o.channels.split(',').map((s) => s.trim()).includes(c.code));
  o.work = resolve(o.work);
  o.out = resolve(o.out);
  return o;
}

async function channelPanels({ channel, client, fitted, work, listings, log }) {
  const files = (await listBrowse(client, channel.code, { days: 2, listings })).filter((f) => !fitted.has(iso(f.date)));
  if (!files.length) throw new Error(`no NASA browse image outside the fit for ${channel.code}`);
  let best = null;
  for (const f of files.slice(-6).reverse()) {
    const pair = await twinFor(client, channel, f);
    if (!best || Math.abs(pair.deltaSeconds) < Math.abs(best.deltaSeconds)) best = pair;
    if (Math.abs(pair.deltaSeconds) <= 2) break;
  }
  const dir = join(work, channel.code);
  const paths = await fetchPair(client, best, dir);
  log(`[${channel.code}] NASA ${best.nasa.name} with Helioviewer ${iso(best.hv.date)} (${best.deltaSeconds} s)`);

  const listPath = join(dir, 'still.ffconcat');
  writeFileSync(listPath, concatList([{ file: paths.hvPath, date: best.hv.date }]));
  const offPng = join(dir, 'still_off.png');
  const nasaPng = join(dir, 'still_nasa.png');
  run('ffmpeg', stillArgs({ listPath, outPath: offPng }));
  run('ffmpeg', stillArgs({ listPath, outPath: nasaPng, lutFile: brightnessLut(channel.code) }));

  const rows = NASA_LABEL_TOP_PX;
  const off = decodeRgb(offPng).rgb;
  const on = decodeRgb(nasaPng).rgb;
  const ref = decodeRgb(paths.nasaPath).rgb;
  const m = {
    channel: channel.code,
    nasaImage: browseUrl(best.nasa),
    nasaUtc: iso(best.nasa.date),
    helioviewerUtc: iso(best.hv.date),
    deltaSeconds: best.deltaSeconds,
    meanLuma: { off: r1(meanLuma(off, 1024, 1024, { rows })), nasaOption: r1(meanLuma(on, 1024, 1024, { rows })), nasaOwn: r1(meanLuma(ref, 1024, 1024, { rows })) },
    meanDifferenceFromNasa: { off: r1(meanAbsDiff(off, ref, 1024, 1024, { rows })), nasaOption: r1(meanAbsDiff(on, ref, 1024, 1024, { rows })) },
  };
  log(`  mean luma off ${m.meanLuma.off}, nasa option ${m.meanLuma.nasaOption}, NASA ${m.meanLuma.nasaOwn}; difference from NASA ${m.meanDifferenceFromNasa.off} -> ${m.meanDifferenceFromNasa.nasaOption}`);

  const captions = [
    [`${channel.name}. Before: brightness off`, `Helioviewer frame as it comes. Mean luma ${m.meanLuma.off}, differs from NASA by ${m.meanDifferenceFromNasa.off}`],
    [`${channel.name}. After: brightness nasa (the default)`, `Same frame through the curve. Mean luma ${m.meanLuma.nasaOption}, differs from NASA by ${m.meanDifferenceFromNasa.nasaOption}`],
    [`${channel.name}. NASA's own SDO image, same instant`, `Taken ${m.nasaUtc.slice(0, 19).replace('T', ' ')} UTC${m.deltaSeconds ? ` (Helioviewer's ${Math.abs(m.deltaSeconds)} s ${m.deltaSeconds < 0 ? 'earlier' : 'later'})` : ''}. Mean luma ${m.meanLuma.nasaOwn}`],
  ].map((lines, i) => lines.map((line, j) => {
    // One file per line: drawtext draws a stray box for a newline.
    const p = join(dir, `caption${i}_${j}.txt`);
    writeFileSync(p, line);
    return p;
  }));
  return { inputs: [offPng, nasaPng, paths.nasaPath], captions, metrics: m };
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const log = (...a) => console.log(...a);
  const fitPath = join(BRIGHTNESS_DIR, 'fit.json');
  const fit = existsSync(fitPath) ? JSON.parse(readFileSync(fitPath, 'utf8')) : { channels: {} };
  const client = new HelioviewerClient({ log });
  const listings = new Map();
  const rowsOut = [];
  for (const channel of o.channels) {
    const fitted = new Set((fit.channels?.[channel.code]?.pairs || []).map((p) => p.nasaUtc));
    rowsOut.push(await channelPanels({ channel, client, fitted, work: o.work, listings, log }));
  }

  const font = filterValue(fwd(FONT_FILE));
  const inputs = rowsOut.flatMap((r) => r.inputs);
  const captions = rowsOut.flatMap((r) => r.captions);
  const chains = inputs.map((_, i) => `[${i}:v]scale=${PANEL}:${PANEL}:flags=lanczos,format=rgb24,pad=${PANEL}:${PANEL + CAPTION_H}:0:${CAPTION_H}:color=black,`
    + captions[i].map((file, j) => `drawtext=fontfile=${font}:textfile=${filterValue(fwd(file))}:expansion=none:x=12:y=${12 + j * 30}:fontsize=19:fontcolor=white`).join(',')
    + `[p${i}]`);
  const stacks = rowsOut.map((_, r) => `[p${r * 3}][p${r * 3 + 1}][p${r * 3 + 2}]hstack=inputs=3[r${r}]`);
  const titleFile = join(o.work, 'title.txt');
  mkdirSync(o.work, { recursive: true });
  writeFileSync(titleFile, 'Sun movie brightness, before and after. The instants shown were not used to fit the curve.');
  const width = PANEL * 3;
  const height = TITLE_H + rowsOut.length * (PANEL + CAPTION_H);
  const tail = `${rowsOut.map((_, r) => `[r${r}]`).join('')}${rowsOut.length > 1 ? `vstack=inputs=${rowsOut.length},` : ''}`
    + `pad=${width}:${height}:0:${TITLE_H}:color=black,drawtext=fontfile=${font}:textfile=${filterValue(fwd(titleFile))}:expansion=none:x=12:y=14:fontsize=22:fontcolor=white[out]`;
  const graph = [...chains, ...stacks, tail].join(';');
  mkdirSync(dirname(o.out), { recursive: true });
  run('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', ...inputs.flatMap((p) => ['-i', fwd(p)]),
    '-filter_complex', graph, '-map', '[out]', '-frames:v', '1', '-update', '1', fwd(o.out)]);
  const metricsPath = o.out.replace(/\.png$/i, '') + '.json';
  writeFileSync(metricsPath, JSON.stringify({ madeUtc: iso(new Date()), rows: rowsOut.map((r) => r.metrics) }, null, 1) + '\n');
  log(`Wrote ${o.out} and ${metricsPath} (${client.stats.requests} requests).`);
}

main().catch((err) => { console.error(`compare-brightness: ${err.message}`); process.exitCode = 1; });
