/**
 * Offline end-to-end rehearsal of the pipeline without pipeline.ts (docs/CONTRACTS.md section 4).
 *
 * The 10 sample PDFs, in demo order, on ONE fresh in-memory seeded database, through the real stage sequence of
 * CONTRACTS 4.1: validateUpload (pdf.ts) -> checkIngest, screenPdf -> checkScreen (guardrails.ts), the MOCK
 * extractor -> checkExtract, groundExtraction(buildGroundingText(...)) -> checkValidate, normalizeInvoice ->
 * checkNormalize, checkVendor, checkPoMatch (mock suggestPO), checkAmounts, checkDuplicate, then decide() and
 * nextAction(). Every stage is wrapped in try/catch the way the pipeline does it, the skip rules apply, and the
 * runs, run_steps and invoices rows are written per CONTRACTS 4.2, so each sample sees the ones before it (#6
 * after #1 used PO-1002, #4 against the pre-loaded INV-0042, #7 against September's subscription).
 *
 * No network, no API key, no files written: the extractor is always the mock (extract-mock.ts). The business
 * clock is the checks' FIXED_NOW (2026-11-02) so the run is repeatable; row timestamps are real, as in the app.
 *
 *   npx tsx scripts/rehearse.ts                       truth mock: every sample must end as plan section 3 says
 *   EXTRACT_MOCK=fooled npx tsx scripts/rehearse.ts   a model that obeyed #9's hidden text (PO-1003, total 400,
 *                                                     confidence 1.0). #9 must still be HOLD with the security flag
 *                                                     and no other sample may change (a truth pass is run to compare)
 *
 * Exit code 0 when every expectation holds, 1 otherwise.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import type { DB } from "../src/lib/db";
import { PROMPT_VERSION } from "../src/lib/extract";
import { mockExtractInvoice, mockSuggestPO } from "../src/lib/extract-mock";
import { formatUsd } from "../src/lib/format";
import { buildGroundingText, checkScreen, groundExtraction, screenPdf } from "../src/lib/guardrails";
import { insertInvoice, loadSnapshot, poBalance } from "../src/lib/master";
import { normalizeInvoice } from "../src/lib/normalize";
import { sha256, validateUpload } from "../src/lib/pdf";
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
} from "../src/lib/rules";
import { type TruthSample, loadTruthSamples } from "../src/lib/samples";
import {
  STAGES,
  STAGE_KEYS,
  STAGE_LABELS,
  type AmountsOutcome,
  type DecideDetail,
  type DecideResult,
  type DecisionContext,
  type DuplicateOutcome,
  type ExtractResult,
  type NormalizedInvoice,
  type PoMatchOutcome,
  type StageKey,
  type StepMap,
  type StepResult,
  type TextItem,
  type UploadValidation,
  type VendorOutcome,
} from "../src/lib/types";
import { FIXED_NOW, openSeededMemoryDb } from "./checks/harness";

type Mode = "truth" | "fooled";

interface PassOptions {
  /** worst case of a fooled model: it also keeps quiet about the hidden sentence (suspicious_content emptied) */
  hideSuspicious?: boolean;
}

/** The mock extractor, optionally made worse: a model that obeyed the injection AND did not report it. */
async function extractFor(bytes: Uint8Array, isImageOnly: boolean, opts: PassOptions): Promise<ExtractResult> {
  const ex = await mockExtractInvoice(bytes, { isImageOnly });
  if (!opts.hideSuspicious || !ex.ok) return ex;
  const data = { ...ex.data, suspicious_content: [] };
  return { ...ex, data, rawOutput: JSON.stringify(data) };
}

interface Outcome {
  id: string;
  file: string;
  decision: DecideResult["decision"];
  reasons: string[];
  action: string;
  securityFlag: boolean;
  po: string | null;
  inferred: boolean;
  steps: StepMap;
  extraction: ExtractResult | null;
  expected: TruthSample["meta"];
}

const iso = () => new Date().toISOString();

/** One stage: run it, turn its outcome into the step, persist; a throw is an error step and a missing outcome. */
async function stage<T>(
  db: DB,
  runId: string,
  steps: StepMap,
  key: StageKey,
  run: () => T | Promise<T>,
  toStep: (out: T) => StepResult,
): Promise<T | null> {
  const def = STAGES.find((s) => s.key === key);
  const startedAt = iso();
  db.prepare("UPDATE run_steps SET status = 'running', started_at = ? WHERE run_id = ? AND idx = ?").run(startedAt, runId, def?.idx);
  let out: T | null = null;
  let step: StepResult;
  try {
    out = await run();
    step = toStep(out);
  } catch {
    out = null;
    step = { status: "error", reason: `System error at ${STAGE_LABELS[key]}, manual review` };
  }
  steps[key] = step;
  persistStep(db, runId, key, step, startedAt);
  return out;
}

function persistStep(db: DB, runId: string, key: StageKey, step: StepResult, startedAt: string | null): void {
  const def = STAGES.find((s) => s.key === key);
  db.prepare("UPDATE run_steps SET status = ?, severity = ?, reason = ?, detail = ?, started_at = ?, finished_at = ? WHERE run_id = ? AND idx = ?").run(
    step.status,
    step.severity ?? null,
    step.reason,
    step.detail === undefined ? null : JSON.stringify(step.detail),
    startedAt,
    iso(),
    runId,
    def?.idx,
  );
}

function skipFrom(db: DB, runId: string, steps: StepMap, first: StageKey, reason: string): void {
  for (const key of STAGE_KEYS.slice(STAGE_KEYS.indexOf(first), STAGE_KEYS.indexOf("decide"))) {
    steps[key] = { status: "skipped", reason };
    persistStep(db, runId, key, steps[key] as StepResult, null);
  }
}

/** createRun (CONTRACTS 4.2): a queued run and its 10 pending steps. */
function createRun(db: DB, fileName: string, fileHash: string): string {
  const id = crypto.randomUUID();
  db.transaction(() => {
    db.prepare("INSERT INTO runs (id, file_name, file_hash, status, security_flag, created_at) VALUES (?, ?, ?, 'queued', 0, ?)").run(id, fileName, fileHash, iso());
    const add = db.prepare("INSERT INTO run_steps (run_id, idx, key, label, status) VALUES (?, ?, ?, ?, 'pending')");
    for (const s of STAGES) add.run(id, s.idx, s.key, s.label);
  })();
  return id;
}

/** runPipeline for one sample, minus pacing and logging. */
async function runSample(db: DB, sample: TruthSample, opts: PassOptions): Promise<Outcome> {
  const bytes = new Uint8Array(fs.readFileSync(sample.pdfPath));
  const fileHash = sha256(bytes);
  const runId = createRun(db, sample.file, fileHash);
  db.prepare("UPDATE runs SET status = 'running' WHERE id = ?").run(runId);
  const now = FIXED_NOW;
  const snapshot = loadSnapshot(db);
  const steps: StepMap = {};
  let ctx: DecisionContext = { extraction: null, normalized: null, vendor: null, poMatch: null, amounts: null, duplicate: null };
  let extraction: ExtractResult | null = null;

  const upload = await stage<UploadValidation>(db, runId, steps, "ingest", () => validateUpload(bytes), (u) => checkIngest(u, fileHash, snapshot));
  if (steps.ingest?.status === "fail" || upload === null || !upload.ok) {
    skipFrom(db, runId, steps, "screen", "Skipped: the file did not pass ingest");
  } else {
    const textItems: TextItem[] = upload.textItems;
    const screen = await stage(db, runId, steps, "screen", () => screenPdf(textItems), (s) => checkScreen(s));
    const isImageOnly = screen?.isImageOnly ?? false;
    extraction = await stage(db, runId, steps, "extract", () => extractFor(bytes, isImageOnly, opts), (ex) => checkExtract(ex));
    // after stage 3 the pipeline writes the extraction at once, so the run view shows the fields early
    db.prepare("UPDATE runs SET extraction = ?, raw_model_output = ?, model = ?, prompt_version = ?, cost_usd = ? WHERE id = ?").run(
      extraction?.ok ? JSON.stringify(extraction.data) : null,
      extraction?.ok ? extraction.rawOutput : null,
      extraction?.model ?? null,
      PROMPT_VERSION,
      extraction?.costUsd ?? 0,
      runId,
    );
    if (extraction === null || !extraction.ok) {
      skipFrom(db, runId, steps, "validate", "Skipped: no extraction to check");
    } else {
      const data = extraction.data;
      await stage(db, runId, steps, "validate", () => (isImageOnly ? null : groundExtraction(data, buildGroundingText(textItems))), (g) => checkValidate(data, g, now));
      const normalized = await stage<NormalizedInvoice>(db, runId, steps, "normalize", () => normalizeInvoice(data, snapshot.vendors), (n) => checkNormalize(n));
      const vendor = await stage<VendorOutcome>(db, runId, steps, "vendor", () => checkVendor(data, normalized as NormalizedInvoice, snapshot), (v) => v);
      const poMatch = await stage<PoMatchOutcome>(db, runId, steps, "po_match", () => checkPoMatch(data, normalized as NormalizedInvoice, vendor?.vendor ?? null, snapshot, mockSuggestPO), (p) => p);
      if (poMatch?.suggestion) db.prepare("UPDATE runs SET cost_usd = cost_usd + ? WHERE id = ?").run(poMatch.suggestion.costUsd, runId);
      const amounts = await stage<AmountsOutcome>(db, runId, steps, "amounts", () => checkAmounts(data, normalized as NormalizedInvoice, poMatch as PoMatchOutcome, snapshot), (a) => a);
      const duplicate = await stage<DuplicateOutcome>(db, runId, steps, "duplicate", () => checkDuplicate(data, normalized as NormalizedInvoice, vendor?.vendor ?? null, snapshot), (d) => d);
      ctx = { extraction: data, normalized, vendor, poMatch, amounts, duplicate };
    }
  }

  // stage 10: decide, then ONE invoices row (any decision, also when extraction failed)
  const d = decide(steps, ctx);
  const action = nextAction(d.decision, steps, ctx);
  const decideStep: StepResult = {
    status: "pass",
    reason: `${d.decision}: ${d.reasons[0] ?? "all checks passed"}`,
    detail: { decision: d.decision, reasons: d.reasons, next_action: action, security_flag: d.securityFlag } satisfies DecideDetail as unknown as Record<string, unknown>,
  };
  steps.decide = decideStep;
  persistStep(db, runId, "decide", decideStep, iso());
  const finishedAt = iso();
  db.prepare("UPDATE runs SET status = 'done', decision = ?, decision_reasons = ?, next_action = ?, security_flag = ?, finished_at = ? WHERE id = ?").run(
    d.decision,
    JSON.stringify(d.reasons),
    action,
    d.securityFlag ? 1 : 0,
    finishedAt,
    runId,
  );
  const data = ctx.extraction;
  insertInvoice(db, {
    id: runId,
    run_id: runId,
    vendor_id: ctx.vendor?.vendor?.id ?? null,
    invoice_number: data?.invoice_number ?? null,
    invoice_number_norm: ctx.normalized?.invoice_number_norm ?? null,
    invoice_date: ctx.normalized?.invoice_date ?? null,
    po_number: ctx.poMatch?.po?.po_number ?? null,
    po_inferred: ctx.poMatch?.inferred ?? false,
    subtotal: data?.subtotal ?? null,
    tax: data?.tax ?? null,
    total: data?.total ?? null,
    currency: ctx.normalized?.currency ?? null,
    bank_account: data?.bank_account ?? null,
    file_hash: fileHash,
    decision: d.decision,
    created_at: finishedAt,
  });
  return {
    id: sample.id,
    file: sample.file,
    decision: d.decision,
    reasons: d.reasons,
    action,
    securityFlag: d.securityFlag,
    po: ctx.poMatch?.po?.po_number ?? null,
    inferred: ctx.poMatch?.inferred ?? false,
    steps,
    extraction,
    expected: sample.meta,
  };
}

/** The demo order on one fresh database, in the given mock mode. */
async function rehearse(mode: Mode, opts: PassOptions = {}): Promise<{ outcomes: Outcome[]; balances: string[] }> {
  process.env.EXTRACT_MOCK = mode === "fooled" ? "fooled" : "1"; // read by the mock at call time
  const samples = loadTruthSamples();
  const missing = samples.filter((s) => !s.pdfExists).map((s) => s.file);
  if (samples.length !== 10 || missing.length > 0) throw new Error(`the 10 samples are needed (missing: ${missing.join(", ") || "truth files"}); run npm run gen`);
  const db = openSeededMemoryDb();
  try {
    const outcomes: Outcome[] = [];
    for (const s of samples) outcomes.push(await runSample(db, s, opts));
    const snap = loadSnapshot(db);
    const balances = snap.pos.map((po) => {
      const b = poBalance(po, snap.invoices);
      return `${po.po_number} ${formatUsd(b.remaining).padStart(12)} left of ${formatUsd(po.subtotal)}`;
    });
    const counts = db.prepare("SELECT (SELECT COUNT(*) FROM runs) AS runs, (SELECT COUNT(*) FROM invoices) AS invoices, (SELECT COUNT(*) FROM run_steps) AS steps, (SELECT COUNT(*) FROM runs WHERE status = 'done') AS done").get() as Record<string, number>;
    balances.push(`rows: ${counts.runs} runs (${counts.done} done), ${counts.invoices} invoices, ${counts.steps} run_steps (4 pre-loaded history runs have none)`);
    return { outcomes, balances };
  } finally {
    db.close();
  }
}

/* ------------------------------------------------------------------------------------------------ output */

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const STEP_CHAR: Record<string, string> = { pass: "p", warn: "w", fail: "F", skipped: "-", error: "E", pending: ".", running: "r" };
const stageString = (o: Outcome) => STAGE_KEYS.filter((k) => k !== "decide").map((k) => STEP_CHAR[o.steps[k]?.status ?? "pending"]).join("");
const poText = (po: string | null, inferred: boolean) => (po === null ? "-" : `${po}${inferred ? " (inferred)" : ""}`);

/** Every _meta expectation (CONTRACTS 3.3) that the outcome breaks; [] = all good. */
function problemsOf(o: Outcome): string[] {
  const m = o.expected;
  const out: string[] = [];
  if (o.decision !== m.expectedDecision) out.push(`decision ${o.decision}, expected ${m.expectedDecision}`);
  if (o.securityFlag !== m.expectedSecurityFlag) out.push(`security flag ${o.securityFlag}, expected ${m.expectedSecurityFlag}`);
  const wantPo = m.expectedPo === null ? null : m.expectedPo.po_number;
  if (o.po !== wantPo || (m.expectedPo !== null && o.inferred !== m.expectedPo.inferred)) out.push(`PO ${poText(o.po, o.inferred)}, expected ${m.expectedPo === null ? "-" : poText(m.expectedPo.po_number, m.expectedPo.inferred)}`);
  for (const phrase of m.expectedReasonIncludes) if (!o.reasons.some((r) => r.toLowerCase().includes(phrase.toLowerCase()))) out.push(`no reason contains "${phrase}"`);
  if (!o.action.toLowerCase().includes(m.expectedNextActionIncludes.toLowerCase())) out.push(`next action "${o.action}" lacks "${m.expectedNextActionIncludes}"`);
  return out;
}

function printTable(title: string, outcomes: Outcome[], ok: (o: Outcome) => boolean): void {
  const rows = outcomes.map((o) => [
    o.id,
    o.decision,
    o.expected.expectedDecision,
    o.securityFlag ? "yes" : "no",
    poText(o.po, o.inferred),
    stageString(o),
    ok(o) ? "ok" : "MISMATCH",
    clip(o.reasons[0] ?? "(none: all checks passed)", 78),
  ]);
  const head = ["#", "decision", "expected", "flag", "PO", "stages 1-9", "check", "first reason"];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cells: string[]) => cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i]))).join("  ");
  console.log(`\n${title}`);
  console.log(line(head));
  console.log(line(widths.map((w) => "-".repeat(w))));
  for (const r of rows) console.log(line(r));
  console.log("stages: p pass, w warn, F fail, - skipped, E error (ingest, screen, extract, validate, normalize, vendor, PO match, amounts, duplicate)");
}

async function main(): Promise<void> {
  const requested = (process.env.EXTRACT_MOCK ?? "").trim().toLowerCase();
  const mode: Mode = requested === "fooled" ? "fooled" : "truth";
  console.log(`Rehearsal: 10 samples in demo order on one fresh in-memory database; extractor: mock (${mode}); business clock ${FIXED_NOW.toISOString()}`);

  const run = await rehearse(mode);
  let failures = 0;
  if (mode === "truth") {
    printTable("Results (truth mock)", run.outcomes, (o) => problemsOf(o).length === 0);
    for (const o of run.outcomes) {
      const p = problemsOf(o);
      if (p.length > 0) {
        failures++;
        console.log(`  ${o.id} ${o.file}: ${p.join("; ")}`);
      }
    }
  } else {
    // The fooled model changes #9's extraction only. #9 must stay HOLD with the flag; nothing else may move.
    const truth = await rehearse("truth");
    const same = (a: Outcome, b: Outcome) => a.decision === b.decision && a.securityFlag === b.securityFlag && a.po === b.po && a.inferred === b.inferred && a.reasons[0] === b.reasons[0] && a.action === b.action;
    const okFooled = (o: Outcome) => {
      const t = truth.outcomes.find((x) => x.id === o.id) as Outcome;
      return o.id === "09" ? o.decision === "HOLD" && o.securityFlag : same(o, t);
    };
    printTable("Results (fooled mock: the model obeyed #9's hidden text)", run.outcomes, okFooled);
    for (const o of run.outcomes) if (!okFooled(o)) failures++;
    const changed = run.outcomes.filter((o) => !same(o, truth.outcomes.find((x) => x.id === o.id) as Outcome)).map((o) => o.id);
    console.log(`\nCompared with a truth-mock pass: samples that differ: ${changed.length === 0 ? "none" : changed.join(", ")} (only 09 may)`);
    const show = (label: string, nine: Outcome) => {
      const ex = nine.extraction?.ok ? nine.extraction.data : null;
      console.log(`${label}: po_reference ${ex?.po_reference}, total ${ex?.total}, confidences ${ex ? Object.values(ex.confidence).join("/") : "-"}, suspicious_content ${ex?.suspicious_content.length ?? 0} item(s)`);
      for (const key of ["screen", "extract", "validate", "amounts"] as const) {
        const s = nine.steps[key];
        console.log(`  ${STAGE_LABELS[key].padEnd(16)} ${(s?.status ?? "-").padEnd(5)} ${clip(s?.reason ?? "", 150)}`);
      }
      console.log(`  => ${nine.decision}, security flag ${nine.securityFlag}, next action: ${nine.action}`);
    };
    show("#9 as the fooled model returned it", run.outcomes.find((o) => o.id === "09") as Outcome);
    // Worst case: the model obeyed AND hid the sentence. Only the screen and grounding are left to catch it.
    const worst = await rehearse("fooled", { hideSuspicious: true });
    const worstNine = worst.outcomes.find((o) => o.id === "09") as Outcome;
    show("\n#9 worst case (the model also reported nothing suspicious)", worstNine);
    if (!(worstNine.decision === "HOLD" && worstNine.securityFlag && worstNine.steps.screen?.status === "fail" && worstNine.steps.validate?.status === "fail")) failures++;
    const worstChanged = worst.outcomes.filter((o) => !same(o, truth.outcomes.find((x) => x.id === o.id) as Outcome)).map((o) => o.id);
    console.log(`  worst-case pass, samples that differ from the truth pass: ${worstChanged.join(", ") || "none"} (only 09 may)`);
    if (worstChanged.some((id) => id !== "09")) failures++;
  }
  console.log("\nPO balances after the run:");
  for (const b of run.balances) console.log(`  ${b}`);
  console.log(failures === 0 ? "\nAll 10 samples match their expected outcome." : `\n${failures} sample(s) do NOT match.`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
