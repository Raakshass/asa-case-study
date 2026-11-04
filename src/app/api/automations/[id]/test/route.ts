/**
 * POST /api/automations/:id/test: run one against a real past invoice (needs the operator token). `send: false` shows what
 * a webhook or chat step would send; `send: true` really sends (still only to an allowed host). Answers 202 at once; the
 * execution is read back from its own route.
 */
import { z } from "zod";
import { defaultAutomationDeps, startTestExecution } from "@/lib/automations/engine";
import { getDb } from "@/lib/db";
import { apiError, json, serverError } from "../../../_lib/http";
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
    const parsed = z.object({ run_id: z.uuid().nullable(), send: z.boolean() }).safeParse(body.value);
    if (!parsed.success) return apiError(400, "Send {run_id, send} as JSON.");
    const started = startTestExecution(defaultAutomationDeps(getDb()), idCheck.data, parsed.data.run_id, parsed.data.send);
    return started.ok ? json({ executionId: started.executionId }, { status: 202 }) : apiError(started.status, started.error);
  } catch (e) {
    return serverError("POST /api/automations/:id/test", e);
  }
}
