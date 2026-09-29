#!/usr/bin/env node
// The 24 hour Sun movie, built with plain ffmpeg.
//
//   node src/sun-movie.mjs [--channels 171,304] [--brightness nasa|off]
//                          [--cache-dir DIR] [--out-dir DIR] [--max-age-hours 3]
//   node src/sun-movie.mjs --self-test [--brightness nasa|off]
//
// For each channel (CHANNELS in config.mjs):
//   1. Ask Helioviewer for its newest frame, lay 288 slots 5 minutes apart
//      back from it, and fill each slot with the real frame closest to it
//      (cached on disk by capture time, so a run fetches only new frames).
//   2. Fail if the newest frame is more than 3 hours old or fewer than half
//      the slots have a frame.
//   3. Encode 1024x1024 H.264 at 24 fps (288 frames = 12 s) with the UTC
//      capture time printed bottom left (rounded to the nearest minute), the
//      brightness curve applied when chosen, CRF stepped until the file is 5
//      to 10 MB, moov atom first (faststart).
//   4. Check it with ffprobe (codec, size, pixel format, frame count,
//      duration, bytes), check the printed time is visible on the first and
//      last frames, and write sun-24h-<channel>.json next to
//      sun-24h-<channel>.mp4 with the exact newest and oldest frame times,
//      the frame count and the sha256.
// Exit code 0 when every channel passed, 1 otherwise. Only checked movies are
// left in the out dir, so the publish step can take whatever is there.
// Node built-ins only; needs ffmpeg with libx264, drawtext and lut1d, and
// ffprobe.
import { mkdirSync, rmSync, writeFileSync, renameSync, appendFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CHANNELS, DEFAULT_CACHE_DIR, DEFAULT_OUT_DIR, MAX_NEWEST_AGE_SECONDS, MIN_FRAMES, SLOT_COUNT,
  FPS, SIZE_PX, CREDIT, BRIGHTNESS_MODES, DEFAULT_BRIGHTNESS, brightnessLut, movieName, manifestName,
} from './config.mjs';
import { HelioviewerClient } from './helioviewer.mjs';
import { collectFrames, iso, roundToMinute } from './frames.mjs';
import {
  checkTools, encodeMovie, probe, checkProbe, isFaststart, labelBrightness, checkLabel, sha256File, selfTest,
} from './encode.mjs';

const USAGE = 'node src/sun-movie.mjs [--channels 171,304] [--brightness nasa|off] [--cache-dir DIR] [--out-dir DIR] [--max-age-hours 3] [--self-test]';

export function parseArgs(argv, env = process.env) {
  const o = {
    channels: env.SUN_MOVIE_CHANNELS || CHANNELS.map((c) => c.code).join(','),
    brightness: env.SUN_MOVIE_BRIGHTNESS || DEFAULT_BRIGHTNESS,
    cacheDir: env.SUN_MOVIE_CACHE_DIR || DEFAULT_CACHE_DIR,
    outDir: env.SUN_MOVIE_OUT_DIR || DEFAULT_OUT_DIR,
    maxAgeSeconds: MAX_NEWEST_AGE_SECONDS,
    selfTest: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    if (a === '--channels') o.channels = val();
    else if (a === '--brightness') o.brightness = val();
    else if (a === '--cache-dir') o.cacheDir = val();
    else if (a === '--out-dir') o.outDir = val();
    else if (a === '--max-age-hours') {
      const h = Number(val());
      if (!(h > 0)) throw new Error('--max-age-hours needs a positive number');
      o.maxAgeSeconds = h * 3600;
    } else if (a === '--self-test') o.selfTest = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else throw new Error(`unknown argument ${a}`);
  }
  o.brightness = String(o.brightness).trim().toLowerCase();
  if (!BRIGHTNESS_MODES.includes(o.brightness)) throw new Error(`unknown brightness "${o.brightness}"; use ${BRIGHTNESS_MODES.join(' or ')}`);
  const codes = o.channels.split(',').map((s) => s.trim()).filter(Boolean);
  const unknown = codes.filter((c) => !CHANNELS.some((ch) => ch.code === c));
  if (unknown.length) throw new Error(`unknown channel(s) ${unknown.join(', ')}; known: ${CHANNELS.map((c) => c.code).join(', ')}`);
  o.channels = CHANNELS.filter((ch) => codes.includes(ch.code));
  o.cacheDir = resolve(o.cacheDir);
  o.outDir = resolve(o.outDir);
  return o;
}

/** The curve file for a channel, or null when brightness is off. */
export const lutFor = (channel, brightness) => (brightness === 'nasa' ? brightnessLut(channel.code) : null);

/** "Newest frame 21:06 UTC": rounded to the nearest minute, like the printed time. */
export const newestLabel = (d) => `Newest frame ${iso(roundToMinute(d)).slice(11, 16)} UTC`;

export function buildManifest({ channel, frames, missing, bytes, sha256, crf, builtAt, brightness = DEFAULT_BRIGHTNESS }) {
  const newest = frames[frames.length - 1].date;
  const oldest = frames[0].date;
  return {
    schema: 1,
    channel: channel.code,
    name: channel.name,
    movie: movieName(channel.code),
    version: sha256.slice(0, 12),
    newestFrameUtc: iso(newest),
    oldestFrameUtc: iso(oldest),
    newestLabel: newestLabel(newest),
    frameCount: frames.length,
    slots: SLOT_COUNT,
    missingFrames: missing.length,
    fps: FPS,
    durationSeconds: Number((frames.length / FPS).toFixed(3)),
    width: SIZE_PX,
    height: SIZE_PX,
    bytes,
    sha256,
    crf,
    brightness,
    builtUtc: iso(builtAt),
    credit: CREDIT,
  };
}

async function buildChannel({ channel, cacheDir, outDir, client, log, brightness, maxAgeSeconds = MAX_NEWEST_AGE_SECONDS }) {
  const t0 = Date.now();
  const before = { ...client.stats };
  const moviePath = join(outDir, movieName(channel.code));
  const manifestPath = join(outDir, manifestName(channel.code));
  rmSync(moviePath, { force: true });
  rmSync(manifestPath, { force: true });

  log(`\n[${channel.code}] ${channel.name}, brightness ${brightness}`);
  const got = await collectFrames({ channel, cacheDir, client, log });
  const { frames, missing } = got;
  const fetchSeconds = (Date.now() - t0) / 1000;
  const requests = client.stats.requests - before.requests;
  log(`  frames: ${frames.length} of ${SLOT_COUNT} (downloaded ${got.fetched}, from cache ${got.reused}, missing ${missing.length}, pruned ${got.pruned})`);
  log(`  requests: ${requests} (${client.stats.retries - before.retries} retries, ${((client.stats.bytes - before.bytes) / 1048576).toFixed(1)} MB) in ${fetchSeconds.toFixed(1)} s`);

  if (frames.length < MIN_FRAMES) throw new Error(`only ${frames.length} frames, need at least ${MIN_FRAMES}`);
  const now = new Date();
  const newest = frames[frames.length - 1].date;
  const ageS = (now - newest) / 1000;
  log(`  newest frame ${iso(newest)}, ${(ageS / 60).toFixed(0)} minutes old; oldest ${iso(frames[0].date)}`);
  if (ageS > maxAgeSeconds) {
    throw new Error(`stale: the newest frame is ${(ageS / 3600).toFixed(1)} hours old (limit ${+(maxAgeSeconds / 3600).toFixed(2)})`);
  }

  const workDir = join(outDir, '.work', channel.code);
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(workDir, { recursive: true });
  const partPath = join(workDir, 'movie.mp4');
  const t1 = Date.now();
  const enc = encodeMovie({ frames, workDir, outPath: partPath, crfStart: channel.crfStart, lutFile: lutFor(channel, brightness), log });
  const encodeSeconds = (Date.now() - t1) / 1000;

  const p = probe(partPath);
  const problems = checkProbe(p, frames.length);
  if (!isFaststart(partPath)) problems.push('moov atom is not before mdat (no faststart)');
  const lb = labelBrightness(partPath, frames.length);
  problems.push(...checkLabel(lb, frames.length));
  if (problems.length) throw new Error(`check failed: ${problems.join('; ')}`);
  log(`  ffprobe: ${p.codec} ${p.profile} ${p.width}x${p.height} ${p.pixFmt}, ${p.frames} frames at ${p.fps}, ${p.duration.toFixed(3)} s, ${p.bytes} bytes, faststart; frame time printed (label luma ${lb.label.join(', ')}, empty corner ${lb.control.join(', ')})`);

  const sha256 = await sha256File(partPath);
  const manifest = buildManifest({ channel, frames, missing, bytes: p.bytes, sha256, crf: enc.crf, builtAt: now, brightness });
  renameSync(partPath, moviePath); // the movie first, so a manifest never points at a missing movie
  writeFileSync(`${manifestPath}.tmp`, JSON.stringify(manifest, null, 2) + '\n');
  renameSync(`${manifestPath}.tmp`, manifestPath);
  rmSync(workDir, { recursive: true, force: true });
  log(`  wrote ${movieName(channel.code)} (${(p.bytes / 1048576).toFixed(2)} MB, CRF ${enc.crf}, sha256 ${sha256.slice(0, 12)}) and ${manifestName(channel.code)}`);

  return {
    channel: channel.code, ok: true, brightness, frames: frames.length, missing: missing.length, fetched: got.fetched, reused: got.reused,
    requests, fetchSeconds, encodeSeconds, totalSeconds: (Date.now() - t0) / 1000, newestAgeMinutes: Math.round(ageS / 60),
    bytes: p.bytes, crf: enc.crf, encodes: enc.tries, newest: iso(newest), oldest: iso(frames[0].date), sha256,
  };
}

function stepSummary(results) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  const rows = results.map((r) => r.ok
    ? `| ${r.channel} | ok | ${r.frames} | ${r.missing} | ${r.fetched} | ${r.newest} | ${r.newestAgeMinutes} min | ${(r.bytes / 1048576).toFixed(2)} MB | ${r.crf} | ${r.brightness} |`
    : `| ${r.channel} | FAILED: ${r.error} | | | | | | | | |`);
  appendFileSync(file, ['## Sun movie', '', '| Channel | Result | Frames | Missing | Downloaded | Newest frame | Age | Size | CRF | Brightness |',
    '|---|---|---|---|---|---|---|---|---|---|', ...rows, ''].join('\n'));
}

export async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.help) {
    console.log(USAGE);
    return 0;
  }
  const log = (...a) => console.log(...a);
  const lutFiles = opts.channels.map((c) => lutFor(c, opts.brightness)).filter(Boolean);
  if (opts.selfTest) {
    log(`  ${checkTools({ lutFiles })}`);
    selfTest({ log });
    for (const f of lutFiles) selfTest({ lutFile: f, log });
    return 0;
  }
  const t0 = Date.now();
  log(`Sun movie: channels ${opts.channels.map((c) => c.code).join(', ')}; brightness ${opts.brightness}; cache ${opts.cacheDir}; out ${opts.outDir}`);
  log(`  ${checkTools({ lutFiles })}`);
  mkdirSync(opts.cacheDir, { recursive: true });
  mkdirSync(opts.outDir, { recursive: true });

  const client = new HelioviewerClient({ log });
  const results = [];
  for (const channel of opts.channels) {
    try {
      results.push(await buildChannel({
        channel, cacheDir: opts.cacheDir, outDir: opts.outDir, client, log, brightness: opts.brightness, maxAgeSeconds: opts.maxAgeSeconds,
      }));
    } catch (err) {
      log(`  FAILED: ${err.message}`);
      results.push({ channel: channel.code, ok: false, error: err.message });
    }
  }
  if (existsSync(join(opts.outDir, '.work'))) rmSync(join(opts.outDir, '.work'), { recursive: true, force: true });

  const summary = { finishedUtc: iso(new Date()), seconds: Math.round((Date.now() - t0) / 1000), requests: client.stats.requests, results };
  writeFileSync(join(opts.outDir, 'run-summary.json'), JSON.stringify(summary, null, 2) + '\n');
  stepSummary(results);
  log(`\nDone in ${summary.seconds} s, ${client.stats.requests} requests (${JSON.stringify(client.stats.byServer)}).`);
  const failed = results.filter((r) => !r.ok);
  if (failed.length) log(`Failed: ${failed.map((r) => `${r.channel} (${r.error})`).join('; ')}`);
  return failed.length ? 1 : 0;
}

const sameFile = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
const invokedDirectly = Boolean(process.argv[1]) && sameFile(resolve(process.argv[1]), fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main().then((code) => { process.exitCode = code; }, (err) => { console.error(`Sun movie: ${err.message}`); process.exitCode = 1; });
}
