// The 24 hour frame set for one channel: 288 slots, 5 minutes apart, ending at
// the newest frame Helioviewer has. Frames are cached on disk by their own
// capture time, so a run downloads only the slots it has not filled before.
// A slot with no real frame near it stays empty and is logged. Nothing is
// ever duplicated, interpolated or invented to fill a gap.
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, statSync, readdirSync, unlinkSync } from 'node:fs';
import { join, basename } from 'node:path';
import {
  SLOT_SECONDS, SLOT_COUNT, MATCH_TOLERANCE_SECONDS, KEEP_SECONDS, MIN_FRAME_BYTES, CACHE_MAX_BYTES_PER_CHANNEL,
} from './config.mjs';

const INDEX_VERSION = 1;
const FRAME_FILE_RE = /^\d{8}T\d{6}Z\.jpg$/;

/** "2026-09-29T00:05:09Z": exact to the second, as Helioviewer gives it. */
export const iso = (d) => new Date(Math.floor(d.getTime() / 1000) * 1000).toISOString().replace('.000Z', 'Z');

/** The same instant rounded to the nearest minute (30 s and up rounds up). */
export const roundToMinute = (d) => new Date(Math.round(d.getTime() / 60_000) * 60_000);

/** Cache file name for a frame, from its capture time: 20260929T000509Z.jpg */
export const frameFileName = (d) => iso(d).replace(/[-:]/g, '') + '.jpg';

/**
 * The text printed on the frame: "2026-09-29 00:05 UTC", the capture time in
 * UTC rounded to the nearest minute (03:54:57 prints as 03:55), the same rule
 * the app and the site use. The manifest keeps the exact times.
 */
export function frameLabel(d) {
  const s = iso(roundToMinute(d));
  return `${s.slice(0, 10)} ${s.slice(11, 16)} UTC`;
}

/**
 * The slot times, oldest first: SLOT_COUNT slots on the 5 minute grid, the
 * last one at or just before the newest frame.
 */
export function slotTimes(newest, { slotSeconds = SLOT_SECONDS, count = SLOT_COUNT } = {}) {
  const endS = Math.floor(newest.getTime() / 1000 / slotSeconds) * slotSeconds;
  const out = [];
  for (let k = count - 1; k >= 0; k--) out.push(new Date((endS - k * slotSeconds) * 1000));
  return out;
}

/** True when a frame taken at `frame` may fill the slot at `slot`. */
export const matchesSlot = (slot, frame, tolerance = MATCH_TOLERANCE_SECONDS) =>
  Math.abs(frame.getTime() - slot.getTime()) <= tolerance * 1000;

// ---- the on-disk index: slot -> frame ----
export function loadIndex(dir, code) {
  const p = join(dir, 'index.json');
  if (!existsSync(p)) return { version: INDEX_VERSION, channel: code, slots: {} };
  try {
    const j = JSON.parse(readFileSync(p, 'utf8'));
    if (j.version !== INDEX_VERSION || j.channel !== code || typeof j.slots !== 'object') throw new Error('unexpected shape');
    return j;
  } catch (err) {
    // A broken index only costs a re-check of each slot; frames on disk stay.
    return { version: INDEX_VERSION, channel: code, slots: {}, note: `index rebuilt: ${err.message}` };
  }
}

export function saveIndex(dir, index) {
  const p = join(dir, 'index.json');
  const tmp = `${p}.tmp`;
  const sorted = Object.fromEntries(Object.entries(index.slots).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(tmp, JSON.stringify({ version: INDEX_VERSION, channel: index.channel, slots: sorted }, null, 1) + '\n');
  renameSync(tmp, p);
}

function writeAtomic(path, buffer) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, buffer);
  renameSync(tmp, path);
}

function usableFile(path) {
  try { return statSync(path).size >= MIN_FRAME_BYTES; } catch { return false; }
}

/**
 * Keep one channel's cache under a hard size ceiling: forget the oldest slots
 * until the frames they point at fit. Returns the slot keys dropped.
 */
export function capIndex(dir, index, maxBytes = CACHE_MAX_BYTES_PER_CHANNEL) {
  const sizeOf = (file) => { try { return statSync(join(dir, file)).size; } catch { return 0; } };
  const keys = Object.keys(index.slots).sort(); // ISO keys sort oldest first
  let total = 0;
  const sizes = new Map();
  for (const k of keys) {
    const s = sizeOf(index.slots[k].file);
    sizes.set(k, s);
    total += s;
  }
  const dropped = [];
  for (const k of keys) {
    if (total <= maxBytes) break;
    total -= sizes.get(k);
    delete index.slots[k];
    dropped.push(k);
  }
  return dropped;
}

/**
 * Fill the 24 hour window for one channel.
 * @returns {Promise<{frames:{slot:Date,date:Date,file:string}[], missing:{slot:Date,why:string}[],
 *   newestKnown:Date, fetched:number, reused:number, pruned:number}>}
 */
export async function collectFrames({ channel, cacheDir, client, now = new Date(), log = () => {}, maxCacheBytes = CACHE_MAX_BYTES_PER_CHANNEL }) {
  const dir = join(cacheDir, channel.code);
  mkdirSync(dir, { recursive: true });
  const index = loadIndex(dir, channel.code);
  if (index.note) log(`  ${index.note}`);

  // 1. Where the window ends: the newest frame any server has.
  const newestInfo = await client.newest(channel.sourceId, now);
  const newestKnown = newestInfo.date.getTime() > now.getTime() ? now : newestInfo.date;
  const slots = slotTimes(newestKnown);
  log(`  newest frame on ${newestInfo.server.name}: ${iso(newestInfo.date)}; window ${iso(slots[0])} to ${iso(slots[slots.length - 1])}`);

  const frames = [];
  const missing = [];
  const used = new Set(); // capture times already in the movie
  let fetched = 0;
  let reused = 0;

  for (const slot of slots) {
    const key = iso(slot);
    const known = index.slots[key];
    if (known && FRAME_FILE_RE.test(known.file) && usableFile(join(dir, known.file))) {
      const date = new Date(known.date);
      if (!used.has(known.date) && matchesSlot(slot, date)) {
        used.add(known.date);
        frames.push({ slot, date, file: join(dir, known.file) });
        reused++;
        continue;
      }
    }
    delete index.slots[key];

    // 2. Ask each live server in turn: which frame is closest to this slot,
    // then download that frame from the same server (ids differ per server).
    let filled = false;
    let why = '';
    for (const server of client.liveServers()) {
      let info;
      try {
        info = await client.closestOn(server, channel.sourceId, slot);
      } catch (err) {
        why = `${server.name}: ${err.message}`;
        continue;
      }
      if (!matchesSlot(slot, info.date)) {
        // The server answered; there is simply no frame near this slot.
        why = `nearest frame is ${iso(info.date)}`;
        break;
      }
      const dateKey = iso(info.date);
      if (used.has(dateKey)) { why = `nearest frame ${dateKey} already fills another slot`; break; }
      const file = frameFileName(info.date);
      const path = join(dir, file);
      if (!usableFile(path)) {
        try {
          writeAtomic(path, await client.downloadOn(server, info.id));
          fetched++;
        } catch (err) {
          why = `${server.name}: download of ${dateKey} failed: ${err.message}`;
          continue;
        }
      } else {
        reused++;
      }
      index.slots[key] = { date: dateKey, file };
      used.add(dateKey);
      frames.push({ slot, date: info.date, file: path });
      filled = true;
      break;
    }
    if (!filled) {
      missing.push({ slot, why: why || 'no server left to ask' });
      log(`  missing ${key}: ${why || 'no server left to ask'}`);
    }
  }

  // 3. Forget and delete what fell out of the kept window, then hold the
  // cache under its hard size ceiling.
  const keepFrom = newestKnown.getTime() - KEEP_SECONDS * 1000;
  for (const [key, v] of Object.entries(index.slots)) {
    if (new Date(key).getTime() < keepFrom) delete index.slots[key];
    else if (!FRAME_FILE_RE.test(v.file)) delete index.slots[key];
  }
  const capped = capIndex(dir, index, maxCacheBytes);
  if (capped.length) log(`  cache over ${Math.round(maxCacheBytes / 1048576)} MB: dropped the ${capped.length} oldest slots`);
  const referenced = new Set(Object.values(index.slots).map((v) => v.file));
  let pruned = 0;
  for (const name of readdirSync(dir)) {
    const stale = (FRAME_FILE_RE.test(name) && !referenced.has(name)) || name.endsWith('.jpg.tmp');
    if (stale) { unlinkSync(join(dir, name)); pruned++; }
  }
  saveIndex(dir, index);

  // A capped slot is gone from disk too, so it cannot be in this movie.
  const kept = frames.filter((f) => referenced.has(basename(f.file)));
  kept.sort((a, b) => a.date - b.date);
  return { frames: kept, missing, newestKnown: newestInfo.date, fetched, reused, pruned };
}
