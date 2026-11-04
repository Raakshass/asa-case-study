/** GET /api/runs/:id/automations: which automations ran for one invoice, their notes and its assignment (anyone). */
import { z } from "zod";
import { getDb } from "@/lib/db";
import { apiError, json, serverError } from "../../../_lib/http";
import { loadRunAutomations } from "../../../_lib/automation-views";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const { id } = await context.params;
    const parsed = z.uuid().safeParse(id);
    if (!parsed.success) return apiError(400, "Invalid run id.");
    const detail = loadRunAutomations(getDb(), parsed.data);
    return detail === null ? apiError(404, "Run not found.") : json(detail);
  } catch (e) {
    return serverError("GET /api/runs/:id/automations", e);
  }
}
