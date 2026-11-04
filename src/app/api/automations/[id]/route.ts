/**
 * GET /api/automations/:id (anyone), PUT (save: needs the operator token), DELETE (needs it too). A webhook URL or signing
 * secret in a PUT is stored in the secrets column and never returned: the API answers with whether one is set and a hint.
 * Next.js 15 passes `params` as a Promise.
 */
import { z } from "zod";
import { deleteWorkflow, getWorkflow, parseSecrets, saveWorkflow, type StepSecrets } from "@/lib/automations/store";
import { CONFIG } from "@/lib/config";
import { getDb } from "@/lib/db";
import { GraphSchema, NODE_SPECS, isTriggerType, validateGraph } from "@/lib/workflow-graph";
import { apiError, json, serverError } from "../../_lib/http";
import { loadAutomation, reviewTriggerAvailable } from "../../_lib/automation-views";
import { readJsonBody, tokenDenied, writeLimited } from "../../_lib/write-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SecretEdit = z.object({ url: z.string().nullable().optional(), signing_secret: z.string().nullable().optional() });
const BodySchema = z.object({
  name: z.string().trim().min(1).max(60),
  graph: z.unknown(),
  version: z.int().min(1),
  secrets: z.record(z.string().max(40), SecretEdit).optional(),
});
const URL_RE = /^https:\/\/\S{1,1990}$/;

export async function GET(_req: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const { id } = await context.params;
    const parsed = z.uuid().safeParse(id);
    if (!parsed.success) return apiError(400, "Invalid automation id.");
    const detail = loadAutomation(getDb(), parsed.data);
    return detail === null ? apiError(404, "Automation not found.") : json(detail);
  } catch (e) {
    return serverError("GET /api/automations/:id", e);
  }
}

export async function PUT(req: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const denied = tokenDenied(req);
    if (denied !== null) return denied;
    const { id } = await context.params;
    const idCheck = z.uuid().safeParse(id);
    if (!idCheck.success) return apiError(400, "Invalid automation id.");
    const limited = writeLimited(req);
    if (limited !== null) return limited;
    const body = await readJsonBody(req, CONFIG.automationGraphMaxBytes);
    if (!body.ok) return body.response;
    const parsed = BodySchema.safeParse(body.value);
    if (!parsed.success) return apiError(400, "Send {name, graph, version} as JSON.");
    const graph = GraphSchema.safeParse(parsed.data.graph);
    if (!graph.success) return apiError(400, "This automation could not be read.");

    const db = getDb();
    const row = getWorkflow(db, idCheck.data);
    if (row === null) return apiError(404, "Automation not found.");

    // Secrets are merged BEFORE validation, so the problems reflect the URLs this save leaves in place.
    const merged: Record<string, StepSecrets> = parseSecrets(row.secrets);
    for (const [nodeId, edit] of Object.entries(parsed.data.secrets ?? {})) {
      const entry: StepSecrets = { ...merged[nodeId] };
      if (typeof edit.url === "string") {
        if (!URL_RE.test(edit.url)) return apiError(400, "A webhook URL must start with https:// and be at most 2,000 characters.");
        entry.url = edit.url;
      } else if (edit.url === null) delete entry.url;
      if (typeof edit.signing_secret === "string") {
        if (edit.signing_secret.length < 1 || edit.signing_secret.length > 200) return apiError(400, "A signing secret must be 1 to 200 characters.");
        entry.signing_secret = edit.signing_secret;
      } else if (edit.signing_secret === null) delete entry.signing_secret;
      merged[nodeId] = entry;
    }
    // Secrets of steps that no longer exist (or that never send) are dropped.
    const sending = new Set(graph.data.nodes.filter((n) => NODE_SPECS[n.type].hasUrl).map((n) => n.id));
    for (const nodeId of Object.keys(merged)) if (!sending.has(nodeId) || (merged[nodeId].url === undefined && merged[nodeId].signing_secret === undefined)) delete merged[nodeId];

    const checked = validateGraph(graph.data, {
      reviewTrigger: reviewTriggerAvailable(db),
      secrets: Object.fromEntries([...sending].map((nodeId) => [nodeId, { has_url: merged[nodeId]?.url !== undefined }])),
    });
    const now = new Date().toISOString();
    const trigger = graph.data.nodes.find((n) => isTriggerType(n.type));
    const triggerType = trigger === undefined ? row.trigger_type : trigger.type.replace("trigger.", "");
    const wasEnabled = row.enabled === 1;
    // a newly scheduled automation never fires for a slot from before the change
    const enabledAt = wasEnabled && triggerType !== row.trigger_type ? now : row.enabled_at;
    const turnOff = wasEnabled && checked.problems.length > 0;
    const saved = saveWorkflow(db, idCheck.data, {
      name: parsed.data.name,
      graph: JSON.stringify(graph.data),
      secrets: JSON.stringify(merged),
      triggerType,
      enabled: wasEnabled && !turnOff,
      enabledAt,
      expectedVersion: parsed.data.version,
      now,
    });
    if (!saved.ok) return saved.reason === "not_found" ? apiError(404, "Automation not found.") : apiError(409, "Someone else saved this automation. Reload to see their changes.");
    return json({ version: saved.version, problems: checked.problems, turned_off: turnOff });
  } catch (e) {
    return serverError("PUT /api/automations/:id", e);
  }
}

export async function DELETE(req: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const denied = tokenDenied(req);
    if (denied !== null) return denied;
    const { id } = await context.params;
    const parsed = z.uuid().safeParse(id);
    if (!parsed.success) return apiError(400, "Invalid automation id.");
    const limited = writeLimited(req);
    if (limited !== null) return limited;
    return deleteWorkflow(getDb(), parsed.data) ? json({ ok: true }) : apiError(404, "Automation not found.");
  } catch (e) {
    return serverError("DELETE /api/automations/:id", e);
  }
}
