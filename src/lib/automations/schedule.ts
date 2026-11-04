/**
 * The scheduler of Automations (plan A12): "On a schedule" automations start at a set time, hourly or daily, in UTC. A tick
 * (every minute, and once at startup) starts every enabled schedule automation whose latest slot is at or after the moment
 * it was turned on and that has no execution for that slot yet. Only the LATEST slot ever runs, so a server that was
 * asleep does not fire a storm of missed slots when it wakes; a slot that fell while it slept runs once on waking, if it
 * is still the latest. The slot is part of the execution's trigger key, so a slot fires at most once, even across restarts.
 * It never touches the decision tables and writes nothing but the execution it queues. Server-only.
 */
import crypto from "node:crypto";
import { CONFIG, ENV } from "../config";
import { CONFIG_SCHEMAS, GraphSchema } from "../workflow-graph";
import { chainAutomation, defaultAutomationDeps, executeWorkflow, type AutomationDeps } from "./engine";
import { insertExecution, type WorkflowRow } from "./store";

export interface ScheduleConfig {
  every: "hour" | "day";
  hour: number;
  minute: number;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/**
 * The latest scheduled slot at or before `now` (UTC), seconds zero. A day schedule: today at hh:mm, or yesterday's if
 * that is still ahead. An hour schedule: this hour at :mm, or the previous hour's.
 */
export function latestSlot(config: ScheduleConfig, now: Date): Date {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();
  if (config.every === "day") {
    const today = Date.UTC(y, m, d, config.hour, config.minute, 0, 0);
    return new Date(today > now.getTime() ? today - DAY_MS : today);
  }
  const thisHour = Date.UTC(y, m, d, now.getUTCHours(), config.minute, 0, 0);
  return new Date(thisHour > now.getTime() ? thisHour - HOUR_MS : thisHour);
}

/** The settings of a schedule automation's starting step, or null when its graph cannot be read. */
function scheduleOf(row: WorkflowRow): ScheduleConfig | null {
  let raw: unknown;
  try {
    raw = JSON.parse(row.graph);
  } catch {
    return null;
  }
  const graph = GraphSchema.safeParse(raw);
  if (!graph.success) return null;
  const trigger = graph.data.nodes.find((n) => n.type === "trigger.schedule");
  if (trigger === undefined) return null;
  const config = CONFIG_SCHEMAS["trigger.schedule"].safeParse(trigger.config);
  return config.success ? config.data : null;
}

/**
 * Queues one execution of a schedule automation for a slot. Returns true when it was queued (false for a slot that
 * already has an execution, an automation that is not a schedule one, or when automations are off or paused).
 */
export function dispatchSchedule(deps: AutomationDeps, row: WorkflowRow, slotIso: string): boolean {
  if (!ENV.automationsEnabled) return false;
  const now = deps.now();
  const id = crypto.randomUUID();
  const capped = false; // the hourly cap is for invoices; a schedule fires at most once an hour per automation
  const inserted = insertExecution(deps.db, {
    id,
    workflow_id: row.id,
    workflow_name: row.name,
    workflow_version: row.version,
    graph: row.graph,
    trigger_type: "schedule",
    trigger_key: `schedule:${slotIso}`,
    run_id: null,
    mode: "live",
    status: "queued",
    error: null,
    vars: JSON.stringify({ "now.date": slotIso.slice(0, 10), "workflow.name": row.name }),
    created_at: now.toISOString(),
    started_at: null,
    finished_at: null,
  });
  if (inserted && !capped) chainAutomation(() => executeWorkflow(deps, id));
  return inserted;
}

/** One pass over the enabled schedule automations. Returns how many were dispatched. */
export function tickSchedules(deps: AutomationDeps): number {
  if (!ENV.automationsEnabled) return 0;
  const rows = deps.db.prepare("SELECT * FROM workflows WHERE enabled = 1 AND trigger_type = 'schedule' ORDER BY created_at, rowid").all() as WorkflowRow[];
  let dispatched = 0;
  for (const row of rows) {
    const config = scheduleOf(row);
    if (config === null) continue;
    const slot = latestSlot(config, deps.now());
    const slotIso = slot.toISOString();
    if (row.enabled_at === null || slotIso < row.enabled_at) continue; // never a slot from before it was turned on
    if (dispatchSchedule(deps, row, slotIso)) dispatched++;
  }
  return dispatched;
}

type GlobalWithScheduler = typeof globalThis & { __invoiceApScheduler?: NodeJS.Timeout };

/**
 * Starts the once-a-minute tick (and one tick now), once per process. A no-op when automations are switched off or when
 * AUTOMATION_SCHEDULER is "off" (the tests set it, so the instrumentation test starts no real interval). It logs nothing:
 * register() must still print exactly one line. `unref` only keeps the timer from holding the process open.
 */
export function startScheduler(): void {
  if (!ENV.automationsEnabled || (process.env.AUTOMATION_SCHEDULER ?? "").trim().toLowerCase() === "off") return;
  const g = globalThis as GlobalWithScheduler;
  if (g.__invoiceApScheduler !== undefined) return;
  const tick = (): void => {
    try {
      tickSchedules(defaultAutomationDeps());
    } catch (e) {
      const name = e instanceof Error ? e.name.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 40) : "Error";
      console.log(JSON.stringify({ event: "automation_scheduler", status: "error", error: name }));
    }
  };
  g.__invoiceApScheduler = setInterval(tick, CONFIG.automationSchedulerTickMs);
  g.__invoiceApScheduler.unref();
  tick();
}
