#!/usr/bin/env node
// Puts together the files GitHub Pages serves: for each channel the movie
// and its manifest, plus a tiny index.html. Nothing else, so the gh-pages
// branch (one commit, force-pushed each run) never grows.
//
//   node src/site.mjs [--out-dir out] [--previous-dir prev] [--site-dir site]
//
// Fails closed. A channel is published only when its manifest and movie
// agree (name, bytes, sha256) and its newest frame is less than 6 hours old
// (STALE_AFTER_SECONDS, the same limit the app and the site use):
//   - the movie this run built and checked, or else
//   - the copy already on gh-pages (--previous-dir), if it still passes the
//     same checks; so one failed channel does not take down the other, and a
//     stale movie is never put up again.
// A channel with neither is left out. When no channel is left, nothing is
// written and the exit code is 1: gh-pages keeps what it had, whose manifests
// carry their true frame times, so the app and the site see the age.
import { existsSync, readFileSync, rmSync, mkdirSync, copyFileSync, writeFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CHANNELS, DEFAULT_OUT_DIR, DEFAULT_SITE_DIR, STALE_AFTER_SECONDS, MIN_FRAMES, CREDIT, movieName, manifestName,
} from './config.mjs';
import { sha256File } from './encode.mjs';
import { frameLabel } from './frames.mjs';

/**
 * Checks one channel's manifest and movie in `dir`. Resolves to
 * {ok:true, manifest} or {ok:false, why}.
 */
export async function checkPublished(dir, channel, now = new Date()) {
  const mPath = join(dir, manifestName(channel.code));
  const vPath = join(dir, movieName(channel.code));
  if (!existsSync(mPath)) return { ok: false, why: 'no manifest' };
  if (!existsSync(vPath)) return { ok: false, why: 'manifest without its movie' };
  let m;
  try { m = JSON.parse(readFileSync(mPath, 'utf8')); } catch { return { ok: false, why: 'manifest is not JSON' }; }
  if (m.schema !== 1) return { ok: false, why: `unknown manifest schema ${m.schema}` };
  if (m.channel !== channel.code || m.movie !== movieName(channel.code)) return { ok: false, why: 'manifest names another channel or file' };
  if (!/^[0-9a-f]{64}$/.test(String(m.sha256)) || m.version !== m.sha256.slice(0, 12)) return { ok: false, why: 'manifest sha256 or version malformed' };
  if (!(m.frameCount >= MIN_FRAMES)) return { ok: false, why: `only ${m.frameCount} frames` };
  if (typeof m.newestLabel !== 'string' || !m.credit) return { ok: false, why: 'manifest has no label or credit' };
  const newest = Date.parse(m.newestFrameUtc);
  if (!Number.isFinite(newest)) return { ok: false, why: 'manifest has no newest frame time' };
  const ageS = (now.getTime() - newest) / 1000;
  if (ageS < -600) return { ok: false, why: `newest frame ${m.newestFrameUtc} is in the future` };
  if (ageS > STALE_AFTER_SECONDS) return { ok: false, why: `stale: newest frame ${m.newestFrameUtc} is ${(ageS / 3600).toFixed(1)} hours old` };
  const bytes = statSync(vPath).size;
  if (bytes !== m.bytes) return { ok: false, why: `movie is ${bytes} bytes, manifest says ${m.bytes}` };
  const sha = await sha256File(vPath);
  if (sha !== m.sha256) return { ok: false, why: 'movie sha256 does not match its manifest' };
  return { ok: true, manifest: m };
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** The tiny index page. `repoUrl` is optional (GitHub Actions knows it). */
export function indexHtml(entries, { repoUrl = '' } = {}) {
  const figures = entries.map(({ manifest: m }) => `<figure>
<video src="${esc(m.movie)}?v=${esc(m.version)}" controls muted loop playsinline preload="metadata" aria-label="${esc(m.name)}, the last 24 hours of the Sun"></video>
<figcaption>${esc(m.name)}. Newest frame ${esc(frameLabel(new Date(m.newestFrameUtc)))}. ${m.frameCount} frames. <a href="${esc(manifestName(m.channel))}">Details (JSON)</a></figcaption>
</figure>`).join('\n');
  const source = repoUrl ? ` <a href="${esc(repoUrl)}">How it is made</a>.` : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sun, last 24 hours</title>
<meta name="description" content="The last 24 hours of the Sun from NASA's Solar Dynamics Observatory, one frame every 5 minutes, rebuilt every 3 hours.">
<style>
body{margin:0;padding:16px;background:#000;color:#eee;font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:1024px;margin:0 auto}
h1{font-size:1.5rem;font-weight:600;margin:0 0 8px}
figure{margin:0 0 24px}
video{display:block;width:100%;height:auto;background:#000}
figcaption{margin-top:6px;color:#ccc}
a{color:#9cf}
</style>
</head>
<body>
<main>
<h1>The Sun, last 24 hours</h1>
<p>One frame every 5 minutes from NASA's Solar Dynamics Observatory, rebuilt every 3 hours. The time printed on each frame is when it was taken, in UTC.</p>
${figures}
<p>Images: ${esc(CREDIT)}. Built with ffmpeg.${source}</p>
</main>
</body>
</html>
`;
}

/**
 * Builds `siteDir` from `outDir` (this run) and `previousDir` (what gh-pages
 * serves now). Returns {published:[{code, from, newestFrameUtc}], left:[{code, why}]}.
 * Throws when no channel can be published; `siteDir` is then left empty.
 */
export async function assembleSite({ outDir, previousDir = null, siteDir, now = new Date(), channels = CHANNELS, repoUrl = '', log = () => {} }) {
  rmSync(siteDir, { recursive: true, force: true });
  const entries = [];
  const left = [];
  for (const channel of channels) {
    const fresh = await checkPublished(outDir, channel, now);
    if (fresh.ok) { entries.push({ channel, dir: outDir, from: 'this run', manifest: fresh.manifest }); continue; }
    let why = `this run: ${fresh.why}`;
    if (previousDir && existsSync(previousDir)) {
      const prev = await checkPublished(previousDir, channel, now);
      if (prev.ok) { entries.push({ channel, dir: previousDir, from: 'kept from the last publish', manifest: prev.manifest }); continue; }
      why += `; last publish: ${prev.why}`;
    }
    left.push({ code: channel.code, why });
  }
  for (const l of left) log(`  ${l.code}: left out (${l.why})`);
  if (!entries.length) throw new Error('no channel has a checked, fresh movie; nothing published');

  mkdirSync(siteDir, { recursive: true });
  for (const e of entries) {
    // The movie first, then its manifest.
    copyFileSync(join(e.dir, movieName(e.channel.code)), join(siteDir, movieName(e.channel.code)));
    copyFileSync(join(e.dir, manifestName(e.channel.code)), join(siteDir, manifestName(e.channel.code)));
    log(`  ${e.channel.code}: ${e.from}, newest frame ${e.manifest.newestFrameUtc}, ${e.manifest.bytes} bytes`);
  }
  writeFileSync(join(siteDir, 'index.html'), indexHtml(entries, { repoUrl }));
  writeFileSync(join(siteDir, '.nojekyll'), ''); // serve the files as they are, no Jekyll pass
  return {
    published: entries.map((e) => ({ code: e.channel.code, from: e.from, newestFrameUtc: e.manifest.newestFrameUtc })),
    left,
  };
}

export function parseArgs(argv, env = process.env) {
  const o = { outDir: env.SUN_MOVIE_OUT_DIR || DEFAULT_OUT_DIR, previousDir: null, siteDir: DEFAULT_SITE_DIR };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    if (a === '--out-dir') o.outDir = val();
    else if (a === '--previous-dir') o.previousDir = val();
    else if (a === '--site-dir') o.siteDir = val();
    else throw new Error(`unknown argument ${a}`);
  }
  o.outDir = resolve(o.outDir);
  o.siteDir = resolve(o.siteDir);
  if (o.previousDir) o.previousDir = resolve(o.previousDir);
  return o;
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const o = parseArgs(argv, env);
  const repoUrl = env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}` : '';
  const log = (...a) => console.log(...a);
  log(`Site: from ${o.outDir}${o.previousDir ? ` (else ${o.previousDir})` : ''} into ${o.siteDir}`);
  const r = await assembleSite({ ...o, repoUrl, log });
  log(`Site ready: ${r.published.map((p) => p.code).join(', ')}${r.left.length ? `; left out ${r.left.map((l) => l.code).join(', ')}` : ''}`);
  return 0;
}

const sameFile = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
const invokedDirectly = Boolean(process.argv[1]) && sameFile(resolve(process.argv[1]), fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main().then((code) => { process.exitCode = code; }, (err) => { console.error(`Site: ${err.message}`); process.exitCode = 1; });
}
