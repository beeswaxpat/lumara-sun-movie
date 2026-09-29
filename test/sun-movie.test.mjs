// The pure parts of the movie builder and the fetch loop against a fake
// Helioviewer. No network. The last test runs the ffmpeg self-test when
// ffmpeg is installed and is skipped otherwise.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  CHANNELS, SLOT_COUNT, SLOT_SECONDS, SERVERS, TARGET_MIN_BYTES, TARGET_MAX_BYTES, CRF_MAX, CRF_MIN, DEFAULT_BRIGHTNESS, brightnessLut,
} from '../src/config.mjs';
import { HelioviewerClient, isoSeconds, parseHelioviewerDate, jpegSize } from '../src/helioviewer.mjs';
import {
  slotTimes, matchesSlot, frameLabel, frameFileName, iso, roundToMinute, collectFrames, capIndex, saveIndex, loadIndex,
} from '../src/frames.mjs';
import {
  ffconcatQuote, filterValue, concatList, nextCrf, checkProbe, checkLabel, isFaststart, topLevelBoxes, videoFilter, ffmpegArgs, selfTest,
} from '../src/encode.mjs';
import { parseArgs, buildManifest, newestLabel, lutFor } from '../src/sun-movie.mjs';

const C171 = CHANNELS.find((c) => c.code === '171');

// A JPEG header big enough to pass the frame checks: SOI, a COM filler, SOF0 1024x1024, EOI.
export function fakeJpeg(width = 1024, height = 1024, filler = 12_000) {
  const com = Buffer.alloc(4 + filler);
  com.writeUInt16BE(0xfffe, 0);
  com.writeUInt16BE(filler + 2, 2);
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 0x03,
    0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), com, sof, Buffer.from([0xff, 0xd9])]);
}

test('dates: Helioviewer form in, ISO out', () => {
  assert.equal(parseHelioviewerDate('2026-09-29 00:05:09').toISOString(), '2026-09-29T00:05:09.000Z');
  assert.equal(parseHelioviewerDate('2026-09-29T00:05:09.348Z').toISOString(), '2026-09-29T00:05:09.348Z');
  assert.equal(parseHelioviewerDate('yesterday'), null);
  assert.equal(parseHelioviewerDate(undefined), null);
  assert.equal(isoSeconds(new Date('2026-09-29T00:05:09.900Z')), '2026-09-29T00:05:09Z');
});

test('the printed time is rounded to the nearest minute', () => {
  assert.equal(frameLabel(new Date('2026-09-28T21:05:47Z')), '2026-09-28 21:06 UTC');
  assert.equal(frameLabel(new Date('2026-09-28T21:05:29Z')), '2026-09-28 21:05 UTC');
  assert.equal(frameLabel(new Date('2026-09-28T21:05:30Z')), '2026-09-28 21:06 UTC', '30 s rounds up');
  assert.equal(frameLabel(new Date('2026-09-29T03:54:57Z')), '2026-09-29 03:55 UTC', 'run 2 review finding 10');
  assert.equal(frameLabel(new Date('2026-12-31T23:59:45Z')), '2027-01-01 00:00 UTC', 'the date rolls over too');
  assert.equal(iso(roundToMinute(new Date('2026-09-28T21:05:47Z'))), '2026-09-28T21:06:00Z');
  assert.equal(newestLabel(new Date('2026-09-28T21:05:47Z')), 'Newest frame 21:06 UTC');
});

test('file names keep the exact capture time', () => {
  const d = new Date('2026-09-28T21:05:47Z');
  assert.equal(frameFileName(d), '20260928T210547Z.jpg');
  assert.doesNotMatch(frameLabel(d) + newestLabel(d), /[\u2013\u2014]/);
});

test('288 slots, 5 minutes apart, ending on the grid at or before the newest frame', () => {
  const newest = new Date('2026-09-29T03:46:33Z');
  const s = slotTimes(newest);
  assert.equal(s.length, SLOT_COUNT);
  assert.equal(iso(s[s.length - 1]), '2026-09-29T03:45:00Z');
  assert.equal(iso(s[0]), '2026-09-28T03:50:00Z');
  for (let i = 1; i < s.length; i++) assert.equal(s[i] - s[i - 1], SLOT_SECONDS * 1000);
});

test('a frame fills a slot only within half a slot', () => {
  const slot = new Date('2026-09-29T00:05:00Z');
  assert.ok(matchesSlot(slot, new Date('2026-09-29T00:05:09Z')));
  assert.ok(matchesSlot(slot, new Date('2026-09-29T00:02:30Z')));
  assert.ok(!matchesSlot(slot, new Date('2026-09-29T00:07:31Z')));
});

test('jpegSize reads SOF and rejects cut or foreign files', () => {
  assert.deepEqual(jpegSize(fakeJpeg()), { width: 1024, height: 1024 });
  assert.deepEqual(jpegSize(fakeJpeg(512, 256)), { width: 512, height: 256 });
  const whole = fakeJpeg();
  assert.equal(jpegSize(whole.subarray(0, whole.length - 2)), null, 'no EOI');
  assert.equal(jpegSize(Buffer.from('{"error":"x"}')), null);
});

test('ffconcat and filter escaping', () => {
  assert.equal(ffconcatQuote("it's"), "'it'\\''s'");
  assert.equal(filterValue('D:/fonts dir/f.ttf'), 'D\\\\:/fonts dir/f.ttf');
  const list = concatList([{ file: 'D:\\x\\20260929T000509Z.jpg', date: new Date('2026-09-29T00:05:09Z') }]);
  assert.equal(list, "ffconcat version 1.0\nfile 'D:/x/20260929T000509Z.jpg'\nfile_packet_meta lumara_time '2026-09-29 00:05 UTC'\n");
  const vf = videoFilter({ fontFile: 'D:\\f\\Roboto-Regular.ttf' });
  assert.match(vf, /^setpts=N\/\(24\*TB\),scale=1024:1024:/);
  assert.match(vf, /drawtext=fontfile=D\\\\:\/f\/Roboto-Regular\.ttf:text='%\{metadata\\:lumara_time\}'/);
  assert.doesNotMatch(vf, /lut1d/);
});

test('the brightness curve goes in before the scale, on the frames as decoded', () => {
  const vf = videoFilter({ fontFile: '/f/Roboto-Regular.ttf', lutFile: 'D:\\b\\aia-171.cube' });
  assert.match(vf, /^setpts=N\/\(24\*TB\),lut1d=file=D\\\\:\/b\/aia-171\.cube:interp=linear,scale=1024:1024:/);
  const args = ffmpegArgs({ listPath: '/w/frames.ffconcat', outPath: '/w/m.mp4', crf: 18, lutFile: '/b/aia-304.cube' });
  assert.ok(args[args.indexOf('-vf') + 1].includes('lut1d=file=/b/aia-304.cube'));
  for (const flag of ['-fps_mode', '-movflags', '-map_metadata', '-sc_threshold']) assert.ok(args.includes(flag), flag);
});

test('CRF steps toward 5 to 10 MB and stays in bounds', () => {
  const MB = 1024 * 1024;
  const t = (crf, mb) => ({ crf, bytes: Math.round(mb * MB) });
  assert.equal(nextCrf([t(18, 7)]), null, 'in range: done');
  assert.ok(nextCrf([t(18, 20)]) > 18);
  assert.ok(nextCrf([t(18, 2)]) < 18);
  assert.equal(nextCrf([t(18, 10.01)]), 20, 'aims at the middle of the range');
  // The 304 run of 2026-09-29: CRF 18 gave 20.28 MB, CRF 27 gave 3.29 MB.
  assert.equal(nextCrf([t(18, 20.28)]), 27);
  assert.equal(nextCrf([t(18, 20.28), t(27, 3.29)]), 23, 'interpolates inside the bracket');
  assert.equal(nextCrf([t(23, 11), t(24, 4)]), null, 'no whole CRF left between them');
  assert.equal(nextCrf([t(CRF_MAX, 500)]), null, 'cannot go above CRF_MAX');
  assert.equal(nextCrf([t(CRF_MIN, 0.001)]), null, 'cannot go below CRF_MIN');
  assert.equal(CHANNELS.find((c) => c.code === '304').crfStart, 23);
  assert.equal(TARGET_MIN_BYTES, 5 * MB);
  assert.equal(TARGET_MAX_BYTES, 10 * MB);
});

test('ffprobe checks', () => {
  const good = { codec: 'h264', profile: 'High', pixFmt: 'yuv420p', width: 1024, height: 1024, frames: 288, fps: '24/1', duration: 12, bytes: 7e6 };
  assert.deepEqual(checkProbe(good, 288), []);
  assert.match(checkProbe({ ...good, frames: 287 }, 288).join(), /287 frames, expected 288/);
  assert.match(checkProbe({ ...good, duration: 11 }, 288).join(), /duration 11 s/);
  assert.equal(checkProbe({ ...good, codec: 'hevc' }, 288).length, 1);
  assert.equal(checkProbe({ ...good, bytes: 11 * 1024 * 1024 }, 288).length, 1);
  assert.equal(checkProbe({ ...good, pixFmt: 'yuv444p' }, 288).length, 1);
});

test('label check: bright label against a dark, unprinted corner', () => {
  assert.deepEqual(checkLabel({ label: [214, 220], control: [24, 26] }, 288), []);
  assert.match(checkLabel({ label: [30, 220], control: [24, 26] }, 288).join(), /not visible on the first frame/);
  assert.match(checkLabel({ label: [214, 90], control: [24, 26] }, 288).join(), /not visible on the last frame/);
  assert.equal(checkLabel({ label: [200, 200], control: [190, 190] }, 288).length, 2, 'a bright corner does not count as a label');
  assert.match(checkLabel({ label: [214], control: [24] }, 288).join(), /unreadable/);
  assert.deepEqual(checkLabel({ label: [214], control: [24] }, 1), []);
});

test('faststart: moov before mdat', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sunmovie-'));
  try {
    const box = (type, len) => { const b = Buffer.alloc(len); b.writeUInt32BE(len, 0); b.write(type, 4, 'latin1'); return b; };
    writeFileSync(join(dir, 'fast.mp4'), Buffer.concat([box('ftyp', 24), box('moov', 100), box('mdat', 400)]));
    writeFileSync(join(dir, 'slow.mp4'), Buffer.concat([box('ftyp', 24), box('mdat', 400), box('moov', 100)]));
    assert.deepEqual(topLevelBoxes(join(dir, 'fast.mp4')).map((b) => b.type), ['ftyp', 'moov', 'mdat']);
    assert.ok(isFaststart(join(dir, 'fast.mp4')));
    assert.ok(!isFaststart(join(dir, 'slow.mp4')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('arguments, the channel list and the brightness choice', () => {
  assert.deepEqual(CHANNELS.map((c) => c.code), ['171', '304']);
  assert.deepEqual(parseArgs([], {}).channels.map((c) => c.code), ['171', '304']);
  assert.deepEqual(parseArgs(['--channels', '171'], {}).channels.map((c) => c.code), ['171']);
  assert.throws(() => parseArgs(['--channels', '999'], {}), /unknown channel/);
  assert.throws(() => parseArgs(['--nope'], {}), /unknown argument/);
  assert.equal(parseArgs([], {}).maxAgeSeconds, 3 * 3600);
  assert.equal(parseArgs(['--max-age-hours', '0.5'], {}).maxAgeSeconds, 1800);
  assert.throws(() => parseArgs(['--max-age-hours', '0'], {}), /positive/);
  assert.equal(DEFAULT_BRIGHTNESS, 'nasa', 'decided 2026-09-29: on by default');
  assert.equal(parseArgs([], {}).brightness, 'nasa');
  assert.equal(parseArgs(['--brightness', 'off'], {}).brightness, 'off');
  assert.equal(parseArgs([], { SUN_MOVIE_BRIGHTNESS: 'OFF' }).brightness, 'off');
  assert.throws(() => parseArgs(['--brightness', 'bright'], {}), /unknown brightness/);
  assert.equal(lutFor(C171, 'off'), null);
  assert.equal(lutFor(C171, 'nasa'), brightnessLut('171'));
  assert.equal(parseArgs(['--self-test'], {}).selfTest, true);
});

test('manifest keeps exact times; only the label is rounded', () => {
  const frames = [{ date: new Date('2026-09-28T21:10:05Z') }, { date: new Date('2026-09-29T21:05:47Z') }];
  const m = buildManifest({ channel: C171, frames, missing: [{}], bytes: 6_000_000, sha256: 'ab'.repeat(32), crf: 18, builtAt: new Date('2026-09-29T21:40:00Z') });
  assert.equal(m.movie, 'sun-24h-171.mp4');
  assert.equal(m.newestFrameUtc, '2026-09-29T21:05:47Z');
  assert.equal(m.oldestFrameUtc, '2026-09-28T21:10:05Z');
  assert.equal(m.newestLabel, 'Newest frame 21:06 UTC');
  assert.equal(m.frameCount, 2);
  assert.equal(m.missingFrames, 1);
  assert.equal(m.sha256.length, 64);
  assert.equal(m.version, m.sha256.slice(0, 12));
  assert.equal(m.brightness, 'nasa');
  assert.equal(m.credit, 'NASA/SDO and the AIA science team, via Helioviewer.org');
  assert.doesNotMatch(JSON.stringify(m), /[\u2013\u2014]/);
});

test('the frame cache has a hard size ceiling; the oldest slots go first', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sunmovie-'));
  try {
    const index = { version: 1, channel: '171', slots: {} };
    for (let i = 0; i < 5; i++) {
      const key = `2026-09-29T0${i}:00:00Z`;
      const file = `2026092${9}T0${i}0000Z.jpg`;
      writeFileSync(join(dir, file), Buffer.alloc(1000));
      index.slots[key] = { date: key, file };
    }
    const dropped = capIndex(dir, index, 3000);
    assert.deepEqual(dropped, ['2026-09-29T00:00:00Z', '2026-09-29T01:00:00Z']);
    assert.equal(Object.keys(index.slots).length, 3);
    saveIndex(dir, index);
    assert.equal(Object.keys(loadIndex(dir, '171').slots).length, 3);
    assert.deepEqual(capIndex(dir, index, 1e9), [], 'under the ceiling nothing goes');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- the fetch loop against a fake Helioviewer ----
// Frames every 36 s up to `newest`, none inside `gap`. The mirror has the same
// frames under other ids. `failMain` makes the main server answer 503.
function fakeHelioviewer({ newest, gap = null, failMain = () => false }) {
  const start = newest.getTime() - 26 * 3600 * 1000;
  const times = [];
  for (let t = newest.getTime(); t >= start; t -= 36_000) {
    if (gap && t >= gap[0].getTime() && t <= gap[1].getTime()) continue;
    times.push(t);
  }
  times.reverse();
  const calls = { closest: 0, download: 0, byHost: {} };
  const fmt = (t) => new Date(t).toISOString().slice(0, 19).replace('T', ' ');
  const fetchImpl = async (url) => {
    const u = new URL(url);
    calls.byHost[u.host] = (calls.byHost[u.host] || 0) + 1;
    const mirror = u.host !== new URL(SERVERS[0].base).host;
    if (!mirror && failMain(u)) return new Response('busy', { status: 503 });
    const off = mirror ? 1_000_000 : 0;
    if (u.pathname.endsWith('/getClosestImage/')) {
      calls.closest++;
      const want = new Date(u.searchParams.get('date')).getTime();
      let best = 0;
      for (let i = 1; i < times.length; i++) if (Math.abs(times[i] - want) < Math.abs(times[best] - want)) best = i;
      return Response.json({ id: String(best + off), date: fmt(times[best]), name: 'AIA 171' });
    }
    if (u.pathname.endsWith('/downloadImage/')) {
      calls.download++;
      const i = Number(u.searchParams.get('id')) - off;
      if (!(i >= 0 && i < times.length)) return new Response('no', { status: 404 });
      return new Response(fakeJpeg(), { headers: { 'content-type': 'image/jpeg' } });
    }
    return new Response('?', { status: 404 });
  };
  return { fetchImpl, calls };
}

const quietClient = (fetchImpl) => new HelioviewerClient({ fetchImpl, sleepImpl: async () => {}, minGapMs: 0, backoffBaseMs: 0, retries: 3 });

test('first run fills 288 slots; the next run fetches only the new ones', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sunmovie-'));
  try {
    const newest = new Date('2026-09-29T03:46:33Z');
    const hv = fakeHelioviewer({ newest });
    const r1 = await collectFrames({ channel: C171, cacheDir: dir, client: quietClient(hv.fetchImpl), now: new Date('2026-09-29T04:10:00Z') });
    assert.equal(r1.frames.length, 288);
    assert.equal(r1.missing.length, 0);
    assert.equal(r1.fetched, 288);
    assert.equal(hv.calls.download, 288);
    assert.equal(readdirSync(join(dir, '171')).filter((n) => n.endsWith('.jpg')).length, 288);
    for (const f of r1.frames) assert.ok(matchesSlot(f.slot, f.date));
    assert.equal(new Set(r1.frames.map((f) => f.date.getTime())).size, 288, 'no frame used twice');

    // Three hours later: 36 new slots, the 36 oldest pruned only once past the kept window.
    const later = new Date(newest.getTime() + 3 * 3600 * 1000);
    const hv2 = fakeHelioviewer({ newest: later });
    const r2 = await collectFrames({ channel: C171, cacheDir: dir, client: quietClient(hv2.fetchImpl), now: new Date(later.getTime() + 20 * 60 * 1000) });
    assert.equal(r2.frames.length, 288);
    assert.equal(r2.fetched, 36);
    assert.equal(r2.reused, 252);
    assert.equal(hv2.calls.download, 36);
    assert.equal(hv2.calls.closest, 1 + 36, 'one newest probe plus one lookup per new slot');
    const idx = JSON.parse(readFileSync(join(dir, '171', 'index.json'), 'utf8'));
    assert.equal(idx.channel, '171');
    assert.ok(Object.keys(idx.slots).length >= 288);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a cache over its ceiling drops the oldest frames, and the movie never names a deleted frame', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sunmovie-'));
  try {
    const hv = fakeHelioviewer({ newest: new Date('2026-09-29T03:46:33Z') });
    const frameBytes = fakeJpeg().length;
    const r = await collectFrames({
      channel: C171, cacheDir: dir, client: quietClient(hv.fetchImpl), now: new Date('2026-09-29T04:00:00Z'), maxCacheBytes: frameBytes * 200,
    });
    assert.equal(r.frames.length, 200);
    for (const f of r.frames) assert.ok(existsSync(f.file));
    assert.equal(readdirSync(join(dir, '171')).filter((n) => n.endsWith('.jpg')).length, 200);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a data gap leaves slots empty; nothing is invented', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sunmovie-'));
  try {
    const newest = new Date('2026-09-29T03:46:33Z');
    const gap = [new Date('2026-09-28T12:00:00Z'), new Date('2026-09-28T13:00:00Z')];
    const hv = fakeHelioviewer({ newest, gap });
    const r = await collectFrames({ channel: C171, cacheDir: dir, client: quietClient(hv.fetchImpl), now: new Date('2026-09-29T04:00:00Z') });
    assert.ok(r.missing.length >= 10 && r.missing.length <= 12, `missing ${r.missing.length}`);
    assert.equal(r.frames.length + r.missing.length, 288);
    for (const f of r.frames) assert.ok(f.date < gap[0] || f.date > gap[1]);
    assert.match(r.missing[0].why, /nearest frame is/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('retries a busy server, then moves to the mirror when it stays down', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sunmovie-'));
  try {
    const newest = new Date('2026-09-29T03:46:33Z');
    let n = 0;
    // Every third main request is busy once (retried), and after 100 requests the main server is gone.
    const hv = fakeHelioviewer({ newest, failMain: () => { n++; return n > 100 || n % 3 === 0; } });
    const client = quietClient(hv.fetchImpl);
    const r = await collectFrames({ channel: C171, cacheDir: dir, client, now: new Date('2026-09-29T04:00:00Z') });
    assert.equal(r.frames.length, 288);
    assert.ok(client.stats.retries > 0);
    assert.ok(client.down.has(SERVERS[0].name));
    assert.ok(hv.calls.byHost[new URL(SERVERS[1].base).host] > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a cut download is not saved and the slot is logged missing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sunmovie-'));
  try {
    const newest = new Date('2026-09-29T03:46:33Z');
    const hv = fakeHelioviewer({ newest });
    const cut = async (url, init) => {
      const res = await hv.fetchImpl(url, init);
      if (!String(url).includes('/downloadImage/')) return res;
      const b = Buffer.from(await res.arrayBuffer());
      return new Response(b.subarray(0, b.length - 100), { headers: res.headers });
    };
    const r = await collectFrames({ channel: C171, cacheDir: dir, client: quietClient(cut), now: new Date('2026-09-29T04:00:00Z') });
    assert.equal(r.frames.length, 0);
    assert.equal(r.missing.length, 288);
    assert.match(r.missing[0].why, /not a whole JPEG/);
    assert.ok(!existsSync(join(dir, '171')) || readdirSync(join(dir, '171')).every((n) => !n.endsWith('.jpg')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- the real ffmpeg, when there is one ----
const hasFfmpeg = spawnSync('ffmpeg', ['-hide_banner', '-version'], { windowsHide: true }).status === 0;

test('ffmpeg self-test: the time is printed, with and without the brightness curve', { skip: !hasFfmpeg && 'ffmpeg is not installed' }, () => {
  assert.match(selfTest(), /self-test passed/);
  for (const c of CHANNELS) assert.match(selfTest({ lutFile: brightnessLut(c.code) }), /with the brightness curve/);
});
