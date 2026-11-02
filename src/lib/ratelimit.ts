/**
 * Tiny in-memory limiter for POST /api/runs (IMPLEMENTATION_PLAN.md section 6.7): at most
 * CONFIG.rateLimitPerIpPerMinute (10) runs per IP per rolling minute and ENV.maxRunsPerHour runs per
 * rolling hour globally. Process-local: resets on restart (the OpenRouter key credit limit is the backstop).
 *
 * OWNER: Phase 5. Stubs below throw NOT_IMPLEMENTED; keep every exported signature (docs/CONTRACTS.md).
 */

function notImplemented(what: string, ...args: unknown[]): never {
  void args;
  throw new Error(`NOT_IMPLEMENTED: ${what}`);
}

export interface RateLimitResult {
  ok: boolean;
  /** 0 when ok; else seconds until the oldest counted request leaves the window (>= 1), for Retry-After */
  retryAfterSec: number;
  /** "" when ok; else a friendly sentence for the 429 body, e.g. "Too many runs from your address. Try again in 42 s." */
  message: string;
  /** which limit tripped */
  scope: "ip" | "global" | null;
}

/**
 * Checks AND records one attempt for `ip` at `now` (ms since epoch, default Date.now()). Only allowed
 * attempts are recorded, so a client stuck at 429 does not extend its own window. The caller derives ip
 * from the request (x-real-ip, else the last x-forwarded-for entry, else "unknown").
 */
export function checkRateLimit(ip: string, now?: number): RateLimitResult {
  return notImplemented("ratelimit.checkRateLimit", ip, now);
}

/** Clears all counters (tests). */
export function resetRateLimits(): void {
  return notImplemented("ratelimit.resetRateLimits");
}
