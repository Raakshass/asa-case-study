/**
 * Shared helpers of the route handlers (Phase 5). Not a route: the underscore keeps this folder out of routing.
 * Server-only. Everything a request carries (headers, body, file names) is untrusted.
 */
import { CONFIG } from "@/lib/config";
import type { ApiError } from "@/lib/types";

/** Every JSON response: never cached, whatever sits in front of the app. */
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } as const;

export function json(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), { status: init.status ?? 200, headers: { ...JSON_HEADERS, ...init.headers } });
}

/** `{ error }` (plus `retryAfterSec` on a 429). The message is fixed text: never the request's own content, never a path. */
export function apiError(status: number, error: string, opts: { retryAfterSec?: number; headers?: Record<string, string> } = {}): Response {
  const body: ApiError = opts.retryAfterSec === undefined ? { error } : { error, retryAfterSec: opts.retryAfterSec };
  return json(body, { status, headers: opts.headers });
}

/** Error name (or system error code) only, in a safe charset: the message may quote content, a path or a query. */
function errorLabel(e: unknown): string {
  const code = e instanceof Error ? (e as Error & { code?: unknown }).code : undefined;
  const raw = typeof code === "string" ? code : e instanceof Error ? e.name : "Error";
  return raw.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 40) || "Error";
}

/** The catch-all of every handler: one log line without sensitive data, a fixed 500 body. */
export function serverError(route: string, e: unknown): Response {
  console.error(JSON.stringify({ route, event: "unhandled_error", error: errorLabel(e) }));
  return apiError(500, "Something went wrong.");
}

const MAX_IP_CHARS = 64;

/**
 * The client address for rate limiting (docs/CONTRACTS.md section 5): x-real-ip, else the LAST x-forwarded-for entry,
 * else "unknown". A proxy that appends the peer address to x-forwarded-for (and sets x-real-ip to it) makes that entry
 * the one the client cannot choose; the FIRST entry is whatever the client sent (red team RT-PIPE-03: a forged first
 * entry per request skipped the per-IP limit). Still spoofable when the app is reached without such a proxy (Next only
 * sets x-forwarded-for when it is absent); the global hourly cap is the backstop.
 */
export function clientIp(req: Request): string {
  const real = req.headers.get("x-real-ip")?.trim();
  if (real) return real.slice(0, MAX_IP_CHARS);
  const entries = (req.headers.get("x-forwarded-for") ?? "").split(",").map((s) => s.trim()).filter((s) => s !== "");
  const last = entries[entries.length - 1];
  if (last) return last.slice(0, MAX_IP_CHARS);
  return "unknown";
}

/** The media type of the request without parameters, lower-cased ("" when absent). */
export function mediaType(req: Request): string {
  return (req.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
}

/** The declared Content-Length, or null when it is absent or not a plain number (the header can lie, or be missing). */
export function declaredLength(req: Request): number | null {
  const raw = req.headers.get("content-length")?.trim();
  return raw !== undefined && /^\d{1,15}$/.test(raw) ? Number(raw) : null;
}

/** Why a body read gave up: more bytes than allowed arrived, or the whole body did not arrive in time. */
export type BodyFailure = "too_large" | "timeout";

/** setTimeout turns anything above this into 1 ms (with a warning). */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * A total deadline for reading one request body: not an idle timeout, so a client that crawls is cut off as well as
 * one that stalls (security SEC-6). When `ms` pass before stop() is called, the reader is cancelled: a read that is
 * waiting then ends as "done", so the caller must ask expired() before it takes "done" for a complete body. The
 * cancel also lets go of the client's stream instead of keeping it attached until the server's own request timeout.
 */
export function bodyDeadline(reader: { cancel(reason?: unknown): Promise<void> }, ms: number): { expired(): boolean; stop(): void } {
  let expired = false;
  const timer = setTimeout(
    () => {
      expired = true;
      reader.cancel().catch(() => undefined);
    },
    Math.min(Math.max(Number.isNaN(ms) ? 0 : ms, 0), MAX_TIMER_MS),
  );
  return { expired: () => expired, stop: () => clearTimeout(timer) };
}

export type BodyRead = { ok: true; bytes: Uint8Array<ArrayBuffer> } | { ok: false; reason: BodyFailure };

/**
 * Reads the request body but never more than `maxBytes`, and only within `timeoutMs` (default
 * CONFIG.bodyReceiveTimeoutMs, read at call time). A declared Content-Length above the limit is refused
 * without reading anything; the bytes that actually arrive are counted too (the header can lie, or be absent
 * with chunked uploads) and reading stops, and the rest is dropped, as soon as the limit is crossed ("too_large")
 * or the time is up ("timeout", see bodyDeadline).
 */
export async function readBody(req: Request, maxBytes: number, timeoutMs: number = CONFIG.bodyReceiveTimeoutMs): Promise<BodyRead> {
  const declared = declaredLength(req);
  if (declared !== null && declared > maxBytes) return { ok: false, reason: "too_large" };
  if (req.body === null) return { ok: true, bytes: new Uint8Array(0) };
  const reader = req.body.getReader();
  const deadline = bodyDeadline(reader, timeoutMs);
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (deadline.expired()) return { ok: false, reason: "timeout" };
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, reason: "too_large" };
      }
      chunks.push(value);
    }
  } finally {
    deadline.stop();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes };
}
