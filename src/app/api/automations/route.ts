/**
 * GET /api/automations: the list (anyone). POST /api/automations: create one from a seed or a blank start (needs the operator
 * token). The copy is always off, and a copy of a seed carries its graph but none of its secrets.
 */
import crypto from "node:crypto";
import { z } from "zod";
import { insertWorkflow } from "@/lib/automations/store";
import { seedGraph } from "@/lib/automations/seed-workflows";
import { getDb } from "@/lib/db";
import { NODE_SPECS, type Graph } from "@/lib/workflow-graph";
import { apiError, json, serverError } from "../_lib/http";
import { listAutomations } from "../_lib/automation-views";
import { readJsonBody, tokenDenied, writeLimited } from "../_lib/write-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const StartSchema = z.enum(["seed:route-holds", "seed:chat-rejections", "seed:daily-holds", "blank:run_finished", "blank:schedule"]);
const BodySchema = z.object({ name: z.string().trim().min(1).max(60), start: StartSchema });

function startingGraph(start: z.infer<typeof StartSchema>): { graph: Graph; triggerType: string } | null {
  if (start.startsWith("seed:")) {
    const graph = seedGraph(start.slice("seed:".length));
    return graph === null ? null : { graph, triggerType: graph.nodes[0].type.replace("trigger.", "") };
  }
  const type = start === "blank:schedule" ? "trigger.schedule" : "trigger.run_finished";
  const graph: Graph = { nodes: [{ id: "start", type, name: NODE_SPECS[type].label, position: { x: 0, y: 0 }, config: NODE_SPECS[type].defaultConfig() as Record<string, unknown> }], edges: [] };
  return { graph, triggerType: type.replace("trigger.", "") };
}

export async function GET(): Promise<Response> {
  try {
    return json(listAutomations(getDb()));
  } catch (e) {
    return serverError("GET /api/automations", e);
  }
}

export async function POST(req: Request): Promise<Response> {
  try {
    const denied = tokenDenied(req) ?? writeLimited(req);
    if (denied !== null) return denied;
    const body = await readJsonBody(req, 4096);
    if (!body.ok) return body.response;
    const parsed = BodySchema.safeParse(body.value);
    if (!parsed.success) return apiError(400, "Send {name, start} as JSON.");
    const start = startingGraph(parsed.data.start);
    if (start === null) return apiError(400, "Send {name, start} as JSON.");
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    insertWorkflow(getDb(), {
      id,
      name: parsed.data.name,
      enabled: 0,
      enabled_at: null,
      trigger_type: start.triggerType,
      graph: JSON.stringify(start.graph),
      secrets: "{}",
      version: 1,
      seed_key: null,
      created_at: now,
      updated_at: now,
    });
    return json({ id }, { status: 201 });
  } catch (e) {
    return serverError("POST /api/automations", e);
  }
}
