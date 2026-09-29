// Plain ffmpeg: frames -> 1024 px H.264 MP4 with the capture time printed on
// each frame, then ffprobe checks. No render framework, one ffmpeg call per
// encode.
//
// How the time gets onto each frame in a single pass: the frame list is an
// ffconcat file, each entry carries `file_packet_meta lumara_time '...'`, the
// decoder turns that packet metadata into frame metadata, and drawtext prints
// it with text='%{metadata\:lumara_time}'.
//
// Works the same on ffmpeg 6.1 (Ubuntu 24.04, the GitHub runner) and 8.0.
// Checked against the 6.1 sources and docs: the concat demuxer's
// file_packet_meta directive, the decoder copying packet string metadata to
// the frame, -fps_mode, setparams' colour options, drawtext's
// %{metadata:...}, lh and y_align (default "text", as in 8.0), and lut1d's
// .cube reader (the same code in both). `node src/sun-movie.mjs --self-test`
// proves it on whatever ffmpeg is installed before a run fetches anything.
import { spawnSync } from 'node:child_process';
import {
  writeFileSync, statSync, renameSync, unlinkSync, existsSync, openSync, readSync, closeSync,
  createReadStream, readFileSync, mkdtempSync, rmSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FPS, SIZE_PX, FONT_FILE, LABEL_SIZE, LABEL_MARGIN, LABEL_COLOR, CRF_START, CRF_MIN, CRF_MAX,
  MAX_ENCODES, X264_PRESET, KEYFRAME_EVERY, TARGET_MIN_BYTES, TARGET_MAX_BYTES,
} from './config.mjs';
import { frameLabel } from './frames.mjs';
import { parseCube } from './brightness.mjs';

const fwd = (p) => p.split('\\').join('/');

/** Quote a string for an ffconcat file: 'it'\''s' */
export const ffconcatQuote = (s) => `'${String(s).split("'").join("'\\''")}'`;

/** Escape a value for a filter option inside a -vf filtergraph (both levels). */
export function filterValue(v) {
  const level1 = String(v).replace(/[\\':]/g, (c) => `\\${c}`);
  return level1.replace(/[\\'[\],;]/g, (c) => `\\${c}`);
}

/** The ffconcat text for frames sorted oldest first. */
export function concatList(frames) {
  const lines = ['ffconcat version 1.0'];
  for (const f of frames) {
    lines.push(`file ${ffconcatQuote(fwd(f.file))}`);
    lines.push(`file_packet_meta lumara_time ${ffconcatQuote(frameLabel(f.date))}`);
  }
  return lines.join('\n') + '\n';
}

/**
 * The whole picture chain, shared by the movie and the stills:
 * timestamps, the optional brightness curve (lut1d, on RGB), 1024 px BT.709
 * limited range 4:2:0, and the printed time.
 */
export function videoFilter({ fontFile = FONT_FILE, lutFile = null } = {}) {
  return [
    `setpts=N/(${FPS}*TB)`,
    ...(lutFile ? [`lut1d=file=${filterValue(fwd(lutFile))}:interp=linear`] : []),
    `scale=${SIZE_PX}:${SIZE_PX}:flags=lanczos:out_range=tv:out_color_matrix=bt709`,
    'format=yuv420p',
    // Tag the frames BT.709 limited range so players convert the colours back
    // the same way (ffmpeg takes the stream's colour tags from the frames).
    'setparams=range=tv:colorspace=bt709:color_primaries=bt709:color_trc=bt709',
    'drawtext=' + [
      `fontfile=${filterValue(fwd(fontFile))}`,
      "text='%{metadata\\:lumara_time}'",
      `fontsize=${LABEL_SIZE}`,
      `fontcolor=${LABEL_COLOR}`,
      `x=${LABEL_MARGIN}`,
      `y=h-${LABEL_MARGIN}-lh`,
    ].join(':'),
  ].join(',');
}

export function ffmpegArgs({ listPath, outPath, crf, fontFile = FONT_FILE, lutFile = null }) {
  return [
    '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'concat', '-safe', '0', '-i', fwd(listPath),
    '-vf', videoFilter({ fontFile, lutFile }),
    '-r', String(FPS), '-fps_mode', 'cfr',
    '-c:v', 'libx264', '-preset', X264_PRESET, '-crf', String(crf),
    '-profile:v', 'high', '-pix_fmt', 'yuv420p',
    '-g', String(KEYFRAME_EVERY), '-keyint_min', String(KEYFRAME_EVERY), '-sc_threshold', '0',
    '-an', '-map_metadata', '-1',
    '-movflags', '+faststart',
    '-f', 'mp4', fwd(outPath),
  ];
}

/**
 * One still through the same chain as the movie, as a full range RGB PNG
 * (what a player shows, before H.264 compression). Used for the brightness
 * comparison.
 */
export function stillArgs({ listPath, outPath, fontFile = FONT_FILE, lutFile = null }) {
  return [
    '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'concat', '-safe', '0', '-i', fwd(listPath),
    '-vf', `${videoFilter({ fontFile, lutFile })},scale=in_range=tv:in_color_matrix=bt709:out_range=pc,format=rgb24`,
    '-frames:v', '1', '-update', '1', fwd(outPath),
  ];
}

export function run(cmd, args, { encoding = 'utf8' } = {}) {
  const r = spawnSync(cmd, args, { encoding, maxBuffer: 256 * 1024 * 1024, windowsHide: true });
  if (r.error) throw new Error(`${cmd} could not start: ${r.error.message}`);
  if (r.status !== 0) {
    const err = Buffer.isBuffer(r.stderr) ? r.stderr.toString('utf8') : r.stderr || '';
    throw new Error(`${cmd} exited ${r.status}: ${err.trim().split('\n').slice(-5).join(' | ')}`);
  }
  return r.stdout;
}

/**
 * Throws unless ffmpeg (with drawtext and libx264, and lut1d when a
 * brightness curve is used) and ffprobe are on PATH, the font is there and
 * every curve file reads as a whole 256 step curve.
 */
export function checkTools({ lutFiles = [] } = {}) {
  const v = run('ffmpeg', ['-hide_banner', '-version']).split('\n')[0];
  const filters = run('ffmpeg', ['-hide_banner', '-filters']);
  if (!/\bdrawtext\b/.test(filters)) throw new Error('this ffmpeg has no drawtext filter (needs libfreetype)');
  if (lutFiles.length && !/\blut1d\b/.test(filters)) throw new Error('this ffmpeg has no lut1d filter (needed for the brightness curve)');
  const enc = run('ffmpeg', ['-hide_banner', '-encoders']);
  if (!/\blibx264\b/.test(enc)) throw new Error('this ffmpeg has no libx264 encoder');
  run('ffprobe', ['-hide_banner', '-version']);
  if (!existsSync(FONT_FILE)) throw new Error(`font missing: ${FONT_FILE}`);
  for (const f of lutFiles) {
    if (!existsSync(f)) throw new Error(`brightness curve missing: ${f}`);
    parseCube(readFileSync(f, 'utf8')); // throws on a broken file
  }
  return v;
}

/** Top-level MP4 boxes in order: [{type, offset, size}]. */
export function topLevelBoxes(path, maxBoxes = 64) {
  const fd = openSync(path, 'r');
  try {
    const total = statSync(path).size;
    const out = [];
    let off = 0;
    const head = Buffer.alloc(16);
    while (off + 8 <= total && out.length < maxBoxes) {
      readSync(fd, head, 0, 16, off);
      let size = head.readUInt32BE(0);
      const type = head.toString('latin1', 4, 8);
      if (size === 1) size = Number(head.readBigUInt64BE(8));
      else if (size === 0) size = total - off;
      if (size < 8) break;
      out.push({ type, offset: off, size });
      off += size;
    }
    return out;
  } finally {
    closeSync(fd);
  }
}

export function isFaststart(path) {
  const boxes = topLevelBoxes(path);
  const moov = boxes.findIndex((b) => b.type === 'moov');
  const mdat = boxes.findIndex((b) => b.type === 'mdat');
  return moov >= 0 && mdat >= 0 && moov < mdat;
}

export function probe(path) {
  const out = run('ffprobe', [
    '-v', 'error', '-count_frames', '-select_streams', 'v:0',
    '-show_entries', 'stream=codec_name,profile,pix_fmt,width,height,nb_read_frames,avg_frame_rate:format=duration,size',
    '-of', 'json', fwd(path),
  ]);
  const j = JSON.parse(out);
  const s = j.streams?.[0] || {};
  return {
    codec: s.codec_name, profile: s.profile, pixFmt: s.pix_fmt, width: s.width, height: s.height,
    frames: Number(s.nb_read_frames), fps: s.avg_frame_rate,
    duration: Number(j.format?.duration), bytes: Number(j.format?.size),
  };
}

// The label box (bottom left, where the time is printed) and a control box
// of the same size in the bottom right corner, where nothing is printed.
export const LABEL_BOX_W = 240;
export const LABEL_BOX_H = LABEL_SIZE + 10;
const boxY = SIZE_PX - LABEL_MARGIN - LABEL_BOX_H;
export const labelBox = () => `crop=${LABEL_BOX_W}:${LABEL_BOX_H}:${LABEL_MARGIN}:${boxY}`;
export const controlBox = () => `crop=${LABEL_BOX_W}:${LABEL_BOX_H}:${SIZE_PX - LABEL_MARGIN - LABEL_BOX_W}:${boxY}`;

function boxBrightness(path, frameCount, box) {
  const last = Math.max(0, frameCount - 1);
  const out = run('ffmpeg', [
    '-nostdin', '-v', 'error', '-i', fwd(path),
    '-vf', `select='eq(n\\,0)+eq(n\\,${last})',${box},signalstats,metadata=mode=print:key=lavfi.signalstats.YMAX:file=-`,
    '-fps_mode', 'passthrough', '-f', 'null', '-',
  ]);
  return [...out.matchAll(/lavfi\.signalstats\.YMAX=(\d+)/g)].map((m) => Number(m[1]));
}

/**
 * The printed time really is there: the brightest pixel in the label box of
 * the first and last frames, and the same for the unprinted corner on the
 * other side. The corners of an AIA frame are near black (luma about 16 to
 * 40) and the label is white (about 210), so a missing label (an ffmpeg that
 * drops the packet metadata, a wrong font path) fails loudly, with or
 * without the brightness curve.
 */
export function labelBrightness(path, frameCount) {
  return { label: boxBrightness(path, frameCount, labelBox()), control: boxBrightness(path, frameCount, controlBox()) };
}

/** Problems with the label measurement (empty list = the time is printed). */
export function checkLabel({ label, control }, frameCount) {
  const want = frameCount > 1 ? 2 : 1;
  if (label.length !== want || control.length !== want) return [`label brightness unreadable (${label.join(', ')} / ${control.join(', ')})`];
  const problems = [];
  label.forEach((y, i) => {
    if (y < 128 || y - control[i] < 48) {
      problems.push(`the frame time is not visible on ${i === 0 ? 'the first' : 'the last'} frame (label luma ${y}, empty corner ${control[i]})`);
    }
  });
  return problems;
}

/** Problems with a probed movie (empty list = good). */
export function checkProbe(p, expectedFrames, { maxBytes = TARGET_MAX_BYTES } = {}) {
  const problems = [];
  if (p.codec !== 'h264') problems.push(`codec is ${p.codec}, not h264`);
  if (p.width !== SIZE_PX || p.height !== SIZE_PX) problems.push(`size is ${p.width}x${p.height}`);
  if (p.pixFmt !== 'yuv420p') problems.push(`pixel format is ${p.pixFmt}`);
  if (p.frames !== expectedFrames) problems.push(`${p.frames} frames, expected ${expectedFrames}`);
  if (p.fps !== `${FPS}/1`) problems.push(`frame rate is ${p.fps}`);
  const want = expectedFrames / FPS;
  if (!(Math.abs(p.duration - want) <= 1 / FPS + 0.01)) problems.push(`duration ${p.duration} s, expected ${want.toFixed(3)} s`);
  if (!(p.bytes > 0 && p.bytes <= maxBytes)) problems.push(`${p.bytes} bytes, over the ${maxBytes} byte ceiling`);
  return problems;
}

/**
 * The CRF to try next, or null when the last try is inside the size range or
 * no useful CRF is left. File size falls roughly exponentially with CRF, so
 * the search works on log2(bytes): the first step assumes the size halves
 * every 6 CRF (it is steeper for 304), later steps use the measured slope,
 * interpolating between the closest "too big" and "too small" tries once
 * there are both.
 */
export function nextCrf(tries, { min = TARGET_MIN_BYTES, max = TARGET_MAX_BYTES, lo = CRF_MIN, hi = CRF_MAX } = {}) {
  const last = tries[tries.length - 1];
  if (last.bytes >= min && last.bytes <= max) return null;
  const target = Math.log2((min + max) / 2);
  const y = (t) => Math.log2(t.bytes);
  const big = tries.filter((t) => t.bytes > max).sort((a, b) => b.crf - a.crf)[0]; // highest CRF still too big
  const small = tries.filter((t) => t.bytes < min).sort((a, b) => a.crf - b.crf)[0]; // lowest CRF still too small
  const bracket = big && small && small.crf > big.crf;
  let guess;
  if (bracket) {
    guess = big.crf + ((y(big) - target) * (small.crf - big.crf)) / (y(big) - y(small));
  } else {
    const prev = tries[tries.length - 2];
    const slope = prev && prev.crf !== last.crf ? (y(last) - y(prev)) / (last.crf - prev.crf) : 0;
    guess = slope < -0.02 ? last.crf + (target - y(last)) / slope : last.crf + 6 * (y(last) - target);
  }
  const tried = new Set(tries.map((t) => t.crf));
  let next = Math.min(hi, Math.max(lo, Math.round(guess)));
  if (tried.has(next)) {
    const dir = last.bytes > max ? 1 : -1;
    next = last.crf + dir;
    while (tried.has(next)) next += dir;
  }
  if (next < lo || next > hi) return null;
  if (bracket && !(next > big.crf && next < small.crf)) return null; // no whole CRF left between them
  return next;
}

/**
 * Encode, stepping the CRF until the file is 5 to 10 MB (or the tries run
 * out), and keep the best file: inside the range, else the largest under the
 * ceiling. Returns {path, crf, bytes, tries:[{crf,bytes,seconds}]}.
 */
export function encodeMovie({ frames, workDir, outPath, crfStart = CRF_START, lutFile = null, log = () => {} }) {
  const listPath = `${workDir}/frames.ffconcat`;
  writeFileSync(listPath, concatList(frames));
  const tries = [];
  let crf = crfStart;
  for (let n = 0; n < MAX_ENCODES; n++) {
    const path = `${workDir}/crf${crf}.mp4`;
    const t0 = Date.now();
    run('ffmpeg', ffmpegArgs({ listPath, outPath: path, crf, lutFile }));
    const bytes = statSync(path).size;
    const seconds = (Date.now() - t0) / 1000;
    tries.push({ crf, bytes, seconds, path });
    log(`  encode CRF ${crf}: ${(bytes / 1048576).toFixed(2)} MB in ${seconds.toFixed(1)} s`);
    const next = nextCrf(tries);
    if (next === null) break;
    crf = next;
  }
  const inRange = tries.filter((t) => t.bytes >= TARGET_MIN_BYTES && t.bytes <= TARGET_MAX_BYTES);
  const under = tries.filter((t) => t.bytes <= TARGET_MAX_BYTES).sort((a, b) => b.bytes - a.bytes);
  const pick = inRange[0] || under[0];
  for (const t of tries) if (t !== pick && existsSync(t.path)) unlinkSync(t.path);
  if (!pick) throw new Error(`every encode was over ${TARGET_MAX_BYTES} bytes (${tries.map((t) => `CRF ${t.crf}: ${t.bytes}`).join(', ')})`);
  renameSync(pick.path, outPath);
  return { path: outPath, crf: pick.crf, bytes: pick.bytes, tries: tries.map(({ crf: c, bytes: b, seconds: s }) => ({ crf: c, bytes: b, seconds: s })) };
}

export function sha256File(path) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(path).on('data', (d) => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });
}

/**
 * Proves the installed ffmpeg prints the time and applies the curve before a
 * run fetches anything: three dark synthetic frames through the real chain,
 * then the same probe, faststart and label checks a real movie gets.
 * Returns a one-line summary; throws on any problem.
 */
export function selfTest({ lutFile = null, log = () => {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sun-movie-selftest-'));
  try {
    const frames = [];
    for (let i = 0; i < 3; i++) {
      const file = join(dir, `f${i}.jpg`);
      run('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=0x0b0b0b:s=${SIZE_PX}x${SIZE_PX}:d=1`,
        '-frames:v', '1', '-q:v', '3', fwd(file)]);
      frames.push({ file, date: new Date(Date.UTC(2026, 8, 29, 3, 54, 29 + i * 20)) });
    }
    writeFileSync(join(dir, 'frames.ffconcat'), concatList(frames));
    const out = join(dir, 'selftest.mp4');
    run('ffmpeg', ffmpegArgs({ listPath: join(dir, 'frames.ffconcat'), outPath: out, crf: 23, lutFile }));
    const p = probe(out);
    const problems = checkProbe(p, frames.length);
    if (!isFaststart(out)) problems.push('moov atom is not before mdat (no faststart)');
    const lb = labelBrightness(out, frames.length);
    problems.push(...checkLabel(lb, frames.length));
    if (problems.length) throw new Error(`ffmpeg self-test failed: ${problems.join('; ')}`);
    const line = `ffmpeg self-test passed${lutFile ? ' with the brightness curve' : ''}: ${p.codec} ${p.width}x${p.height} ${p.pixFmt}, ${p.frames} frames at ${p.fps}, faststart, time printed (label luma ${lb.label.join(', ')}, empty corner ${lb.control.join(', ')})`;
    log(`  ${line}`);
    return line;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
