// The Pages site: only fresh, checked movies go up; a failed channel keeps
// its last copy only while that copy is fresh; nothing fresh, nothing
// published.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHANNELS, movieName, manifestName } from '../src/config.mjs';
import { assembleSite, checkPublished, indexHtml } from '../src/site.mjs';

// En and em dashes, built from char codes so this file holds neither.
const DASHES = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`);
const NOW = new Date('2026-09-29T09:00:00Z');

function putMovie(dir, code, { newest = '2026-09-29T08:10:47Z', tamper = false, bytes = 4096, schema = 1 } = {}) {
  const movie = Buffer.alloc(bytes, code === '171' ? 1 : 2);
  const sha = createHash('sha256').update(movie).digest('hex');
  writeFileSync(join(dir, movieName(code)), tamper ? Buffer.alloc(bytes, 9) : movie);
  writeFileSync(join(dir, manifestName(code)), JSON.stringify({
    schema, channel: code, name: `AIA ${code}`, movie: movieName(code), version: sha.slice(0, 12),
    newestFrameUtc: newest, oldestFrameUtc: '2026-09-28T08:15:02Z', newestLabel: 'Newest frame 08:11 UTC',
    frameCount: 288, bytes, sha256: sha, credit: 'NASA/SDO and the AIA science team, via Helioviewer.org',
  }));
}

function dirs() {
  const base = mkdtempSync(join(tmpdir(), 'sunsite-'));
  const d = { base, out: join(base, 'out'), prev: join(base, 'prev'), site: join(base, 'site') };
  mkdirSync(d.out);
  mkdirSync(d.prev);
  return d;
}

test('both channels fresh: both go up, with a tiny index and nothing else', async () => {
  const d = dirs();
  try {
    putMovie(d.out, '171');
    putMovie(d.out, '304');
    const r = await assembleSite({ outDir: d.out, previousDir: null, siteDir: d.site, now: NOW, repoUrl: 'https://github.com/example/sun' });
    assert.deepEqual(r.published.map((p) => p.code), ['171', '304']);
    assert.deepEqual(readdirSync(d.site).sort(), ['.nojekyll', 'index.html', 'sun-24h-171.json', 'sun-24h-171.mp4', 'sun-24h-304.json', 'sun-24h-304.mp4']);
    const html = readFileSync(join(d.site, 'index.html'), 'utf8');
    assert.match(html, /sun-24h-171\.mp4\?v=[0-9a-f]{12}/);
    assert.match(html, /Newest frame 2026-09-29 08:11 UTC/, 'rounded to the nearest minute');
    assert.match(html, /NASA\/SDO and the AIA science team, via Helioviewer\.org/);
    assert.match(html, /https:\/\/github\.com\/example\/sun/);
    assert.doesNotMatch(html, DASHES);
    assert.ok(statSync(join(d.site, 'index.html')).size < 4096, 'tiny');
  } finally {
    rmSync(d.base, { recursive: true, force: true });
  }
});

test('a failed channel keeps its last copy while it is fresh, and loses it once stale', async () => {
  const d = dirs();
  try {
    putMovie(d.out, '171');
    putMovie(d.prev, '304', { newest: '2026-09-29T05:10:00Z' }); // 3.8 hours old: fresh
    let r = await assembleSite({ outDir: d.out, previousDir: d.prev, siteDir: d.site, now: NOW });
    assert.deepEqual(r.published.map((p) => [p.code, p.from]), [['171', 'this run'], ['304', 'kept from the last publish']]);

    putMovie(d.prev, '304', { newest: '2026-09-29T02:30:00Z' }); // 6.5 hours old: stale
    r = await assembleSite({ outDir: d.out, previousDir: d.prev, siteDir: d.site, now: NOW });
    assert.deepEqual(r.published.map((p) => p.code), ['171']);
    assert.match(r.left[0].why, /stale/);
    assert.ok(!existsSync(join(d.site, 'sun-24h-304.mp4')), 'a stale movie is never put up again');
  } finally {
    rmSync(d.base, { recursive: true, force: true });
  }
});

test('a movie that does not match its manifest is refused', async () => {
  const d = dirs();
  try {
    putMovie(d.out, '171', { tamper: true });
    assert.match((await checkPublished(d.out, CHANNELS[0], NOW)).why, /sha256/);
    putMovie(d.out, '171', { schema: 2 });
    assert.match((await checkPublished(d.out, CHANNELS[0], NOW)).why, /schema/);
    putMovie(d.out, '171', { newest: '2026-09-29T11:00:00Z' });
    assert.match((await checkPublished(d.out, CHANNELS[0], NOW)).why, /future/);
    rmSync(join(d.out, movieName('171')));
    assert.match((await checkPublished(d.out, CHANNELS[0], NOW)).why, /without its movie/);
  } finally {
    rmSync(d.base, { recursive: true, force: true });
  }
});

test('nothing fresh: nothing published, and the run fails', async () => {
  const d = dirs();
  try {
    putMovie(d.prev, '171', { newest: '2026-09-28T20:00:00Z' });
    await assert.rejects(assembleSite({ outDir: d.out, previousDir: d.prev, siteDir: d.site, now: NOW }), /nothing published/);
    assert.ok(!existsSync(d.site));
  } finally {
    rmSync(d.base, { recursive: true, force: true });
  }
});

test('index.html escapes what it prints', () => {
  const html = indexHtml([{ manifest: { movie: 'sun-24h-171.mp4', version: 'abc', name: '<AIA>', channel: '171', newestFrameUtc: '2026-09-29T08:10:47Z', frameCount: 288 } }]);
  assert.match(html, /&lt;AIA&gt;/);
  assert.doesNotMatch(html, /<AIA>/);
});
