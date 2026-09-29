// Settings for the 24 hour Sun movie. Everything a person might want to
// change lives here.
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

/** The repository root (this file lives in src/). */
export const ROOT = fileURLToPath(new URL('../', import.meta.url));

// ---- channels ----
// 171 (Quiet Corona) is the channel NASA's own rolling 24 hour movie used.
// sourceId is Helioviewer's datasource id, from
// https://api.helioviewer.org/docs/v2/appendix/data_sources.html
// (checked 2026-09-29: sourceId 10 answers "AIA 171", 13 answers "AIA 304").
// crfStart is the first CRF tried: 304 is full of fine texture and needs a
// higher CRF for the same size (2026-09-29: CRF 18 gave 7.5 MB for 171 and
// 20.3 MB for 304; CRF 26 gave 4.2 MB for 304).
export const CHANNELS = Object.freeze([
  Object.freeze({ code: '171', sourceId: 10, name: 'AIA 171', crfStart: 18 }),
  Object.freeze({ code: '304', sourceId: 13, name: 'AIA 304', crfStart: 23 }),
]);

// ---- the 24 hour window ----
export const SLOT_SECONDS = 300; // one frame every 5 minutes
export const SLOT_COUNT = 288; // 24 hours of 5 minute slots
// A slot takes the frame closest to it only when that frame is within half a
// slot, so one frame can never fill two slots. Helioviewer keeps AIA frames
// about every 36 seconds, so a normal slot is matched within about 20 seconds.
export const MATCH_TOLERANCE_SECONDS = SLOT_SECONDS / 2;
// Frames older than this (before the newest frame) are pruned from the cache.
export const KEEP_SECONDS = (24 + 3) * 3600;
// Hard ceiling for one channel's frame cache on disk. The 27 hour window above
// holds about 324 frames (about 31 MB for 171, 41 MB for 304), so this is
// only reached if something goes wrong; the oldest frames go first.
export const CACHE_MAX_BYTES_PER_CHANNEL = 120 * 1024 * 1024;

// ---- checks ----
export const MAX_NEWEST_AGE_SECONDS = 3 * 3600; // fail the run past this
export const MIN_FRAMES = SLOT_COUNT / 2; // fail with fewer real frames than this
// A movie whose newest frame is older than this is stale. The app and the
// site use the same limit; the publish step never carries a stale movie over.
export const STALE_AFTER_SECONDS = 6 * 3600;

// ---- the movie ----
export const SIZE_PX = 1024;
export const FPS = 24; // 288 frames at 24 fps = 12 seconds
export const TARGET_MIN_BYTES = 5 * 1024 * 1024;
export const TARGET_MAX_BYTES = 10 * 1024 * 1024;
// Start at the channel's crfStart (else CRF_START) and search until the file
// lands between the two sizes above, never outside CRF_MIN..CRF_MAX and at
// most MAX_ENCODES encodes (see nextCrf in encode.mjs).
export const CRF_START = 18;
export const CRF_MIN = 12;
export const CRF_MAX = 32;
export const MAX_ENCODES = 5;
export const X264_PRESET = 'slow';
export const KEYFRAME_EVERY = 48; // a keyframe every 2 seconds, for seeking

// ---- the time printed on each frame ----
// PLACEHOLDER (new visual, awaiting approval): the label's font, size, colour
// and place, the "2026-09-29 03:44 UTC" wording, and the CREDIT line below.
// The printed time is the capture time rounded to the nearest minute; the
// manifest keeps the exact capture times.
export const FONT_FILE = join(ROOT, 'fonts', 'Roboto-Regular.ttf'); // Apache 2.0, see fonts/LICENSE-Roboto.txt
export const LABEL_SIZE = 20; // px, on the 1024 px frame
export const LABEL_MARGIN = 16; // px from the left and bottom edges
export const LABEL_COLOR = 'white@0.85';

// ---- brightness ----
// "nasa" (the default, decided 2026-09-29): each frame goes through a fixed
// curve per colour channel that makes it as bright as NASA's own SDO browse
// image of the same instant. The curves are fitted by
// tools/fit-brightness.mjs and stored in brightness/. Nothing else changes:
// same frames, same times, same colour table.
// "off": Helioviewer's frames exactly as they come (a little darker).
// Choose with --brightness, or SUN_MOVIE_BRIGHTNESS in the environment.
export const BRIGHTNESS_MODES = Object.freeze(['nasa', 'off']);
export const DEFAULT_BRIGHTNESS = 'nasa';
export const BRIGHTNESS_DIR = join(ROOT, 'brightness');
export const brightnessLut = (code) => join(BRIGHTNESS_DIR, `aia-${code}.cube`);

// ---- files ----
export const DEFAULT_CACHE_DIR = join(ROOT, '.cache'); // gitignored
export const DEFAULT_OUT_DIR = join(ROOT, 'out'); // gitignored
export const DEFAULT_SITE_DIR = join(ROOT, 'site'); // gitignored
export const movieName = (code) => `sun-24h-${code}.mp4`;
export const manifestName = (code) => `sun-24h-${code}.json`;

export const CREDIT = 'NASA/SDO and the AIA science team, via Helioviewer.org';

// ---- Helioviewer ----
// API v2 docs: https://api.helioviewer.org/docs/v2/
//  - getClosestImage (date, sourceId) returns the frame closest to a time with
//    its id and observation date:
//    https://api.helioviewer.org/docs/v2/api/api_groups/official_clients.html
//  - downloadImage (id, width, type) returns that frame coloured with the
//    standard AIA colour table, here 1024 px JPEG (about 95 KB):
//    https://api.helioviewer.org/docs/v2/api/api_groups/jpeg2000.html
// Why downloadImage and not takeScreenshot or getJP2Image: takeScreenshot
// (layers [SDO,AIA,AIA,171,1,100], x0=0&y0=0) renders the same colours but
// returns a 900 KB PNG and stores a screenshot record on their server for
// every call; getJP2Image sends the 4096 px JPEG 2000 file (megabytes) and we
// would have to colour it ourselves with the same table Helioviewer uses.
// downloadImage is the lightest request that gives the standard colours at
// 1024 px, and the server caches the result.
// The IAS mirror in France has its own ids and returns byte-identical images
// (checked 2026-09-29); it is used only when the main server fails.
export const SERVERS = Object.freeze([
  Object.freeze({ name: 'api.helioviewer.org', base: 'https://api.helioviewer.org/v2' }),
  Object.freeze({ name: 'helioviewer-api.ias.u-psud.fr', base: 'https://helioviewer-api.ias.u-psud.fr/v2' }),
]);
export const USER_AGENT = 'LumaraSunMovie/1.1 (+https://lumara-space.app; plain ffmpeg 24 hour Sun movie, one frame per 5 minutes)';
// Politeness: one request at a time, at least MIN_GAP_MS between request starts.
export const MIN_GAP_MS = 300;
export const REQUEST_TIMEOUT_MS = 60_000;
export const RETRIES = 4; // attempts per server, with backoff
export const BACKOFF_BASE_MS = 2_000; // 2 s, 4 s, 8 s, plus jitter
// After this many requests in a row fail on one server, stop asking it for the
// rest of the run.
export const SERVER_FAILS_BEFORE_SWITCH = 5;
export const MIN_FRAME_BYTES = 10_000; // a real 1024 px frame is about 95 KB

// ---- NASA's own images (only for fitting the "nasa" brightness curves) ----
// NASA SDO's browse archive: one directory per day, files named
// YYYYMMDD_HHMMSS_1024_<channel>.jpg with the capture time in the name. It
// runs about half a day behind, which is fine for fitting a fixed curve.
export const NASA_BROWSE_BASE = 'https://sdo.gsfc.nasa.gov/assets/img/browse';
// NASA prints its own label along the bottom of the browse image; rows from
// here down are left out when comparing brightness.
export const NASA_LABEL_TOP_PX = 940;
