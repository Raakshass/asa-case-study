/** POST /api/automations/:id/enabled: turn one on or off (needs the operator token). Turning on needs a graph without problems. */
import { z } from "zod";
import { getWorkflow, setEnabled } from "@/lib/automations/store";
import { getDb } from "@/lib/db";
import { apiError, json, serverError } from "../../../_lib/http";
import { graphAndProblems, reviewTriggerAvailable } from "../../../_lib/automation-views";
import { readJsonBody, tokenDenied, writeLimited } from "../../../_lib/write-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const denied = tokenDenied(req);
    if (denied !== null) return denied;
    const { id } = await context.params;
    const idCheck = z.uuid().safeParse(id);
    if (!idCheck.success) return apiError(400, "Invalid automation id.");
    const limited = writeLimited(req);
    if (limited !== null) return limited;
    const body = await readJsonBody(req, 1024);
    if (!body.ok) return body.response;
    const parsed = z.object({ enabled: z.boolean() }).safeParse(body.value);
    if (!parsed.success) return apiError(400, "Send {enabled} as JSON.");
    const db = getDb();
    const row = getWorkflow(db, idCheck.data);
    if (row === null) return apiError(404, "Automation not found.");
    if (parsed.data.enabled) {
      const { problems } = graphAndProblems(row, reviewTriggerAvailable(db));
      if (problems.length > 0) return json({ error: "Fix the problems listed before turning this automation on.", problems }, { status: 409 });
    }
    setEnabled(db, idCheck.data, parsed.data.enabled, new Date().toISOString());
    return json({ enabled: parsed.data.enabled });
  } catch (e) {
    return serverError("POST /api/automations/:id/enabled", e);
  }
}
