/**
 * Shared helpers of the route handlers (Phase 5). Not a route: the underscore keeps this folder out of routing.
 * Server-only. Everything a request carries (headers, body, file names) is untrusted.
 */
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

export type BodyRead = { ok: true; bytes: Uint8Array<ArrayBuffer> } | { ok: false };

/**
 * Reads the request body but never more than `maxBytes`. A declared Content-Length above the limit is refused
 * without reading anything; the bytes that actually arrive are counted too (the header can lie, or be absent
 * with chunked uploads) and reading stops, and the rest is dropped, as soon as the limit is crossed.
 */
export async function readBody(req: Request, maxBytes: number): Promise<BodyRead> {
  const declared = declaredLength(req);
  if (declared !== null && declared > maxBytes) return { ok: false };
  if (req.body === null) return { ok: true, bytes: new Uint8Array(0) };
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return { ok: false };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes };
}
