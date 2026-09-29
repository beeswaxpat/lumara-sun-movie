// A small, polite Helioviewer API v2 client: one request at a time, a fixed
// gap between requests, retries with backoff, and a switch to the mirror when
// the main server keeps failing. Node built-ins only.
//
// Endpoints (docs cited in config.mjs):
//   GET {base}/getClosestImage/?date=<ISO>&sourceId=<n>
//     -> {"id":"192537488","date":"2026-09-29 00:05:09","name":"AIA 171",...}
//   GET {base}/downloadImage/?id=<id>&width=1024&type=jpg
//     -> image/jpeg, the frame with the standard AIA colour table
import {
  SERVERS, USER_AGENT, MIN_GAP_MS, REQUEST_TIMEOUT_MS, RETRIES, BACKOFF_BASE_MS,
  SERVER_FAILS_BEFORE_SWITCH, SIZE_PX, MIN_FRAME_BYTES,
} from './config.mjs';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** ISO 8601 UTC to the second, the form Helioviewer's `date` wants. */
export function isoSeconds(date) {
  return new Date(Math.floor(date.getTime() / 1000) * 1000).toISOString().replace('.000Z', 'Z');
}

/**
 * Helioviewer answers dates as "2026-09-29 00:05:09" (UTC, no zone).
 * Returns a Date, or null for anything else.
 */
export function parseHelioviewerDate(s) {
  if (typeof s !== 'string') return null;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(\.\d+)?Z?$/);
  if (!m) return null;
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], m[7] ? Math.round(parseFloat(m[7]) * 1000) : 0);
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Width and height from a baseline or progressive JPEG, or null if it is not a whole JPEG. */
export function jpegSize(buf) {
  if (!buf || buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  // The file must end with the EOI marker (a cut download does not).
  let end = buf.length;
  while (end > 2 && buf[end - 1] === 0x00) end--;
  if (buf[end - 2] !== 0xff || buf[end - 1] !== 0xd9) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1];
    if (marker === 0xff) { i++; continue; }
    const len = buf.readUInt16BE(i + 2);
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  return null;
}

export class HttpError extends Error {
  constructor(message, { status = 0, retryable = true, retryAfterMs = 0 } = {}) {
    super(message);
    this.status = status;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}

export class HelioviewerClient {
  /**
   * @param {object} [o]
   * @param {Array<{name:string,base:string}>} [o.servers]
   * @param {typeof fetch} [o.fetchImpl]   injected in tests
   * @param {(ms:number)=>Promise<void>} [o.sleepImpl]
   * @param {(...a:any[])=>void} [o.log]
   */
  constructor({
    servers = SERVERS, fetchImpl = globalThis.fetch, sleepImpl = sleep, log = () => {},
    minGapMs = MIN_GAP_MS, retries = RETRIES, backoffBaseMs = BACKOFF_BASE_MS,
    timeoutMs = REQUEST_TIMEOUT_MS, failsBeforeSwitch = SERVER_FAILS_BEFORE_SWITCH,
  } = {}) {
    Object.assign(this, { servers, fetchImpl, sleepImpl, log, minGapMs, retries, backoffBaseMs, timeoutMs, failsBeforeSwitch });
    this.lastStart = 0;
    this.failStreak = new Map(); // server name -> failures in a row
    this.down = new Set(); // servers not asked again this run
    this.stats = { requests: 0, retries: 0, failedRequests: 0, bytes: 0, byServer: {} };
  }

  liveServers() {
    return this.servers.filter((s) => !this.down.has(s.name));
  }

  async throttle() {
    const wait = this.lastStart + this.minGapMs - Date.now();
    if (wait > 0) await this.sleepImpl(wait);
    this.lastStart = Date.now();
  }

  noteResult(server, ok) {
    if (ok) { this.failStreak.set(server.name, 0); return; }
    const n = (this.failStreak.get(server.name) || 0) + 1;
    this.failStreak.set(server.name, n);
    if (n >= this.failsBeforeSwitch && !this.down.has(server.name)) {
      this.down.add(server.name);
      this.log(`  ${server.name}: ${n} failures in a row, not asking it again this run`);
    }
  }

  /** One GET with retries. Resolves to {buffer, headers}; throws HttpError after the last try. */
  async get(server, url, expect) {
    let lastErr;
    for (let attempt = 1; attempt <= this.retries; attempt++) {
      await this.throttle();
      this.stats.requests++;
      this.stats.byServer[server.name] = (this.stats.byServer[server.name] || 0) + 1;
      try {
        const res = await this.fetchImpl(url, {
          headers: { 'User-Agent': USER_AGENT, Accept: expect === 'json' ? 'application/json' : expect === 'html' ? 'text/html' : 'image/jpeg' },
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (!res.ok) {
          const retryAfter = Number(res.headers.get('retry-after'));
          const retryable = res.status === 408 || res.status === 429 || res.status >= 500;
          throw new HttpError(`HTTP ${res.status}`, {
            status: res.status, retryable,
            retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 60) * 1000 : 0,
          });
        }
        const buffer = Buffer.from(await res.arrayBuffer());
        this.stats.bytes += buffer.length;
        return { buffer, headers: res.headers };
      } catch (err) {
        lastErr = err instanceof HttpError ? err : new HttpError(err?.name === 'TimeoutError' ? 'timed out' : String(err?.message || err));
        if (!lastErr.retryable || attempt === this.retries) break;
        this.stats.retries++;
        const backoff = lastErr.retryAfterMs || this.backoffBaseMs * 2 ** (attempt - 1) + Math.floor(Math.random() * 500);
        this.log(`  ${server.name}: ${lastErr.message}, retry ${attempt} of ${this.retries - 1} in ${Math.round(backoff / 1000)} s`);
        await this.sleepImpl(backoff);
      }
    }
    this.stats.failedRequests++;
    throw lastErr;
  }

  /**
   * The frame closest to `date` on one server: {server, id, date} or throws.
   * A malformed answer counts as a failure of that server.
   */
  async closestOn(server, sourceId, date) {
    const url = `${server.base}/getClosestImage/?date=${isoSeconds(date)}&sourceId=${sourceId}`;
    try {
      const { buffer } = await this.get(server, url, 'json');
      let body;
      try { body = JSON.parse(buffer.toString('utf8')); } catch { throw new HttpError('not JSON', { retryable: false }); }
      const when = parseHelioviewerDate(body?.date);
      const id = body?.id != null ? String(body.id) : '';
      if (!when || !/^\d+$/.test(id)) {
        throw new HttpError(`no frame in the answer (${String(body?.error || body?.message || 'no id or date').slice(0, 80)})`, { retryable: false });
      }
      this.noteResult(server, true);
      return { server, id, date: when };
    } catch (err) {
      this.noteResult(server, false);
      throw err;
    }
  }

  /** The 1024 px JPEG for a frame id on the server that gave the id. Validated. */
  async downloadOn(server, id) {
    const url = `${server.base}/downloadImage/?id=${id}&width=${SIZE_PX}&type=jpg`;
    try {
      const { buffer } = await this.get(server, url, 'image');
      const size = jpegSize(buffer);
      if (buffer.length < MIN_FRAME_BYTES || !size) {
        throw new HttpError(`not a whole JPEG (${buffer.length} bytes)`, { retryable: false });
      }
      if (size.width !== SIZE_PX || size.height !== SIZE_PX) {
        throw new HttpError(`frame is ${size.width}x${size.height}, wanted ${SIZE_PX}x${SIZE_PX}`, { retryable: false });
      }
      this.noteResult(server, true);
      return buffer;
    } catch (err) {
      this.noteResult(server, false);
      throw err;
    }
  }

  /**
   * The newest frame each live server knows, first server that answers wins:
   * getClosestImage for "now" returns the newest frame it has.
   */
  async newest(sourceId, now = new Date()) {
    const errors = [];
    for (const server of this.liveServers()) {
      try {
        return await this.closestOn(server, sourceId, now);
      } catch (err) {
        errors.push(`${server.name}: ${err.message}`);
      }
    }
    throw new Error(`no server answered for the newest frame (${errors.join('; ') || 'every server is down'})`);
  }
}
