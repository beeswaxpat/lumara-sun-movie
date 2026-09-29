// NASA SDO browse images and their Helioviewer twins, for the brightness
// tools only (the movie itself never asks NASA for anything).
//
// NASA's browse archive has one directory per UTC day,
//   https://sdo.gsfc.nasa.gov/assets/img/browse/2026/09/28/
// with files named 20260928_105634_1024_0171.jpg: capture time, size,
// channel. For each such file the Helioviewer frame closest to that time is
// the same instant (AIA takes a 171 or 304 picture every 12 seconds;
// Helioviewer keeps one about every 36 seconds).
import { mkdirSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { NASA_BROWSE_BASE, SIZE_PX, MIN_FRAME_BYTES } from '../src/config.mjs';
import { jpegSize } from '../src/helioviewer.mjs';
import { iso } from '../src/frames.mjs';

export const NASA_SERVER = Object.freeze({ name: 'sdo.gsfc.nasa.gov', base: NASA_BROWSE_BASE });
export const MAX_PAIR_SECONDS = 30;

const pad = (n) => String(n).padStart(2, '0');
export const dayPath = (d) => `${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}`;

/** 4 digit NASA channel code: "171" -> "0171". */
export const nasaCode = (code) => code.padStart(4, '0');

/** Browse file names for one channel in a directory listing, with their capture times, oldest first. */
export function parseListing(html, code) {
  const re = new RegExp(`(\\d{4})(\\d{2})(\\d{2})_(\\d{2})(\\d{2})(\\d{2})_${SIZE_PX}_${nasaCode(code)}\\.jpg`, 'g');
  const seen = new Map();
  for (const m of String(html).matchAll(re)) {
    const date = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
    seen.set(m[0], date);
  }
  return [...seen].map(([name, date]) => ({ name, date })).sort((a, b) => a.date - b.date);
}

export const browseUrl = (f) => `${NASA_BROWSE_BASE}/${dayPath(f.date)}/${f.name}`;

/** Every browse file for a channel over the last `days` UTC days (today included), oldest first. */
export async function listBrowse(client, code, { days = 3, now = new Date(), listings = new Map() } = {}) {
  const out = [];
  for (let k = days - 1; k >= 0; k--) {
    const d = new Date(now.getTime() - k * 86400_000);
    const url = `${NASA_BROWSE_BASE}/${dayPath(d)}/`;
    if (!listings.has(url)) {
      try {
        const { buffer } = await client.get(NASA_SERVER, url, 'html');
        listings.set(url, buffer.toString('utf8'));
      } catch {
        listings.set(url, ''); // a missing day (the archive runs behind) is not an error
      }
    }
    out.push(...parseListing(listings.get(url), code));
  }
  return out;
}

async function saveJpeg(path, buffer) {
  const size = jpegSize(buffer);
  if (buffer.length < MIN_FRAME_BYTES || !size || size.width !== SIZE_PX || size.height !== SIZE_PX) {
    throw new Error(`${path}: not a whole ${SIZE_PX} px JPEG`);
  }
  writeFileSync(path, buffer);
}

/**
 * The Helioviewer frame for a NASA browse file: {nasa, hv:{server,id,date}, deltaSeconds}.
 * Asks the main server, then the mirror.
 */
export async function twinFor(client, channel, nasaFile) {
  let lastErr;
  for (const server of client.liveServers()) {
    try {
      const hv = await client.closestOn(server, channel.sourceId, nasaFile.date);
      return { nasa: nasaFile, hv, deltaSeconds: Math.round((hv.date - nasaFile.date) / 1000) };
    } catch (err) { lastErr = err; }
  }
  throw lastErr || new Error('no Helioviewer server left');
}

/** Download both images of a pair into dir (kept if already there). Returns {nasaPath, hvPath}. */
export async function fetchPair(client, pair, dir) {
  mkdirSync(dir, { recursive: true });
  const stamp = iso(pair.nasa.date).replace(/[-:]/g, '');
  const nasaPath = join(dir, `nasa_${stamp}.jpg`);
  const hvPath = join(dir, `helioviewer_${iso(pair.hv.date).replace(/[-:]/g, '')}.jpg`);
  const have = (p) => existsSync(p) && statSync(p).size >= MIN_FRAME_BYTES;
  if (!have(nasaPath)) {
    const { buffer } = await client.get(NASA_SERVER, browseUrl(pair.nasa), 'image');
    await saveJpeg(nasaPath, buffer);
  }
  if (!have(hvPath)) await saveJpeg(hvPath, await client.downloadOn(pair.hv.server, pair.hv.id));
  return { nasaPath, hvPath };
}
