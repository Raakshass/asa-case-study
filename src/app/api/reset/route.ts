/**
 * POST /api/reset: restore the demo state (plan 6.8, docs/CONTRACTS.md section 7). Refused (403) unless
 * DEMO_RESET_ENABLED is "true" and the x-reset-token header equals DEMO_RESET_TOKEN (at least 16 characters).
 * Waits for the pipeline to go idle, reloads the seed data and deletes the stored uploads. It does NOT clear the
 * rate limiter, so the endpoint cannot be used to get around it.
 */
import crypto from "node:crypto";
import { CONFIG, ENV } from "@/lib/config";
import { getDb } from "@/lib/db";
import { runExclusive, whenIdle } from "@/lib/pipeline";
import { seedDatabase } from "@/lib/seed";
import type { ResetResponse } from "@/lib/types";
import { apiError, json, serverError } from "../_lib/http";
import { wipeUploads } from "../_lib/uploads";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const sha256Digest = (value: string): Buffer => crypto.createHash("sha256").update(value).digest();

/**
 * timingSafeEqual throws on buffers of different lengths, so both sides are hashed first: two 32-byte digests
 * always compare, whatever the header holds, and the time does not depend on how long the matching prefix is.
 * The compare runs even when reset is disabled or no token is configured, so those cases look alike.
 */
function resetAllowed(req: Request): boolean {
  const expected = ENV.demoResetToken; // null when unset or shorter than 16 characters
  const supplied = req.headers.get("x-reset-token") ?? "";
  const sameToken = crypto.timingSafeEqual(sha256Digest(supplied), sha256Digest(expected ?? ""));
  return ENV.demoResetEnabled && expected !== null && sameToken;
}

/**
 * whenIdle(), but for at most CONFIG.resetIdleWaitMs: it only resolves once the chain stops growing, so a steady
 * stream of uploads kept a reset waiting for as long as the stream lasted (red team RT-PIPE-04). After the wait the
 * wipe simply takes its turn on the chain (after every run queued so far), which already rules out any overlap.
 */
async function idleOrWaited(): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const waited = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, CONFIG.resetIdleWaitMs);
  });
  try {
    await Promise.race([whenIdle(), waited]);
  } finally {
    clearTimeout(timer);
  }
}

export async function POST(req: Request): Promise<Response> {
  try {
    if (!resetAllowed(req)) return apiError(403, "Reset is not allowed.");
    await idleOrWaited(); // a run in flight finishes first (and runs enqueued meanwhile, for a bounded time)
    // The wipe takes its turn on the pipeline's own chain, so a run enqueued meanwhile cannot start in the middle of it.
    const counts = await runExclusive(async () => {
      const seeded = seedDatabase(getDb());
      await wipeUploads();
      return seeded;
    });
    return json({ ok: true, counts } satisfies ResetResponse);
  } catch (e) {
    return serverError("POST /api/reset", e);
  }
}
