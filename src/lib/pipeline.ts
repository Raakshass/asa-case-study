/**
 * Runs the 10 stages serially for one run and writes run_steps live (IMPLEMENTATION_PLAN.md sections 6.6
 * and 7, docs/CONTRACTS.md section 4 for the exact data flow and row conventions). Server-only.
 *
 * OWNER: Phase 5. defaultPipelineDeps is final; the rest are stubs. Keep every exported signature.
 */
import { CONFIG, paths } from "./config";
import { type DB, getDb } from "./db";
import { getExtractor, getSuggestPo } from "./extract";
import type { ExtractFn, RunRow, SuggestPoFn } from "./types";

function notImplemented(what: string, ...args: unknown[]): never {
  void args;
  throw new Error(`NOT_IMPLEMENTED: ${what}`);
}

/** Everything the pipeline touches outside pure code, injectable for tests and the mock. */
export interface PipelineDeps {
  db: DB;
  extract: ExtractFn;
  suggestPo: SuggestPoFn;
  /** the clock; called once per run and passed to the rules as `now` */
  now: () => Date;
  /** presentational delay between stages (CONFIG.stagePacingMs; 0 in tests) */
  pacingMs: number;
  /** where uploads/<sha256>.pdf live */
  uploadsDir: string;
}

/** Production wiring: getDb(), getExtractor(), getSuggestPo(), the real clock, CONFIG pacing, DATA_DIR/uploads. */
export function defaultPipelineDeps(): PipelineDeps {
  return {
    db: getDb(),
    extract: getExtractor(),
    suggestPo: getSuggestPo(),
    now: () => new Date(),
    pacingMs: CONFIG.stagePacingMs,
    uploadsDir: paths.uploadsDir,
  };
}

export interface CreateRunInput {
  /** already sanitized display name (pdf.ts sanitizeDisplayName), or the sample file name */
  fileName: string | null;
  /** sha256 of the bytes already stored at uploads/<fileHash>.pdf */
  fileHash: string;
  now?: Date;
}

/**
 * Inserts a runs row (status "queued", id = crypto.randomUUID(), created_at = now ISO) and the 10 run_steps
 * rows (status "pending", idx/key/label from STAGES) in one transaction. Returns the run id.
 */
export function createRun(db: DB, input: CreateRunInput): string {
  return notImplemented("pipeline.createRun", db, input);
}

/**
 * Appends runPipeline(runId, deps) to the single in-process promise chain (plan 6.6), so runs execute one
 * at a time. The chain lives on globalThis so Next.js dev HMR does not start a second one. The returned
 * promise resolves when this run has finished (never rejects).
 */
export function enqueue(runId: string, deps?: Partial<PipelineDeps>): Promise<void> {
  return notImplemented("pipeline.enqueue", runId, deps);
}

/** Resolves when every run queued so far has finished (reset route, tests). Never rejects. */
export function whenIdle(): Promise<void> {
  return notImplemented("pipeline.whenIdle");
}

/**
 * Executes all stages for an existing queued run and returns the final runs row (status "done", or
 * "error" only if the pipeline itself failed outside a stage). Each stage is wrapped in try/catch: an
 * exception becomes step "error" with reason "System error at <label>, manual review" and the run still
 * reaches decide (-> HOLD). Writes the invoices row at decide. Never rejects for stage failures.
 */
export async function runPipeline(runId: string, deps?: Partial<PipelineDeps>): Promise<RunRow> {
  return notImplemented("pipeline.runPipeline", runId, deps);
}
