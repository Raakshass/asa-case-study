/**
 * What every route that CHANGES automations does first, in this order: the operator token (403), the write limit (429, its
 * own window, not the run quota), the media type (415) and the body (413 too large, 408 too slow). Not a route: the
 * underscore keeps this folder out of routing. Server-only. Everything a request carries is untrusted.
 */
import { checkWriteLimit } from "@/lib/ratelimit";
import { apiError, clientIp, mediaType, readBody, tokenMatches } from "./http";

/** 403 unless the x-reset-token header is the operator token. */
export function tokenDenied(req: Request): Response | null {
  return tokenMatches(req) ? null : apiError(403, "Changing automations is not allowed. Enter the operator token.");
}

/** 429 when this address has made too many changes in the last minute. */
export function writeLimited(req: Request): Response | null {
  const limit = checkWriteLimit(clientIp(req), Date.now());
  return limit.ok ? null : apiError(429, limit.message, { retryAfterSec: limit.retryAfterSec });
}

/**
 * Reads a JSON body of at most `maxBytes`. A body that is not valid JSON gives `value: undefined`, so the route's own
 * schema check answers with its fixed 400 text.
 */
export async function readJsonBody(req: Request, maxBytes: number): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> {
  if (mediaType(req) !== "application/json") return { ok: false, response: apiError(415, "Send JSON.") };
  const read = await readBody(req, maxBytes);
  if (!read.ok) {
    return { ok: false, response: read.reason === "too_large" ? apiError(413, "This automation is too large.") : apiError(408, "The request took too long.") };
  }
  try {
    return { ok: true, value: JSON.parse(new TextDecoder().decode(read.bytes)) as unknown };
  } catch {
    return { ok: true, value: undefined };
  }
}
