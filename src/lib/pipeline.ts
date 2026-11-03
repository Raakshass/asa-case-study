/**
 * Runs the 10 stages serially for one run and writes run_steps live (IMPLEMENTATION_PLAN.md sections 6.6
 * and 7, docs/CONTRACTS.md section 4 for the exact data flow and row conventions). Server-only.
 *
 * OWNER: Phase 5. Every exported signature of the contract is kept; `runExclusive`, `PIPELINE_FILE_REASON`
 * and `PIPELINE_FAILURE_REASON` are additive (docs/CONTRACT_CHANGES.md).
 *
 * Everything derived from the invoice (the PDF bytes, extracted text, model output, error messages) is
 * untrusted: a stage failure shows only "System error at <label>, manual review", and the log lines carry the
 * run id, stage, status and duration (plus an error NAME on a failure), never bytes, text, model output or keys.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import { CONFIG, paths, uploadPath } from "./config";
import { type DB, INTERRUPTED_NEXT_ACTION, getDb } from "./db";
import { PROMPT_VERSION, getExtractor, getSuggestPo } from "./extract";
import { buildGroundingText, checkScreen, groundExtraction, printedBankAccounts, screenPdf } from "./guardrails";
import { insertInvoice, loadSnapshot } from "./master";
import { normalizeInvoice } from "./normalize";
import { validateUpload } from "./pdf";
import {
  checkAmounts,
  checkDuplicate,
  checkExtract,
  checkIngest,
  checkNormalize,
  checkPoMatch,
  checkValidate,
  checkVendor,
  decide,
  nextAction,
} from "./rules";
import {
  STAGES,
  STAGE_KEYS,
  STAGE_LABELS,
  type AmountsOutcome,
  type DecideDetail,
  type DecideResult,
  type DecisionContext,
  type DuplicateOutcome,
  type ExtractFn,
  type NormalizedInvoice,
  type PoMatchOutcome,
  type RunRow,
  type StageKey,
  type StepMap,
  type StepResult,
  type SuggestPoFn,
  type VendorOutcome,
} from "./types";

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

/**
 * Same wiring as defaultPipelineDeps(), field by field, so a caller that injects `db` (a test with an in-memory
 * database) never opens the default DATA_DIR/app.db as a side effect.
 */
function resolveDeps(partial: Partial<PipelineDeps> | undefined): PipelineDeps {
  const p = partial ?? {};
  return {
    db: p.db ?? getDb(),
    extract: p.extract ?? getExtractor(),
    suggestPo: p.suggestPo ?? getSuggestPo(),
    now: p.now ?? (() => new Date()),
    pacingMs: p.pacingMs ?? CONFIG.stagePacingMs,
    uploadsDir: p.uploadsDir ?? paths.uploadsDir,
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
  const id = crypto.randomUUID();
  const createdAt = (input.now ?? new Date()).toISOString();
  db.transaction(() => {
    db.prepare(
      "INSERT INTO runs (id, file_name, file_hash, status, security_flag, created_at) VALUES (?, ?, ?, 'queued', 0, ?)",
    ).run(id, input.fileName, input.fileHash, createdAt);
    const addStep = db.prepare("INSERT INTO run_steps (run_id, idx, key, label, status) VALUES (?, ?, ?, ?, 'pending')");
    for (const stage of STAGES) addStep.run(id, stage.idx, stage.key, stage.label);
  })();
  return id;
}

/* ------------------------------------------------------------------------------------------------
 * The serial chain (plan 6.6)
 * ---------------------------------------------------------------------------------------------- */

interface QueueState {
  /** settles when everything appended so far has finished; never rejects */
  tail: Promise<void>;
}
type GlobalWithQueue = typeof globalThis & { __invoiceApPipelineQueue?: QueueState };

/**
 * ONE chain per process, kept on globalThis: Next.js duplicates this module per route bundle (and on every hot
 * reload in dev), and separate chains would run two pipelines at once and race on duplicates and PO balances.
 */
function queue(): QueueState {
  const g = globalThis as GlobalWithQueue;
  g.__invoiceApPipelineQueue ??= { tail: Promise.resolve() };
  return g.__invoiceApPipelineQueue;
}

/** Appends `task` after everything queued before it. The chain survives a rejecting task; the caller still sees it. */
function chain<T>(task: () => Promise<T> | T): Promise<T> {
  const q = queue();
  const result = q.tail.then(task);
  q.tail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/**
 * Appends runPipeline(runId, deps) to the single in-process promise chain (plan 6.6), so runs execute one
 * at a time. The chain lives on globalThis so Next.js dev HMR and the per-route module copies share it. The
 * returned promise resolves when this run has finished and never rejects: a failing run is logged and the
 * next one still starts.
 */
export function enqueue(runId: string, deps?: Partial<PipelineDeps>): Promise<void> {
  return chain(() => runPipeline(runId, deps)).then(
    () => undefined,
    (e: unknown) => {
      logLine({ run: runId, stage: "pipeline", status: "error", ms: 0, error: errorLabel(e) });
    },
  );
}

/**
 * Resolves when every run queued so far has finished, including runs enqueued while it waits (reset route,
 * tests). Never rejects.
 */
export async function whenIdle(): Promise<void> {
  const q = queue();
  for (;;) {
    const tail = q.tail;
    await tail.catch(() => undefined);
    if (q.tail === tail) return;
  }
}

/**
 * Runs `task` on the same chain as the pipeline runs: after every run queued before it and before any queued
 * later, so it never overlaps a run (POST /api/reset wipes the tables with it). Rejects with the task's own
 * error; the chain itself is not affected.
 */
export function runExclusive<T>(task: () => Promise<T> | T): Promise<T> {
  return chain(task);
}

/* ------------------------------------------------------------------------------------------------
 * Helpers
 * ---------------------------------------------------------------------------------------------- */

const iso = (): string => new Date().toISOString();

/** Shown for a run whose stored file is missing or unreadable (pipeline-level failure; never the error text). */
export const PIPELINE_FILE_REASON = "The uploaded file could not be read, please upload it again";
/** Shown for any other failure outside the stages (database error, ...). */
export const PIPELINE_FAILURE_REASON = "System error while processing this invoice, please re-run";

const systemErrorReason = (key: StageKey): string => `System error at ${STAGE_LABELS[key]}, manual review`;

/** A failure outside the stages that already carries its own safe reason. */
class PipelineFailure extends Error {
  constructor(readonly safeReason: string) {
    super(safeReason);
    this.name = "PipelineFailure";
  }
}

/** A stage that did not settle within CONFIG.stageTimeoutMs (logged by name; its late result is ignored). */
class StageTimeout extends Error {
  constructor() {
    super("stage timed out");
    this.name = "StageTimeout";
  }
}

/**
 * `work()`, or a StageTimeout after `ms`, whichever settles first (red team RT-PIPE-04: one stage that never settles
 * would otherwise hold the serial chain, every later run and POST /api/reset forever). The work itself cannot be
 * cancelled; its late result or error is dropped. The timer never outlives the race.
 */
async function withinDeadline<T>(work: () => T | Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new StageTimeout()), Math.min(Math.max(Number.isFinite(ms) ? ms : 0, 0), 2_147_483_647));
  });
  try {
    return await Promise.race([Promise.resolve().then(work), expired]);
  } finally {
    clearTimeout(timer);
  }
}

/** Error name (or system error code) only, trimmed to a safe charset: never the message, which may quote content or paths. */
function errorLabel(e: unknown): string {
  const code = e instanceof Error ? (e as Error & { code?: unknown }).code : undefined;
  const raw = typeof code === "string" ? code : e instanceof Error ? e.name : "Error";
  return raw.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 40) || "Error";
}

function logLine(line: Record<string, string | number>): void {
  console.log(JSON.stringify(line));
}

function logStage(runId: string, stage: string, status: string, ms: number, error?: string): void {
  logLine(error === undefined ? { run: runId, stage, status, ms: Math.round(ms) } : { run: runId, stage, status, ms: Math.round(ms), error });
}

const pause = (ms: number): Promise<void> => (ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve());

/** JSON of a step detail; a detail that cannot be serialised is dropped rather than failing the run. */
function detailJson(detail: StepResult["detail"]): string | null {
  if (detail === undefined) return null;
  try {
    return JSON.stringify(detail);
  } catch {
    return null;
  }
}

const finiteOrZero = (n: unknown): number => (typeof n === "number" && Number.isFinite(n) ? n : 0);

function readRun(db: DB, runId: string): RunRow | undefined {
  return db.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as RunRow | undefined;
}

/** uploads/<hash>.pdf: the hash is validated by uploadPath(), so no path is ever built from anything else. */
async function readUpload(fileHash: string | null, uploadsDir: string): Promise<{ bytes: Uint8Array; hash: string }> {
  try {
    const hash = fileHash ?? "";
    const file = uploadPath(hash, uploadsDir);
    return { bytes: new Uint8Array(await fs.promises.readFile(file)), hash };
  } catch {
    throw new PipelineFailure(PIPELINE_FILE_REASON);
  }
}

/**
 * A failure outside the stages: status "error", decision NULL, decision_reasons [reason], no invoices row. A
 * running step becomes "error" and the pending ones "skipped" (the UI must not spin forever). Only touches a
 * run that has not decided: a done run is append-only.
 */
function failRun(db: DB, runId: string, reason: string): void {
  const at = iso();
  db.transaction(() => {
    const res = db
      .prepare(
        "UPDATE runs SET status = 'error', decision = NULL, decision_reasons = ?, next_action = ?, finished_at = ? WHERE id = ? AND status IN ('queued', 'running')",
      )
      .run(JSON.stringify([reason]), INTERRUPTED_NEXT_ACTION, at, runId);
    if (res.changes === 0) return;
    db.prepare("UPDATE run_steps SET status = 'error', reason = ?, finished_at = ? WHERE run_id = ? AND status = 'running'").run(reason, at, runId);
    db.prepare("UPDATE run_steps SET status = 'skipped', reason = ? WHERE run_id = ? AND status = 'pending'").run(
      "Not run (the pipeline stopped with a system error)",
      runId,
    );
  })();
}

function markRunning(db: DB, runId: string, key: StageKey, startedAt: string): void {
  db.prepare("UPDATE run_steps SET status = 'running', started_at = ? WHERE run_id = ? AND key = ?").run(startedAt, runId, key);
}

/** Persists only status, severity, reason and detail of a result; outcome extras (vendor, po, ...) stay in memory. */
function writeStep(db: DB, runId: string, key: StageKey, step: StepResult, startedAt: string | null, finishedAt: string): void {
  db.prepare(
    "UPDATE run_steps SET status = ?, severity = ?, reason = ?, detail = ?, started_at = ?, finished_at = ? WHERE run_id = ? AND key = ?",
  ).run(step.status, step.severity ?? null, step.reason, detailJson(step.detail), startedAt, finishedAt, runId, key);
}

const range = (from: StageKey, to: StageKey): StageKey[] => STAGE_KEYS.slice(STAGE_KEYS.indexOf(from), STAGE_KEYS.indexOf(to) + 1);

/** What to do when decide() itself throws: HOLD, with every problem found so far, so nothing is ever auto-approved. */
function fallbackDecision(steps: StepMap, ctx: DecisionContext): { d: DecideResult; action: string } {
  const reasons = [systemErrorReason("decide")];
  for (const key of STAGE_KEYS) {
    const step = steps[key];
    if (key === "decide" || step === undefined) continue;
    if ((step.status === "fail" || step.status === "warn" || step.status === "error") && step.reason.trim() !== "") reasons.push(step.reason);
  }
  const flagged = steps.screen?.status === "fail" || (ctx.extraction?.suspicious_content.length ?? 0) > 0;
  return { d: { decision: "HOLD", reasons, securityFlag: flagged }, action: "Review the reasons above." };
}

/* ------------------------------------------------------------------------------------------------
 * The run
 * ---------------------------------------------------------------------------------------------- */

/**
 * Executes all stages for an existing queued run and returns the final runs row (status "done", or
 * "error" only if the pipeline itself failed outside a stage, in which case decision stays NULL and no
 * invoices row is written). Each stage is wrapped in try/catch: an exception becomes step "error" with reason
 * "System error at <label>, manual review" and the run still reaches decide (-> HOLD). Writes the run result
 * and the invoices row together at decide. A run that is not "queued" is returned unchanged (runs are
 * append-only: nothing is ever processed twice). Rejects only when the database itself is unusable or the run
 * does not exist; enqueue() absorbs that.
 */
export async function runPipeline(runId: string, deps?: Partial<PipelineDeps>): Promise<RunRow> {
  const d = resolveDeps(deps);
  const db = d.db;
  const claimed = db.prepare("UPDATE runs SET status = 'running' WHERE id = ? AND status = 'queued'").run(runId).changes === 1;
  const run = readRun(db, runId);
  if (run === undefined) throw new Error("Run not found");
  if (!claimed) {
    logLine({ run: runId, stage: "pipeline", status: "skipped", ms: 0 });
    return run;
  }
  const t0 = performance.now();
  try {
    await execute(d, run);
  } catch (e) {
    const reason = e instanceof PipelineFailure ? e.safeReason : PIPELINE_FAILURE_REASON;
    logLine({ run: runId, stage: "pipeline", status: "error", ms: Math.round(performance.now() - t0), error: errorLabel(e) });
    failRun(db, runId, reason);
  }
  const done = readRun(db, runId);
  if (done === undefined) throw new Error("Run not found");
  return done;
}

/** Stages 1-10 for one claimed run. Anything that escapes is a failure outside the stages (see runPipeline). */
async function execute(deps: PipelineDeps, run: RunRow): Promise<void> {
  const { db } = deps;
  const runId = run.id;
  const { bytes, hash: fileHash } = await readUpload(run.file_hash, deps.uploadsDir);
  const now = deps.now(); // once per run: every date rule of this run sees the same instant
  const snapshot = loadSnapshot(db); // once, at the start (the serial queue makes it current)
  const steps: StepMap = {};
  let executed = 0;

  interface Attempt<T> {
    out: T | null;
    step: StepResult;
    startedAt: string;
    t0: number;
    failure: string | undefined;
  }

  /**
   * Mark running, pace, run within CONFIG.stageTimeoutMs, turn the outcome into a step (a throw or a timeout -> error
   * step, no outcome). Does not persist the result: stage() does, and decide writes it with the run's result.
   */
  async function attempt<T>(key: StageKey, work: () => T | Promise<T>, toStep: (out: T) => StepResult): Promise<Attempt<T>> {
    const startedAt = iso();
    markRunning(db, runId, key, startedAt); // the run view shows the stage as working through the pause below
    if (executed++ > 0) await pause(deps.pacingMs); // between stages (before every one but the first), never after the last
    const t0 = performance.now();
    let out: T | null = null;
    let step: StepResult;
    let failure: string | undefined;
    try {
      const value = await withinDeadline(work, CONFIG.stageTimeoutMs);
      step = toStep(value);
      out = value;
    } catch (e) {
      step = { status: "error", reason: systemErrorReason(key) };
      failure = errorLabel(e);
    }
    steps[key] = step;
    return { out, step, startedAt, t0, failure };
  }

  /** One stage: attempt it, persist the step, log. */
  async function stage<T>(key: StageKey, work: () => T | Promise<T>, toStep: (out: T) => StepResult): Promise<T | null> {
    const r = await attempt(key, work, toStep);
    writeStep(db, runId, key, r.step, r.startedAt, iso());
    logStage(runId, key, r.step.status, performance.now() - r.t0, r.failure);
    return r.out;
  }

  /** Set as soon as the screen or the model flags the document, so the flag survives a run that later fails (RT-PIPE-05). */
  const flagSecurity = (): void => {
    db.prepare("UPDATE runs SET security_flag = 1 WHERE id = ?").run(runId);
  };

  /** Stages that cannot run: written at once, no pacing. */
  function skip(keys: readonly StageKey[], reason: string): void {
    for (const key of keys) {
      const step: StepResult = { status: "skipped", reason };
      steps[key] = step;
      writeStep(db, runId, key, step, null, iso());
      logStage(runId, key, "skipped", 0);
    }
  }

  let ctx: DecisionContext = { extraction: null, normalized: null, vendor: null, poMatch: null, amounts: null, duplicate: null };

  // 1 ingest
  const upload = await stage("ingest", () => validateUpload(bytes), (u) => checkIngest(u, fileHash, snapshot));
  if (upload === null || !upload.ok || steps.ingest?.status === "fail" || steps.ingest?.status === "error") {
    skip(range("screen", "duplicate"), "Skipped: the file did not pass ingest");
  } else {
    // 2 screen
    const textItems = upload.textItems;
    const screen = await stage("screen", () => screenPdf(textItems), (s) => checkScreen(s));
    const isImageOnly = screen?.isImageOnly ?? false;
    if (steps.screen?.status === "fail") flagSecurity();

    // 3 extract; the fields are persisted at once so the run view shows them while the later stages run
    const ex = await stage("extract", () => deps.extract(bytes, { isImageOnly }), (r) => checkExtract(r));
    db.prepare("UPDATE runs SET extraction = ?, raw_model_output = ?, model = ?, prompt_version = ?, cost_usd = ? WHERE id = ?").run(
      ex?.ok ? JSON.stringify(ex.data) : null,
      ex?.ok ? ex.rawOutput : null,
      ex?.model ?? null,
      PROMPT_VERSION,
      finiteOrZero(ex?.costUsd),
      runId,
    );
    if (ex?.ok && Array.isArray(ex.data.suspicious_content) && ex.data.suspicious_content.length > 0) flagSecurity();

    if (ex === null || !ex.ok) {
      skip(range("validate", "duplicate"), "Skipped: no extraction to check");
    } else {
      const data = ex.data;

      // 4 validate (grounding only for text PDFs: null means "not checked")
      await stage(
        "validate",
        () => (isImageOnly ? null : groundExtraction(data, buildGroundingText(textItems))),
        (grounding) => checkValidate(data, grounding, now),
      );

      // 5 normalize
      const normalized = await stage<NormalizedInvoice>("normalize", () => normalizeInvoice(data, snapshot.vendors), (n) => checkNormalize(n));
      let vendor: VendorOutcome | null = null;
      let poMatch: PoMatchOutcome | null = null;
      let amounts: AmountsOutcome | null = null;
      let duplicate: DuplicateOutcome | null = null;

      if (normalized === null) {
        skip(range("vendor", "duplicate"), "Skipped: the normalize stage failed");
      } else {
        // 6 vendor: the bank account the model read AND any account number printed in the visible text (a text PDF) are
        // compared with the one on file, so the bank-change hold does not rest on the model alone (fix round SEC-2)
        vendor = await stage<VendorOutcome>(
          "vendor",
          () => {
            const printed = isImageOnly ? null : printedBankAccounts(buildGroundingText(textItems), snapshot.vendors.map((v) => v.bank_account));
            return checkVendor(data, normalized, snapshot, printed);
          },
          (v) => v,
        );
        const knownVendor = vendor?.vendor ?? null;

        // 7 po_match (a suggestion's cost is added to the run)
        poMatch = await stage<PoMatchOutcome>("po_match", () => checkPoMatch(data, normalized, knownVendor, snapshot, deps.suggestPo), (p) => p);
        if (poMatch?.suggestion) {
          db.prepare("UPDATE runs SET cost_usd = COALESCE(cost_usd, 0) + ? WHERE id = ?").run(finiteOrZero(poMatch.suggestion.costUsd), runId);
        }

        // 8 amounts
        const matched = poMatch;
        if (matched === null) skip(["amounts"], "Skipped: the PO match stage failed");
        else amounts = await stage<AmountsOutcome>("amounts", () => checkAmounts(data, normalized, matched, snapshot), (a) => a);

        // 9 duplicate
        duplicate = await stage<DuplicateOutcome>("duplicate", () => checkDuplicate(data, normalized, knownVendor, snapshot), (x) => x);
      }
      ctx = { extraction: data, normalized, vendor, poMatch, amounts, duplicate };
    }
  }

  // 10 decide: the step, the run result and ONE invoices row (any decision) are written in one transaction, so a run
  // whose final write fails never shows a decided step it did not record (RT-PIPE-05: "APPROVE: all checks passed" on
  // a run in status error); the step stays "running" and failRun turns it into "error".
  const decided = await attempt(
    "decide",
    () => {
      const result = decide(steps, ctx);
      return { result, action: nextAction(result.decision, steps, ctx) };
    },
    ({ result, action }): StepResult => {
      const detail = {
        decision: result.decision,
        reasons: result.reasons,
        next_action: action,
        security_flag: result.securityFlag,
      } satisfies DecideDetail;
      return { status: "pass", reason: `${result.decision}: ${result.reasons[0] ?? "all checks passed"}`, detail };
    },
  );
  const final = decided.out ? { d: decided.out.result, action: decided.out.action } : fallbackDecision(steps, ctx);
  const finishedAt = iso();
  const data = ctx.extraction;
  const decidedCtx = ctx;
  try {
    db.transaction(() => {
      writeStep(db, runId, "decide", decided.step, decided.startedAt, finishedAt);
      const res = db
        .prepare(
          "UPDATE runs SET status = 'done', decision = ?, decision_reasons = ?, next_action = ?, security_flag = ?, finished_at = ? WHERE id = ? AND status = 'running'",
        )
        .run(final.d.decision, JSON.stringify(final.d.reasons), final.action, final.d.securityFlag ? 1 : 0, finishedAt, runId);
      if (res.changes !== 1) throw new PipelineFailure(PIPELINE_FAILURE_REASON); // the run vanished (a reset) or was already settled
      insertInvoice(db, {
        id: runId,
        run_id: runId,
        vendor_id: decidedCtx.vendor?.vendor?.id ?? null,
        invoice_number: data?.invoice_number ?? null,
        invoice_number_norm: decidedCtx.normalized?.invoice_number_norm ?? null,
        invoice_date: decidedCtx.normalized?.invoice_date ?? null,
        po_number: decidedCtx.poMatch?.po?.po_number ?? null,
        po_inferred: decidedCtx.poMatch?.inferred ?? false,
        subtotal: data?.subtotal ?? null,
        tax: data?.tax ?? null,
        total: data?.total ?? null,
        currency: decidedCtx.normalized?.currency ?? null,
        bank_account: data?.bank_account ?? null,
        file_hash: fileHash,
        decision: final.d.decision,
        created_at: finishedAt,
      });
    })();
  } catch (e) {
    logStage(runId, "decide", "error", performance.now() - decided.t0, errorLabel(e));
    throw e;
  }
  logStage(runId, "decide", decided.step.status, performance.now() - decided.t0, decided.failure);
}
