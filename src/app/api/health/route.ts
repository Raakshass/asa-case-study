/**
 * GET /api/health (and HEAD): is the app up and its database usable? Made for a monitor that polls every few minutes (a
 * host's health check, or a pinger that keeps a sleeping free instance awake): it does one `SELECT 1` and answers
 * `{ ok: true }`, never reads a table, writes nothing and is not rate limited. A database that cannot be opened is a
 * fixed 503, so a deploy with an unwritable DATA_DIR fails the check instead of looking healthy. The answer carries no
 * version, path, count or error text.
 */
import { getDb } from "@/lib/db";
import { apiError, json } from "../_lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** True when the database opens and answers a trivial query. */
function databaseUp(): boolean {
  try {
    return getDb().prepare("SELECT 1").pluck().get() === 1;
  } catch {
    return false;
  }
}

export async function GET(): Promise<Response> {
  return databaseUp() ? json({ ok: true }) : apiError(503, "The database is not available.");
}

/** Same status and headers, no body (many pingers use HEAD). */
export async function HEAD(): Promise<Response> {
  const res = await GET();
  return new Response(null, { status: res.status, headers: res.headers });
}
