/**
 * POST /api/runs/:id/review: a person resolves a HOLD (review round B4, docs/CONTRACT_CHANGES.md). Needs the operator
 * token (the same x-reset-token as reset). Counts against its own write limit, not the run quota. The change runs on the
 * pipeline's chain, so it never interleaves with a run that is spending PO balance. Next.js 15 passes `params` as a Promise.
 */
import { z } from "zod";
import { getDb } from "@/lib/db";
import { runExclusive } from "@/lib/pipeline";
import { checkWriteLimit } from "@/lib/ratelimit";
import { reviewRun } from "@/lib/review";
import { apiError, clientIp, json, readBody, serverError, tokenMatches } from "../../../_lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BODY_LIMIT_BYTES = 4096;
const BodySchema = z.object({
  action: z.enum(["APPROVE", "REJECT"]),
  comment: z.string().max(2000),
  po_number: z.string().max(40).nullable().optional(),
});

export async function POST(req: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    if (!tokenMatches(req)) return apiError(403, "Review is not allowed. Enter the operator token.");
    const { id } = await context.params;
    const parsedId = z.uuid().safeParse(id);
    if (!parsedId.success) return apiError(400, "Invalid run id.");
    const limit = checkWriteLimit(clientIp(req), Date.now());
    if (!limit.ok) return apiError(429, limit.message, { retryAfterSec: limit.retryAfterSec });

    const read = await readBody(req, BODY_LIMIT_BYTES);
    if (!read.ok) return apiError(read.reason === "too_large" ? 413 : 408, read.reason === "too_large" ? "This request is too large." : "The request took too long.");
    let body: z.infer<typeof BodySchema>;
    try {
      body = BodySchema.parse(JSON.parse(new TextDecoder().decode(read.bytes)));
    } catch {
      return apiError(400, "Send {action, comment} as JSON.");
    }
    const outcome = await runExclusive(() => reviewRun(getDb(), parsedId.data, body));
    if (!outcome.ok) return apiError(outcome.status, outcome.error);
    return json({ ok: true, review: outcome.review });
  } catch (e) {
    return serverError("POST /api/runs/:id/review", e);
  }
}
