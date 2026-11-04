/** GET /api/automations/:id/executions?limit=1..100 (default 25): the newest executions of one automation (anyone). */
import { z } from "zod";
import { getDb } from "@/lib/db";
import { apiError, json, serverError } from "../../../_lib/http";
import { loadExecutions } from "../../../_lib/automation-views";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const { id } = await context.params;
    const parsed = z.uuid().safeParse(id);
    if (!parsed.success) return apiError(400, "Invalid automation id.");
    const raw = new URL(req.url).searchParams.get("limit");
    const n = raw === null ? 25 : Number(raw);
    const limit = Number.isInteger(n) && n >= 1 && n <= 100 ? n : 25;
    const executions = loadExecutions(getDb(), parsed.data, limit);
    return executions === null ? apiError(404, "Automation not found.") : json({ executions });
  } catch (e) {
    return serverError("GET /api/automations/:id/executions", e);
  }
}
