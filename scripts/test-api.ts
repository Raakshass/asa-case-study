/* eslint-disable @typescript-eslint/no-require-imports -- the pipeline's collaborators are wrapped BEFORE it loads, so it is loaded with require() */
/**
 * npx tsx scripts/test-api.ts [--grep=text]
 *
 * Fast, self-contained test of the pipeline (src/lib/pipeline.ts), the rate limiter (src/lib/ratelimit.ts), the API
 * route handlers (src/app/api/**), the instrumentation hook and startup recovery. No Next.js process and no network:
 * the route handlers are called directly with `new Request(...)` (dynamic routes: `{ params: Promise.resolve(...) }`).
 *
 *   - a fresh temp DATA_DIR, EXTRACT_MOCK=1 (the offline mock extractor, so no API key is involved), stage pacing 0,
 *     and a fetch that refuses to run (the last test asserts it was never called)
 *   - the 10 samples in demo order THROUGH THE REAL PIPELINE against every truth file's _meta, and against what
 *     scripts/rehearse.ts prints (it runs as a child process)
 *   - a throwing collaborator at EACH stage: the functions the pipeline imports (pdf, guardrails, normalize, rules)
 *     are wrapped so a test can make one throw once; the extractor is a pipeline dependency and is injected
 *   - the queue, rate limiter, every route (success and error shapes, traversal and malformed input, 413, 429),
 *     the reset guard, instrumentation and startup recovery
 *
 * Business dates: the samples are dated 2026-10-20..31 and an invoice older than 365 days is held, so the tests that
 * go through the DEFAULT clock (the route tests) can only reach their decisions until 2027-10-20; the pipeline tests
 * inject FIXED_NOW (2026-11-02) and do not depend on today's date.
 *
 * Exit code 1 on any failure.
 */
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { PDFDocument, PDFName } from "pdf-lib";
import { z } from "zod";
import { CONFIG, paths, uploadPath } from "../src/lib/config";
import { type DB, INTERRUPTED_NEXT_ACTION, INTERRUPTED_REASON, getDb, openDb } from "../src/lib/db";
import { normId } from "../src/lib/format";
import { loadSnapshot, poBalance } from "../src/lib/master";
import { type TruthSample, SAMPLE_FILES, SampleFileSchema, loadTruthSamples, samplePdfPath } from "../src/lib/samples";
import { historyRunId, readSeedFiles, seedDatabase } from "../src/lib/seed";
import {
  DecisionSchema,
  InvoiceExtractionSchema,
  RUN_STATUSES,
  SEVERITIES,
  SHA256_HEX_RE,
  STAGES,
  STAGE_KEYS,
  STAGE_LABELS,
  STEP_STATUSES,
  StageKeySchema,
  type ExtractFn,
  type RunRow,
  type RunStepRow,
  type StageKey,
  type SuggestPoFn,
} from "../src/lib/types";
import { type Check, FIXED_NOW, createHarness, openSeededMemoryDb } from "./checks/harness";

/* ================================================================================================
 * Environment (before anything reads it): temp DATA_DIR, mock extractor, no key, no network
 * ============================================================================================== */

const ROOT = path.resolve(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "asa-test-api-"));
const RESET_TOKEN = "test-reset-token-0123456789";
const MAIN_DATA_DIR = path.join(TMP, "data");

process.env.DATA_DIR = MAIN_DATA_DIR;
process.env.EXTRACT_MOCK = "1";
process.env.DEMO_RESET_ENABLED = "true";
process.env.DEMO_RESET_TOKEN = RESET_TOKEN;
process.env.MAX_RUNS_PER_HOUR = "100000";
(CONFIG as { stagePacingMs: number }).stagePacingMs = 0; // the route handlers use the default deps

let blockedFetches = 0; // nothing in this script may reach a model or any host: fetch refuses to run
globalThis.fetch = (() => {
  blockedFetches++;
  return Promise.reject(new TypeError("blocked: test-api never uses the network"));
}) as typeof fetch;

/** JSON log lines of the app (pipeline stages, server errors, startup) are captured; everything else prints. */
const captured: string[] = [];
const realLog = console.log.bind(console);
const realError = console.error.bind(console);
const appLine = (args: unknown[]): args is [string] => args.length === 1 && typeof args[0] === "string" && args[0].startsWith('{"');
console.log = (...args: unknown[]) => (appLine(args) ? void captured.push(args[0]) : realLog(...args));
console.error = (...args: unknown[]) => (appLine(args) ? void captured.push(args[0]) : realError(...args));
const takeLogs = (): string[] => captured.splice(0, captured.length);

/* ================================================================================================
 * Fault injection: wrap the functions the pipeline imports, before it loads
 * ============================================================================================== */

const faults = new Map<string, { left: number; error: Error }>();

/** Replaces a module's exports by a Proxy whose functions throw the registered fault (once per `left`) before running. */
function interceptModule(file: string): void {
  const resolved = require.resolve(path.join(ROOT, "src", "lib", file));
  const real = require(resolved) as Record<string, unknown>;
  const wrapped = new Proxy(real, {
    get(target, prop, receiver) {
      const value: unknown = Reflect.get(target, prop, receiver);
      if (typeof prop !== "string" || typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const fault = faults.get(prop);
        if (fault !== undefined && fault.left > 0) {
          fault.left--;
          throw fault.error;
        }
        return (value as (...a: unknown[]) => unknown)(...args);
      };
    },
  });
  const entry = require.cache[resolved];
  if (entry === undefined) throw new Error(`module was not cached: ${file}`);
  entry.exports = wrapped;
}
for (const name of ["pdf", "guardrails", "normalize", "rules"]) interceptModule(name);

const load = <T>(rel: string): T => require(path.join(ROOT, rel)) as T;
const pipeline = load<typeof import("../src/lib/pipeline")>("src/lib/pipeline");
const limiter = load<typeof import("../src/lib/ratelimit")>("src/lib/ratelimit");
const pdfMod = load<typeof import("../src/lib/pdf")>("src/lib/pdf");
const extractMod = load<typeof import("../src/lib/extract")>("src/lib/extract");
const instrumentation = load<typeof import("../src/instrumentation")>("src/instrumentation");
const runsRoute = load<typeof import("../src/app/api/runs/route")>("src/app/api/runs/route");
const runRoute = load<typeof import("../src/app/api/runs/[id]/route")>("src/app/api/runs/[id]/route");
const fileRoute = load<typeof import("../src/app/api/files/[hash]/route")>("src/app/api/files/[hash]/route");
const samplesRoute = load<typeof import("../src/app/api/samples/route")>("src/app/api/samples/route");
const masterRoute = load<typeof import("../src/app/api/master/route")>("src/app/api/master/route");
const resetRoute = load<typeof import("../src/app/api/reset/route")>("src/app/api/reset/route");

const { createRun, enqueue, whenIdle, runPipeline, runExclusive } = pipeline;
const { sha256 } = pdfMod;

/* ================================================================================================
 * Helpers
 * ============================================================================================== */

const ORIGIN = "http://127.0.0.1:3100";
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const sampleBytes = (file: (typeof SAMPLE_FILES)[number]): Uint8Array => new Uint8Array(fs.readFileSync(samplePdfPath(file)));
const samples: TruthSample[] = loadTruthSamples();
const truthOf = (file: string): TruthSample => samples.find((s) => s.file === file) as TruthSample;

/** The default clock is real: samples dated 2026-10-20..31 are only decidable inside this window. */
const DEFAULT_CLOCK_OK = Date.now() >= Date.parse("2026-11-01T00:00:00Z") && Date.now() < Date.parse("2027-10-20T00:00:00Z");

/** A test that needs the default clock inside the samples' date window; outside it, a recorded skip (never a silent pass). */
async function clockTest(t: Check, name: string, fn: () => Promise<void>, opts?: { timeoutMs?: number }): Promise<void> {
  if (DEFAULT_CLOCK_OK) await t.test(name, fn, opts);
  else t.skip(name, "the real date is outside 2026-11-01..2027-10-19, the window in which the samples' invoice dates pass the date rules");
}

let ipCounter = 0;
/** A fresh client address per call, so the 10 per minute limit never couples two tests. */
const freshIp = (): string => `10.9.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}
/** Every gate a test creates is released when that test ends, pass or fail: a run left waiting on one would hang the queue. */
const openGates: Deferred[] = [];
function deferred(): Deferred {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((r) => (resolve = r));
  const gate = { promise, resolve };
  openGates.push(gate);
  return gate;
}
const releaseGates = (): void => {
  for (const gate of openGates.splice(0)) gate.resolve();
};
/** The harness' Check, but every test releases its gates when it finishes (also when an assertion threw before it did). */
const guarded = (t: Check): Check => ({
  ...t,
  test: (name, fn, opts) =>
    t.test(
      name,
      async () => {
        try {
          await fn();
        } finally {
          releaseGates();
        }
      },
      opts,
    ),
});

async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T> | T): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(vars)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** CONFIG is `as const` (readonly types) but a plain object at run time: tests may narrow a limit and must restore it. */
async function withConfig<T>(
  patch: Partial<Record<"maxFileBytes" | "stagePacingMs" | "stageTimeoutMs" | "resetIdleWaitMs" | "bodyReceiveTimeoutMs", number>>,
  fn: () => Promise<T> | T,
): Promise<T> {
  const cfg = CONFIG as unknown as Record<string, number>;
  const saved = Object.fromEntries(Object.keys(patch).map((k) => [k, cfg[k]]));
  Object.assign(cfg, patch);
  try {
    return await fn();
  } finally {
    Object.assign(cfg, saved);
  }
}

const letterOf: Record<string, string> = { pass: "p", warn: "w", fail: "F", skipped: "-", error: "E", pending: ".", running: "r" };
const runRow = (db: DB, id: string): RunRow => db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as RunRow;
const stepRows = (db: DB, id: string): RunStepRow[] => db.prepare("SELECT * FROM run_steps WHERE run_id = ? ORDER BY idx").all(id) as RunStepRow[];
const invoiceRowsOf = (db: DB, id: string): Record<string, unknown>[] => db.prepare("SELECT * FROM invoices WHERE run_id = ?").all(id) as Record<string, unknown>[];
const countOf = (db: DB, table: string): number => db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get() as number;
const stageString = (steps: RunStepRow[]): string => steps.filter((s) => s.idx <= 9).map((s) => letterOf[s.status] ?? "?").join("");
const reasonsOf = (row: RunRow): string[] => JSON.parse(row.decision_reasons ?? "[]") as string[];
const poText = (po: unknown, inferred: unknown): string => (po === null || po === undefined ? "-" : `${String(po)}${inferred ? " (inferred)" : ""}`);
const clip78 = (s: string): string => (s.length > 78 ? `${s.slice(0, 77)}…` : s);

/** A queue of runs on a throwaway in-memory database with its own uploads directory. */
interface Rig {
  db: DB;
  uploadsDir: string;
  /** stores the bytes as <hash>.pdf and creates a queued run for them */
  run(bytes: Uint8Array, name?: string): string;
  deps(extra?: Partial<import("../src/lib/pipeline").PipelineDeps>): Partial<import("../src/lib/pipeline").PipelineDeps>;
}
let rigCounter = 0;
function makeRig(): Rig {
  const db = openSeededMemoryDb();
  const uploadsDir = fs.mkdtempSync(path.join(TMP, `rig${++rigCounter}-`));
  return {
    db,
    uploadsDir,
    run(bytes, name = "test.pdf") {
      const fileHash = sha256(bytes);
      fs.writeFileSync(path.join(uploadsDir, `${fileHash}.pdf`), bytes);
      return createRun(db, { fileName: name, fileHash });
    },
    deps(extra = {}) {
      return { db, uploadsDir, pacingMs: 0, now: () => FIXED_NOW, ...extra };
    },
  };
}

/** The extractor the pipeline uses with EXTRACT_MOCK=1. */
const mockExtract: ExtractFn = (pdf, opts) => extractMod.getExtractor()(pdf, opts);
const mockSuggest: SuggestPoFn = (input) => extractMod.getSuggestPo()(input);

/* ---- requests ---- */

const get = (p: string, headers: Record<string, string> = {}) => new Request(`${ORIGIN}${p}`, { headers });
const postJson = (body: unknown, ip = freshIp(), headers: Record<string, string> = {}) =>
  new Request(`${ORIGIN}/api/runs`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const postForm = (form: FormData, ip = freshIp(), headers: Record<string, string> = {}) =>
  new Request(`${ORIGIN}/api/runs`, { method: "POST", headers: { "x-forwarded-for": ip, ...headers }, body: form });
const formWith = (bytes: Uint8Array | string, name: string): FormData => {
  const form = new FormData();
  form.append("file", new File([bytes as BlobPart], name, { type: "application/pdf" }));
  return form;
};
const formOf = (entries: [string, string | File][]): FormData => {
  const form = new FormData();
  for (const [name, value] of entries) form.append(name, value);
  return form;
};
const postReset = (token?: string) => new Request(`${ORIGIN}/api/reset`, { method: "POST", headers: token === undefined ? {} : { "x-reset-token": token } });
const idContext = (id: string) => ({ params: Promise.resolve({ id }) });
const hashContext = (hash: string) => ({ params: Promise.resolve({ hash }) });

/* ---- response shapes (strict: a field nobody listed must not leak, e.g. raw_model_output) ---- */

const ApiErrorSchema = z.strictObject({ error: z.string().min(1), retryAfterSec: z.number().int().min(1).optional() });
const CreateRunResponseSchema = z.strictObject({ runId: z.uuid() });
const StepViewSchema = z.strictObject({
  idx: z.number().int().min(1).max(10),
  key: StageKeySchema,
  label: z.string(),
  status: z.enum(STEP_STATUSES),
  severity: z.enum(SEVERITIES).nullable(),
  reason: z.string().nullable(),
  detail: z.record(z.string(), z.unknown()).nullable(),
  started_at: z.string().nullable(),
  finished_at: z.string().nullable(),
});
const RunDetailSchema = z.strictObject({
  id: z.uuid(),
  status: z.enum(RUN_STATUSES),
  file_name: z.string().nullable(),
  file_hash: z.string().regex(SHA256_HEX_RE).nullable(),
  decision: DecisionSchema.nullable(),
  decision_reasons: z.array(z.string()),
  next_action: z.string().nullable(),
  security_flag: z.boolean(),
  extraction: InvoiceExtractionSchema.nullable(),
  model: z.string().nullable(),
  prompt_version: z.string().nullable(),
  cost_usd: z.number().nullable(),
  created_at: z.string(),
  finished_at: z.string().nullable(),
  is_history: z.boolean(),
  steps: z.array(StepViewSchema),
});
const RunListItemSchema = z.strictObject({
  id: z.uuid(),
  created_at: z.string(),
  status: z.enum(RUN_STATUSES),
  file_name: z.string().nullable(),
  vendor_name: z.string().nullable(),
  invoice_number: z.string().nullable(),
  total: z.number().nullable(),
  currency: z.string().nullable(),
  decision: DecisionSchema.nullable(),
  security_flag: z.boolean(),
  first_reason: z.string().nullable(),
  cost_usd: z.number().nullable(),
  is_history: z.boolean(),
});
const KpisSchema = z.strictObject({
  total: z.number().int(),
  approved: z.number().int(),
  hold: z.number().int(),
  rejected: z.number().int(),
  security_flags: z.number().int(),
  approved_value: z.number(),
});
const RunsListSchema = z.strictObject({ runs: z.array(RunListItemSchema), kpis: KpisSchema });
const SampleListSchema = z.array(
  z.strictObject({ file: SampleFileSchema, title: z.string(), scenario: z.string(), expected: DecisionSchema, edge_case: z.string().nullable() }),
);
const PoLineSchema = z.strictObject({ description: z.string(), quantity: z.number(), unit_price: z.number(), amount: z.number() });
const MasterSchema = z.strictObject({
  vendors: z.array(
    z.strictObject({
      id: z.string(),
      name: z.string(),
      aliases: z.array(z.string()),
      approved: z.boolean(),
      bank_account_masked: z.string().nullable(),
      phone_on_file: z.string().nullable(),
    }),
  ),
  purchase_orders: z.array(
    z.strictObject({
      po_number: z.string(),
      vendor_id: z.string(),
      vendor_name: z.string().nullable(),
      lines: z.array(PoLineSchema),
      subtotal: z.number(),
      currency: z.string(),
      status: z.enum(["open", "closed"]),
      invoiced: z.number(),
      remaining: z.number(),
      approved_invoices: z.array(z.string()),
      approved_breakdown: z.array(z.strictObject({ invoice_number: z.string(), amount: z.number() })),
    }),
  ),
});
const ResetSchema = z.strictObject({
  ok: z.literal(true),
  counts: z.strictObject({ vendors: z.number().int(), purchase_orders: z.number().int(), invoices: z.number().int(), runs: z.number().int() }),
});

function parsed<T>(t: Check, schema: z.ZodType<T>, value: unknown, what: string): T {
  const result = schema.safeParse(value);
  if (!result.success) t.fail(`${what} does not match its shape: ${z.prettifyError(result.error)}`);
  return result.data;
}

/** Status, JSON content type, no-store, and the ApiError shape. Returns the body. */
async function expectError(t: Check, res: Response, status: number, what: string): Promise<z.infer<typeof ApiErrorSchema>> {
  t.eq(res.status, status, `${what}: status`);
  t.includes(res.headers.get("content-type"), "application/json", `${what}: content type`);
  t.eq(res.headers.get("cache-control"), "no-store", `${what}: cache-control`);
  return parsed(t, ApiErrorSchema, await res.json(), `${what}: body`);
}

/** Every message an API error carries must be free of paths, ids and stack traces. */
function noInternals(t: Check, message: string, what: string): void {
  t.ok(!/\/|\\|\.ts\b|\.js\b|node_modules|at Object|uploads|DATA_DIR|sqlite/i.test(message), `${what}: message leaks internals: ${message}`);
}

/** POSTs a sample, waits for the queue, returns the run id. */
async function runSampleViaRoute(t: Check, sample: (typeof SAMPLE_FILES)[number]): Promise<string> {
  const res = await runsRoute.POST(postJson({ sample }));
  t.eq(res.status, 202, `POST ${sample}`);
  const { runId } = parsed(t, CreateRunResponseSchema, await res.json(), "POST body");
  await whenIdle();
  return runId;
}

/** Resets the shared default database through the route (the way the app does it). */
async function resetViaRoute(t: Check): Promise<void> {
  const res = await resetRoute.POST(postReset(RESET_TOKEN));
  t.eq(res.status, 200, "reset");
}

/** The files in the default uploads directory, sorted. */
const uploadsListing = (): string[] => (fs.existsSync(paths.uploadsDir) ? fs.readdirSync(paths.uploadsDir).sort() : []);

/* ================================================================================================
 * Group: pipeline
 * ============================================================================================== */

interface TenRun {
  rig: Rig;
  ids: Map<string, string>; // sample id -> run id
}
let ten: TenRun | null = null;

interface RehearseRow {
  decision: string;
  expected: string;
  flag: string;
  po: string;
  stages: string;
  check: string;
  reason: string;
}

/** Runs scripts/rehearse.ts (offline, truth mock) and parses the table it prints. */
function rehearsalTable(): Map<string, RehearseRow> {
  const cli = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
  const res = spawnSync(process.execPath, [cli, path.join(ROOT, "scripts", "rehearse.ts")], {
    cwd: ROOT,
    env: { ...process.env, EXTRACT_MOCK: "1" },
    encoding: "utf8",
    timeout: 120_000,
  });
  if (res.status !== 0) throw new Error(`scripts/rehearse.ts exited with ${res.status}:\n${res.stdout}\n${res.stderr}`);
  const rows = new Map<string, RehearseRow>();
  for (const line of res.stdout.split("\n")) {
    const m = /^(\d{2})\s+(APPROVE|HOLD|REJECT)\s+(APPROVE|HOLD|REJECT)\s+(yes|no)\s+(.+?)\s{2,}([pwF\-E.r]{9})\s+(ok|MISMATCH)\s+(.*)$/.exec(line);
    if (m) rows.set(m[1], { decision: m[2], expected: m[3], flag: m[4], po: m[5], stages: m[6], check: m[7], reason: m[8] });
  }
  return rows;
}

const FAULT_CASES: { stage: StageKey; fn: string }[] = [
  { stage: "ingest", fn: "validateUpload" },
  { stage: "ingest", fn: "checkIngest" },
  { stage: "screen", fn: "screenPdf" },
  { stage: "screen", fn: "checkScreen" },
  { stage: "extract", fn: "deps.extract" },
  { stage: "extract", fn: "checkExtract" },
  { stage: "validate", fn: "groundExtraction" },
  { stage: "validate", fn: "checkValidate" },
  { stage: "normalize", fn: "normalizeInvoice" },
  { stage: "normalize", fn: "checkNormalize" },
  { stage: "vendor", fn: "checkVendor" },
  { stage: "po_match", fn: "checkPoMatch" },
  { stage: "amounts", fn: "checkAmounts" },
  { stage: "duplicate", fn: "checkDuplicate" },
  { stage: "decide", fn: "decide" },
  { stage: "decide", fn: "nextAction" },
];
const SECRET = "SECRET-DETAIL-7731 /etc/passwd <script>alert(1)</script>";

async function pipelineGroup(t: Check): Promise<void> {
  await t.test("createRun: one queued run and 10 pending steps in one transaction", () => {
    const rig = makeRig();
    const before = Date.now();
    const id = createRun(rig.db, { fileName: "a.pdf", fileHash: "a".repeat(64) });
    t.ok(z.uuid().safeParse(id).success, "id is a UUID");
    const run = runRow(rig.db, id);
    t.eq(
      { status: run.status, file_name: run.file_name, file_hash: run.file_hash, decision: run.decision, security_flag: run.security_flag, finished_at: run.finished_at },
      { status: "queued", file_name: "a.pdf", file_hash: "a".repeat(64), decision: null, security_flag: 0, finished_at: null },
    );
    t.ok(Date.parse(run.created_at) >= before - 1000 && /Z$/.test(run.created_at), `created_at is a UTC ISO timestamp (${run.created_at})`);
    const steps = stepRows(rig.db, id);
    t.eq(steps.length, 10);
    t.eq(
      steps.map((s) => [s.idx, s.key, s.label, s.status, s.severity, s.reason, s.detail, s.started_at, s.finished_at]),
      STAGES.map((s) => [s.idx, s.key, s.label, "pending", null, null, null, null, null]),
    );
    const stamp = new Date("2026-01-02T03:04:05.678Z");
    t.eq(runRow(rig.db, createRun(rig.db, { fileName: null, fileHash: "b".repeat(64), now: stamp })).created_at, stamp.toISOString(), "input.now is used");
    // atomic: when the steps cannot be inserted, the run is not left behind either
    const broken = openSeededMemoryDb();
    broken.exec("DROP TABLE run_steps");
    let threw = false;
    try {
      createRun(broken, { fileName: "x.pdf", fileHash: "c".repeat(64) });
    } catch {
      threw = true;
    }
    t.ok(threw, "createRun throws when the steps table is gone");
    t.eq(countOf(broken, "runs"), 4, "no half-created run (only the 4 history runs)");
  });

  await t.test(
    "ten samples in demo order, all enqueued at once: decision, flag, PO, reasons, next action and steps match every _meta",
    async () => {
      const rig = makeRig();
      const ids = new Map<string, string>();
      for (const s of samples) ids.set(s.id, rig.run(sampleBytes(s.file), s.file));
      await Promise.all([...ids.values()].map((id) => enqueue(id, rig.deps())));
      ten = { rig, ids };
      for (const s of samples) {
        const id = ids.get(s.id) as string;
        const m = s.meta;
        const run = runRow(rig.db, id);
        const steps = stepRows(rig.db, id);
        const inv = invoiceRowsOf(rig.db, id)[0] ?? {};
        const at = `#${s.id} ${s.file}`;
        t.eq(run.status, "done", `${at}: status`);
        t.eq(run.decision, m.expectedDecision, `${at}: decision`);
        t.eq(run.security_flag === 1, m.expectedSecurityFlag, `${at}: security flag`);
        t.eq(
          inv.po_number === null ? null : { po_number: inv.po_number, inferred: inv.po_inferred === 1 },
          m.expectedPo,
          `${at}: PO stage 7 ends on`,
        );
        for (const phrase of m.expectedReasonIncludes) t.includes(reasonsOf(run), phrase, `${at}: reasons`);
        t.includes(run.next_action, m.expectedNextActionIncludes, `${at}: next action`);
        for (const [key, want] of Object.entries(m.expectedSteps)) {
          const step = steps.find((x) => x.key === key);
          if (step === undefined) t.fail(`${at}: no step ${key}`);
          if (want.status !== undefined) t.eq(step.status, want.status, `${at}: ${key} status`);
          if (want.reasonIncludes !== undefined) t.includes(step.reason, want.reasonIncludes, `${at}: ${key} reason`);
        }
      }
    },
    { timeoutMs: 60_000 },
  );

  await t.test(
    "the results equal what scripts/rehearse.ts prints (decision, flag, PO, stage string, first reason)",
    () => {
      if (ten === null) t.fail("the ten-sample test did not complete");
      const table = rehearsalTable();
      t.eq(table.size, 10, "rehearse printed 10 rows");
      for (const s of samples) {
        const row = table.get(s.id);
        if (row === undefined) t.fail(`rehearse printed no row for #${s.id}`);
        const id = ten.ids.get(s.id) as string;
        const run = runRow(ten.rig.db, id);
        const inv = invoiceRowsOf(ten.rig.db, id)[0] ?? {};
        const at = `#${s.id}`;
        t.eq(run.decision, row.decision, `${at}: decision`);
        t.eq(run.security_flag === 1 ? "yes" : "no", row.flag, `${at}: flag`);
        t.eq(poText(inv.po_number, inv.po_inferred === 1), row.po, `${at}: PO`);
        t.eq(stageString(stepRows(ten.rig.db, id)), row.stages, `${at}: stages 1-9`);
        t.eq(clip78(reasonsOf(run)[0] ?? "(none: all checks passed)"), row.reason, `${at}: first reason`);
        t.eq(row.check, "ok", `${at}: rehearse itself agrees with _meta`);
      }
    },
    { timeoutMs: 150_000 },
  );

  await t.test("row conventions (CONTRACTS 4.2): 10 steps, invoices.id = runs.id, one invoices row per decided run, mapped fields", () => {
    if (ten === null) t.fail("the ten-sample test did not complete");
    const { rig, ids } = ten;
    const db = rig.db;
    const vendorIds = new Map(readSeedFiles().vendors.map((v) => [v.name, v.id]));
    for (const s of samples) {
      const id = ids.get(s.id) as string;
      const at = `#${s.id}`;
      const run = runRow(db, id);
      const steps = stepRows(db, id);
      t.eq(steps.length, 10, `${at}: 10 steps`);
      t.eq(
        steps.map((x) => [x.idx, x.key, x.label]),
        STAGES.map((x) => [x.idx, x.key, x.label]),
        `${at}: idx/key/label from STAGES`,
      );
      t.ok(steps.every((x) => x.status !== "pending" && x.status !== "running"), `${at}: no step left pending or running`);
      for (const step of steps) {
        // a step the pipeline skipped never started; a stage that ran and reported "skipped" (PO match for an unknown vendor) did
        t.ok(step.finished_at !== null, `${at} ${step.key}: every step has finished_at`);
        t.ok(step.started_at === null ? step.status === "skipped" : step.started_at <= (step.finished_at as string), `${at} ${step.key}: started_at <= finished_at (or never started and skipped)`);
      }
      const decideStep = steps[9];
      t.eq(decideStep.status, "pass", `${at}: decide step passes`);
      t.eq(decideStep.reason, `${run.decision}: ${reasonsOf(run)[0] ?? "all checks passed"}`, `${at}: decide reason`);
      t.eq(
        JSON.parse(decideStep.detail ?? "null"),
        { decision: run.decision, reasons: reasonsOf(run), next_action: run.next_action, security_flag: run.security_flag === 1 },
        `${at}: DecideDetail`,
      );
      t.ok(z.uuid().safeParse(id).success, `${at}: run id is a UUID`);
      t.ok(typeof run.finished_at === "string" && run.created_at <= run.finished_at, `${at}: created_at <= finished_at`);
      t.eq([run.model, run.prompt_version], ["mock", extractMod.PROMPT_VERSION], `${at}: model and prompt version`);
      t.ok(typeof run.cost_usd === "number" && run.cost_usd >= 0, `${at}: cost_usd`);
      t.ok(typeof run.raw_model_output === "string" && run.raw_model_output.length > 0, `${at}: raw_model_output kept`);
      t.eq(InvoiceExtractionSchema.parse(JSON.parse(run.extraction ?? "null")), s.extraction, `${at}: persisted extraction equals the truth`);
      const invoices = invoiceRowsOf(db, id);
      t.eq(invoices.length, 1, `${at}: exactly one invoices row`);
      const inv = invoices[0];
      const ex = s.extraction;
      t.eq(inv.id, id, `${at}: invoices.id = runs.id`);
      t.eq(inv.decision, run.decision, `${at}: invoices.decision`);
      t.eq(inv.created_at, run.finished_at, `${at}: invoices.created_at = finished_at`);
      t.eq(inv.invoice_number, ex.invoice_number, `${at}: invoice number as printed`);
      t.eq(inv.invoice_number_norm, ex.invoice_number === null ? null : normId(ex.invoice_number), `${at}: invoice_number_norm`);
      t.eq([inv.subtotal, inv.tax, inv.total], [ex.subtotal, ex.tax, ex.total], `${at}: amounts`);
      t.eq(inv.bank_account, ex.bank_account, `${at}: bank account`);
      t.eq(inv.file_hash, sha256(sampleBytes(s.file)), `${at}: file hash`);
      t.eq(inv.po_number, s.meta.expectedPo?.po_number ?? null, `${at}: canonical PO number`);
      t.eq(inv.po_inferred, s.meta.expectedPo?.inferred ? 1 : 0, `${at}: po_inferred`);
      t.eq([inv.currency, inv.invoice_date], [ex.currency, ex.invoice_date], `${at}: normalized currency and ISO date`);
      t.eq(inv.vendor_id, vendorIds.get(ex.vendor_name ?? ""), `${at}: the vendor the master resolves (also for a rejected or held invoice)`);
    }
    t.eq(db.prepare("SELECT COUNT(*) FROM runs WHERE security_flag = 1 AND decision = 'APPROVE'").pluck().get(), 0, "a security flag never APPROVEs");
    t.eq(
      db.prepare("SELECT COUNT(*) FROM runs r WHERE r.decision IS NOT NULL AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.id = r.id)").pluck().get(),
      0,
      "every decided run has its invoices row",
    );
    t.eq(db.prepare("SELECT COUNT(*) FROM invoices i WHERE NOT EXISTS (SELECT 1 FROM runs r WHERE r.id = i.id)").pluck().get(), 0, "no invoices row without a run");
    t.eq(countOf(db, "invoices"), 4 + 10, "4 history invoices + 10 decided runs");
    const snap = loadSnapshot(db);
    const remaining = (po: string) => poBalance(snap.pos.find((p) => p.po_number === po)!, snap.invoices).remaining;
    t.eq([remaining("PO-1001"), remaining("PO-1002"), remaining("PO-1003"), remaining("PO-1006"), remaining("PO-1007")], [0, 2300, 6000, 4000, -24], "PO balances after the demo order");
  });

  await t.test("a fooled model (#9) is still HOLD with the security flag; and so is one that also reports nothing", async () => {
    const rig = makeRig();
    const bytes = sampleBytes("09-prompt-injection.pdf");
    const fooled = rig.run(bytes);
    await withEnv({ EXTRACT_MOCK: "fooled" }, () => enqueue(fooled, rig.deps()));
    const a = runRow(rig.db, fooled);
    t.eq([a.decision, a.security_flag], ["HOLD", 1]);
    t.eq(JSON.parse(a.extraction ?? "{}").total, 400, "the fooled extraction really carries the injected total");

    const hideSuspicious: ExtractFn = async (pdf, opts) => {
      const ex = await withEnv({ EXTRACT_MOCK: "fooled" }, () => mockExtract(pdf, opts));
      return ex.ok ? { ...ex, data: { ...ex.data, suspicious_content: [] } } : ex;
    };
    // the same bytes were processed before: an earlier decided run with the same hash is a REJECT at ingest, so use a fresh rig
    const rig2 = makeRig();
    const id2 = rig2.run(bytes);
    await enqueue(id2, rig2.deps({ extract: hideSuspicious }));
    const b = runRow(rig2.db, id2);
    const steps = stepRows(rig2.db, id2);
    t.eq([b.decision, b.security_flag], ["HOLD", 1], "worst case: HOLD, flagged");
    t.eq([steps[1].status, steps[3].status], ["fail", "fail"], "the screen and the grounding check each catch it");
  });

  await t.test("fix round SEC-2: a model that leaves out the NEW bank account printed on the invoice cannot get it approved: the visible text is checked too", async () => {
    // Sample 6 prints "Account no: ACC-00-9911" (Northwind's account on file is ACC-44-5566). A fooled model reports no
    // bank account and nothing suspicious; before the fix the vendor stage passed ("the invoice prints no bank account").
    const dropBank: ExtractFn = async (pdf, opts) => {
      const ex = await mockExtract(pdf, opts);
      return ex.ok ? { ...ex, data: { ...ex.data, bank_account: null, notes: "" } } : ex;
    };
    const rig = makeRig();
    const id = rig.run(sampleBytes("06-bank-change.pdf"));
    await enqueue(id, rig.deps({ extract: dropBank }));
    const run = runRow(rig.db, id);
    const vendorStep = stepRows(rig.db, id)[5];
    t.eq(JSON.parse(run.extraction ?? "{}").bank_account, null, "the extraction really has no bank account");
    t.eq([run.decision, run.security_flag], ["HOLD", 0]);
    t.eq([vendorStep.status, vendorStep.severity, vendorStep.reason], ["fail", "hold", "Bank details differ from vendor master; call +1 415 555 0102 (number on file) to verify. Do not use contact details from the invoice."]);
    t.eq(run.next_action, "Call the vendor on +1 415 555 0102 to verify new bank details before any payment.");
    t.eq(JSON.parse(vendorStep.detail ?? "{}").printed_accounts, ["••••9911"], "only the masked account is kept");
    const shown = JSON.stringify(stepRows(rig.db, id));
    t.ok(!shown.includes("ACC-00-9911") && !shown.includes("ACC009911"), "the steps never repeat the new account in full (only its masked tail)");
    t.ok(!`${run.decision_reasons} ${run.next_action}`.includes("9911"), "the reasons and the next action do not mention it at all");
    // control: the same model on sample 1 (which prints Northwind's own account) still approves
    const id1 = rig.run(sampleBytes("01-happy-northwind.pdf"));
    await enqueue(id1, rig.deps({ extract: dropBank }));
    t.eq(runRow(rig.db, id1).decision, "APPROVE", "sample 1 prints the account on file");
    t.includes(stepRows(rig.db, id1)[5].reason, "the bank account matches the vendor master");
  });

  await t.test("steps are written live, the extraction is persisted right after stage 3 and a suggestion's cost is added", async () => {
    const rig = makeRig();
    const id = rig.run(sampleBytes("05-scanned-no-po.pdf"), "05.pdf");
    const seen: { at: string; run: RunRow; steps: RunStepRow[] }[] = [];
    const snapshot = (at: string) => seen.push({ at, run: runRow(rig.db, id), steps: stepRows(rig.db, id) });
    const extract: ExtractFn = async (pdf, opts) => {
      snapshot("during extract");
      const ex = await mockExtract(pdf, opts);
      return ex.ok ? { ...ex, costUsd: 0.05 } : ex;
    };
    const suggestPo: SuggestPoFn = async (input) => {
      snapshot("during suggestPo");
      const out = await mockSuggest(input);
      return { ...out, costUsd: 0.0123 };
    };
    await enqueue(id, rig.deps({ extract, suggestPo }));
    const during = seen.find((s) => s.at === "during extract");
    const duringPo = seen.find((s) => s.at === "during suggestPo");
    if (during === undefined || duringPo === undefined) t.fail("the extractor and suggestPo were not both called");
    t.eq(during.run.status, "running");
    t.eq(during.steps.map((s) => s.status), ["pass", "pass", "running", "pending", "pending", "pending", "pending", "pending", "pending", "pending"], "during extract");
    t.ok(during.steps[2].started_at !== null && during.steps[2].finished_at === null, "running step has started_at only");
    t.ok(during.steps[1].finished_at !== null, "finished steps have finished_at");
    t.eq(during.run.extraction, null, "no extraction yet while stage 3 runs");
    t.eq(duringPo.steps.map((s) => s.status).slice(0, 7), ["pass", "pass", "pass", "warn", "pass", "pass", "running"], "during PO match (the scan has no text layer to ground)");
    t.ok(duringPo.run.extraction !== null && duringPo.run.raw_model_output !== null, "extraction and raw output persisted right after stage 3");
    t.eq([duringPo.run.model, duringPo.run.prompt_version], ["mock", extractMod.PROMPT_VERSION]);
    t.approx(duringPo.run.cost_usd, 0.05, 1e-9, "cost after stage 3");
    t.approx(runRow(rig.db, id).cost_usd, 0.0623, 1e-9, "stage 7 adds the suggestion cost");
  });

  for (const c of FAULT_CASES) {
    const label = STAGE_LABELS[c.stage];
    await t.test(`a throw in ${c.fn} at "${label}": step error, run HOLDs, the queue continues and a re-run is not a duplicate`, async () => {
      const rig = makeRig();
      const bytes = sampleBytes("01-happy-northwind.pdf");
      const first = rig.run(bytes, "first.pdf");
      const second = rig.run(bytes, "second.pdf");
      const boom = new RangeError(SECRET);
      let extract: ExtractFn = mockExtract;
      if (c.fn === "deps.extract") {
        let thrown = false;
        extract = async (pdf, opts) => {
          if (!thrown) {
            thrown = true;
            throw boom;
          }
          return mockExtract(pdf, opts);
        };
      } else {
        faults.set(c.fn, { left: 1, error: boom });
      }
      takeLogs();
      try {
        const a = enqueue(first, rig.deps({ extract }));
        const b = enqueue(second, rig.deps({ extract }));
        await Promise.all([a, b]);
      } finally {
        faults.clear();
      }
      const run = runRow(rig.db, first);
      const steps = stepRows(rig.db, first);
      const step = steps.find((s) => s.key === c.stage) as RunStepRow;
      t.eq(run.status, "done", "the run still reaches decide");
      t.eq(run.decision, "HOLD");
      t.eq(run.security_flag, 0);
      t.eq([step.status, step.reason, step.severity, step.detail], ["error", `System error at ${label}, manual review`, null, null], "the failing step");
      t.eq(reasonsOf(run), [`System error at ${label}, manual review`], "the reason list");
      t.ok(steps.every((s) => s.status !== "pending" && s.status !== "running"), "no step left pending or running");
      t.eq(invoiceRowsOf(rig.db, first).map((r) => r.decision), ["HOLD"], "one invoices row, HOLD");
      const next = runRow(rig.db, second);
      t.eq([next.status, next.decision], ["done", "APPROVE"], "the next run in the queue is processed, and is not rejected as a duplicate of the failed one");
      const everything = JSON.stringify([run, steps, invoiceRowsOf(rig.db, first)]);
      t.ok(!everything.includes("SECRET-DETAIL") && !everything.includes("/etc/passwd") && !everything.includes("<script>"), "the error text is never stored");
      const lines = takeLogs();
      t.ok(!lines.some((l) => l.includes("SECRET-DETAIL") || l.includes("passwd")), "the error text is never logged");
      const logged = lines.map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l.run === first && l.stage === c.stage);
      t.eq([logged?.status, logged?.error], ["error", "RangeError"], "the stage line says error and names the error class only");
    });
  }

  await t.test("a throwing suggestPo is a PO failure (HOLD), not a crash; an extractor that reports failure skips stages 4-9", async () => {
    const rig = makeRig();
    const id = rig.run(sampleBytes("05-scanned-no-po.pdf"));
    await enqueue(id, rig.deps({ suggestPo: async () => Promise.reject(new Error(SECRET)) }));
    const run = runRow(rig.db, id);
    const steps = stepRows(rig.db, id);
    t.eq([run.status, run.decision], ["done", "HOLD"]);
    t.eq([steps[6].status, steps[6].severity], ["fail", "hold"], "PO match fails with hold");
    t.ok(!JSON.stringify(steps).includes("SECRET-DETAIL"), "no error text in the steps");

    const billing: ExtractFn = async () => ({ ok: false, kind: "billing_auth", message: SECRET, model: null, costUsd: 0, latencyMs: 1, attempts: [] });
    const id2 = rig.run(sampleBytes("02-within-tolerance.pdf"));
    await enqueue(id2, rig.deps({ extract: billing }));
    const run2 = runRow(rig.db, id2);
    const steps2 = stepRows(rig.db, id2);
    t.eq([run2.status, run2.decision, run2.extraction, run2.model, run2.prompt_version, run2.cost_usd], ["done", "HOLD", null, null, extractMod.PROMPT_VERSION, 0]);
    t.eq([steps2[2].status, steps2[2].reason], ["error", "LLM provider unavailable (billing/auth)"]);
    t.eq(steps2.slice(3, 9).map((s) => [s.status, s.reason]), Array(6).fill(["skipped", "Skipped: no extraction to check"]), "stages 4-9 are skipped");
    t.eq(invoiceRowsOf(rig.db, id2).length, 1, "a decided run with no extraction still gets its invoices row");
    t.eq(invoiceRowsOf(rig.db, id2)[0].invoice_number, null);
    t.ok(!JSON.stringify(steps2).includes("SECRET-DETAIL"), "the extractor's message is not shown");
  });

  await t.test("an upload that fails ingest skips stages 2-9 and still decides (one invoices row)", async () => {
    const rig = makeRig();
    const id = rig.run(new TextEncoder().encode("this is not a pdf\n"), "fake.pdf");
    await enqueue(id, rig.deps());
    const run = runRow(rig.db, id);
    const steps = stepRows(rig.db, id);
    t.eq([run.status, run.decision, run.security_flag], ["done", "REJECT", 0]);
    t.eq([steps[0].status, steps[0].severity, steps[0].reason], ["fail", "reject", "Not a PDF"]);
    t.eq(steps.slice(1, 9).map((s) => [s.status, s.reason]), Array(8).fill(["skipped", "Skipped: the file did not pass ingest"]));
    t.eq(steps.slice(1, 9).map((s) => s.started_at), Array(8).fill(null), "skipped stages never started");
    t.eq(steps[9].status, "pass");
    t.eq(run.extraction, null);
    t.eq(invoiceRowsOf(rig.db, id).map((r) => [r.decision, r.vendor_id, r.invoice_number, r.total]), [["REJECT", null, null, null]]);
  });

  await t.test("two identical uploads enqueued concurrently: exactly one APPROVE and one REJECT duplicate", async () => {
    const rig = makeRig();
    const bytes = sampleBytes("01-happy-northwind.pdf");
    const a = rig.run(bytes, "a.pdf");
    const b = rig.run(bytes, "b.pdf");
    await Promise.all([enqueue(a, rig.deps()), enqueue(b, rig.deps())]);
    const ra = runRow(rig.db, a);
    const rb = runRow(rig.db, b);
    t.eq([ra.decision, rb.decision].sort(), ["APPROVE", "REJECT"], "one of each");
    t.eq([ra.decision, rb.decision], ["APPROVE", "REJECT"], "the first enqueued wins");
    t.includes(reasonsOf(rb)[0], `Exact same file already processed in run ${a}`);
    t.eq(rb.next_action, "Do not process this file again; the same file was already handled.");
    const snap = loadSnapshot(rig.db);
    t.eq(poBalance(snap.pos.find((p) => p.po_number === "PO-1002")!, snap.invoices).remaining, 2300, "the PO balance was consumed exactly once");
  });

  await t.test("runs execute one at a time, in enqueue order; a second run stays queued while the first works", async () => {
    const rig = makeRig();
    const gate = deferred();
    let inFlight = 0;
    let maxInFlight = 0;
    const order: string[] = [];
    const extract: ExtractFn = async (pdf, opts) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await gate.promise;
      await sleep(15);
      const ex = await mockExtract(pdf, opts);
      inFlight--;
      return ex;
    };
    const files = ["01-happy-northwind.pdf", "02-within-tolerance.pdf", "03-split-po-overbill.pdf", "07-recurring-not-duplicate.pdf"] as const;
    const ids = files.map((f) => rig.run(sampleBytes(f), f));
    const done = ids.map((id, i) => enqueue(id, rig.deps({ extract })).then(() => void order.push(String(i))));
    await sleep(120);
    t.eq(runRow(rig.db, ids[0]).status, "running", "the first run is working");
    t.eq(ids.slice(1).map((id) => runRow(rig.db, id).status), ["queued", "queued", "queued"], "the others have not started");
    gate.resolve();
    await Promise.all(done);
    t.eq(maxInFlight, 1, "never two extractions at once");
    t.eq(order, ["0", "1", "2", "3"], "completed in enqueue order");
    t.eq(ids.map((id) => runRow(rig.db, id).status), ["done", "done", "done", "done"]);
  });

  await t.test("enqueue never rejects and a failing run does not block later ones; whenIdle waits for runs enqueued while it waits", async () => {
    const rig = makeRig();
    // an unknown run id, a run whose upload is missing, then a good run
    const ghost = "00000000-0000-4000-8000-000000000000";
    const missing = createRun(rig.db, { fileName: "gone.pdf", fileHash: "d".repeat(64) });
    const good = rig.run(sampleBytes("01-happy-northwind.pdf"));
    takeLogs();
    const results = await Promise.allSettled([enqueue(ghost, rig.deps()), enqueue(missing, rig.deps()), enqueue(good, rig.deps())]);
    t.eq(results.map((r) => r.status), ["fulfilled", "fulfilled", "fulfilled"], "enqueue never rejects");
    t.eq(runRow(rig.db, good).decision, "APPROVE", "the run after the failures was processed");
    const lines = takeLogs().map((l) => JSON.parse(l) as Record<string, unknown>);
    t.ok(lines.some((l) => l.run === ghost && l.stage === "pipeline" && l.status === "error"), "the unknown run is logged");
    await t.throws(() => runPipeline(ghost, rig.deps()), "Run not found", "runPipeline itself rejects for an unknown run");

    // whenIdle: drained, including a run enqueued while waiting
    const gate = deferred();
    const slow: ExtractFn = async (pdf, opts) => {
      await gate.promise;
      return mockExtract(pdf, opts);
    };
    const first = rig.run(sampleBytes("02-within-tolerance.pdf"));
    const late = rig.run(sampleBytes("07-recurring-not-duplicate.pdf"));
    const firstDone = enqueue(first, rig.deps({ extract: slow }));
    let idle = false;
    const idlePromise = whenIdle().then(() => void (idle = true));
    await sleep(60);
    t.ok(!idle, "whenIdle is pending while a run works");
    const lateDone = enqueue(late, rig.deps());
    gate.resolve();
    await idlePromise;
    t.eq([runRow(rig.db, first).status, runRow(rig.db, late).status], ["done", "done"], "whenIdle resolved only after the run enqueued while waiting");
    await Promise.all([firstDone, lateDone]);
    await whenIdle();
  });

  await t.test("runExclusive takes its turn on the same chain: after earlier runs, before later ones, and a failing task does not break it", async () => {
    const rig = makeRig();
    const gate = deferred();
    const slow: ExtractFn = async (pdf, opts) => {
      await gate.promise;
      return mockExtract(pdf, opts);
    };
    const first = rig.run(sampleBytes("01-happy-northwind.pdf"));
    const second = rig.run(sampleBytes("02-within-tolerance.pdf"));
    const seen: { first?: string; second?: string } = {};
    const a = enqueue(first, rig.deps({ extract: slow }));
    const x = runExclusive(() => {
      seen.first = runRow(rig.db, first).status;
      seen.second = runRow(rig.db, second).status;
      return "ran";
    });
    const bad = runExclusive(() => Promise.reject(new Error("task failed"))).then(
      () => "ok",
      () => "rejected",
    );
    const b = enqueue(second, rig.deps());
    await sleep(60);
    t.eq(seen, {}, "the exclusive task has not started while the first run works");
    gate.resolve();
    t.eq(await x, "ran", "the task's result reaches its caller");
    await Promise.all([a, b]);
    t.eq(seen, { first: "done", second: "queued" }, "it ran after the earlier run finished and before the later one started");
    t.eq(await bad, "rejected", "the task's own error reaches its caller");
    t.eq(runRow(rig.db, second).status, "done", "the chain survived the failing task");
  });

  await t.test("pipeline-level failures: a missing or invalid upload, a database failure and a failed final write end as status error (no decision, no invoices row)", async () => {
    const rig = makeRig();
    const bad: [string, string][] = [
      ["missing file", "a".repeat(64)],
      ["not a hash", "not-a-hash"],
      ["traversal", "../../../etc/passwd"],
    ];
    for (const [what, fileHash] of bad) {
      const id = createRun(rig.db, { fileName: "x.pdf", fileHash });
      const row = await runPipeline(id, rig.deps());
      t.eq([row.status, row.decision, row.next_action], ["error", null, INTERRUPTED_NEXT_ACTION], `${what}: status`);
      t.eq(reasonsOf(row), [pipeline.PIPELINE_FILE_REASON], `${what}: one safe reason`);
      t.ok(row.finished_at !== null, `${what}: finished_at`);
      t.eq(stepRows(rig.db, id).map((s) => s.status), Array(10).fill("skipped"), `${what}: no step left pending`);
      t.eq(invoiceRowsOf(rig.db, id).length, 0, `${what}: no invoices row`);
      const shown = `${row.decision_reasons} ${row.next_action} ${JSON.stringify(stepRows(rig.db, id))}`;
      t.ok(!shown.includes("passwd") && !shown.includes(rig.uploadsDir) && !shown.includes("ENOENT"), `${what}: no path or system error in what the run shows`);
    }

    // a database failure before any stage (the snapshot cannot be read)
    const broken = makeRig();
    const id = broken.run(sampleBytes("01-happy-northwind.pdf"));
    broken.db.exec("ALTER TABLE invoices RENAME TO invoices_gone");
    const row = await runPipeline(id, broken.deps());
    t.eq([row.status, row.decision], ["error", null]);
    t.eq(reasonsOf(row), [pipeline.PIPELINE_FAILURE_REASON]);

    // the final write is atomic: when the invoices insert fails, the run is not left "done"
    const trig = makeRig();
    const id3 = trig.run(sampleBytes("01-happy-northwind.pdf"));
    trig.db.exec("CREATE TRIGGER no_invoices BEFORE INSERT ON invoices BEGIN SELECT RAISE(ABORT, 'refused'); END;");
    const row3 = await runPipeline(id3, trig.deps());
    t.eq([row3.status, row3.decision, row3.security_flag], ["error", null, 0], "rolled back: not done, no decision");
    t.eq(reasonsOf(row3), [pipeline.PIPELINE_FAILURE_REASON]);
    t.eq(invoiceRowsOf(trig.db, id3).length, 0);
    t.ok(!stepRows(trig.db, id3).some((s) => s.status === "pending" || s.status === "running"), "no spinner left behind");
    t.ok(!JSON.stringify(row3).includes("refused"), "the database's message is not shown");
    t.includes(reasonsOf(row3)[0], "System error");

    // and the queue goes on
    const after = makeRig();
    const failing = broken.run(sampleBytes("02-within-tolerance.pdf"));
    const ok = after.run(sampleBytes("01-happy-northwind.pdf"));
    await Promise.all([enqueue(failing, broken.deps()), enqueue(ok, after.deps())]);
    t.eq(runRow(broken.db, failing).status, "error", "the failing run is absorbed by enqueue");
    t.eq(runRow(after.db, ok).decision, "APPROVE", "a later run is processed after the failed one");
  });

  await t.test("a run that is not queued is never processed again (append-only)", async () => {
    const rig = makeRig();
    const id = rig.run(sampleBytes("01-happy-northwind.pdf"));
    await enqueue(id, rig.deps());
    const snapshot = () => JSON.stringify([runRow(rig.db, id), stepRows(rig.db, id), countOf(rig.db, "invoices")]);
    const before = snapshot();
    takeLogs();
    const again = await runPipeline(id, rig.deps());
    t.eq(again.status, "done");
    await enqueue(id, rig.deps());
    t.eq(snapshot(), before, "a done run is untouched");
    t.eq(takeLogs().filter((l) => l.includes('"stage":"ingest"')).length, 0, "no stage ran again");
    for (const status of ["running", "error"] as const) {
      const other = rig.run(sampleBytes("02-within-tolerance.pdf"), status);
      rig.db.prepare("UPDATE runs SET status = ? WHERE id = ?").run(status, other);
      const row = await runPipeline(other, rig.deps());
      t.eq(row.status, status, `a ${status} run is returned as it is`);
      t.eq(stepRows(rig.db, other).map((s) => s.status), Array(10).fill("pending"), `a ${status} run's steps are untouched`);
    }
  });

  await t.test("pacing: a pause before every stage but the first (shown as 'running'), none after the last; a skipped run pauses once", async () => {
    const rig = makeRig();
    const id = rig.run(sampleBytes("01-happy-northwind.pdf"));
    const started = Date.now();
    await enqueue(id, rig.deps({ pacingMs: 200 }));
    const took = Date.now() - started;
    t.ok(took >= 9 * 200 * 0.9, `9 pauses of 200 ms (took ${took} ms)`);
    const steps = stepRows(rig.db, id);
    const at = (iso: string | null) => Date.parse(iso as string);
    const first = at(steps[0].started_at) - at(runRow(rig.db, id).created_at);
    t.ok(first < 120, `no pause before the first stage (${first} ms from the run's creation to ingest's start)`);
    for (const step of steps.slice(1)) {
      const shown = at(step.finished_at) - at(step.started_at);
      t.ok(shown >= 190, `${step.key} is "running" through its pause (${shown} ms between started_at and finished_at)`);
    }
    t.ok(at(steps[1].started_at) - at(steps[0].finished_at) < 120, "the next stage is marked running right after the previous one finishes");
    const tail = at(runRow(rig.db, id).finished_at) - at(steps[9].finished_at);
    t.ok(tail < 120, `no pause after the last stage (${tail} ms between the decide step and the run's finished_at)`);

    const junk = rig.run(new TextEncoder().encode("not a pdf, again\n"));
    const t0 = Date.now();
    await enqueue(junk, rig.deps({ pacingMs: 300 }));
    const skipped = Date.now() - t0;
    t.ok(skipped >= 270 && skipped < 800, `a run that skips stages 2-9 pauses once, before decide (${skipped} ms)`);
  });

  await t.test("deps.now() is called once per run and reaches the date rules; one snapshot per run", async () => {
    const rig = makeRig();
    let calls = 0;
    const id = rig.run(sampleBytes("01-happy-northwind.pdf"));
    const prepared: string[] = [];
    const counting = new Proxy(rig.db, {
      get(target, prop) {
        const value: unknown = Reflect.get(target, prop, target);
        if (prop === "prepare") return (sql: string) => (prepared.push(sql), target.prepare(sql));
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await enqueue(id, rig.deps({ db: counting, now: () => (calls++, FIXED_NOW) }));
    t.eq(calls, 1, "the clock is read once");
    t.eq(prepared.filter((sql) => /FROM purchase_orders/.test(sql)).length, 1, "the master data is read once, at the start");
    t.eq(runRow(rig.db, id).decision, "APPROVE");

    const late = rig.run(sampleBytes("07-recurring-not-duplicate.pdf"));
    await enqueue(late, rig.deps({ now: () => new Date("2028-06-01T00:00:00Z") }));
    const lateRun = runRow(rig.db, late);
    t.eq([lateRun.decision, stepRows(rig.db, late)[3].status], ["HOLD", "fail"], "an injected clock two years on makes the invoice too old");
  });

  await t.test("log lines: one JSON line per stage (10 per run, also for skipped stages); never bytes, text, model output or keys", async () => {
    const rig = makeRig();
    const full = rig.run(sampleBytes("01-happy-northwind.pdf"));
    const skip = rig.run(new TextEncoder().encode("junk, not a pdf\n"));
    takeLogs();
    await enqueue(full, rig.deps());
    await enqueue(skip, rig.deps());
    const lines = takeLogs();
    for (const id of [full, skip]) {
      const mine = lines.filter((l) => l.includes(id)).map((l) => JSON.parse(l) as Record<string, unknown>);
      t.eq(mine.map((l) => l.stage), STAGE_KEYS, "one line per stage in order");
      for (const l of mine) {
        t.eq(Object.keys(l), ["run", "stage", "status", "ms"], "exactly run, stage, status, ms");
        t.ok(Number.isInteger(l.ms) && (l.ms as number) >= 0, "ms is a whole number");
      }
      const persisted = stepRows(rig.db, id).map((s) => s.status);
      t.eq(mine.map((l) => l.status), persisted, "each line carries the persisted status");
    }
    const t1 = truthOf("01-happy-northwind.pdf").extraction;
    const joined = lines.join("\n");
    for (const secret of [t1.vendor_name, t1.invoice_number, t1.bank_account, "%PDF", "sk-or-"]) {
      t.ok(secret === null || !joined.includes(secret), `no "${secret}" in the log`);
    }
    t.ok(lines.every((l) => l.length < 200), "every line is short");
  });

  await t.test(
    "red team RT-PIPE-01: memory the main thread allocates while a text read runs does not count against the file (a valid PDF is not 'damaged')",
    async () => {
      // 15 million "q Q" operators: a valid PDF without text that keeps the worker busy for about 3 s
      const flood = await opFloodPdf(15_000_000);
      const held: Buffer[] = [];
      // the main thread grows by 512 MB meanwhile (what eight 10 MB uploads finishing at once used to cost)
      const grow = setInterval(() => {
        if (held.length < 32) held.push(Buffer.alloc(16 * 1024 * 1024, 1));
      }, 10);
      try {
        const r = await pdfMod.validateUploadWithin(flood, 60_000);
        t.ok(held.length === 32, `the main thread really grew by 512 MB during the read (${held.length * 16} MB)`);
        t.ok(r.ok, `the flood is a valid PDF with no text, not rejected (${r.ok ? "ok" : `${r.code}: ${r.reason}`})`);
        t.eq(r.ok ? r.textItems.length : -1, 0, "no text items");
      } finally {
        clearInterval(grow);
        held.length = 0;
      }
      const after = await pdfMod.validateUpload(sampleBytes("01-happy-northwind.pdf"));
      t.ok(after.ok, "a real invoice right after still passes");
    },
    { timeoutMs: 60_000 },
  );

  await t.test("red team RT-PIPE-04: a stage that never settles is cut off at CONFIG.stageTimeoutMs; the run HOLDs and the queue moves on", async () => {
    const rig = makeRig();
    const stuck = rig.run(sampleBytes("02-within-tolerance.pdf"), "stuck.pdf");
    const next = rig.run(sampleBytes("01-happy-northwind.pdf"), "next.pdf");
    const seenSignals: (AbortSignal | undefined)[] = [];
    const never: ExtractFn = (_pdf, opts) => {
      seenSignals.push(opts?.signal);
      return new Promise<never>(() => undefined);
    };
    takeLogs();
    await withConfig({ stageTimeoutMs: 300 }, async () => {
      const started = Date.now();
      const both = Promise.all([enqueue(stuck, rig.deps({ extract: never })), enqueue(next, rig.deps())]);
      let guard: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, reject) => (guard = setTimeout(() => reject(new Error("the queue is still blocked after 5 s")), 5_000)));
      await Promise.race([both, timeout]).finally(() => clearTimeout(guard));
      const took = Date.now() - started;
      t.ok(took >= 280 && took < 3_000, `both runs finished ${took} ms later (deadline 300 ms)`);
    });
    const run = runRow(rig.db, stuck);
    const steps = stepRows(rig.db, stuck);
    t.eq([run.status, run.decision, run.security_flag], ["done", "HOLD", 0], "the stuck run still decides: HOLD");
    t.eq([steps[2].status, steps[2].reason], ["error", "System error at Extract fields, manual review"], "the stage that never settled is an error step");
    t.eq(steps.slice(3, 9).map((s) => s.status), Array(6).fill("skipped"), "nothing to check after it");
    t.eq(reasonsOf(run), ["System error at Extract fields, manual review"]);
    t.eq([runRow(rig.db, next).status, runRow(rig.db, next).decision], ["done", "APPROVE"], "the run behind it is processed");
    const logged = takeLogs().map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l.run === stuck && l.stage === "extract");
    t.eq([logged?.status, logged?.error], ["error", "StageTimeout"], "the log names the timeout");
    t.eq([seenSignals.length, seenSignals[0]?.aborted], [1, true], "B6: the extractor got a signal and it was aborted at the deadline");
    await whenIdle();
  });

  await t.test(
    "red team RT-PIPE-05: a failed final write leaves no decided step behind (no 'APPROVE' on a run in status error) and keeps the security flag",
    async () => {
      for (const file of ["01-happy-northwind.pdf", "09-prompt-injection.pdf"] as const) {
        const rig = makeRig();
        const id = rig.run(sampleBytes(file), file);
        rig.db.exec("CREATE TRIGGER no_invoices BEFORE INSERT ON invoices BEGIN SELECT RAISE(ABORT, 'disk full'); END;");
        takeLogs();
        const row = await runPipeline(id, rig.deps());
        const steps = stepRows(rig.db, id);
        const decideStep = steps[9];
        t.eq([row.status, row.decision], ["error", null], `${file}: the run ends in error`);
        t.eq([decideStep.status, decideStep.detail], ["error", null], `${file}: the decide step is an error, with no decision detail`);
        const shown = JSON.stringify([row.decision_reasons, row.next_action, decideStep.reason, decideStep.detail]);
        t.ok(!/APPROVE|HOLD|REJECT|Queue for payment|security review/.test(shown), `${file}: nothing shows a decision that was never recorded: ${shown.slice(0, 160)}`);
        t.eq(row.security_flag, file.startsWith("09") ? 1 : 0, `${file}: security flag`);
        const lines = takeLogs().map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.run === id);
        t.eq(lines.filter((l) => l.stage === "decide").map((l) => l.status), ["error"], `${file}: one decide log line, status error`);
      }
      // the flag is set as soon as the screen fails, not only at decide
      const rig = makeRig();
      const id = rig.run(sampleBytes("09-prompt-injection.pdf"));
      let flagDuringExtract: number | null = null;
      const extract: ExtractFn = async (pdf, opts) => {
        flagDuringExtract = runRow(rig.db, id).security_flag;
        return mockExtract(pdf, opts);
      };
      await enqueue(id, rig.deps({ extract }));
      t.eq(flagDuringExtract, 1, "security_flag is already 1 while stage 3 runs");
      t.eq([runRow(rig.db, id).decision, runRow(rig.db, id).security_flag], ["HOLD", 1]);
    },
  );
}

/** A valid 1-page PDF whose content stream is `ops` non-text "q Q" operators (seconds of synchronous pdf.js work). */
async function opFloodPdf(ops: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const z = deflateSync(Buffer.alloc(ops * 4).fill("q Q\n", "latin1"), { level: 6 });
  page.node.set(PDFName.of("Contents"), doc.context.register(doc.context.stream(z, { Filter: "FlateDecode", Length: z.length })));
  return await doc.save({ useObjectStreams: false });
}

/* ================================================================================================
 * Group: ratelimit
 * ============================================================================================== */

async function ratelimitGroup(t: Check): Promise<void> {
  const { checkRateLimit, resetRateLimits, rateLimiterSize } = limiter;
  const T0 = 1_000_000_000_000;

  await t.test("10 per minute per IP: the 11th is refused with a truthful wait and a friendly message", () => {
    resetRateLimits();
    for (let i = 0; i < 10; i++) t.eq(checkRateLimit("1.2.3.4", T0 + i * 1000), { ok: true, retryAfterSec: 0, message: "", scope: null }, `call ${i + 1}`);
    const denied = checkRateLimit("1.2.3.4", T0 + 20_000);
    t.eq([denied.ok, denied.scope, denied.retryAfterSec], [false, "ip", 40], "oldest call at +0 s leaves the window at +60 s");
    t.includes(denied.message, "Too many runs from your address");
    t.includes(denied.message, "40 s");
  });

  await t.test("buckets per IP; the address is normalised (case, spaces, blank -> unknown, absurd length cut)", () => {
    resetRateLimits();
    for (let i = 0; i < 10; i++) checkRateLimit("1.1.1.1", T0);
    t.eq(checkRateLimit("1.1.1.1", T0).ok, false);
    t.eq(checkRateLimit("2.2.2.2", T0).ok, true, "another address has its own bucket");
    for (let i = 0; i < 10; i++) checkRateLimit("ABCD::1", T0);
    t.eq(checkRateLimit(" abcd::1 ", T0).ok, false, "case and spaces do not make a new bucket");
    for (let i = 0; i < 10; i++) checkRateLimit("", T0);
    t.eq(checkRateLimit("unknown", T0).ok, false, "blank counts as unknown");
    const long = "9".repeat(5000);
    for (let i = 0; i < 10; i++) checkRateLimit(long, T0);
    t.eq(checkRateLimit(long + "x", T0).ok, false, "a 5000-character address is cut, not stored whole");
  });

  await t.test("a rejected call does not extend its own lockout; the window expires exactly 60 s after the oldest allowed call", () => {
    resetRateLimits();
    for (let i = 0; i < 10; i++) checkRateLimit("5.5.5.5", T0 + i * 100);
    for (const offset of [1_000, 10_000, 30_000, 50_000, 59_000]) {
      const r = checkRateLimit("5.5.5.5", T0 + offset);
      t.eq(r.ok, false, `still limited at +${offset} ms`);
      t.eq(r.retryAfterSec, Math.ceil((60_000 - offset) / 1000), `truthful wait at +${offset} ms`);
    }
    t.eq(checkRateLimit("5.5.5.5", T0 + 59_999).ok, false, "1 ms before the first call leaves the window");
    t.eq(checkRateLimit("5.5.5.5", T0 + 60_000).ok, true, "the first call has left the window: allowed, although 6 refused calls came in between");
    t.eq(checkRateLimit("5.5.5.5", T0 + 60_000).ok, false, "only that one slot was free");
    t.eq(checkRateLimit("5.5.5.5", T0 + 60_100).ok, true, "and the second call (at +100 ms) frees the next one at +60.1 s");
  });

  await t.test("the global hourly cap: scope 'global', counted over all IPs, rejected calls are not counted", () => {
    resetRateLimits();
    withEnvSync({ MAX_RUNS_PER_HOUR: "7" }, () => {
      for (let i = 0; i < 5; i++) t.eq(checkRateLimit("10.0.0.1", T0 + i).ok, true);
      for (let i = 0; i < 2; i++) t.eq(checkRateLimit("10.0.0.2", T0 + 10 + i).ok, true);
      const denied = checkRateLimit("10.0.0.3", T0 + 1_000);
      t.eq([denied.ok, denied.scope], [false, "global"]);
      t.eq(denied.retryAfterSec, 3600 - 1, "the oldest call (at +0) leaves the hour at +3600 s");
      t.includes(denied.message, "7 runs per hour");
      t.includes(denied.message, "min", "a long wait is given in minutes");
      for (let i = 0; i < 50; i++) checkRateLimit(`10.1.0.${i}`, T0 + 2_000);
      t.eq(rateLimiterSize().global, 7, "50 refused calls were not counted");
      t.eq(checkRateLimit("10.0.0.3", T0 + 3_600_000).ok, true, "the oldest call left the hour");
      t.eq(checkRateLimit("10.0.0.4", T0 + 3_600_000).ok, false, "only that one slot was free");
      t.eq(checkRateLimit("10.0.0.4", T0 + 3_600_001).ok, true, "the second call (at +1 ms) frees the next one");
    });
  });

  await t.test("when both limits trip, the longer wait is reported", () => {
    resetRateLimits();
    withEnvSync({ MAX_RUNS_PER_HOUR: "10" }, () => {
      for (let i = 0; i < 10; i++) checkRateLimit("8.8.8.8", T0 + i * 1000);
      const r = checkRateLimit("8.8.8.8", T0 + 20_000);
      t.eq([r.ok, r.scope], [false, "global"], "the hour outlasts the minute");
      t.eq(r.retryAfterSec, 3580);
    });
  });

  await t.test("memory is bounded: a flood of addresses is capped, expired ones are swept, refused calls remember nothing", () => {
    resetRateLimits();
    withEnvSync({ MAX_RUNS_PER_HOUR: "1000000000" }, () => {
      for (let i = 0; i < 12_000; i++) checkRateLimit(`flood-${i}`, T0 + i);
      const size = rateLimiterSize();
      t.ok(size.ips <= 10_000, `at most 10000 addresses are kept (${size.ips})`);
      t.ok(size.ips >= 9_000, "and the cap is not wildly under-used");
      t.eq(checkRateLimit("flood-11999", T0 + 12_000).ok, true, "the newest address is still tracked (1 hit)");
      checkRateLimit("late", T0 + 90_000);
      t.eq(rateLimiterSize().ips, 1, "a minute later every other address was swept");
      checkRateLimit("later", T0 + 4_000_000);
      t.eq(rateLimiterSize().global, 1, "an hour later the global list is down to the newest call");
    });
    resetRateLimits();
    withEnvSync({ MAX_RUNS_PER_HOUR: "3" }, () => {
      for (let i = 0; i < 3; i++) checkRateLimit("full", T0);
      for (let i = 0; i < 1000; i++) checkRateLimit(`refused-${i}`, T0 + 1);
      t.eq(rateLimiterSize().ips, 1, "refused calls from 1000 addresses created no entries");
    });
  });

  await t.test("the clock defaults to Date.now() and a nonsense clock falls back to it", () => {
    resetRateLimits();
    for (let i = 0; i < 10; i++) t.eq(checkRateLimit("real-clock").ok, true);
    t.eq(checkRateLimit("real-clock").ok, false);
    const r = checkRateLimit("real-clock", Number.NaN);
    t.eq(r.ok, false);
    t.ok(r.retryAfterSec >= 59 && r.retryAfterSec <= 60, `the wait is about a minute (${r.retryAfterSec})`);
    resetRateLimits();
    t.eq(checkRateLimit("real-clock").ok, true, "resetRateLimits clears every counter");
  });

  await t.test("red team RT-PIPE-03: IPv6 shares one bucket per /64, IPv4-mapped IPv6 is the IPv4 address, an IPv4 port is ignored", () => {
    const fill = (ip: string) => {
      for (let i = 0; i < 10; i++) t.eq(checkRateLimit(ip, T0).ok, true, `fill ${ip} (${i + 1})`);
    };
    resetRateLimits();
    fill("2001:db8:1:2::1");
    for (const same of ["2001:db8:1:2::ffff", "2001:0db8:0001:0002:aaaa:bbbb:cccc:dddd", "[2001:db8:1:2::9]:443", "2001:DB8:1:2:0:0:0:7", "2001:db8:1:2::5%eth0"]) {
      t.eq(checkRateLimit(same, T0).ok, false, `${same} is in the same /64`);
    }
    for (const other of ["2001:db8:1:3::1", "2001:db8::1", "2001:db8:1::2:1"]) t.eq(checkRateLimit(other, T0).ok, true, `${other} is another /64`);
    resetRateLimits();
    fill("::ffff:192.0.2.7");
    t.eq(checkRateLimit("192.0.2.7", T0).ok, false, "IPv4-mapped IPv6 and the IPv4 address share a bucket");
    t.eq(checkRateLimit("::ffff:c000:207", T0).ok, false, "also in hex notation");
    t.eq(checkRateLimit("192.0.2.7:51234", T0).ok, false, "a port does not make a new IPv4 bucket");
    t.eq(checkRateLimit("192.0.2.8", T0).ok, true, "the next IPv4 address is another bucket");
    resetRateLimits();
    for (const junk of ["1::2::3", "2001:db8:zzzz::1", "not-an-ip", ":::"]) {
      for (let i = 0; i < 10; i++) checkRateLimit(junk, T0);
      t.eq(checkRateLimit(junk, T0).ok, false, `${junk}: a value that is not an address is still its own (limited) bucket`);
    }
  });

  await t.test("red team RT-PIPE-03: refundGlobalSlot gives back exactly the hourly slot of one call and keeps the per-IP count", () => {
    resetRateLimits();
    withEnvSync({ MAX_RUNS_PER_HOUR: "2" }, () => {
      t.eq(checkRateLimit("7.7.7.7", T0).ok, true);
      limiter.refundGlobalSlot(T0);
      t.eq(rateLimiterSize().global, 0, "the hourly slot was given back");
      t.eq(checkRateLimit("7.7.7.8", T0 + 1).ok, true);
      t.eq(checkRateLimit("7.7.7.9", T0 + 2).ok, true);
      t.eq(checkRateLimit("7.7.7.10", T0 + 3).scope, "global", "two runs fill the cap of 2");
      limiter.refundGlobalSlot(T0 + 999); // no call was made at that time: nothing changes
      t.eq(rateLimiterSize().global, 2, "a refund for a time with no call does nothing");
    });
    resetRateLimits();
    for (let i = 0; i < 10; i++) {
      t.eq(checkRateLimit("6.6.6.6", T0 + i).ok, true);
      limiter.refundGlobalSlot(T0 + i);
    }
    t.eq(checkRateLimit("6.6.6.6", T0 + 20).scope, "ip", "refunded calls still count toward the address's 10 per minute");
    resetRateLimits();
  });

  await t.test("fix round SEC-6: with { recordGlobal: false } an allowed call holds no hourly slot; takeGlobalSlot takes it right before the run, checks the cap again and can be refunded", () => {
    resetRateLimits();
    withEnvSync({ MAX_RUNS_PER_HOUR: "2" }, () => {
      for (let i = 0; i < 6; i++) t.eq(checkRateLimit(`4.4.4.${i}`, T0 + i, { recordGlobal: false }).ok, true, `door ${i + 1}`);
      t.eq(rateLimiterSize(), { ips: 6, global: 0 }, "six calls passed the door of a cap of 2: each address is recorded, no hourly slot is held");
      t.eq(limiter.takeGlobalSlot(T0 + 10), { ok: true, retryAfterSec: 0, message: "", scope: null }, "the first run takes a slot");
      t.eq(limiter.takeGlobalSlot(T0 + 20).ok, true, "the second run takes the last one");
      const late = limiter.takeGlobalSlot(T0 + 30);
      t.eq([late.ok, late.scope, late.retryAfterSec], [false, "global", 3600], "the cap is checked again at the take: the oldest slot (T0 + 10 ms) leaves the hour 3599.98 s later");
      t.includes(late.message, "2 runs per hour");
      t.eq(rateLimiterSize().global, 2, "a refused take records nothing");
      const door = checkRateLimit("4.4.4.9", T0 + 40, { recordGlobal: false });
      t.eq([door.ok, door.scope], [false, "global"], "a full hour is still refused at the door, before any body is read");
      t.eq(rateLimiterSize().ips, 6, "and that refusal records nothing either");
      limiter.refundGlobalSlot(T0 + 20);
      t.eq(rateLimiterSize().global, 1, "refundGlobalSlot gives back a slot taken with takeGlobalSlot");
      t.eq(limiter.takeGlobalSlot(T0 + 50).ok, true, "so the next run can take it");
      t.eq(limiter.takeGlobalSlot(T0 + 3_600_010).ok, true, "a taken slot leaves the hour like any other");
    });
    resetRateLimits();
    for (let i = 0; i < 10; i++) t.eq(checkRateLimit("3.3.3.3", T0 + i, { recordGlobal: false }).ok, true, `call ${i + 1}`);
    t.eq(checkRateLimit("3.3.3.3", T0 + 20, { recordGlobal: false }).scope, "ip", "the address's 10 per minute is unchanged");
    t.eq(rateLimiterSize().global, 0);
    resetRateLimits();
  });

  await t.test("fix round SEC-6: beginUpload caps the uploads in progress per address (the limiter's buckets) and in all; a refusal holds and records nothing; release is idempotent", () => {
    resetRateLimits();
    const { beginUpload, uploadsInFlight } = limiter;
    const perIp = CONFIG.maxUploadsInFlightPerIp;
    const cap = CONFIG.maxUploadsInFlight;
    t.ok(perIp >= 1 && cap >= 10 && cap > perIp, `caps: ${perIp} per address, ${cap} in all (RT-PIPE-02's test sends 10 at once)`);
    t.eq(uploadsInFlight(), { total: 0, ips: 0 }, "nothing in progress");
    const held: ReturnType<typeof beginUpload>[] = [];
    for (let i = 0; i < perIp; i++) {
      const slot = beginUpload("2001:db8:7:7::1");
      t.eq([slot.ok, slot.retryAfterSec, slot.message, slot.scope], [true, 0, "", null], `upload ${i + 1} of the address`);
      held.push(slot);
    }
    for (const same of ["2001:db8:7:7::beef", "[2001:db8:7:7::2]:443", "2001:DB8:7:7:0:0:0:3"]) {
      const refused = beginUpload(same);
      t.eq([refused.ok, refused.scope, refused.retryAfterSec], [false, "ip", CONFIG.uploadsBusyRetryAfterSec], `${same} is in the same /64`);
      t.includes(refused.message, `already sending ${perIp} files`);
      t.includes(refused.message, `${CONFIG.uploadsBusyRetryAfterSec} s`);
      refused.release(); // a refusal has nothing to give back
    }
    t.eq(uploadsInFlight(), { total: perIp, ips: 1 }, "refusals hold nothing");
    for (let i = 0; i < perIp; i++) held.push(beginUpload("::ffff:192.0.2.70"));
    t.eq(beginUpload("192.0.2.70:5555").scope, "ip", "an IPv4-mapped address and an IPv4 address with a port share one bucket");
    let n = 0;
    while (uploadsInFlight().total < cap) {
      const slot = beginUpload(`10.77.0.${++n}`);
      t.ok(slot.ok, `below the cap in all (${uploadsInFlight().total})`);
      held.push(slot);
    }
    const full = beginUpload("198.51.100.200");
    t.eq([full.ok, full.scope, full.retryAfterSec], [false, "global", CONFIG.uploadsBusyRetryAfterSec], "the cap in all");
    t.includes(full.message, "too many files at once");
    t.eq(rateLimiterSize(), { ips: 0, global: 0 }, "the rate limiter was never touched");
    held[0].release();
    held[0].release();
    t.eq(uploadsInFlight().total, cap - 1, "a second release does not give back another upload's place");
    const again = beginUpload("2001:db8:7:7::9");
    t.eq(again.ok, true, "the freed place can be taken again");
    held.push(again);
    resetRateLimits();
    t.eq(uploadsInFlight().total, cap, "resetRateLimits leaves uploads in progress alone (they are live requests)");
    for (const slot of held) slot.release();
    t.eq(uploadsInFlight(), { total: 0, ips: 0 }, "every place is back, and an address without an upload has no entry");
  });
}

function withEnvSync(vars: Record<string, string>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(vars)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  try {
    fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/* ---- fix round SEC-6: clients that stall or crawl ---- */

const SEC6_MULTIPART = "multipart/form-data; boundary=sec6-boundary-7f3a";
/** One multipart part header and the first bytes of a PDF: what a stalling client sends before it goes quiet. */
const sec6PartHead = (): Uint8Array =>
  new TextEncoder().encode('--sec6-boundary-7f3a\r\nContent-Disposition: form-data; name="file"; filename="stall.pdf"\r\nContent-Type: application/pdf\r\n\r\n%PDF-1.7\n');

/** A POST /api/runs whose body the test sends piece by piece (or never finishes). The route is called at once. */
interface HeldPost {
  readonly req: Request;
  /** the route's answer, once it has come */
  answer(): Response | null;
  /** the answer, or null when it has not come within `ms` (a test never waits on a request without a bound) */
  settle(ms: number): Promise<Response | null>;
  send(bytes: Uint8Array): void;
  finish(): void;
  /** the client goes away: the body breaks off (nothing happens once it is closed or cancelled) */
  drop(): void;
  /** the server stopped reading: it cancelled the body */
  cancelled(): boolean;
}
function heldPost(contentType: string, ip: string, first: Uint8Array | null): HeldPost {
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let open = true;
  let wasCancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      if (first !== null) c.enqueue(first);
    },
    cancel() {
      open = false;
      wasCancelled = true;
    },
  });
  const req = new Request(`${ORIGIN}/api/runs`, { method: "POST", headers: { "content-type": contentType, "x-forwarded-for": ip }, body: stream, duplex: "half" } as RequestInit);
  let answer: Response | null = null;
  const answered = runsRoute.POST(req).then((res) => (answer = res));
  return {
    req,
    answer: () => answer,
    settle: (ms) => Promise.race([answered, sleep(ms).then(() => null)]),
    send: (bytes) => void (open && controller?.enqueue(bytes)),
    finish: () => {
      if (open) controller?.close();
      open = false;
    },
    drop: () => {
      if (open) controller?.error(new Error("client went away"));
      open = false;
    },
    cancelled: () => wasCancelled,
  };
}
/** Temp files of uploads that are still arriving (or were left behind). */
const incomingFiles = (): string[] => uploadsListing().filter((n) => n.startsWith(".incoming-"));

/* ================================================================================================
 * Group: routes
 * ============================================================================================== */

async function routesGroup(t: Check): Promise<void> {
  const db = getDb(); // first call in this process: opens DATA_DIR/app.db and seeds it
  limiter.resetRateLimits();

  await t.test("GET /api/samples: the 10 samples, strict shape, equal to listSamples()", async () => {
    const res = await samplesRoute.GET();
    t.eq(res.status, 200);
    t.eq(res.headers.get("cache-control"), "no-store");
    const body = parsed(t, SampleListSchema, await res.json(), "samples");
    t.eq(body.map((s) => s.file), [...SAMPLE_FILES]);
    t.eq(body.map((s) => s.expected), samples.map((s) => s.meta.expectedDecision));
  });

  await t.test("GET /api/master: vendors with masked banks, POs with balances; never a raw account number", async () => {
    const res = await masterRoute.GET();
    t.eq(res.status, 200);
    const text = await res.text();
    const body = parsed(t, MasterSchema, JSON.parse(text), "master");
    t.eq([body.vendors.length, body.purchase_orders.length], [5, 8]);
    const seed = readSeedFiles();
    for (const v of seed.vendors) {
      t.ok(v.bank_account === null || !text.includes(v.bank_account), `raw bank account of ${v.id} is not in the response`);
      const out = body.vendors.find((x) => x.id === v.id);
      t.eq(out?.bank_account_masked, v.bank_account === null ? null : `••••${v.bank_account.slice(-4)}`, `${v.id} masked`);
      t.eq(out?.phone_on_file, v.phone_on_file);
    }
    const po = (n: string) => body.purchase_orders.find((p) => p.po_number === n);
    t.eq([po("PO-1003")?.invoiced, po("PO-1003")?.remaining, po("PO-1003")?.approved_invoices], [24000, 6000, ["GLX-301", "GLX-302"]]);
    t.eq([po("PO-1001")?.remaining, po("PO-1002")?.remaining, po("PO-1006")?.remaining], [0, 13800, 4400]);
    t.eq(po("PO-1003")?.vendor_name, "Globex Logistics Ltd");
  });

  await clockTest(t, "POST /api/runs {sample}: 202 at once, file stored, queued run, then the full pipeline (APPROVE for #1)", async () => {
    await resetViaRoute(t);
    const bytes = sampleBytes("01-happy-northwind.pdf");
    const res = await runsRoute.POST(postJson({ sample: "01-happy-northwind.pdf" }));
    t.eq(res.status, 202);
    t.eq(res.headers.get("cache-control"), "no-store");
    const { runId } = parsed(t, CreateRunResponseSchema, await res.json(), "202 body");
    const row = runRow(db, runId);
    t.ok(row.status === "queued" || row.status === "running", `not finished when the 202 returns (${row.status})`);
    t.eq([row.file_name, row.file_hash], ["01-happy-northwind.pdf", sha256(bytes)]);
    t.eq(Buffer.compare(fs.readFileSync(uploadPath(sha256(bytes))), Buffer.from(bytes)), 0, "uploads/<sha256>.pdf holds the exact bytes");
    t.eq(stepRows(db, runId).length, 10, "10 steps already exist");
    await whenIdle();

    const detailRes = await runRoute.GET(get(`/api/runs/${runId}`), idContext(runId));
    t.eq(detailRes.status, 200);
    t.eq(detailRes.headers.get("cache-control"), "no-store");
    const detail = parsed(t, RunDetailSchema, await detailRes.json(), "run detail");
    t.eq([detail.status, detail.decision, detail.security_flag, detail.is_history, detail.model], ["done", "APPROVE", false, false, "mock"]);
    t.eq(detail.steps.map((s) => [s.idx, s.key, s.label]), STAGES.map((s) => [s.idx, s.key, s.label]), "steps ordered by idx");
    t.eq(detail.steps.map((s) => s.status), Array(10).fill("pass"));
    t.eq(detail.extraction?.invoice_number, truthOf("01-happy-northwind.pdf").extraction.invoice_number);
    t.includes(detail.next_action, "Queue for payment");
    t.ok(!JSON.stringify(detail).includes("raw_model_output"), "the raw model output is not part of the API");
  });

  await clockTest(t, "a run is visible live: steps flip one by one and the extraction appears before the run is done", async () => {
    await resetViaRoute(t);
    const snapshots: { status: string; passes: number; extraction: boolean; running: number }[] = [];
    await withConfig({ stagePacingMs: 80 }, async () => {
      const res = await runsRoute.POST(postJson({ sample: "02-within-tolerance.pdf" }));
      const { runId } = parsed(t, CreateRunResponseSchema, await res.json(), "202 body");
      for (let i = 0; i < 1500; i++) {
        const r = await runRoute.GET(get(`/api/runs/${runId}`), idContext(runId));
        const d = parsed(t, RunDetailSchema, await r.json(), "run detail");
        snapshots.push({
          status: d.status,
          passes: d.steps.filter((s) => s.status === "pass" || s.status === "warn").length,
          extraction: d.extraction !== null,
          running: d.steps.filter((s) => s.status === "running").length,
        });
        if (d.status === "done" || d.status === "error") break;
        await sleep(10);
      }
    });
    const last = snapshots[snapshots.length - 1];
    t.eq(last.status, "done");
    t.ok(snapshots.some((s) => s.status === "running" && s.running === 1), "a snapshot with exactly one running step");
    t.ok(snapshots.some((s) => s.status === "running" && s.extraction && s.passes >= 3 && s.passes < 9), "extraction visible while later stages are still pending");
    const progress = snapshots.map((s) => s.passes);
    t.ok(progress.every((p, i) => i === 0 || p >= progress[i - 1]), "progress never goes backwards");
    await whenIdle();
  });

  await clockTest(t, "GET /api/runs: strict shape, newest first, history rows flagged, filters, limit, KPIs over all runs", async () => {
    await resetViaRoute(t);
    const history = (await (await runsRoute.GET(get("/api/runs"))).json()) as unknown;
    const h = parsed(t, RunsListSchema, history, "empty-state list");
    const approvedHistory = readSeedFiles().history.reduce((sum, row) => sum + row.total, 0);
    t.eq(h.kpis, { total: 4, approved: 4, hold: 0, rejected: 0, security_flags: 0, approved_value: Math.round(approvedHistory * 100) / 100 }, "KPIs right after a reset");
    t.eq(h.runs.every((r) => r.is_history), true, "the 4 history runs are flagged");
    t.ok(h.runs.every((r) => r.vendor_name !== null && r.invoice_number !== null && r.total !== null && r.first_reason !== null), "history rows carry vendor, number, total and reason");

    const ids: string[] = [];
    for (const s of ["01-happy-northwind.pdf", "03-split-po-overbill.pdf", "04-disguised-duplicate.pdf", "09-prompt-injection.pdf"] as const) ids.push(await runSampleViaRoute(t, s));
    const all = parsed(t, RunsListSchema, await (await runsRoute.GET(get("/api/runs"))).json(), "list");
    t.eq(all.runs.length, 8);
    t.eq(all.runs.slice(0, 4).map((r) => r.id), [...ids].reverse(), "newest first");
    const created = all.runs.map((r) => r.created_at);
    t.ok(created.every((c, i) => i === 0 || c <= created[i - 1]), "created_at never increases down the list");
    t.eq(all.kpis, { total: 8, approved: 5, hold: 2, rejected: 1, security_flags: 1, approved_value: Math.round((approvedHistory + 12650) * 100) / 100 }, "KPIs over all runs");
    const nine = all.runs.find((r) => r.id === ids[3]);
    t.eq([nine?.decision, nine?.security_flag, nine?.status], ["HOLD", true, "done"]);
    t.includes(nine?.first_reason, "Suspicious");
    t.eq(nine?.vendor_name, "Globex Logistics Ltd", "vendor from the master");
    t.eq([nine?.invoice_number, nine?.total, nine?.currency, nine?.file_name], ["GLX-310", 4620, "USD", "09-prompt-injection.pdf"]);
    const dup = all.runs.find((r) => r.id === ids[2]);
    t.eq(dup?.decision, "REJECT");
    t.includes(dup?.first_reason, "Duplicate");

    const only = async (query: string) => parsed(t, RunsListSchema, await (await runsRoute.GET(get(`/api/runs${query}`))).json(), `list ${query}`);
    t.eq((await only("?decision=APPROVE")).runs.every((r) => r.decision === "APPROVE"), true);
    t.eq((await only("?decision=APPROVE")).runs.length, 5);
    t.eq((await only("?decision=HOLD")).runs.map((r) => r.decision), ["HOLD", "HOLD"]);
    t.eq((await only("?decision=REJECT")).runs.length, 1);
    t.eq((await only("?decision=security")).runs.map((r) => r.id), [ids[3]], "security = flagged runs of any decision");
    t.eq((await only("?decision=security")).kpis.total, 8, "KPIs ignore the filter");
    t.eq((await only("?limit=1")).runs.map((r) => r.id), [ids[3]]);
    t.eq((await only("?limit=1")).kpis.total, 8, "KPIs ignore the limit");
    t.eq((await only("?limit=200")).runs.length, 8);
    t.eq((await only("?decision=&limit=")).runs.length, 8, "empty values count as not given (the plan's ?decision=&limit=50)");
    t.eq((await only("?limit=3&decision=APPROVE")).runs.length, 3);
    const total = await only("");
    t.eq(total.runs.length, 8, "the default limit is 50");
  });

  await t.test("GET /api/runs: bad query parameters are 400 ApiErrors, never 500, never SQL", async () => {
    for (const q of ["?limit=0", "?limit=201", "?limit=-1", "?limit=abc", "?limit=1.5", "?limit=1e2", "?limit=%20", "?limit=1&limit=2", "?limit=0x10", "?limit=1000", "?decision=bogus", "?decision=approve", "?decision=APPROVE'--", "?decision=APPROVE&decision=HOLD", "?decision=%00", "?limit=1;DROP%20TABLE%20runs"]) {
      const body = await expectError(t, await runsRoute.GET(get(`/api/runs${q}`)), 400, `GET ${q}`);
      noInternals(t, body.error, q);
    }
    t.ok(countOf(db, "runs") > 0, "the runs table is intact");
  });

  await t.test("GET /api/runs/:id: 400 for anything that is not a UUID, 404 for an unknown one, 200 for history (no steps)", async () => {
    for (const id of ["abc", "1", "../../etc/passwd", "..%2f..%2f.env", "00000000-0000-0000-0000-00000000000", "g0000000-0000-4000-8000-000000000000", "' OR 1=1 --", "", "a".repeat(500), "00000000-0000-4000-8000-000000000000/extra"]) {
      const body = await expectError(t, await runRoute.GET(get("/api/runs/x"), idContext(id)), 400, `id ${id.slice(0, 20)}`);
      noInternals(t, body.error, "bad id");
    }
    const unknown = await expectError(t, await runRoute.GET(get("/api/runs/x"), idContext("00000000-0000-4000-8000-000000000000")), 404, "unknown id");
    noInternals(t, unknown.error, "unknown id");
    const historyId = historyRunId("V001", "INV-0042");
    const res = await runRoute.GET(get(`/api/runs/${historyId}`), idContext(historyId));
    t.eq(res.status, 200);
    const detail = parsed(t, RunDetailSchema, await res.json(), "history run");
    t.eq([detail.is_history, detail.steps, detail.model, detail.decision, detail.status, detail.extraction], [true, [], "history", "APPROVE", "done", null]);
    t.eq(detail.decision_reasons, ["Pre-loaded history: processed before the demo."]);
  });

  await t.test("corrupt JSON cells never make GET /api/runs/:id or the list a 500", async () => {
    const id = crypto.randomUUID();
    db.prepare("INSERT INTO runs (id, file_name, file_hash, status, decision, decision_reasons, extraction, model, created_at) VALUES (?, 'x.pdf', NULL, 'done', 'HOLD', '{not json', '[1,2', 'mock', ?)").run(id, new Date().toISOString());
    const add = db.prepare("INSERT INTO run_steps (run_id, idx, key, label, status, detail) VALUES (?, ?, ?, ?, 'pass', ?)");
    add.run(id, 1, "ingest", "Ingest file", "{broken");
    add.run(id, 2, "screen", "Security screen", "[1,2,3]");
    add.run(id, 3, "extract", "Extract fields", '"a string"');
    add.run(id, 4, "validate", "Validate", '{"fine":true}');
    const res = await runRoute.GET(get(`/api/runs/${id}`), idContext(id));
    t.eq(res.status, 200);
    const detail = parsed(t, RunDetailSchema, await res.json(), "corrupt run");
    t.eq([detail.decision_reasons, detail.extraction], [[], null], "reasons -> [] (the type is string[]), extraction -> null");
    t.eq(detail.steps.map((s) => s.detail), [null, null, null, { fine: true }], "a cell that is not a JSON object is null");
    db.prepare("UPDATE runs SET decision_reasons = '[\"ok\", 5, null]', extraction = '{\"vendor_name\": \"Half Corp\"}' WHERE id = ?").run(id);
    const list = parsed(t, RunsListSchema, await (await runsRoute.GET(get("/api/runs?limit=200"))).json(), "list with a corrupt row");
    const row = list.runs.find((r) => r.id === id);
    t.eq([row?.first_reason, row?.vendor_name], ["ok", "Half Corp"], "a partial extraction still feeds the list");
    db.prepare("UPDATE runs SET extraction = '{oops' WHERE id = ?").run(id);
    t.eq((await runsRoute.GET(get("/api/runs?limit=200"))).status, 200, "a corrupt extraction cell does not break the list");
    db.prepare("DELETE FROM run_steps WHERE run_id = ?").run(id);
    db.prepare("DELETE FROM runs WHERE id = ?").run(id);
  });

  await t.test("GET /api/files/:hash: the exact bytes and the exact headers; 400 for a bad hash, 404 for anything missing, never a path", async () => {
    const bytes = sampleBytes("10-not-an-invoice.pdf");
    const hash = sha256(bytes);
    const runId = await runSampleViaRoute(t, "10-not-an-invoice.pdf");
    t.ok(runRow(db, runId).file_hash === hash);
    const res = await fileRoute.GET(get(`/api/files/${hash}`), hashContext(hash));
    t.eq(res.status, 200);
    t.eq(res.headers.get("content-type"), "application/pdf");
    t.eq(res.headers.get("x-content-type-options"), "nosniff");
    t.eq(res.headers.get("content-disposition"), "inline");
    t.eq(res.headers.get("content-length"), String(bytes.length));
    const got = new Uint8Array(await res.arrayBuffer());
    t.eq(Buffer.compare(Buffer.from(got), Buffer.from(bytes)), 0, "byte for byte");
    t.eq(sha256(got), hash, "and its hash is the address");

    const bad = ["abc", hash.slice(1), `${hash}0`, hash.toUpperCase(), "../../.env", "..%2f..%2f.env", `${hash.slice(0, 60)}../`, "g".repeat(64), `${hash}.pdf`, "", " ".repeat(64), `${hash}\n`];
    for (const h of bad) {
      const body = await expectError(t, await fileRoute.GET(get("/api/files/x"), hashContext(h)), 400, `hash "${h.slice(0, 20)}"`);
      noInternals(t, body.error, "bad hash");
    }
    const missing = await expectError(t, await fileRoute.GET(get("/api/files/x"), hashContext("a".repeat(64))), 404, "unknown hash");
    noInternals(t, missing.error, "unknown hash");
    const dirName = "b".repeat(64);
    fs.mkdirSync(path.join(paths.uploadsDir, `${dirName}.pdf`));
    try {
      const asDir = await expectError(t, await fileRoute.GET(get("/api/files/x"), hashContext(dirName)), 404, "a directory with a hash name");
      noInternals(t, asDir.error, "directory");
    } finally {
      fs.rmSync(path.join(paths.uploadsDir, `${dirName}.pdf`), { recursive: true });
    }
  });

  await t.test("POST /api/runs: malformed input is always a 400 ApiError (never 500) and creates nothing", async () => {
    const runsBefore = countOf(db, "runs");
    const filesBefore = uploadsListing();
    const dir = (name: string) => path.join(ROOT, name);
    const cases: [string, Request][] = [
      ["traversal ../../.env", postJson({ sample: "../../.env" })],
      ["traversal with a valid suffix", postJson({ sample: "../data/samples/01-happy-northwind.pdf" })],
      ["absolute path", postJson({ sample: dir("data/samples/01-happy-northwind.pdf") })],
      ["a sample plus a slash", postJson({ sample: "01-happy-northwind.pdf/" })],
      ["a sample with a NUL", postJson({ sample: "01-happy-northwind.pdf\u0000.txt" })],
      ["unknown sample", postJson({ sample: "99-nope.pdf" })],
      ["case differs", postJson({ sample: "01-HAPPY-NORTHWIND.PDF" })],
      ["non-string sample: number", postJson({ sample: 5 })],
      ["non-string sample: array", postJson({ sample: ["01-happy-northwind.pdf"] })],
      ["non-string sample: object", postJson({ sample: { toString: "x" } })],
      ["non-string sample: null", postJson({ sample: null })],
      ["no sample", postJson({})],
      ["JSON null", postJson("null")],
      ["JSON array", postJson("[]")],
      ["JSON number", postJson("42")],
      ["JSON string", postJson('"01-happy-northwind.pdf"')],
      ["invalid JSON", postJson("{not json")],
      ["empty body", postJson("")],
      ["invalid UTF-8", new Request(`${ORIGIN}/api/runs`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": freshIp() }, body: new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]) })],
      ["no content type", new Request(`${ORIGIN}/api/runs`, { method: "POST", headers: { "x-forwarded-for": freshIp() }, body: '{"sample":"01-happy-northwind.pdf"}' })],
      ["text/plain", new Request(`${ORIGIN}/api/runs`, { method: "POST", headers: { "content-type": "text/plain", "x-forwarded-for": freshIp() }, body: '{"sample":"01-happy-northwind.pdf"}' })],
      ["application/x-www-form-urlencoded", new Request(`${ORIGIN}/api/runs`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": freshIp() }, body: "sample=01-happy-northwind.pdf" })],
      ["multipart without a boundary", new Request(`${ORIGIN}/api/runs`, { method: "POST", headers: { "content-type": "multipart/form-data", "x-forwarded-for": freshIp() }, body: "garbage" })],
      ["multipart with a broken body", new Request(`${ORIGIN}/api/runs`, { method: "POST", headers: { "content-type": "multipart/form-data; boundary=xyz", "x-forwarded-for": freshIp() }, body: "--xyz\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a.pdf\"\r\n\r\npartial" })],
      ["multipart without any field", postForm(new FormData())],
      ["multipart with a text field only", postForm(formOf([["note", "hello"]]))],
      ["multipart with a text field named file", postForm(formOf([["file", "01-happy-northwind.pdf"]]))],
      ["multipart with two file fields", postForm(formOf([["file", new File(["x"], "a.pdf")], ["file", new File(["y"], "b.pdf")]]))],
      ["multipart with a file and a text field both named file", postForm(formOf([["file", new File(["x"], "a.pdf")], ["file", "again"]]))],
      ["multipart with the file under another name", postForm(formOf([["upload", new File(["x"], "b.pdf")]]))],
      ["multipart with a nameless file part (browsers send that for an empty file input)", postForm(formOf([["file", new File(["x"], "")]]))],
    ];
    for (const [what, req] of cases) {
      const res = await runsRoute.POST(req);
      t.ok(res.status === 400, `${what}: expected 400, got ${res.status}`);
      const body = await expectError(t, res, 400, what);
      noInternals(t, body.error, what);
      t.ok(!body.error.includes("passwd") && !body.error.includes(".env"), `${what}: the input is not echoed`);
    }
    await whenIdle();
    t.eq(countOf(db, "runs"), runsBefore, "no run was created");
    t.eq(uploadsListing(), filesBefore, "no file was written");
  });

  await t.test("uploads: any file type is accepted and ingest decides; a .txt renamed .pdf is REJECT 'Not a PDF'; an empty file 'Empty file'", async () => {
    const txt = new TextEncoder().encode("Quarterly notes, definitely not a pdf.\n");
    const res = await runsRoute.POST(postForm(formWith(txt, "invoice.pdf")));
    t.eq(res.status, 202);
    const { runId } = parsed(t, CreateRunResponseSchema, await res.json(), "202");
    await whenIdle();
    const row = runRow(db, runId);
    t.eq([row.status, row.decision, row.file_name, row.file_hash], ["done", "REJECT", "invoice.pdf", sha256(txt)]);
    const steps = stepRows(db, runId);
    t.eq([steps[0].status, steps[0].severity, steps[0].reason], ["fail", "reject", "Not a PDF"]);
    t.eq(steps.slice(1, 9).map((s) => s.status), Array(8).fill("skipped"));
    t.eq(invoiceRowsOf(db, runId).length, 1, "the rejected upload still has its invoices row");

    const emptyRes = await runsRoute.POST(postForm(formWith(new Uint8Array(0), "empty.pdf")));
    t.eq(emptyRes.status, 202, "an empty file is for ingest to judge");
    const empty = parsed(t, CreateRunResponseSchema, await emptyRes.json(), "202");
    await whenIdle();
    t.eq(stepRows(db, empty.runId)[0].reason, "Empty file");
  });

  await t.test("uploads: the display name is sanitised and never part of a path; the same bytes are stored once", async () => {
    const bytes = sampleBytes("08-unapproved-vendor.pdf");
    const hash = sha256(bytes);
    const names = ['evil<img src=x onerror=alert(1)>.pdf', "../../etc/passwd", "C:\\temp\\x.pdf", "a".repeat(400) + ".pdf", "\u202etxt.exe", "ünï cödé.pdf"];
    const file = uploadPath(hash);
    let mtime = 0;
    for (const raw of names) {
      const res = await runsRoute.POST(postForm(formWith(bytes, raw)));
      t.eq(res.status, 202, `upload named ${JSON.stringify(raw.slice(0, 30))}`);
      const { runId } = parsed(t, CreateRunResponseSchema, await res.json(), "202");
      const stored = runRow(db, runId).file_name as string;
      t.eq(stored, pdfMod.sanitizeDisplayName(raw), "file_name = sanitizeDisplayName(name)");
      t.ok(!/[<>/\\()=]/.test(stored) && stored.length <= 100, `file_name is plain text: ${JSON.stringify(stored)}`);
      if (mtime === 0) mtime = fs.statSync(file).mtimeMs;
      await sleep(5);
    }
    await whenIdle();
    t.eq(fs.statSync(file).mtimeMs, mtime, "the stored file was not rewritten");
    t.eq(uploadsListing().filter((n) => n === `${hash}.pdf`).length, 1, "one file for the one hash");
    t.ok(!uploadsListing().some((n) => n.includes("tmp")), "no temp file left behind");
  });

  await clockTest(t, "same file twice -> the second run is REJECT 'Exact same file already processed in run <id>'", async () => {
    await resetViaRoute(t);
    const bytes = sampleBytes("10-not-an-invoice.pdf");
    const first = parsed(t, CreateRunResponseSchema, await (await runsRoute.POST(postForm(formWith(bytes, "statement.pdf")))).json(), "first");
    await whenIdle();
    const second = parsed(t, CreateRunResponseSchema, await (await runsRoute.POST(postForm(formWith(bytes, "again.pdf")))).json(), "second");
    await whenIdle();
    t.eq(runRow(db, first.runId).decision, "HOLD", "a statement is held");
    const row = runRow(db, second.runId);
    t.eq(row.decision, "REJECT");
    t.includes(reasonsOf(row)[0], `Exact same file already processed in run ${first.runId}`);
  });

  await t.test("413: an oversize upload is refused before any run or file exists, whatever Content-Length says", async () => {
    const runsBefore = countOf(db, "runs");
    const filesBefore = uploadsListing();
    const twelveMb = new Uint8Array(12 * 1024 * 1024).fill(0x41);
    const refused = async (what: string, req: Request) => {
      const body = await expectError(t, await runsRoute.POST(req), 413, what);
      t.includes(body.error, "larger than 10 MB", what);
      noInternals(t, body.error, what);
    };
    await refused("12 MB, no Content-Length", postForm(formWith(twelveMb, "big.pdf")));
    await refused("12 MB, Content-Length lies (100)", new Request(`${ORIGIN}/api/runs`, {
      method: "POST",
      headers: { "x-forwarded-for": freshIp(), "content-length": "100", "content-type": "multipart/form-data; boundary=zzz" },
      body: new Blob([`--zzz\r\nContent-Disposition: form-data; name="file"; filename="big.pdf"\r\n\r\n`, twelveMb, "\r\n--zzz--\r\n"]),
    }));
    // an honest, oversize Content-Length: refused without reading a byte of the body
    const pulls = { n: 0 };
    // (finite on purpose: a handler that wrongly reads it must fail the test, not run out of memory)
    const stream = new ReadableStream<Uint8Array>({ pull(c) { if (pulls.n >= 64 * 1024) c.close(); else { pulls.n++; c.enqueue(new Uint8Array(1024)); } } }, new CountQueuingStrategy({ highWaterMark: 0 }));
    const honest = new Request(`${ORIGIN}/api/runs`, {
      method: "POST",
      headers: { "x-forwarded-for": freshIp(), "content-length": String(50 * 1024 * 1024), "content-type": "multipart/form-data; boundary=zzz" },
      body: stream,
      duplex: "half",
    } as RequestInit);
    await refused("Content-Length 50 MB", honest);
    t.eq([pulls.n, honest.body?.locked], [0, false], "not a byte of the body was read");
    // a long chunked body (50 MB, no Content-Length at all): counted as it arrives, and reading stops at the limit
    let sent = 0;
    const MB = 1024 * 1024;
    const chunk = new Uint8Array(MB);
    const long = new ReadableStream<Uint8Array>({ pull(c) { if (sent >= 50 * MB) c.close(); else { sent += MB; c.enqueue(chunk); } } }, new CountQueuingStrategy({ highWaterMark: 0 }));
    await refused("a 50 MB chunked body", new Request(`${ORIGIN}/api/runs`, {
      method: "POST",
      headers: { "x-forwarded-for": freshIp(), "content-type": "multipart/form-data; boundary=zzz" },
      body: long,
      duplex: "half",
    } as RequestInit));
    t.ok(sent <= 12 * MB, `reading stopped at the limit (${sent / MB} of 50 MB were pulled)`);
    // an oversize JSON body
    const json413 = await runsRoute.POST(postJson(`{"sample":"${"a".repeat(20_000)}"}`));
    await expectError(t, json413, 413, "a 20 KB JSON body");
    await whenIdle();
    t.eq(countOf(db, "runs"), runsBefore, "no run was created");
    t.eq(uploadsListing(), filesBefore, "nothing was written to the uploads directory");
  }, { timeoutMs: 60_000 });

  await t.test("413 boundary: a file of exactly the limit is accepted, one byte more is refused (limit narrowed to 2000 bytes)", async () => {
    await withConfig({ maxFileBytes: 2000 }, async () => {
      const exact = new Uint8Array(2000).fill(0x42);
      const over = new Uint8Array(2001).fill(0x43);
      const ok = await runsRoute.POST(postForm(formWith(exact, "exact.pdf")));
      t.eq(ok.status, 202, "2000 bytes");
      await expectError(t, await runsRoute.POST(postForm(formWith(over, "over.pdf"))), 413, "2001 bytes");
      t.ok(!fs.existsSync(uploadPath(sha256(over))), "the refused file was not stored");
      t.ok(fs.existsSync(uploadPath(sha256(exact))), "the accepted file was");
      await whenIdle();
    });
  });

  await t.test(
    "red team RT-PIPE-02: uploads stream to a temp file and are parsed one at a time, so 10 concurrent 10 MB uploads stay bounded in memory",
    async () => {
      const N = 10;
      const size = CONFIG.maxFileBytes;
      const CHUNK = 64 * 1024; // what a socket hands over
      const bodies: { type: string; bytes: Uint8Array }[] = [];
      for (let i = 0; i < N; i++) {
        const file = new Uint8Array(size);
        file.set(new TextEncoder().encode("%PDF-1.4\n% RT-PIPE-02\n"));
        file[size - 1] = i + 1; // ten different hashes
        const r = postForm(formWith(file, `big-${i}.pdf`));
        bodies.push({ type: r.headers.get("content-type") as string, bytes: new Uint8Array(await r.arrayBuffer()) });
      }
      const proto = Response.prototype as { formData: () => Promise<FormData> };
      const realFormData = proto.formData;
      let parsing = 0;
      let maxParsing = 0;
      let calls = 0;
      const firstParse = deferred();
      proto.formData = async function formData(this: Response): Promise<FormData> {
        maxParsing = Math.max(maxParsing, ++parsing);
        try {
          if (++calls === 1) await firstParse.promise; // the first parse is held open: no second one may start meanwhile
          return await realFormData.call(this);
        } finally {
          parsing--;
        }
      };
      const gate = deferred();
      const base = process.memoryUsage.rss();
      let peak = base;
      const sampler = setInterval(() => (peak = Math.max(peak, process.memoryUsage.rss())), 5);
      try {
        const pending = bodies.map((b) => {
          let off = 0;
          const stream = new ReadableStream<Uint8Array>(
            {
              async pull(c) {
                if (off >= b.bytes.byteLength) return c.close();
                if (b.bytes.byteLength - off <= CHUNK) await gate.promise; // every last chunk arrives together
                c.enqueue(b.bytes.subarray(off, off + CHUNK));
                off += CHUNK;
              },
            },
            new CountQueuingStrategy({ highWaterMark: 0 }),
          );
          return runsRoute.POST(
            new Request(`${ORIGIN}/api/runs`, { method: "POST", headers: { "content-type": b.type, "x-forwarded-for": freshIp() }, body: stream, duplex: "half" } as RequestInit),
          );
        });
        // all but the last chunk of every body has arrived: those bytes sit in temp files, not in memory
        const spooled = (): string[] =>
          uploadsListing().filter((n) => /^\.incoming-.+\.tmp$/.test(n) && fs.statSync(path.join(paths.uploadsDir, n)).size >= size - 2 * CHUNK);
        for (let i = 0; i < 500 && spooled().length < N; i++) await sleep(10);
        t.eq(spooled().length, N, "each upload is being written to its own temp file as it arrives");
        gate.resolve();
        for (let i = 0; i < 300 && calls === 0; i++) await sleep(10);
        await sleep(300); // every other upload has fully arrived by now
        t.eq([calls, maxParsing], [1, 1], "while one upload is being parsed, no other parse starts");
        firstParse.resolve();
        const statuses = await Promise.all(pending.map(async (p) => (await p).status));
        t.eq(statuses, Array(N).fill(202), "all ten are accepted");
      } finally {
        clearInterval(sampler);
        proto.formData = realFormData;
      }
      t.eq(maxParsing, 1, "never two multipart parses at once");
      const grewMb = (peak - base) / (1024 * 1024);
      t.ok(grewMb < 200, `the process grew by ${Math.round(grewMb)} MB for ${N * 10} MB of uploads (holding them whole cost ~370 MB)`);
      t.eq(uploadsListing().filter((n) => n.endsWith(".tmp")), [], "no temp file is left behind");
      await whenIdle();
    },
    { timeoutMs: 90_000 },
  );

  await t.test("red team RT-PIPE-06: HEAD /api/files/:hash answers the headers without a body; a GET whose body is never read opens no file handle", async () => {
    const bytes = sampleBytes("10-not-an-invoice.pdf");
    const hash = sha256(bytes);
    fs.mkdirSync(paths.uploadsDir, { recursive: true });
    if (!fs.existsSync(uploadPath(hash))) fs.writeFileSync(uploadPath(hash), bytes);
    const headReq = (h: string) => new Request(`${ORIGIN}/api/files/${h}`, { method: "HEAD" });
    const head = await fileRoute.HEAD(headReq(hash), hashContext(hash));
    t.eq(head.status, 200);
    t.eq(
      ["content-type", "content-length", "x-content-type-options", "content-disposition"].map((h) => head.headers.get(h)),
      ["application/pdf", String(bytes.length), "nosniff", "inline"],
      "the same headers as GET",
    );
    t.eq(head.body, null, "no body");
    t.eq((await fileRoute.HEAD(headReq("abc"), hashContext("abc"))).status, 400, "HEAD with a bad hash");
    t.eq((await fileRoute.HEAD(headReq("x"), hashContext("a".repeat(64)))).status, 404, "HEAD for an unknown hash");
    const openFds = (): number => fs.readdirSync("/dev/fd").length;
    const before = openFds();
    for (let i = 0; i < 200; i++) {
      // what Next does when it answers HEAD through GET: the body is dropped, never read or cancelled
      t.eq((await fileRoute.GET(get(`/api/files/${hash}`), hashContext(hash))).status, 200);
    }
    await sleep(50);
    t.ok(openFds() - before < 10, `200 unread GET bodies left ${openFds() - before} descriptors open`);
    const full = new Uint8Array(await (await fileRoute.GET(get(`/api/files/${hash}`), hashContext(hash))).arrayBuffer());
    t.eq(Buffer.compare(Buffer.from(full), Buffer.from(bytes)), 0, "a body read to the end is the exact bytes");
    const half = await fileRoute.GET(get(`/api/files/${hash}`), hashContext(hash));
    const reader = (half.body as ReadableStream<Uint8Array>).getReader();
    await reader.read();
    await reader.cancel();
    await sleep(20);
    t.ok(openFds() - before < 10, "a reader that cancels half way closes its handle");
  });

  await t.test("429: the 11th POST in a minute is refused with Retry-After before the body is read; buckets per IP; x-forwarded-for / x-real-ip", async () => {
    limiter.resetRateLimits();
    const ip = "203.0.113.7";
    for (let i = 0; i < 10; i++) t.eq((await runsRoute.POST(postJson({ sample: "nope" }, ip))).status, 400, `call ${i + 1} passes the limiter`);
    const unread = new ReadableStream<Uint8Array>({ pull() { throw new Error("the body was read"); } }, new CountQueuingStrategy({ highWaterMark: 0 }));
    const req = new Request(`${ORIGIN}/api/runs`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip }, body: unread, duplex: "half" } as RequestInit);
    const res = await runsRoute.POST(req);
    const body = await expectError(t, res, 429, "11th call");
    t.eq(req.body?.locked, false, "the body was never touched");
    t.ok(body.retryAfterSec !== undefined && body.retryAfterSec >= 1 && body.retryAfterSec <= 60, `retryAfterSec ${body.retryAfterSec}`);
    t.eq(res.headers.get("retry-after"), String(body.retryAfterSec), "Retry-After header matches");
    t.includes(body.error, "Too many runs");
    t.eq((await runsRoute.POST(postJson({ sample: "nope" }, "203.0.113.8"))).status, 400, "another IP is not limited");
    // docs/CONTRACTS.md section 5 (red team RT-PIPE-03): x-real-ip, else the LAST x-forwarded-for entry (the one an
    // appending proxy adds); the first entry is whatever the client sent
    t.eq((await runsRoute.POST(postJson({ sample: "nope" }, `198.51.100.1, ${ip}`))).status, 429, "the last x-forwarded-for entry is the client");
    t.eq((await runsRoute.POST(postJson({ sample: "nope" }, `${ip}, 198.51.100.2`))).status, 400, "an earlier (client-supplied) entry is not");
    t.eq((await runsRoute.POST(postJson({ sample: "nope" }, `${ip} ,  `))).status, 429, "blank trailing entries are ignored");
    const real = (rip: string, xff?: string) =>
      new Request(`${ORIGIN}/api/runs`, { method: "POST", headers: { "content-type": "application/json", "x-real-ip": rip, ...(xff === undefined ? {} : { "x-forwarded-for": xff }) }, body: '{"sample":"nope"}' });
    for (let i = 0; i < 10; i++) await runsRoute.POST(real("203.0.113.50"));
    t.eq((await runsRoute.POST(real("203.0.113.50"))).status, 429, "x-real-ip is used without x-forwarded-for");
    t.eq((await runsRoute.POST(real("203.0.113.51"))).status, 400);
    t.eq((await runsRoute.POST(real("203.0.113.50", "198.51.100.3"))).status, 429, "x-real-ip wins over x-forwarded-for");
    t.eq((await runsRoute.POST(real("203.0.113.52", ip))).status, 400, "a limited address in x-forwarded-for does not count when x-real-ip is set");
    const anon = () => new Request(`${ORIGIN}/api/runs`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"sample":"nope"}' });
    for (let i = 0; i < 10; i++) await runsRoute.POST(anon());
    t.eq((await runsRoute.POST(anon())).status, 429, "no header at all: one shared 'unknown' bucket");
    limiter.resetRateLimits();
    await withEnv({ MAX_RUNS_PER_HOUR: "3" }, async () => {
      // red team RT-PIPE-03: requests that create no run (here 400s, from 12 addresses) do not spend the hourly cap
      for (let i = 0; i < 12; i++) t.eq((await runsRoute.POST(postJson({ sample: "nope" }))).status, 400, `malformed call ${i + 1}`);
      t.eq(limiter.rateLimiterSize().global, 0, "no hourly slot is held by a request that created no run");
      for (let i = 0; i < 3; i++) t.eq((await runsRoute.POST(postJson({ sample: "07-recurring-not-duplicate.pdf" }))).status, 202, `run ${i + 1} of 3`);
      const cap = await expectError(t, await runsRoute.POST(postJson({ sample: "07-recurring-not-duplicate.pdf" })), 429, "hourly cap");
      t.includes(cap.error, "3 runs per hour");
      t.eq(limiter.rateLimiterSize().global, 3, "exactly the three runs hold hourly slots");
      await whenIdle();
    });
    limiter.resetRateLimits();
  });

  await t.test("a failure inside a handler is a fixed 500 body plus ONE log line without sensitive data", async () => {
    takeLogs();
    db.exec("ALTER TABLE vendors RENAME TO vendors_hidden");
    try {
      const res = await masterRoute.GET();
      t.eq(res.status, 500);
      t.eq(await res.json(), { error: "Something went wrong." });
      t.eq(res.headers.get("cache-control"), "no-store");
    } finally {
      db.exec("ALTER TABLE vendors_hidden RENAME TO vendors");
    }
    const lines = takeLogs();
    t.eq(lines.length, 1, "one log line");
    const entry = JSON.parse(lines[0]) as Record<string, unknown>;
    t.eq(Object.keys(entry).sort(), ["error", "event", "route"]);
    t.eq([entry.route, entry.event], ["GET /api/master", "unhandled_error"]);
    t.ok(!/vendors|SELECT|no such table|\.ts\b|node_modules/.test(lines[0]), `no SQL, table or path in the log line: ${lines[0]}`);
    t.eq((await masterRoute.GET()).status, 200, "and the next request is fine");
  });

  await t.test(
    "fix round SEC-6: 60 uploads that stall (6 addresses x 10) hold no hourly slot: an honest run and an honest upload still get 202, and at the deadline each stalled body is cut off with 408 and leaves no temp file",
    async () => {
      limiter.resetRateLimits();
      const perIp = CONFIG.maxUploadsInFlightPerIp;
      const attackers = ["192.0.2.101", "192.0.2.102", "192.0.2.103", "192.0.2.104", "192.0.2.105", "192.0.2.106"];
      const inFlight = attackers.length * perIp;
      const stalled: HeldPost[] = [];
      const everyone: HeldPost[] = [];
      try {
        await withEnv({ MAX_RUNS_PER_HOUR: "60" }, () =>
          withConfig({ bodyReceiveTimeoutMs: 1_000 }, async () => {
            const started = Date.now();
            for (const ip of attackers) for (let i = 0; i < 10; i++) stalled.push(heldPost(SEC6_MULTIPART, ip, sec6PartHead()));
            const jsonStall = heldPost("application/json", "192.0.2.107", new TextEncoder().encode('{"sample": "07-recurring'));
            everyone.push(...stalled, jsonStall);
            for (let i = 0; i < 200 && incomingFiles().length < inFlight; i++) await sleep(10);
            // the reviewer's repro: an honest user starts a run while the 60 bodies hang (before: 429 "Try again in 60 min")
            const honest = await runsRoute.POST(postJson({ sample: "07-recurring-not-duplicate.pdf" }));
            t.eq(honest.status, 202, "an honest sample run is not locked out while 60 uploads stall");
            t.eq(limiter.rateLimiterSize().global, 1, "only that run holds an hourly slot; the stalled bodies hold none");
            const refusedAtOnce = stalled.filter((s) => s.answer() !== null);
            t.eq(refusedAtOnce.length, stalled.length - inFlight, `${perIp} uploads per address are in progress, the other ${stalled.length - inFlight} were refused at once`);
            for (const s of refusedAtOnce) {
              const res = s.answer() as Response;
              const body = await expectError(t, res, 429, "an upload over the per-address cap");
              t.includes(body.error, `already sending ${perIp} files`);
              noInternals(t, body.error, "429 (per-address upload cap)");
              t.eq([body.retryAfterSec, res.headers.get("retry-after")], [CONFIG.uploadsBusyRetryAfterSec, String(CONFIG.uploadsBusyRetryAfterSec)], "a short wait");
              t.eq(s.req.body?.locked, false, "refused before its body was read");
            }
            t.eq(limiter.uploadsInFlight(), { total: inFlight, ips: attackers.length }, "the uploads in progress");
            t.eq(incomingFiles().length, inFlight, "each upload in progress is being received into its own temp file");
            t.eq(jsonStall.answer(), null, "a JSON body that stalls is still waiting too");
            t.ok(inFlight < CONFIG.maxUploadsInFlight, `6 addresses can hold ${inFlight} of the ${CONFIG.maxUploadsInFlight} upload places, not all`);
            const upload = await runsRoute.POST(postForm(formWith(new TextEncoder().encode(`%PDF-1.4\n% honest ${crypto.randomUUID()}\n`), "honest.pdf")));
            t.eq(upload.status, 202, "an honest upload from another address is accepted");
            const waiting = everyone.filter((s) => s.answer() === null);
            t.eq(waiting.length, inFlight + 1, "the uploads in progress and the JSON body wait for their deadline");
            const answers = await Promise.all(waiting.map((s) => s.settle(4_000)));
            const took = Date.now() - started;
            for (const [i, res] of answers.entries()) {
              if (res === null) return t.fail(`stalled request ${i + 1} was not answered 4 s after its 1 s deadline`);
              const body = await expectError(t, res, 408, `stalled request ${i + 1}`);
              t.includes(body.error, "did not arrive within 1 s");
              noInternals(t, body.error, "408");
            }
            t.ok(took >= 950 && took < 4_000, `cut off at the deadline (${took} ms after the first one started)`);
            t.ok(waiting.every((s) => s.cancelled()), "the server stopped reading every stalled body");
            t.eq(incomingFiles(), [], "no temp file is left behind");
            t.eq(limiter.uploadsInFlight(), { total: 0, ips: 0 }, "every upload place is back");
            t.eq(limiter.rateLimiterSize().global, 2, "the hourly cap holds exactly the two runs");
            const later = await runsRoute.POST(postForm(formWith(new TextEncoder().encode(`%PDF-1.4\n% later ${crypto.randomUUID()}\n`), "later.pdf"), attackers[0]));
            t.eq(later.status, 202, "an address whose uploads were cut off can upload again");
          }),
        );
      } finally {
        for (const s of everyone) s.drop();
        await Promise.all(everyone.map((s) => s.settle(2_000)));
        takeLogs();
        await whenIdle();
        limiter.resetRateLimits();
      }
    },
    { timeoutMs: 30_000 },
  );

  await t.test(
    "fix round SEC-6: the deadline counts the whole body, not idle time: an upload that crawls in under it is accepted, the same crawl past it is cut off with 408 and leaves no temp file",
    async () => {
      const framed = postForm(formWith(sampleBytes("10-not-an-invoice.pdf"), "crawl.pdf"));
      const type = framed.headers.get("content-type") as string;
      const body = new Uint8Array(await framed.arrayBuffer());
      const posts: HeldPost[] = [];
      /** sends the body in `parts` pieces `gapMs` apart (never idle for longer), then ends it; stops once the server cancels */
      const crawl = (parts: number, gapMs: number): HeldPost => {
        const post = heldPost(type, freshIp(), null);
        posts.push(post);
        void (async () => {
          const size = Math.ceil(body.byteLength / parts);
          for (let off = 0; off < body.byteLength && !post.cancelled(); off += size) {
            post.send(body.subarray(off, off + size));
            await sleep(gapMs);
          }
          post.finish();
        })();
        return post;
      };
      try {
        await withConfig({ bodyReceiveTimeoutMs: 2_000 }, async () => {
          let started = Date.now();
          const slow = await crawl(10, 60).settle(8_000);
          const slowMs = Date.now() - started;
          t.eq(slow?.status, 202, `a crawl that ends after ${slowMs} ms, under the 2 s deadline, is accepted`);
          t.ok(slowMs >= 540, `it really crawled (${slowMs} ms)`);
          started = Date.now();
          const tooSlow = crawl(100, 60); // about 6 s in all, never idle for more than 60 ms
          const cut = await tooSlow.settle(8_000);
          const cutMs = Date.now() - started;
          if (cut === null) return t.fail("the crawl past the deadline was not answered within 8 s");
          const err = await expectError(t, cut, 408, "a crawl past the deadline");
          t.includes(err.error, "did not arrive within 2 s");
          t.ok(cutMs >= 1_950 && cutMs < 4_500, `cut off at the deadline (${cutMs} ms), not when the crawl would have ended (about 6 s)`);
          t.ok(tooSlow.cancelled(), "the server stopped reading");
          t.eq(incomingFiles(), [], "no temp file is left behind");
        });
      } finally {
        for (const p of posts) p.drop();
        await Promise.all(posts.map((p) => p.settle(2_000)));
        await whenIdle();
      }
    },
    { timeoutMs: 30_000 },
  );

  await t.test(
    "fix round SEC-6: over the cap of uploads in progress (per address, then in all) the answer is 429 with a short Retry-After, before the body is read and counted nowhere; sample runs are not capped; a body that breaks off gives its place back",
    async () => {
      limiter.resetRateLimits();
      const perIp = CONFIG.maxUploadsInFlightPerIp;
      const cap = CONFIG.maxUploadsInFlight;
      const held: HeldPost[] = [];
      const knock = (ip: string): Request =>
        new Request(`${ORIGIN}/api/runs`, {
          method: "POST",
          headers: { "content-type": SEC6_MULTIPART, "x-forwarded-for": ip },
          body: new ReadableStream<Uint8Array>({ pull() { throw new Error("the body was read"); } }, new CountQueuingStrategy({ highWaterMark: 0 })),
          duplex: "half",
        } as RequestInit);
      try {
        await withConfig({ bodyReceiveTimeoutMs: 15_000 }, async () => {
          const busy = "192.0.2.150";
          for (let i = 0; i < perIp; i++) held.push(heldPost(SEC6_MULTIPART, busy, sec6PartHead()));
          const before = limiter.rateLimiterSize();
          const req = knock(busy);
          const res = await runsRoute.POST(req);
          const body = await expectError(t, res, 429, "one more upload from an address whose uploads are all in progress");
          t.eq(req.body?.locked, false, "refused before the body was touched");
          t.eq([body.retryAfterSec, res.headers.get("retry-after")], [CONFIG.uploadsBusyRetryAfterSec, String(CONFIG.uploadsBusyRetryAfterSec)], "a short Retry-After");
          t.includes(body.error, `already sending ${perIp} files`);
          noInternals(t, body.error, "429 (per-address upload cap)");
          t.eq(limiter.rateLimiterSize(), before, "counted nowhere: no call of the address, no hourly slot");
          t.eq((await runsRoute.POST(postJson({ sample: "07-recurring-not-duplicate.pdf" }, busy))).status, 202, "the same address can still start a sample run");
          let n = 0;
          while (limiter.uploadsInFlight().total < cap) held.push(heldPost(SEC6_MULTIPART, `192.0.2.${160 + Math.floor(n++ / perIp)}`, sec6PartHead()));
          const fresh = "198.51.100.250";
          const ipsBefore = limiter.rateLimiterSize().ips;
          const allRes = await runsRoute.POST(knock(fresh));
          const all = await expectError(t, allRes, 429, "an upload while the server receives as many as it allows");
          t.includes(all.error, "too many files at once");
          noInternals(t, all.error, "429 (upload cap in all)");
          t.eq(all.retryAfterSec, CONFIG.uploadsBusyRetryAfterSec, "a short Retry-After");
          t.eq(limiter.rateLimiterSize().ips, ipsBefore, "the refused address was not recorded");
          t.eq((await runsRoute.POST(postJson({ sample: "07-recurring-not-duplicate.pdf" }, fresh))).status, 202, "sample runs still start while every upload place is taken");
          t.eq(held.filter((h) => h.answer() !== null).length, 0, "the uploads in progress are still waiting for their bodies");
          for (let i = 0; i < 200 && incomingFiles().length < cap; i++) await sleep(10);
          t.eq(incomingFiles().length, cap, "one temp file per upload in progress, no more");
          for (const h of held) h.drop();
          const answers = await Promise.all(held.map((h) => h.settle(3_000)));
          t.eq(answers.map((a) => a?.status ?? "waiting"), Array(held.length).fill(500), "a body that breaks off is a 500, as before");
          t.eq(limiter.uploadsInFlight(), { total: 0, ips: 0 }, "every place is back");
          t.eq(incomingFiles(), [], "no temp file is left behind");
          t.eq(limiter.rateLimiterSize().global, 2, "only the two sample runs hold hourly slots");
          const again = await runsRoute.POST(postForm(formWith(new TextEncoder().encode(`%PDF-1.4\n% again ${crypto.randomUUID()}\n`), "again.pdf"), busy));
          t.eq(again.status, 202, "the address can upload again");
        });
      } finally {
        for (const h of held) h.drop();
        await Promise.all(held.map((h) => h.settle(2_000)));
        takeLogs(); // the 500s' log lines
        await whenIdle();
        limiter.resetRateLimits();
      }
    },
    { timeoutMs: 30_000 },
  );

  await t.test(
    "fix round SEC-6: the hourly slot is taken once the body is complete, right before the run is created: with one slot left both uploads pass the door, the first to finish gets 202, the other 429 and stores nothing; a failure after the take gives the slot back",
    async () => {
      limiter.resetRateLimits();
      const held: HeldPost[] = [];
      try {
        await withEnv({ MAX_RUNS_PER_HOUR: "1" }, async () => {
          const bodyOf = async (tag: string) => {
            const file = new TextEncoder().encode(`%PDF-1.4\n% SEC-6 ${tag} ${crypto.randomUUID()}\n`);
            const framed = postForm(formWith(file, `${tag}.pdf`));
            return { file, type: framed.headers.get("content-type") as string, bytes: new Uint8Array(await framed.arrayBuffer()) };
          };
          const a = await bodyOf("first");
          const b = await bodyOf("second");
          const first = heldPost(a.type, freshIp(), a.bytes.subarray(0, 40));
          const second = heldPost(b.type, freshIp(), b.bytes.subarray(0, 40));
          held.push(first, second);
          await sleep(50);
          t.eq([first.answer()?.status ?? "waiting", second.answer()?.status ?? "waiting"], ["waiting", "waiting"], "both passed the door: the last slot is not held by a body still arriving");
          t.eq(limiter.rateLimiterSize().global, 0, "no slot is taken yet");
          first.send(a.bytes.subarray(40));
          first.finish();
          t.eq((await first.settle(3_000))?.status, 202, "the first complete body takes the last slot");
          second.send(b.bytes.subarray(40));
          second.finish();
          const res = await second.settle(3_000);
          if (res === null) return t.fail("the second upload was not answered");
          const body = await expectError(t, res, 429, "the second complete body");
          t.includes(body.error, "1 runs per hour");
          t.ok(body.retryAfterSec !== undefined && body.retryAfterSec > 3_500, `the truthful wait until the slot leaves the hour (${body.retryAfterSec} s)`);
          t.eq(res.headers.get("retry-after"), String(body.retryAfterSec), "Retry-After header");
          t.ok(!fs.existsSync(uploadPath(sha256(b.file))), "the refused file was not stored");
          t.ok(fs.existsSync(uploadPath(sha256(a.file))), "the accepted one was");
          t.eq(limiter.rateLimiterSize().global, 1, "only the created run holds a slot");
          t.eq(incomingFiles(), [], "no temp file is left behind");
        });
        // RT-PIPE-03's rule at the new place: a request that fails after it took its slot (here in createRun) gives it back
        limiter.resetRateLimits();
        await whenIdle();
        db.exec("ALTER TABLE runs RENAME TO runs_hidden_sec6");
        let status = 0;
        try {
          status = (await runsRoute.POST(postJson({ sample: "07-recurring-not-duplicate.pdf" }))).status;
        } finally {
          db.exec("ALTER TABLE runs_hidden_sec6 RENAME TO runs");
        }
        t.eq(status, 500, "createRun failed after the slot was taken");
        t.eq(limiter.rateLimiterSize().global, 0, "and the slot was given back");
      } finally {
        for (const h of held) h.drop();
        await Promise.all(held.map((h) => h.settle(2_000)));
        takeLogs();
        await whenIdle();
        limiter.resetRateLimits();
      }
    },
  );
}

/* ================================================================================================
 * Group: reset
 * ============================================================================================== */

async function resetGroup(t: Check): Promise<void> {
  const db = getDb();

  await t.test("the guard: 403 when disabled, without a token, with a wrong, short, padded or absurd token, and when the configured token is too short", async () => {
    await resetViaRoute(t);
    if (DEFAULT_CLOCK_OK) await runSampleViaRoute(t, "01-happy-northwind.pdf");
    const marker = "c".repeat(64);
    fs.mkdirSync(paths.uploadsDir, { recursive: true });
    fs.writeFileSync(path.join(paths.uploadsDir, `${marker}.pdf`), "x");
    const runsBefore = countOf(db, "runs");
    const denied = async (what: string, req: Request, env: Record<string, string | undefined> = {}) => {
      const body = await withEnv(env, async () => expectError(t, await resetRoute.POST(req), 403, what));
      t.ok(!JSON.stringify(body).includes(RESET_TOKEN), `${what}: the token is not echoed`);
      t.eq(countOf(db, "runs"), runsBefore, `${what}: nothing was reset`);
      t.ok(fs.existsSync(path.join(paths.uploadsDir, `${marker}.pdf`)), `${what}: uploads untouched`);
    };
    await denied("no token", postReset());
    await denied("empty token", postReset(""));
    await denied("wrong token of the same length", postReset("x".repeat(RESET_TOKEN.length)));
    await denied("wrong token, one character off", postReset(`${RESET_TOKEN.slice(0, -1)}!`));
    await denied("a prefix of the token", postReset(RESET_TOKEN.slice(0, 10)));
    await denied("the token followed by more text", postReset(`${RESET_TOKEN}x`));
    await denied("the token with a space inside", postReset(`${RESET_TOKEN.slice(0, 8)} ${RESET_TOKEN.slice(8)}`));
    await denied("the token upper-cased", postReset(RESET_TOKEN.toUpperCase()));
    await denied("a very long token (timingSafeEqual would throw on a length mismatch)", postReset("z".repeat(200_000)));
    await denied("disabled: DEMO_RESET_ENABLED=false", postReset(RESET_TOKEN), { DEMO_RESET_ENABLED: "false" });
    await denied("disabled: DEMO_RESET_ENABLED unset", postReset(RESET_TOKEN), { DEMO_RESET_ENABLED: undefined });
    await denied("disabled: not exactly 'true'", postReset(RESET_TOKEN), { DEMO_RESET_ENABLED: "TRUE" });
    await denied("no token configured", postReset(RESET_TOKEN), { DEMO_RESET_TOKEN: undefined });
    await denied("no token configured, empty header", postReset(""), { DEMO_RESET_TOKEN: undefined });
    await denied("a configured token shorter than 16 characters counts as unset", postReset("short"), { DEMO_RESET_TOKEN: "short" });
    await denied("empty configured token and empty header", postReset(""), { DEMO_RESET_TOKEN: "" });
    fs.rmSync(path.join(paths.uploadsDir, `${marker}.pdf`));
  });

  await t.test("with the token: 200, only history rows remain, uploads wiped (hash-named files only), the rate limiter is NOT cleared", async () => {
    if (DEFAULT_CLOCK_OK) {
      await runSampleViaRoute(t, "01-happy-northwind.pdf");
      await runSampleViaRoute(t, "03-split-po-overbill.pdf");
    }
    const dir = paths.uploadsDir;
    fs.mkdirSync(dir, { recursive: true });
    const hashA = "e".repeat(64);
    // (names differ by more than case: the default macOS file system is case-insensitive)
    const keep = [`${"A".repeat(64)}.pdf`, `${"1".repeat(63)}.pdf`, `${hashA}.pdf.bak`, "notes.txt", ".gitkeep", ".upload-123.tmp", `${"f".repeat(64)}.PDF`];
    for (const name of keep) fs.writeFileSync(path.join(dir, name), "keep me");
    fs.writeFileSync(path.join(dir, `${hashA}.pdf`), "wipe me");
    fs.mkdirSync(path.join(dir, `${"d".repeat(64)}.pdf`));
    fs.symlinkSync(path.join(dir, "notes.txt"), path.join(dir, `${"9".repeat(64)}.pdf`));
    t.ok(uploadsListing().filter((n) => /^[a-f0-9]{64}\.pdf$/.test(n)).length >= 3, "there are hash-named entries to wipe");

    limiter.resetRateLimits();
    const crowd = "198.51.100.77";
    for (let i = 0; i < 10; i++) await runsRoute.POST(postJson({ sample: "nope" }, crowd));
    t.eq((await runsRoute.POST(postJson({ sample: "nope" }, crowd))).status, 429, "the crowd IP is limited");

    const res = await resetRoute.POST(postReset(RESET_TOKEN));
    t.eq(res.status, 200);
    t.eq(res.headers.get("cache-control"), "no-store");
    const body = parsed(t, ResetSchema, await res.json(), "reset response");
    t.eq(body.counts, { vendors: 5, purchase_orders: 8, invoices: 4, runs: 4 });
    t.eq([countOf(db, "runs"), countOf(db, "run_steps"), countOf(db, "invoices"), countOf(db, "vendors"), countOf(db, "purchase_orders")], [4, 0, 4, 5, 8], "only the seed state remains");
    t.eq(db.prepare("SELECT COUNT(*) FROM runs WHERE model != 'history'").pluck().get(), 0, "only history runs");
    const left = uploadsListing();
    t.eq(left.filter((n) => /^[a-f0-9]{64}\.pdf$/.test(n) && fs.lstatSync(path.join(dir, n)).isFile()), [], "no hash-named regular file is left");
    t.eq(keep.every((n) => left.includes(n)), true, "files that do not match the hash pattern are kept");
    t.ok(left.includes(`${"d".repeat(64)}.pdf`) && left.includes(`${"9".repeat(64)}.pdf`), "a directory and a symlink with hash names are left alone");
    t.eq((await runsRoute.POST(postJson({ sample: "nope" }, crowd))).status, 429, "reset did not clear the rate limiter");
    for (const name of [...keep, `${"9".repeat(64)}.pdf`]) fs.rmSync(path.join(dir, name), { force: true });
    fs.rmSync(path.join(dir, `${"d".repeat(64)}.pdf`), { recursive: true, force: true });
    limiter.resetRateLimits();
    // the system works after a reset
    if (DEFAULT_CLOCK_OK) {
      const id = await runSampleViaRoute(t, "01-happy-northwind.pdf");
      t.eq(runRow(db, id).decision, "APPROVE", "the same sample is not a duplicate any more");
    }
  });

  await clockTest(t, "a run in flight finishes first: reset waits for it (and for one enqueued meanwhile), and nothing leaks into the fresh state", async () => {
    await resetViaRoute(t);
    const store = (file: (typeof SAMPLE_FILES)[number]): string => {
      const bytes = sampleBytes(file);
      fs.mkdirSync(paths.uploadsDir, { recursive: true });
      fs.writeFileSync(uploadPath(sha256(bytes)), bytes);
      return createRun(db, { fileName: file, fileHash: sha256(bytes) });
    };
    const id = store("01-happy-northwind.pdf");
    const gate = deferred();
    let finishedAt = 0;
    let lateFinishedAt = 0;
    const slow: ExtractFn = async (pdf, opts) => {
      await gate.promise;
      return mockExtract(pdf, opts);
    };
    const run = enqueue(id, { extract: slow }).then(() => void (finishedAt = performance.now()));
    await sleep(80);
    t.eq(runRow(db, id).status, "running", "the run is working");
    let resetDone = false;
    const resetPromise = resetRoute.POST(postReset(RESET_TOKEN)).then((r) => ((resetDone = true), r));
    const lateId = store("02-within-tolerance.pdf"); // enqueued while the reset waits: it must not be cut in half by the wipe
    const late = enqueue(lateId).then(() => void (lateFinishedAt = performance.now()));
    await sleep(150);
    t.ok(!resetDone, "reset is still waiting while the run works");
    t.eq(runRow(db, id).status, "running", "and the run was not interrupted");
    t.eq(runRow(db, lateId).status, "queued", "the later run waits its turn");
    gate.resolve();
    const res = await resetPromise;
    const resetAt = performance.now();
    await Promise.all([run, late]);
    t.eq(res.status, 200);
    t.ok(finishedAt > 0 && finishedAt <= resetAt, "the run finished before the reset answered");
    t.ok(lateFinishedAt > 0 && lateFinishedAt <= resetAt, "so did the run enqueued while it waited");
    t.eq([countOf(db, "runs"), countOf(db, "invoices"), countOf(db, "run_steps")], [4, 4, 0], "the wipe came after both runs: no orphan rows");
    t.eq(db.prepare("SELECT COUNT(*) FROM runs WHERE id IN (?, ?)").pluck().get(id, lateId), 0, "the finished runs are gone with the rest");
    await whenIdle();
  }, { timeoutMs: 30_000 });

  await t.test(
    "red team RT-PIPE-04: a steady stream of runs does not starve a reset (it waits at most CONFIG.resetIdleWaitMs for idle, then takes its turn)",
    async () => {
      await resetViaRoute(t);
      const slow: ExtractFn = async (pdf, opts) => {
        await sleep(120); // each run takes longer than the gap between arrivals: the queue never goes idle
        return mockExtract(pdf, opts);
      };
      const bytes = sampleBytes("02-within-tolerance.pdf");
      fs.mkdirSync(paths.uploadsDir, { recursive: true });
      let stop = false;
      const feeder = (async () => {
        const until = Date.now() + 6_000; // bounded, so a broken reset fails this test instead of hanging the script
        let n = 0;
        while (!stop && Date.now() < until) {
          const own = new Uint8Array(Buffer.concat([Buffer.from(bytes), Buffer.from(`\n%stream-${n}\n`)]));
          fs.writeFileSync(uploadPath(sha256(own)), own);
          void enqueue(createRun(db, { fileName: `stream-${n++}.pdf`, fileHash: sha256(own) }), { extract: slow });
          await sleep(60);
        }
        return n;
      })();
      let answeredAfter = -1;
      await withConfig({ resetIdleWaitMs: 300 }, async () => {
        await sleep(150);
        const t0 = Date.now();
        const res = await resetRoute.POST(postReset(RESET_TOKEN));
        answeredAfter = Date.now() - t0;
        t.eq(res.status, 200);
      });
      stop = true;
      const n = await feeder;
      t.ok(answeredAfter >= 280 && answeredAfter < 3_000, `the reset answered after ${answeredAfter} ms while runs kept arriving (${n} in all)`);
      await whenIdle();
      await resetViaRoute(t);
    },
    { timeoutMs: 30_000 },
  );

  await t.test("fix round ROUTE-1: when the browser stops waiting for a reset (its own 60 s timer), the form says it is still resetting, not that it failed", async () => {
    // The reset form's own code (src/components/shared/api.ts resetDemo and start/upload-rules.ts resetOutcomeOf), with a
    // server that never answers: the browser's 60 s timer is shortened for the test, the server keeps working.
    const api = load<typeof import("../src/components/shared/api")>("src/components/shared/api");
    const rules = load<typeof import("../src/components/start/upload-rules")>("src/components/start/upload-rules");
    const realFetch = globalThis.fetch;
    const realSetTimeout = globalThis.setTimeout;
    let calls = 0;
    globalThis.fetch = ((_url: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        calls++;
        init?.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")), { once: true });
      })) as typeof fetch;
    globalThis.setTimeout = ((fn: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) => realSetTimeout(fn, ms === 60_000 ? 30 : ms, ...rest)) as typeof setTimeout;
    let result: Awaited<ReturnType<typeof api.resetDemo>>;
    try {
      result = await api.resetDemo(RESET_TOKEN);
    } finally {
      globalThis.fetch = realFetch;
      globalThis.setTimeout = realSetTimeout;
    }
    t.eq(calls, 1, "one request was sent to the (stubbed) server");
    if (result.ok) return t.fail("a server that never answers cannot succeed");
    t.eq([result.status, result.timedOut], [0, true], "the browser's own timeout is reported as such");
    const shown = rules.resetOutcomeOf(result);
    t.eq(shown.kind, "pending", "not 'Reset failed'");
    t.includes(shown.message, "still finishing the runs that were already queued");
    // real failures stay failures
    t.eq(rules.resetOutcomeOf({ status: 403, error: "Forbidden" }), { kind: "failed", message: "The reset was refused. The token is wrong, or reset is turned off on this server." });
    t.eq(rules.resetOutcomeOf({ status: 0, error: "Could not reach the server. Check your connection and try again." }).kind, "failed", "no response at all is a failure");
    t.eq(rules.resetOutcomeOf({ status: 500, error: "x" }).kind, "failed");
  });

  await t.test("B9: an upload-cap 429 shows the server's own words; a rate-limit 429 still reads 'too many runs'", () => {
    const rules = load<typeof import("../src/components/start/upload-rules")>("src/components/start/upload-rules");
    const { beginUpload, uploadsInFlight } = limiter;
    const wait = CONFIG.uploadsBusyRetryAfterSec;
    t.eq(uploadsInFlight(), { total: 0, ips: 0 }, "nothing in progress before the test");
    // the real refusals of beginUpload: their text reads exactly as before the change, and the start page shows it as it is
    const held = Array.from({ length: CONFIG.maxUploadsInFlightPerIp }, () => beginUpload("198.51.100.91"));
    const ipFull = beginUpload("198.51.100.91");
    if (ipFull.ok) return t.fail("one more upload from a full address must be refused");
    t.eq(ipFull.message, `Your address is already sending ${CONFIG.maxUploadsInFlightPerIp} files. Try again in ${wait} s.`);
    t.eq(rules.startFailureMessage({ status: 429, error: ipFull.message, retryAfterSec: ipFull.retryAfterSec }), ipFull.message, "the per-address refusal is shown as the server worded it");
    for (const slot of held) slot.release();
    const many = Array.from({ length: CONFIG.maxUploadsInFlight }, (_, i) => beginUpload(`198.51.100.${100 + i}`));
    const globalFull = beginUpload("198.51.100.250");
    if (globalFull.ok) return t.fail("one more upload when the server is full must be refused");
    t.eq(globalFull.message, `The server is receiving too many files at once. Try again in ${wait} s.`);
    t.eq(rules.startFailureMessage({ status: 429, error: globalFull.message, retryAfterSec: globalFull.retryAfterSec }), globalFull.message, "the server-wide refusal is shown as the server worded it");
    for (const slot of many) slot.release();
    t.eq(uploadsInFlight(), { total: 0, ips: 0 }, "everything given back");
    // the rate limit keeps the start page's own sentence, whatever text the server sent
    t.eq(rules.startFailureMessage({ status: 429, error: "Too many requests", retryAfterSec: 30 }), "Too many runs were started in a short time. Please wait 30 seconds and try again.");
    t.eq(rules.startFailureMessage({ status: 429, error: "Note: Your address is already sending 2 files.", retryAfterSec: 7 }), "Too many runs were started in a short time. Please wait 7 seconds and try again.", "only a text that opens with the server's words counts");
    t.eq(rules.startFailureMessage({ status: 429, error: "", retryAfterSec: undefined }), "Too many runs were started in a short time. Please wait a moment and try again.");
    // other statuses are unchanged
    t.eq(rules.startFailureMessage({ status: 413, error: "x" }), "That file is larger than 10 MB. Choose a smaller PDF.");
    t.includes(rules.startFailureMessage({ status: 503, error: "x" }), "HTTP 503");
  });
}

/* ================================================================================================
 * Group: startup
 * ============================================================================================== */

async function startupGroup(t: Check): Promise<void> {
  const Mod = instrumentation;

  await t.test("register(): nothing outside the Node.js runtime and nothing during `next build`; otherwise it opens the database and logs one JSON line", async () => {
    const dir = path.join(TMP, "boot");
    await withEnv({ DATA_DIR: dir, NEXT_RUNTIME: "edge" }, async () => {
      await Mod.register();
      t.ok(!fs.existsSync(path.join(dir, "app.db")), "edge runtime: the database is not touched");
    });
    await withEnv({ DATA_DIR: dir, NEXT_RUNTIME: "nodejs", NEXT_PHASE: "phase-production-build" }, async () => {
      await Mod.register();
      t.ok(!fs.existsSync(path.join(dir, "app.db")), "next build: the database is not opened");
    });
    takeLogs();
    await withEnv({ DATA_DIR: dir, NEXT_RUNTIME: "nodejs", NEXT_PHASE: undefined }, async () => {
      await Mod.register();
      t.ok(fs.existsSync(path.join(dir, "app.db")), "the database file exists after boot");
    });
    const lines = takeLogs();
    t.eq(lines.length, 1, "exactly one log line");
    t.eq(JSON.parse(lines[0]), { event: "startup", db: "ready", vendors: 5, runs: 4 }, "first-time seeding happened at boot");

    // an unusable DATA_DIR is logged (name only), not thrown
    const blocker = path.join(TMP, "a-file");
    fs.writeFileSync(blocker, "not a directory");
    takeLogs();
    await withEnv({ DATA_DIR: path.join(blocker, "sub"), NEXT_RUNTIME: "nodejs" }, async () => {
      await Mod.register();
    });
    const failed = takeLogs();
    t.eq(failed.length, 1);
    const entry = JSON.parse(failed[0]) as Record<string, unknown>;
    t.eq([entry.event, entry.db], ["startup", "failed"]);
    t.ok(!failed[0].includes(blocker), "no path in the log line");
    process.env.DATA_DIR = MAIN_DATA_DIR;
    getDb(); // back to the main database for the remaining tests
  });

  await t.test("startup recovery: runs left queued or running become 'error' (decision NULL), their steps error/skipped, nothing else changes", async () => {
    const dir = path.join(TMP, "recover");
    const file = path.join(dir, "app.db");
    const stale = openDb(file);
    seedDatabase(stale);
    const add = (status: string, steps: [number, StageKey, string][]) => {
      const id = crypto.randomUUID();
      stale.prepare("INSERT INTO runs (id, file_name, file_hash, status, security_flag, created_at) VALUES (?, ?, ?, ?, 0, ?)").run(id, `${status}.pdf`, "a".repeat(64), status, new Date().toISOString());
      const ins = stale.prepare("INSERT INTO run_steps (run_id, idx, key, label, status, started_at) VALUES (?, ?, ?, ?, ?, ?)");
      for (const stage of STAGES) {
        const given = steps.find(([idx]) => idx === stage.idx);
        ins.run(id, stage.idx, stage.key, stage.label, given ? given[2] : "pending", given && given[2] !== "pending" ? new Date().toISOString() : null);
      }
      return id;
    };
    const running = add("running", [[1, "ingest", "pass"], [2, "screen", "pass"], [3, "extract", "running"]]);
    const queued = add("queued", []);
    const doneId = add("done", [[1, "ingest", "pass"]]);
    stale.prepare("UPDATE runs SET decision = 'APPROVE', decision_reasons = '[]' WHERE id = ?").run(doneId);
    stale.close();

    await withEnv({ DATA_DIR: dir, NEXT_RUNTIME: "nodejs" }, async () => {
      await Mod.register(); // getDb(): open + startup recovery
      const live = getDb();
      for (const id of [running, queued]) {
        const row = runRow(live, id);
        t.eq([row.status, row.decision, row.next_action, row.security_flag], ["error", null, INTERRUPTED_NEXT_ACTION, 0], `${row.file_name}: status`);
        t.eq(reasonsOf(row), [INTERRUPTED_REASON]);
        t.ok(row.finished_at !== null);
        t.eq(invoiceRowsOf(live, id).length, 0, "no invoices row (a re-run is not a duplicate)");
      }
      t.eq(stepRows(live, running).map((s) => s.status), ["pass", "pass", "error", ...Array(7).fill("skipped")], "the running step is error, the pending ones skipped, finished ones kept");
      t.eq(stepRows(live, running)[2].reason, INTERRUPTED_REASON);
      t.eq(stepRows(live, queued).map((s) => s.status), Array(10).fill("skipped"));
      t.eq([runRow(live, doneId).status, runRow(live, doneId).decision], ["done", "APPROVE"], "a done run is untouched");
      const res = await runRoute.GET(get(`/api/runs/${running}`), idContext(running));
      const detail = parsed(t, RunDetailSchema, await res.json(), "recovered run");
      t.eq([detail.status, detail.decision, detail.decision_reasons, detail.next_action], ["error", null, [INTERRUPTED_REASON], INTERRUPTED_NEXT_ACTION]);
    });
    process.env.DATA_DIR = MAIN_DATA_DIR;
    getDb();
  });

  await t.test("no network call was attempted anywhere in this script", () => {
    t.eq(blockedFetches, 0, "globalThis.fetch was never called");
  });
}

/* ================================================================================================
 * main
 * ============================================================================================== */

async function main(): Promise<number> {
  const grep = process.argv.slice(2).find((a) => a.startsWith("--grep="))?.slice("--grep=".length);
  if (fs.realpathSync(process.cwd()) !== fs.realpathSync(ROOT)) throw new Error(`run this from the project root (${ROOT}); the seed, sample and truth data are read from <cwd>/data`);
  if (samples.length !== 10 || samples.some((s) => !s.pdfExists)) throw new Error("the 10 samples are needed (npm run gen)");
  const harness = createHarness({ grep });
  try {
    await harness.group("pipeline", (t) => pipelineGroup(guarded(t)));
    await harness.group("ratelimit", (t) => ratelimitGroup(guarded(t)));
    await harness.group("routes", (t) => routesGroup(guarded(t)));
    await harness.group("reset", (t) => resetGroup(guarded(t)));
    await harness.group("startup", (t) => startupGroup(guarded(t)));
    releaseGates();
    let drainTimer: NodeJS.Timeout | undefined;
    const stuck = new Promise<never>((_, reject) => {
      drainTimer = setTimeout(() => reject(new Error("the pipeline queue did not drain within 15 s after the last test")), 15_000);
    });
    await Promise.race([whenIdle(), stuck]).finally(() => clearTimeout(drainTimer));
  } finally {
    try {
      (globalThis as { __invoiceApDb?: { db: DB } }).__invoiceApDb?.db.close();
    } catch {
      // already closed
    }
    fs.rmSync(TMP, { recursive: true, force: true });
  }
  const failures = harness.summary();
  summarized = true;
  return failures > 0 ? 1 : 0;
}

/**
 * A promise that never settles ends a Node process silently with exit code 0. If that ever happens here, whatever
 * the cause, it must not look like a pass: no summary printed means failure.
 */
let summarized = false;
process.on("exit", (code) => {
  if (!summarized && code === 0) {
    process.exitCode = 1;
    console.error("scripts/test-api.ts: the process ended before the summary was printed; counted as a failure");
  }
});

main()
  .then((code) => {
    process.exitCode = code;
    // exit even if a worker or a timer is still alive
    setTimeout(() => process.exit(code), 200).unref();
  })
  .catch((e) => {
    console.error(e instanceof Error ? (e.stack ?? e.message) : e);
    fs.rmSync(TMP, { recursive: true, force: true });
    process.exit(1);
  });
