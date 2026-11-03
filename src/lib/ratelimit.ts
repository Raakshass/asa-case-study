/**
 * Tiny in-memory limiter for POST /api/runs (IMPLEMENTATION_PLAN.md section 6.7): at most
 * CONFIG.rateLimitPerIpPerMinute (10) runs per IP per rolling minute and ENV.maxRunsPerHour runs per
 * rolling hour globally. Process-local: resets on restart (the OpenRouter key credit limit is the backstop).
 *
 * OWNER: Phase 5. Every exported signature of docs/CONTRACTS.md is kept; `rateLimiterSize`, `refundGlobalSlot`, the
 * options argument of `checkRateLimit`, `takeGlobalSlot`, `beginUpload` and `uploadsInFlight` are additive.
 *
 * Both windows are sliding (each allowed call is remembered with its time), only ALLOWED calls are remembered,
 * so a client that keeps hammering while limited never extends its own lockout and the Retry-After it was
 * given is truthful. Memory is bounded: expired entries are dropped as they are met and by a sweep once a
 * minute, at most MAX_TRACKED_IPS distinct addresses are kept (the least recently allowed one goes first), and
 * the global list never grows past the hourly cap because a full list rejects. State lives on globalThis so the
 * per-route module copies and dev hot reloads share one limiter.
 *
 * Fix round, security SEC-6: POST /api/runs checks the hourly cap at the door without taking a slot
 * (`{ recordGlobal: false }`) and takes it with takeGlobalSlot once the body has arrived, right before the run is
 * created, so an upload that stalls holds no hourly slot. beginUpload caps the uploads in progress at once, per
 * address (same buckets as the limiter) and in all.
 */
import { CONFIG, ENV } from "./config";
import { UPLOAD_BUSY_PREFIXES } from "./types";

export interface RateLimitResult {
  ok: boolean;
  /** 0 when ok; else seconds until the oldest counted request leaves the window (>= 1), for Retry-After */
  retryAfterSec: number;
  /** "" when ok; else a friendly sentence for the 429 body, e.g. "Too many runs from your address. Try again in 42 s." */
  message: string;
  /** which limit tripped */
  scope: "ip" | "global" | null;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
/** Distinct addresses remembered at once (a spoofed-header flood cannot grow the map without bound). */
const MAX_TRACKED_IPS = 10_000;
const MAX_IP_CHARS = 100;

interface LimiterState {
  /** per address: the times (ms, ascending) of its allowed calls inside the last minute */
  perIp: Map<string, number[]>;
  /** the times (ms, ascending) of every allowed call inside the last hour */
  global: number[];
  lastSweep: number;
}
type GlobalWithLimiter = typeof globalThis & { __invoiceApRateLimiter?: LimiterState };

function state(): LimiterState {
  const g = globalThis as GlobalWithLimiter;
  g.__invoiceApRateLimiter ??= { perIp: new Map(), global: [], lastSweep: 0 };
  return g.__invoiceApRateLimiter;
}

/** Drops the entries (ascending list) that have left the window ending at `now`. */
function prune(times: number[], now: number, windowMs: number): void {
  let expired = 0;
  while (expired < times.length && times[expired] <= now - windowMs) expired++;
  if (expired > 0) times.splice(0, expired);
}

/** Removes every address whose newest allowed call is out of the window. */
function sweep(s: LimiterState, now: number): void {
  for (const [ip, times] of s.perIp) {
    prune(times, now, MINUTE_MS);
    if (times.length === 0) s.perIp.delete(ip);
  }
  s.lastSweep = now;
}

/** Whole seconds until `oldest` leaves a window of `windowMs`, never less than 1. */
function waitSeconds(oldest: number, windowMs: number, now: number): number {
  return Math.max(1, Math.ceil((oldest + windowMs - now) / 1000));
}

function describeWait(sec: number): string {
  return sec < 120 ? `${sec} s` : `${Math.ceil(sec / 60)} min`;
}

/**
 * "2001:db8:1:2::/64" for an IPv6 address (brackets and a zone id are ignored), the IPv4 address for an IPv4-mapped
 * one ("::ffff:1.2.3.4" -> "1.2.3.4"), null for anything that is not IPv6. One subscriber usually holds a whole /64,
 * so per-address buckets would give a single client 2^64 of them (red team RT-PIPE-03).
 */
function ipv6Bucket(raw: string): string | null {
  const s = raw.replace(/^\[/, "").replace(/\](?::\d+)?$/, "").split("%")[0];
  if (!s.includes(":")) return null;
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const part = (h: string): string[] => (h === "" ? [] : h.split(":"));
  const head = part(halves[0]);
  const tail = halves.length === 2 ? part(halves[1]) : [];
  // a dotted IPv4 at the end ("::ffff:1.2.3.4") stands for the last two groups
  const end = tail.length > 0 ? tail : head;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(end[end.length - 1] ?? "");
  if (v4) {
    const n = v4.slice(1).map(Number);
    if (n.some((x) => x > 255)) return null;
    end.splice(end.length - 1, 1, ((n[0] << 8) | n[1]).toString(16), ((n[2] << 8) | n[3]).toString(16));
  }
  const fill = 8 - head.length - tail.length;
  if (halves.length === 1 ? fill !== 0 : fill < 1) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? fill : 0).fill("0"), ...tail];
  if (!groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  const num = groups.map((g) => Number.parseInt(g, 16));
  if (num.slice(0, 5).every((x) => x === 0) && num[5] === 0xffff) return [num[6] >> 8, num[6] & 255, num[7] >> 8, num[7] & 255].join(".");
  return `${num.slice(0, 4).map((x) => x.toString(16)).join(":")}::/64`;
}

/** The bucket of an address: case and spaces ignored, an IPv4 port dropped, IPv6 by /64 (see ipv6Bucket). */
function normalizeIp(ip: string): string {
  const key = String(ip).trim().toLowerCase().slice(0, MAX_IP_CHARS);
  if (key === "") return "unknown";
  const v4WithPort = /^(\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}$/.exec(key);
  if (v4WithPort) return v4WithPort[1];
  return ipv6Bucket(key) ?? key;
}

/** The refusal of a full hourly cap: the wait until its oldest slot leaves the hour. */
function hourlyRefusal(s: LimiterState, hourLimit: number, t: number): RateLimitResult {
  const wait = waitSeconds(s.global[0], HOUR_MS, t);
  return {
    ok: false,
    retryAfterSec: wait,
    message: `The demo has reached its limit of ${hourLimit} runs per hour. Try again in ${describeWait(wait)}.`,
    scope: "global",
  };
}

export interface RateLimitOptions {
  /**
   * false: the hourly cap is checked but no slot is taken (the per-address call is still recorded); the caller takes
   * the slot with takeGlobalSlot once the request is about to create a run. Default true: both are recorded.
   */
  recordGlobal?: boolean;
}

/**
 * Checks AND records one attempt for `ip` at `now` (ms since epoch, default Date.now()). Only allowed
 * attempts are recorded, so a client stuck at 429 does not extend its window. The caller derives ip from the
 * request (the route uses x-real-ip, else the last x-forwarded-for entry, else "unknown"; spoofable without a
 * trusted proxy, which is why the global hourly cap exists) and gives the global slot back with refundGlobalSlot
 * when the request then creates no run. IPv6 addresses share one bucket per /64. When both limits trip, the one
 * that frees up last is reported, so retryAfterSec is the wait after which this call would pass.
 * With `{ recordGlobal: false }` (what POST /api/runs passes, SEC-6) the hourly cap is only read here: a full hour is
 * still refused before the body is read, but an allowed call holds no hourly slot until takeGlobalSlot.
 */
export function checkRateLimit(ip: string, now: number = Date.now(), opts: RateLimitOptions = {}): RateLimitResult {
  const t = Number.isFinite(now) ? now : Date.now();
  const s = state();
  const key = normalizeIp(ip);
  if (t - s.lastSweep >= MINUTE_MS || t < s.lastSweep) sweep(s, t);

  const hits = s.perIp.get(key);
  if (hits) prune(hits, t, MINUTE_MS);
  prune(s.global, t, HOUR_MS);

  const perIpLimit = CONFIG.rateLimitPerIpPerMinute;
  const hourLimit = ENV.maxRunsPerHour;
  const ipFull = hits !== undefined && hits.length >= perIpLimit;
  const globalFull = s.global.length >= hourLimit;

  if (ipFull || globalFull) {
    if (hits !== undefined && hits.length === 0) s.perIp.delete(key);
    const ipWait = ipFull && hits ? waitSeconds(hits[0], MINUTE_MS, t) : 0;
    const globalWait = globalFull ? waitSeconds(s.global[0], HOUR_MS, t) : 0;
    if (ipWait >= globalWait) {
      return {
        ok: false,
        retryAfterSec: ipWait,
        message: `Too many runs from your address. Try again in ${describeWait(ipWait)}.`,
        scope: "ip",
      };
    }
    return hourlyRefusal(s, hourLimit, t);
  }

  // allowed: remember it (least recently allowed address first, so the map order is the eviction order)
  s.perIp.delete(key);
  if (s.perIp.size >= MAX_TRACKED_IPS) {
    sweep(s, t);
    for (const oldest of s.perIp.keys()) {
      if (s.perIp.size < MAX_TRACKED_IPS) break;
      s.perIp.delete(oldest);
    }
  }
  const times = hits ?? [];
  times.push(t);
  s.perIp.set(key, times);
  if (opts.recordGlobal !== false) s.global.push(t);
  return { ok: true, retryAfterSec: 0, message: "", scope: null };
}

/**
 * Takes one slot of the hourly cap at `now` (ms since epoch, default Date.now()) when one is free, for a request that
 * passed checkRateLimit(..., { recordGlobal: false }) and is about to create a run (SEC-6: an upload still arriving
 * holds no slot). The cap is checked again here, because other requests may have taken the last slot since the door:
 * refused, it answers like checkRateLimit's hourly refusal (scope "global", the truthful wait) and records nothing.
 * The per-address window is not touched. Give the slot back with refundGlobalSlot(now) if no run is created after all.
 */
export function takeGlobalSlot(now: number = Date.now()): RateLimitResult {
  const t = Number.isFinite(now) ? now : Date.now();
  const s = state();
  prune(s.global, t, HOUR_MS);
  const hourLimit = ENV.maxRunsPerHour;
  if (s.global.length >= hourLimit) return hourlyRefusal(s, hourLimit, t);
  s.global.push(t);
  return { ok: true, retryAfterSec: 0, message: "", scope: null };
}

/**
 * Gives back the hourly (global) slot that an allowed checkRateLimit call (or a takeGlobalSlot call) made at `at`
 * recorded, for a request that then created no run (400, 413, 500). Without it, 60 tiny malformed requests per hour
 * kept run creation down for every user (red team RT-PIPE-03): MAX_RUNS_PER_HOUR protects model credit, so only runs
 * should spend it. The per-IP count is kept (a client's own bad requests still slow that client down). Pass exactly
 * the `now` given to checkRateLimit / takeGlobalSlot; a slot that is no longer remembered is ignored.
 */
export function refundGlobalSlot(at: number): void {
  const s = state();
  const i = s.global.lastIndexOf(at);
  if (i >= 0) s.global.splice(i, 1);
}

/**
 * Clears all counters (tests). Uploads in progress (beginUpload) are live requests, not counters: each one gives its
 * own place back when it is answered, so they are not cleared here.
 */
export function resetRateLimits(): void {
  const s = state();
  s.perIp.clear();
  s.global.length = 0;
  s.lastSweep = 0;
}

/** How much the limiter remembers right now: distinct addresses and allowed calls in the last hour (tests, diagnostics). */
export function rateLimiterSize(): { ips: number; global: number } {
  const s = state();
  return { ips: s.perIp.size, global: s.global.length };
}

/* ---- uploads in progress (security SEC-6) ---- */

interface UploadsState {
  /** per address bucket (normalizeIp): uploads in progress; an address without one has no entry */
  perIp: Map<string, number>;
  /** uploads in progress in all */
  total: number;
}
type GlobalWithUploads = typeof globalThis & { __invoiceApUploadsInFlight?: UploadsState };

function uploadsState(): UploadsState {
  const g = globalThis as GlobalWithUploads;
  g.__invoiceApUploadsInFlight ??= { perIp: new Map(), total: 0 };
  return g.__invoiceApUploadsInFlight;
}

export interface UploadSlot extends RateLimitResult {
  /** Gives this upload's place back (idempotent; does nothing for a refused one). Call it once the request is answered. */
  release(): void;
}

const NOTHING_TO_RELEASE = (): void => undefined;

/**
 * Starts one upload for `ip` if the caps allow it: at most CONFIG.maxUploadsInFlightPerIp per address (the limiter's
 * buckets: IPv6 per /64, IPv4-mapped as IPv4, a port ignored) and CONFIG.maxUploadsInFlight in all, counted from the
 * start of the request until it is answered. Security SEC-6: uploads that stall used to pile up, each with a temp
 * file and a connection, until Node's 300 s request timeout. Refused: ok false, scope "ip" or "global", a short
 * retryAfterSec (CONFIG.uploadsBusyRetryAfterSec) and a fixed message; a refusal records nothing anywhere (no
 * per-address call, no hourly slot), which is why the route asks this before checkRateLimit. Allowed: call release()
 * when the request is answered, on every path (a finally); a second call does nothing. The memory used is bounded by
 * the caps: an address has an entry only while one of its uploads is in progress.
 */
export function beginUpload(ip: string): UploadSlot {
  const s = uploadsState();
  const key = normalizeIp(ip);
  const mine = s.perIp.get(key) ?? 0;
  const perIpCap = CONFIG.maxUploadsInFlightPerIp;
  const ipFull = mine >= perIpCap;
  if (ipFull || s.total >= CONFIG.maxUploadsInFlight) {
    const wait = Math.max(1, Math.ceil(CONFIG.uploadsBusyRetryAfterSec));
    return {
      ok: false,
      retryAfterSec: wait,
      message: ipFull
        ? `${UPLOAD_BUSY_PREFIXES[0]} ${perIpCap} files. Try again in ${describeWait(wait)}.`
        : `${UPLOAD_BUSY_PREFIXES[1]} at once. Try again in ${describeWait(wait)}.`,
      scope: ipFull ? "ip" : "global",
      release: NOTHING_TO_RELEASE,
    };
  }
  s.perIp.set(key, mine + 1);
  s.total += 1;
  let released = false;
  return {
    ok: true,
    retryAfterSec: 0,
    message: "",
    scope: null,
    release() {
      if (released) return;
      released = true;
      const left = (s.perIp.get(key) ?? 1) - 1;
      if (left > 0) s.perIp.set(key, left);
      else s.perIp.delete(key);
      s.total = Math.max(0, s.total - 1);
    },
  };
}

/** Uploads in progress right now: in all, and how many distinct address buckets have one (tests, diagnostics). */
export function uploadsInFlight(): { total: number; ips: number } {
  const s = uploadsState();
  return { total: s.total, ips: s.perIp.size };
}
