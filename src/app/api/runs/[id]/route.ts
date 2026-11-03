/**
 * GET /api/runs/:id: one run with its steps ordered by idx (docs/CONTRACTS.md section 7).
 * Next.js 15 passes `params` as a Promise.
 */
import { z } from "zod";
import { getDb } from "@/lib/db";
import { apiError, json, serverError } from "../../_lib/http";
import { loadRunDetail } from "../../_lib/views";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const { id } = await context.params;
    const parsed = z.uuid().safeParse(id);
    if (!parsed.success) return apiError(400, "Invalid run id.");
    const run = loadRunDetail(getDb(), parsed.data);
    if (run === null) return apiError(404, "Run not found.");
    return json(run);
  } catch (e) {
    return serverError("GET /api/runs/:id", e);
  }
}
