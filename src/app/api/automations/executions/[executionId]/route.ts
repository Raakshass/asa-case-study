/** GET /api/automations/executions/:executionId: one execution with its steps and the graph it ran (anyone). */
import { z } from "zod";
import { getDb } from "@/lib/db";
import { apiError, json, serverError } from "../../../_lib/http";
import { loadExecutionDetail } from "../../../_lib/automation-views";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, context: { params: Promise<{ executionId: string }> }): Promise<Response> {
  try {
    const { executionId } = await context.params;
    const parsed = z.uuid().safeParse(executionId);
    if (!parsed.success) return apiError(400, "Invalid execution id.");
    const detail = loadExecutionDetail(getDb(), parsed.data);
    return detail === null ? apiError(404, "Execution not found.") : json(detail);
  } catch (e) {
    return serverError("GET /api/automations/executions/:executionId", e);
  }
}
