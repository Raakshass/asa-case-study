/**
 * npx tsx scripts/smoke-http.ts
 *
 * Black-box smoke test of a RUNNING server (the Next.js dev server started as in the Phase 5 task, or any deployment
 * that runs with EXTRACT_MOCK=1) over plain HTTP, with Node's fetch. Prints a PASS / FAIL table and exits 1 on any failure.
 *
 *   BASE_URL            default http://127.0.0.1:3100
 *   SMOKE_RESET_TOKEN   the server's DEMO_RESET_TOKEN. Never hard-coded here. Without it the script cannot start from
 *                       a clean state or test the 200 of /api/reset: those checks are reported as SKIP and the sample
 *                       expectations below only hold if the server has not processed these files before.
 *   SMOKE_WAIT_SECONDS  how long to wait for the server to answer at all (default 180)
 *   SMOKE_SERVER_LOG    optional path of the server's log file: adds checks that every run logged one JSON line per
 *                       stage and that the PDF text worker started (no "no text-parse worker could be started")
 *
 * Every section sends its own fake client address in x-forwarded-for, so the 10 per minute limit of POST /api/runs never
 * couples two sections. The expected decisions come from the truth files (data/samples/truth/NN.json _meta) and assume the
 * mock extractor; the samples are dated 2026-10-20..31, so the date rules decide them as expected until 2027-10-20.
 *
 * Sections: reset (clean slate), plan (the Phase 5 curl checks), samples (all 10 by POST + polling), files, headers,
 * lists (runs, KPIs, master, samples), abuse (traversal, bad hash, .txt renamed .pdf, same file twice, 413, 12 rapid
 * uploads -> 429 after 10), worker (a PDF that keeps pdf.js busy for seconds, and one whose page tree keeps pdf-lib busy
 * for minutes, do not stall the server: the upload's whole parse runs in the worker thread), reset-guard (403 and 200),
 * log (optional).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { PDFDocument, PDFName, StandardFonts } from "pdf-lib";
import { type TruthSample, SAMPLE_FILES, loadTruthSamples, samplePdfPath } from "../src/lib/samples";
import { historyRunId, readSeedFiles } from "../src/lib/seed";

const BASE = (process.env.BASE_URL ?? "http://127.0.0.1:3100").replace(/\/+$/, "");
const TOKEN = process.env.SMOKE_RESET_TOKEN ?? "";
const SERVER_LOG = process.env.SMOKE_SERVER_LOG ?? "";
const REQUEST_TIMEOUT_MS = 90_000;
/** How long to wait for the server to answer at all (a dev server compiles the first route on demand). */
const WAIT_FOR_SERVER_MS = Number(process.env.SMOKE_WAIT_SECONDS ?? 180) * 1000;

/* ================================================================================================
 * Tiny runner and assertions
 * ============================================================================================== */

interface Row {
  result: "PASS" | "FAIL" | "SKIP";
  section: string;
  name: string;
  detail: string;
}
const rows: Row[] = [];

class Failed extends Error {}
function fail(message: string): never {
  throw new Failed(message);
}
const show = (v: unknown): string => {
  const s = typeof v === "string" ? JSON.stringify(v) : JSON.stringify(v);
  return s === undefined ? String(v) : s.length > 160 ? `${s.slice(0, 157)}...` : s;
};
const ok = (cond: unknown, message: string): void => {
  if (!cond) fail(message);
};
const eq = (actual: unknown, expected: unknown, message: string): void => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(`${message}: expected ${show(expected)}, got ${show(actual)}`);
};
const includes = (haystack: string | readonly string[] | null | undefined, needle: string, message: string): void => {
  const n = needle.toLowerCase();
  const hit = typeof haystack === "string" ? haystack.toLowerCase().includes(n) : Array.isArray(haystack) && haystack.some((s) => String(s).toLowerCase().includes(n));
  if (!hit) fail(`${message}: expected ${show(haystack)} to include ${show(needle)}`);
};

async function check(section: string, name: string, fn: () => Promise<void> | void): Promise<void> {
  const started = Date.now();
  try {
    await fn();
    rows.push({ result: "PASS", section, name, detail: "" });
    console.log(`  PASS  ${section} > ${name} (${Date.now() - started} ms)`);
  } catch (e) {
    const detail = e instanceof Error ? (e instanceof Failed ? e.message : `${e.name}: ${e.message}`) : String(e);
    rows.push({ result: "FAIL", section, name, detail });
    console.log(`  FAIL  ${section} > ${name}: ${detail}`);
  }
}
function skip(section: string, name: string, why: string): void {
  rows.push({ result: "SKIP", section, name, detail: why });
  console.log(`  SKIP  ${section} > ${name}: ${why}`);
}

/* ================================================================================================
 * HTTP helpers
 * ============================================================================================== */

interface Reply {
  status: number;
  headers: Headers;
  bytes: Uint8Array;
  text: string;
  json: unknown;
}

async function http(
  p: string,
  opts: { method?: string; ip: string; headers?: Record<string, string>; body?: BodyInit | null } ,
): Promise<Reply> {
  const res = await fetch(`${BASE}${p}`, {
    method: opts.method ?? "GET",
    headers: { "x-forwarded-for": opts.ip, ...opts.headers },
    body: opts.body ?? null,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const bytes = new Uint8Array(await res.arrayBuffer());
  const text = new TextDecoder().decode(bytes);
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON (a PDF, an HTML error page)
  }
  return { status: res.status, headers: res.headers, bytes, text, json };
}

const postSample = (sample: string, ip: string) => http("/api/runs", { method: "POST", ip, headers: { "content-type": "application/json" }, body: JSON.stringify({ sample }) });
const postJsonText = (body: string, ip: string, contentType = "application/json") => http("/api/runs", { method: "POST", ip, headers: { "content-type": contentType }, body });
function upload(bytes: Uint8Array | string, name: string, ip: string): Promise<Reply> {
  const form = new FormData();
  form.append("file", new Blob([bytes as BlobPart], { type: "application/pdf" }), name);
  return http("/api/runs", { method: "POST", ip, body: form });
}

interface StepJson {
  idx: number;
  key: string;
  label: string;
  status: string;
  severity: string | null;
  reason: string | null;
  detail: Record<string, unknown> | null;
  started_at: string | null;
  finished_at: string | null;
}
interface RunJson {
  id: string;
  status: string;
  file_name: string | null;
  file_hash: string | null;
  decision: string | null;
  decision_reasons: string[];
  next_action: string | null;
  security_flag: boolean;
  extraction: Record<string, unknown> | null;
  model: string | null;
  is_history: boolean;
  created_at: string;
  finished_at: string | null;
  steps: StepJson[];
}
interface ListJson {
  runs: { id: string; created_at: string; decision: string | null; security_flag: boolean; is_history: boolean; first_reason: string | null }[];
  kpis: { total: number; approved: number; hold: number; rejected: number; security_flags: number; approved_value: number };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function getRun(id: string, ip: string): Promise<RunJson> {
  const res = await http(`/api/runs/${id}`, { ip });
  ok(res.status === 200, `GET /api/runs/${id} answered ${res.status}`);
  return res.json as RunJson;
}

/** Polls until the run is done or in error. */
async function waitDone(id: string, ip: string, timeoutMs = 120_000, every = 150): Promise<RunJson> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const run = await getRun(id, ip);
    if (run.status === "done" || run.status === "error") return run;
    if (Date.now() > until) fail(`run ${id} did not finish within ${timeoutMs} ms (status ${run.status})`);
    await sleep(every);
  }
}

const sha256 = (bytes: Uint8Array): string => crypto.createHash("sha256").update(bytes).digest("hex");
const sampleBytes = (file: string): Uint8Array => new Uint8Array(fs.readFileSync(samplePdfPath(file as (typeof SAMPLE_FILES)[number])));

/** A fake client address per section: 10.77.<section>.1 */
const ipOf = (section: number): string => `10.77.${section}.1`;
const IP = {
  reset: ipOf(1),
  plan: ipOf(2),
  samples: ipOf(3),
  files: ipOf(4),
  headers: ipOf(5),
  lists: ipOf(6),
  abuse: ipOf(7),
  abuseMore: ipOf(15),
  limit: ipOf(8),
  other: ipOf(9),
  guard: ipOf(10),
  after: ipOf(11),
  big: ipOf(12),
  dup: ipOf(13),
  junk: ipOf(14),
  worker: ipOf(16),
  workerTree: ipOf(17),
};

async function uniquePdf(label: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage().drawText(`${label} ${crypto.randomUUID()}`, { x: 50, y: 700, size: 12, font });
  return await doc.save();
}

/* ================================================================================================
 * The sections
 * ============================================================================================== */

const samples: TruthSample[] = loadTruthSamples();
const runIds = new Map<string, string>(); // sample id -> run id

async function preflight(): Promise<void> {
  // the first request to a route compiles it (dev server): wait for the server instead of failing the first check
  const until = Date.now() + WAIT_FOR_SERVER_MS;
  for (;;) {
    try {
      const res = await http("/api/samples", { ip: IP.reset });
      if (res.status === 200) return;
      if (Date.now() > until) fail(`GET /api/samples answered ${res.status}`);
    } catch (e) {
      if (Date.now() > until) fail(`the server at ${BASE} is not reachable: ${e instanceof Error ? e.message : String(e)}`);
    }
    await sleep(1000);
  }
}

async function sectionReset(): Promise<void> {
  if (TOKEN === "") {
    skip("reset", "start from a clean state (POST /api/reset)", "SMOKE_RESET_TOKEN is not set; results below assume a server that has not processed these samples before");
    return;
  }
  await check("reset", "POST /api/reset with the token starts from the seed state (4 history runs)", async () => {
    const res = await http("/api/reset", { method: "POST", ip: IP.reset, headers: { "x-reset-token": TOKEN } });
    eq(res.status, 200, "status");
    eq(res.json, { ok: true, counts: { vendors: 5, purchase_orders: 8, invoices: 4, runs: 4 } }, "body");
    const list = (await http("/api/runs", { ip: IP.reset })).json as ListJson;
    eq(list.kpis.total, 4, "runs after reset");
  });
}

async function sectionPlan(): Promise<void> {
  const S = "plan";
  await check(S, `{"sample":"../../.env"} -> 400 ApiError`, async () => {
    const res = await postSample("../../.env", IP.plan);
    eq(res.status, 400, "status");
    ok(typeof (res.json as { error?: unknown }).error === "string", "body is { error }");
    ok(!/\.env|\//.test((res.json as { error: string }).error), "the input is not echoed");
  });
  await check(S, "GET /api/files/abc -> 400", async () => {
    const res = await http("/api/files/abc", { ip: IP.plan });
    eq(res.status, 400, "status");
    ok(typeof (res.json as { error?: unknown }).error === "string", "body is { error }");
  });
  await check(S, "GET /api/samples lists the 10 samples with title, scenario and expected decision", async () => {
    const res = await http("/api/samples", { ip: IP.plan });
    eq(res.status, 200, "status");
    const list = res.json as { file: string; title: string; scenario: string; expected: string; edge_case: string | null }[];
    eq(list.map((s) => s.file), [...SAMPLE_FILES], "files in order");
    eq(list.map((s) => s.expected), samples.map((s) => s.meta.expectedDecision), "expected decisions");
    ok(list.every((s) => s.title !== "" && s.scenario !== ""), "titles and scenarios");
  });
  await check(S, "GET /api/runs/<unknown uuid> -> 404, /api/runs/not-a-uuid -> 400", async () => {
    eq((await http("/api/runs/00000000-0000-4000-8000-000000000000", { ip: IP.plan })).status, 404, "unknown id");
    eq((await http("/api/runs/not-a-uuid", { ip: IP.plan })).status, 400, "bad id");
  });
}

/** POST all 10 in demo order from one address (exactly the 10 per minute allowed), then poll each to done. */
async function sectionSamples(): Promise<void> {
  const S = "samples";
  const accepted = new Map<string, number>();
  await check(S, "POST {sample: 01-happy-northwind.pdf} -> 202 { runId } at once (the plan's curl)", async () => {
    const res = await postSample(samples[0].file, IP.samples);
    eq(res.status, 202, "status");
    const body = res.json as { runId?: unknown };
    ok(typeof body.runId === "string" && /^[0-9a-f-]{36}$/.test(body.runId), "runId is a UUID");
    eq(Object.keys(body), ["runId"], "only runId");
    runIds.set(samples[0].id, body.runId as string);
    accepted.set(samples[0].id, Date.now());
  });
  await check(S, "POST the other 9 samples in demo order -> 202 each", async () => {
    for (const s of samples.slice(1)) {
      const res = await postSample(s.file, IP.samples);
      eq(res.status, 202, `${s.file} status`);
      runIds.set(s.id, (res.json as { runId: string }).runId);
    }
    eq(runIds.size, 10, "10 run ids");
    eq(new Set(runIds.values()).size, 10, "10 different run ids");
  });
  await check(S, "run 01 is visible live over HTTP: steps flip one by one, the extraction appears before the run is done", async () => {
    const id = runIds.get("01") as string;
    const seen = new Set<string>();
    let sawRunning = false;
    let sawEarlyExtraction = false;
    let last: RunJson | null = null;
    const until = Date.now() + 120_000;
    while (Date.now() < until) {
      const run = await getRun(id, IP.samples);
      last = run;
      seen.add(run.steps.map((x) => x.status[0]).join(""));
      if (run.status === "running" && run.steps.some((x) => x.status === "running")) sawRunning = true;
      if (run.status !== "done" && run.extraction !== null) sawEarlyExtraction = true;
      if (run.status === "done" || run.status === "error") break;
      await sleep(80);
    }
    ok(last !== null && last.status === "done", "run 01 finished");
    ok(seen.size >= 5, `at least 5 different step states were observed (${seen.size})`);
    ok(sawRunning, "a step was seen as running");
    ok(sawEarlyExtraction, "the extraction was visible before the run was done");
  });
  const finals = new Map<string, RunJson>(); // sample id -> the run as it ended
  for (const s of samples) {
    await check(S, `#${s.id} ${s.file}: ${s.meta.expectedDecision}${s.meta.expectedSecurityFlag ? " + security flag" : ""}, reasons, next action, PO and steps as in the truth _meta`, async () => {
      const run = await waitDone(runIds.get(s.id) as string, IP.samples);
      finals.set(s.id, run);
      const m = s.meta;
      eq(run.status, "done", "status");
      eq(run.decision, m.expectedDecision, "decision");
      eq(run.security_flag, m.expectedSecurityFlag, "security flag");
      for (const phrase of m.expectedReasonIncludes) includes(run.decision_reasons, phrase, "reasons");
      includes(run.next_action, m.expectedNextActionIncludes, "next action");
      eq(run.steps.map((x) => [x.idx, x.key, x.label]).length, 10, "10 steps");
      eq(run.steps.map((x) => x.idx), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], "steps ordered by idx");
      ok(run.steps.every((x) => ["pass", "warn", "fail", "skipped", "error"].includes(x.status)), "no step left pending or running");
      const po = run.steps.find((x) => x.key === "po_match")?.detail ?? null;
      eq(m.expectedPo === null ? null : { po_number: po?.po_number, inferred: po?.inferred }, m.expectedPo, "PO stage 7 ends on");
      for (const [key, want] of Object.entries(m.expectedSteps)) {
        const step = run.steps.find((x) => x.key === key);
        if (!step) fail(`no step ${key}`);
        if (want.status !== undefined) eq(step.status, want.status, `${key} status`);
        if (want.reasonIncludes !== undefined) includes(step.reason, want.reasonIncludes, `${key} reason`);
      }
      eq(run.model, "mock", "this smoke test expects the mock extractor (EXTRACT_MOCK=1)");
      ok(run.extraction !== null && run.file_hash === sha256(sampleBytes(s.file)), "extraction stored and file hash = sha256 of the sample");
      if (m.expectedSecurityFlag) ok(run.decision !== "APPROVE", "a security flag never approves");
    });
  }
  // The ten decisions above do not depend on each other, so only the timestamps show the serial queue at work.
  await check(S, "the 10 runs were processed one at a time, in POST order: each run starts after the previous one finished", () => {
    let previous: RunJson | null = null;
    for (const s of samples) {
      const run = finals.get(s.id);
      if (run === undefined) fail(`no finished run for #${s.id}`);
      const startedAt = run.steps[0].started_at;
      ok(startedAt !== null && run.finished_at !== null, `#${s.id}: has started_at and finished_at`);
      if (previous !== null) {
        ok(previous.finished_at !== null && (startedAt as string) >= previous.finished_at, `#${s.id} started at ${startedAt} but the run before it only finished at ${previous.finished_at}`);
      }
      previous = run;
    }
  });
}

async function sectionFiles(): Promise<void> {
  const S = "files";
  const first = runIds.get("01");
  if (first === undefined) {
    skip(S, "GET /api/files/<hash>", "no run id from the samples section");
    return;
  }
  const run = await getRun(first, IP.files);
  const hash = run.file_hash as string;
  await check(S, "GET /api/files/<hash> returns the exact bytes of the uploaded sample with the exact headers", async () => {
    const res = await http(`/api/files/${hash}`, { ip: IP.files });
    eq(res.status, 200, "status");
    eq(res.headers.get("content-type"), "application/pdf", "content-type");
    eq(res.headers.get("x-content-type-options"), "nosniff", "x-content-type-options (exactly one value)");
    eq(res.headers.get("content-disposition"), "inline", "content-disposition");
    eq(res.headers.get("content-length"), String(res.bytes.length), "content-length");
    const original = sampleBytes("01-happy-northwind.pdf");
    eq(res.bytes.length, original.length, "length");
    eq(sha256(res.bytes), sha256(original), "sha256 of the bytes");
    ok(Buffer.compare(Buffer.from(res.bytes), Buffer.from(original)) === 0, "byte for byte");
    eq(sha256(res.bytes), hash, "and the address is the hash of what it serves");
  });
  await check(S, "bad or unknown hashes: 400 for a malformed one (also traversal), 404 for an unknown one, never a path", async () => {
    for (const bad of ["abc", hash.toUpperCase(), `${hash}0`, hash.slice(1), "..%2f..%2f.env", "..%2F..%2F..%2Fetc%2Fpasswd", "%2e%2e%2f%2e%2e%2f.env", "g".repeat(64)]) {
      const res = await http(`/api/files/${bad}`, { ip: IP.files });
      ok(res.status === 400 || res.status === 404, `${bad}: expected 400 or 404, got ${res.status}`);
      ok(!res.text.includes("root:") && !/\/Users\/|\.env|DATA_DIR/.test(res.text), `${bad}: no path or file content in the answer`);
      ok(res.headers.get("content-type") !== "application/pdf", `${bad}: not served as a PDF`);
    }
    eq((await http(`/api/files/${"a".repeat(64)}`, { ip: IP.files })).status, 404, "an unknown hash");
    eq((await http("/api/files/abc", { ip: IP.files })).status, 400, "a malformed hash");
  });
}

async function sectionHeaders(): Promise<void> {
  const S = "headers";
  const first = runIds.get("01");
  const hash = first === undefined ? "a".repeat(64) : ((await getRun(first, IP.headers)).file_hash as string);
  const paths: [string, { method?: string; body?: string; headers?: Record<string, string> }][] = [
    ["/api/samples", {}],
    ["/api/master", {}],
    ["/api/runs", {}],
    [`/api/files/${hash}`, {}],
    ["/api/files/abc", {}],
    ["/api/runs/not-a-uuid", {}],
    ["/api/no-such-route", {}],
    ["/", {}],
    ["/api/runs", { method: "POST", body: "{not json", headers: { "content-type": "application/json" } }],
  ];
  for (const [p, init] of paths) {
    await check(S, `${init.method ?? "GET"} ${p.replace(hash, "<hash>")}: baseline security headers, a CSP (none on the PDF response), no X-Powered-By`, async () => {
      const res = await http(p, { ip: IP.headers, method: init.method, body: init.body, headers: init.headers });
      ok(res.status < 500 || p === "/", `answered ${res.status}`);
      eq(res.headers.get("x-content-type-options"), "nosniff", "X-Content-Type-Options");
      eq(res.headers.get("referrer-policy"), "no-referrer", "Referrer-Policy");
      eq(res.headers.get("x-frame-options"), "SAMEORIGIN", "X-Frame-Options");
      const permissions = res.headers.get("permissions-policy") ?? "";
      for (const feature of ["camera=()", "microphone=()", "geolocation=()"]) includes(permissions, feature, "Permissions-Policy");
      eq(res.headers.get("x-powered-by"), null, "X-Powered-By");
      const csp = res.headers.get("content-security-policy");
      if (p.startsWith("/api/files/")) ok(csp === null, "no CSP on the PDF response itself (it can stop Chrome's built-in viewer)");
      else {
        ok(csp !== null, "a Content-Security-Policy is sent (review round B7)");
        for (const directive of ["default-src 'self'", "frame-src 'self'", "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'self'"]) {
          includes(csp, directive, "Content-Security-Policy");
        }
      }
      if (p.startsWith("/api/") && !p.startsWith("/api/files/") && res.status !== 404) {
        eq(res.headers.get("cache-control"), "no-store", "Cache-Control on JSON");
      }
    });
  }
}

async function sectionLists(): Promise<void> {
  const S = "lists";
  if (runIds.size < 10) {
    skip(S, "dashboard list, KPIs and master data", "the samples section did not create 10 runs");
    return;
  }
  const history = readSeedFiles().history;
  const approvedSamples = samples.filter((s) => s.meta.expectedDecision === "APPROVE");
  const count = (d: string) => samples.filter((s) => s.meta.expectedDecision === d).length;
  await check(S, "GET /api/runs: newest first, history flagged, KPIs over all runs equal the expected decisions", async () => {
    const res = await http("/api/runs", { ip: IP.lists });
    eq(res.status, 200, "status");
    const list = res.json as ListJson;
    eq(list.runs.length, 14, "4 history + 10 runs");
    eq(list.runs.slice(0, 10).map((r) => r.id), samples.map((s) => runIds.get(s.id)).reverse(), "newest first = reverse demo order");
    eq(list.runs.filter((r) => r.is_history).length, 4, "history runs flagged");
    const created = list.runs.map((r) => r.created_at);
    ok(created.every((c, i) => i === 0 || c <= created[i - 1]), "created_at never increases down the list");
    const approvedValue = Math.round((history.reduce((sum, h) => sum + h.total, 0) + approvedSamples.reduce((sum, s) => sum + (s.extraction.total ?? 0), 0)) * 100) / 100;
    eq(
      list.kpis,
      {
        total: 14,
        approved: 4 + count("APPROVE"),
        hold: count("HOLD"),
        rejected: count("REJECT"),
        security_flags: samples.filter((s) => s.meta.expectedSecurityFlag).length,
        approved_value: approvedValue,
      },
      "KPIs",
    );
  });
  await check(S, "GET /api/runs filters and limit: decision=, security, limit=, empty values; KPIs ignore both", async () => {
    const q = async (query: string) => (await http(`/api/runs${query}`, { ip: IP.lists })).json as ListJson;
    eq((await q("?decision=REJECT")).runs.length, count("REJECT"), "REJECT");
    eq((await q("?decision=HOLD")).runs.length, count("HOLD"), "HOLD");
    eq((await q("?decision=APPROVE")).runs.length, 4 + count("APPROVE"), "APPROVE");
    eq((await q("?decision=security")).runs.map((r) => r.id), [runIds.get("09")], "security");
    const one = await q("?limit=1");
    eq([one.runs.length, one.kpis.total], [1, 14], "limit=1 keeps the KPIs");
    eq((await q("?decision=&limit=")).runs.length, 14, "the plan's ?decision=&limit= form");
    eq((await q("?limit=200")).runs.length, 14, "limit=200");
  });
  await check(S, "GET /api/runs bad parameters -> 400 (limit 0, 201, abc, 1.5; decision bogus), never 500", async () => {
    for (const bad of ["?limit=0", "?limit=201", "?limit=abc", "?limit=1.5", "?limit=-1", "?decision=bogus", "?decision=approve", "?limit=1&limit=2", "?limit=1;DROP%20TABLE%20runs"]) {
      const res = await http(`/api/runs${bad}`, { ip: IP.lists });
      eq(res.status, 400, bad);
      ok(typeof (res.json as { error?: unknown } | null)?.error === "string", `${bad}: ApiError body`);
    }
    eq(((await http("/api/runs", { ip: IP.lists })).json as ListJson).kpis.total, 14, "the table is intact");
  });
  await check(S, "GET /api/runs/:id for a pre-loaded history run: is_history, no steps", async () => {
    const id = historyRunId("V001", "INV-0042");
    const res = await http(`/api/runs/${id}`, { ip: IP.lists });
    eq(res.status, 200, "status");
    const run = res.json as RunJson;
    eq([run.is_history, run.steps, run.decision, run.model], [true, [], "APPROVE", "history"], "history run");
  });
  await check(S, "GET /api/master: banks masked (never raw), PO balances after the demo order", async () => {
    const res = await http("/api/master", { ip: IP.lists });
    eq(res.status, 200, "status");
    const master = res.json as { vendors: { id: string; bank_account_masked: string | null }[]; purchase_orders: { po_number: string; remaining: number; invoiced: number; approved_invoices: string[] }[] };
    for (const v of readSeedFiles().vendors) {
      ok(v.bank_account === null || !res.text.includes(v.bank_account), `raw bank account of ${v.id} is not in the response`);
      eq(master.vendors.find((x) => x.id === v.id)?.bank_account_masked, v.bank_account === null ? null : `••••${v.bank_account.slice(-4)}`, `${v.id} masked`);
    }
    const remaining = (po: string) => master.purchase_orders.find((p) => p.po_number === po)?.remaining;
    eq([remaining("PO-1001"), remaining("PO-1002"), remaining("PO-1003"), remaining("PO-1006"), remaining("PO-1007")], [0, 2300, 6000, 4000, -24], "balances after #1, #2 and #7 were approved");
    eq(master.purchase_orders.find((p) => p.po_number === "PO-1003")?.approved_invoices, ["GLX-301", "GLX-302"], "PO-1003's approving invoices");
  });
}

async function sectionAbuse(): Promise<void> {
  const S = "abuse";
  const total = async () => ((await http("/api/runs", { ip: IP.abuse })).json as ListJson).kpis.total;
  await check(S, "malformed POST bodies are 400 (never 500): non-string sample, invalid JSON, wrong content type, no file, two files", async () => {
    const cases: [string, Reply][] = [
      ["non-string sample", await postJsonText(JSON.stringify({ sample: 5 }), IP.abuse)],
      ["array sample", await postJsonText(JSON.stringify({ sample: ["01-happy-northwind.pdf"] }), IP.abuse)],
      ["unknown sample", await postJsonText(JSON.stringify({ sample: "99-nope.pdf" }), IP.abuse)],
      ["traversal with a valid suffix", await postJsonText(JSON.stringify({ sample: "../data/samples/01-happy-northwind.pdf" }), IP.abuse)],
      ["invalid JSON", await postJsonText("{not json", IP.abuseMore)],
      ["JSON null", await postJsonText("null", IP.abuseMore)],
      ["text/plain", await postJsonText('{"sample":"01-happy-northwind.pdf"}', IP.abuseMore, "text/plain")],
      ["no content type", await http("/api/runs", { method: "POST", ip: IP.abuseMore, body: '{"sample":"01-happy-northwind.pdf"}' })],
      ["multipart without a file", await http("/api/runs", { method: "POST", ip: IP.abuseMore, body: (() => { const f = new FormData(); f.append("note", "hi"); return f; })() })],
      ["multipart with two files", await http("/api/runs", { method: "POST", ip: IP.abuseMore, body: (() => { const f = new FormData(); f.append("file", new Blob(["a"]), "a.pdf"); f.append("file", new Blob(["b"]), "b.pdf"); return f; })() })],
    ];
    for (const [what, res] of cases) {
      eq(res.status, 400, what);
      ok(typeof (res.json as { error?: unknown } | null)?.error === "string", `${what}: ApiError body`);
      ok(!/\/Users\/|\.env|node_modules|at Object/.test(res.text), `${what}: no path or stack trace`);
    }
  });
  await check(S, "a .txt renamed .pdf is accepted (202) and ends REJECT 'Not a PDF' at ingest, stages 2-9 skipped", async () => {
    const res = await upload(new TextEncoder().encode(`Meeting notes ${crypto.randomUUID()}\n`), "invoice.pdf", IP.junk);
    eq(res.status, 202, "status");
    const run = await waitDone((res.json as { runId: string }).runId, IP.junk);
    eq([run.status, run.decision, run.file_name], ["done", "REJECT", "invoice.pdf"], "run");
    eq([run.steps[0].status, run.steps[0].reason], ["fail", "Not a PDF"], "ingest");
    eq(run.steps.slice(1, 9).map((s) => s.status), Array(8).fill("skipped"), "stages 2-9");
    eq(run.steps[9].status, "pass", "decide still runs");
  });
  await check(S, "a hostile file name is stored as plain text only", async () => {
    const res = await upload(new TextEncoder().encode(`x ${crypto.randomUUID()}`), "evil<img src=x onerror=alert(1)>../../etc/passwd.pdf", IP.junk);
    eq(res.status, 202, "status");
    const run = await waitDone((res.json as { runId: string }).runId, IP.junk);
    ok(run.file_name !== null && !/[<>/\\()=]/.test(run.file_name), `file_name is plain: ${show(run.file_name)}`);
  });
  await check(S, "the same file twice, back to back: the first is processed, the second is REJECT 'Exact same file already processed in run <id>' (the serial queue)", async () => {
    const pdf = await uniquePdf("Smoke test document");
    // both uploads are sent before either run can have finished: only a queue that runs them one at a time lets the second see the first
    const a = await upload(pdf, "a.pdf", IP.dup);
    const b = await upload(pdf, "b.pdf", IP.dup);
    eq([a.status, b.status], [202, 202], "both uploads accepted");
    const firstId = (a.json as { runId: string }).runId;
    const first = await waitDone(firstId, IP.dup);
    const second = await waitDone((b.json as { runId: string }).runId, IP.dup);
    eq(first.status, "done", "first run finished");
    ok(first.decision !== "REJECT" || !first.steps[0].reason?.includes("Exact same file"), "the first copy is not a duplicate");
    eq(second.decision, "REJECT", "decision of the second");
    includes(second.decision_reasons[0], `Exact same file already processed in run ${firstId}`, "reason");
  });
  await check(S, "oversize upload (12 MB) -> 413 and no run is created", async () => {
    const before = await total();
    const res = await upload(new Uint8Array(12 * 1024 * 1024).fill(0x41), "big.pdf", IP.big);
    eq(res.status, 413, "status");
    ok(typeof (res.json as { error?: unknown } | null)?.error === "string", "ApiError body");
    includes((res.json as { error: string }).error, "10 MB", "message names the limit");
    eq(await total(), before, "no run was created");
  });
  await check(S, "12 rapid uploads from one address: 202 for the first 10, then 429 with Retry-After and retryAfterSec", async () => {
    const statuses: number[] = [];
    let limited: Reply | null = null;
    for (let i = 0; i < 12; i++) {
      const res = await upload(new TextEncoder().encode(`rapid ${i} ${crypto.randomUUID()}`), "rapid.pdf", IP.limit);
      statuses.push(res.status);
      if (res.status === 429 && limited === null) limited = res;
    }
    eq(statuses, [...Array(10).fill(202), 429, 429], "statuses");
    const body = (limited as unknown as Reply).json as { error: string; retryAfterSec: number };
    ok(Number.isInteger(body.retryAfterSec) && body.retryAfterSec >= 1 && body.retryAfterSec <= 60, `retryAfterSec ${body.retryAfterSec}`);
    eq((limited as unknown as Reply).headers.get("retry-after"), String(body.retryAfterSec), "Retry-After header");
    includes(body.error, "Too many runs", "friendly message");
    eq((await upload(new TextEncoder().encode(`other client ${crypto.randomUUID()}`), "ok.pdf", IP.other)).status, 202, "another address is not limited");
  });
}

async function sectionResetGuard(): Promise<void> {
  const S = "reset-guard";
  const total = async () => ((await http("/api/runs", { ip: IP.guard })).json as ListJson).kpis.total;
  const before = await total();
  await check(S, "POST /api/reset without a token -> 403, with a wrong token -> 403, with a short token -> 403; nothing is reset", async () => {
    const none = await http("/api/reset", { method: "POST", ip: IP.guard });
    eq(none.status, 403, "no token");
    ok(typeof (none.json as { error?: unknown } | null)?.error === "string", "ApiError body");
    eq((await http("/api/reset", { method: "POST", ip: IP.guard, headers: { "x-reset-token": "definitely-not-the-token-123456" } })).status, 403, "wrong token");
    eq((await http("/api/reset", { method: "POST", ip: IP.guard, headers: { "x-reset-token": "short" } })).status, 403, "short token");
    eq((await http("/api/reset", { method: "POST", ip: IP.guard, headers: { "x-reset-token": "z".repeat(5000) } })).status, 403, "very long token");
    eq(await total(), before, "no run was removed");
  });
  if (TOKEN === "") {
    skip(S, "POST /api/reset with the right token -> 200, only history remains, uploads gone", "SMOKE_RESET_TOKEN is not set");
    return;
  }
  await check(S, "POST /api/reset with the token -> 200, only the 4 history runs remain, uploads are wiped, the system works again", async () => {
    const hash = sha256(sampleBytes("01-happy-northwind.pdf"));
    eq((await http(`/api/files/${hash}`, { ip: IP.guard })).status, 200, "the upload exists before the reset");
    const res = await http("/api/reset", { method: "POST", ip: IP.guard, headers: { "x-reset-token": TOKEN } });
    eq(res.status, 200, "status");
    eq(res.json, { ok: true, counts: { vendors: 5, purchase_orders: 8, invoices: 4, runs: 4 } }, "body");
    const list = (await http("/api/runs", { ip: IP.guard })).json as ListJson;
    eq([list.kpis.total, list.runs.every((r) => r.is_history)], [4, true], "only history");
    eq((await http(`/api/files/${hash}`, { ip: IP.guard })).status, 404, "the upload is gone");
    const again = await postSample("01-happy-northwind.pdf", IP.after);
    eq(again.status, 202, "a sample can be started again");
    const run = await waitDone((again.json as { runId: string }).runId, IP.after);
    eq(run.decision, "APPROVE", "and it is not a duplicate of the wiped run");
  });
}

/** A valid 1-page PDF whose content stream is `ops` non-text "q Q" operators: seconds of synchronous pdf.js work, ~60 KB. */
async function opFloodPdf(ops: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const z = deflateSync(Buffer.alloc(ops * 4).fill("q Q\n", "latin1"), { level: 6 });
  page.node.set(PDFName.of("Contents"), doc.context.register(doc.context.stream(z, { Filter: "FlateDecode", Length: z.length })));
  return await doc.save({ useObjectStreams: false });
}

/**
 * The deployment parses uploads in the PDF text WORKER (src/lib/pdf-text-worker.mjs), not on the server's event loop:
 * while a file keeps pdf.js busy for seconds, the server still answers at once. (In-process, the same file blocked every
 * request for the whole parse.) This is the behavioural proof that the worker started in this build.
 */
async function sectionWorker(): Promise<void> {
  const S = "worker";
  await check(S, "a PDF that keeps pdf.js busy for seconds does not stall the server (the text read runs in a worker thread)", async () => {
    const res = await upload(await opFloodPdf(15_000_000), "op-flood.pdf", IP.worker);
    eq(res.status, 202, "upload accepted");
    const id = (res.json as { runId: string }).runId;
    for (let i = 0; ; i++) {
      const status = (await getRun(id, IP.worker)).steps[0]?.status;
      if (status === "running") break;
      if (status !== "pending" || i > 2400) fail(`the ingest stage never ran (status ${status})`);
      await sleep(25);
    }
    const latencies: number[] = [];
    for (;;) {
      const t0 = performance.now();
      eq((await http("/api/samples", { ip: IP.worker })).status, 200, "GET /api/samples while the file is parsed");
      latencies.push(performance.now() - t0);
      if ((await getRun(id, IP.worker)).steps[0]?.status !== "running") break;
      await sleep(25);
    }
    const ingest = (await waitDone(id, IP.worker)).steps[0];
    const took = Date.parse(ingest.finished_at ?? "") - Date.parse(ingest.started_at ?? "");
    ok(took >= 1000, `the parse took only ${took} ms, too short to tell (the file should keep pdf.js busy for seconds)`);
    const worst = Math.max(...latencies);
    ok(latencies.length >= 5 && worst < 1000, `${latencies.length} requests answered during the ${took} ms parse, the slowest in ${Math.round(worst)} ms`);
  });
  await check(S, "fix round SEC-1: a ~3 KB page tree that keeps pdf-lib busy for minutes does not stall the server and is cut off at the 10 s deadline", async () => {
    // 2^32 page-tree visits in pdf-lib's getPageCount: in-process that froze every request for many minutes (13 s at 2^26,
    // measured). The structure step now runs in the worker thread with the text read, terminated at the upload deadline.
    const file = pageTreeDagPdf(32);
    ok(file.length < 5000, `the file is only ${file.length} bytes`);
    const res = await upload(file, "page-tree.pdf", IP.workerTree);
    eq(res.status, 202, "upload accepted");
    const id = (res.json as { runId: string }).runId;
    for (let i = 0; ; i++) {
      const status = (await getRun(id, IP.workerTree)).steps[0]?.status;
      if (status === "running") break;
      if (status !== "pending" || i > 2400) fail(`the ingest stage never ran (status ${status})`);
      await sleep(25);
    }
    const latencies: number[] = [];
    for (;;) {
      const t0 = performance.now();
      eq((await http("/api/samples", { ip: IP.workerTree })).status, 200, "GET /api/samples while the file is parsed");
      latencies.push(performance.now() - t0);
      if ((await getRun(id, IP.workerTree)).steps[0]?.status !== "running") break;
      await sleep(100);
    }
    const run = await waitDone(id, IP.workerTree);
    const ingest = run.steps[0];
    eq([run.decision, ingest.status, ingest.reason], ["REJECT", "fail", "PDF is damaged or unreadable"], "rejected as damaged at the deadline");
    const took = Date.parse(ingest.finished_at ?? "") - Date.parse(ingest.started_at ?? "");
    ok(took < 15_000, `the ingest stage took ${took} ms (the upload deadline is 10 s)`);
    const worst = Math.max(...latencies);
    ok(latencies.length >= 5 && worst < 1000, `${latencies.length} requests answered during the ${took} ms parse, the slowest in ${Math.round(worst)} ms`);
  });
}

/** A ~3 KB PDF whose page tree lists the same child twice per level, `depth` levels deep: 2^depth pdf-lib visits, 1 real page. */
function pageTreeDagPdf(depth: number): Uint8Array {
  const objects: string[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>",
    "<< /Length 0 >>\nstream\n\nendstream",
  ];
  for (let i = 0; i <= depth; i++) {
    const self = 5 + i;
    objects.push(`<< /Type /Pages /Parent ${i === 0 ? 2 : self - 1} 0 R /Kids [${i < depth ? `${self + 1} 0 R ${self + 1} 0 R` : ""}] /Count 0 >>`);
  }
  let pdf = "%PDF-1.7\n";
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(pdf, "latin1"));
}

/** Optional: the server's own log. */
async function sectionLog(): Promise<void> {
  const S = "log";
  if (SERVER_LOG === "") {
    skip(S, "server log: one JSON line per stage, text worker started", "SMOKE_SERVER_LOG is not set");
    return;
  }
  const text = fs.readFileSync(path.resolve(SERVER_LOG), "utf8");
  await check(S, "the server log has no 'no text-parse worker could be started' warning", () => {
    ok(!text.includes("no text-parse worker could be started"), "the PDF text worker did not start under Next");
  });
  await check(S, "every one of the 10 sample runs logged exactly one JSON line per stage, in order, with no extra fields", () => {
    const lines = text.split("\n").filter((l) => l.startsWith('{"run":'));
    const byRun = new Map<string, Record<string, unknown>[]>();
    for (const l of lines) {
      const o = JSON.parse(l) as Record<string, unknown>;
      const id = String(o.run);
      byRun.set(id, [...(byRun.get(id) ?? []), o]);
    }
    const order = ["ingest", "screen", "extract", "validate", "normalize", "vendor", "po_match", "amounts", "duplicate", "decide"];
    for (const s of samples) {
      const id = runIds.get(s.id) as string;
      const mine = byRun.get(id) ?? [];
      eq(mine.map((o) => o.stage), order, `#${s.id} stage lines`);
      ok(mine.every((o) => JSON.stringify(Object.keys(o)) === JSON.stringify(["run", "stage", "status", "ms"])), `#${s.id}: exactly run, stage, status, ms`);
      ok(mine.every((o) => Number.isInteger(o.ms)), `#${s.id}: integer ms`);
    }
  });
  await check(S, "the log never contains extracted text, bank numbers or key material", () => {
    for (const s of samples) {
      for (const secret of [s.extraction.vendor_name, s.extraction.invoice_number, s.extraction.bank_account]) {
        ok(secret === null || !text.includes(`"${secret}"`), `the log quotes "${secret}"`);
      }
    }
    ok(!/sk-or-/.test(text), "no key material");
  });
}

/* ================================================================================================
 * main
 * ============================================================================================== */

async function main(): Promise<number> {
  console.log(`Smoke test of ${BASE} (reset token ${TOKEN === "" ? "NOT provided" : "provided"}${SERVER_LOG === "" ? "" : `, server log ${SERVER_LOG}`})`);
  if (samples.length !== 10 || samples.some((s) => !s.pdfExists)) throw new Error("the 10 samples are needed (npm run gen)");
  await check("preflight", "the server answers GET /api/samples", preflight);
  if (rows.some((r) => r.result === "FAIL")) return report();
  await sectionReset();
  await sectionPlan();
  await sectionSamples();
  await sectionFiles();
  await sectionHeaders();
  await sectionLists();
  await sectionAbuse();
  await sectionWorker();
  await sectionResetGuard();
  await sectionLog();
  return report();
}

function report(): number {
  reported = true;
  const failed = rows.filter((r) => r.result === "FAIL");
  const skipped = rows.filter((r) => r.result === "SKIP");
  const width = (key: "section" | "name", max: number) => Math.min(max, Math.max(key.length, ...rows.map((r) => r[key].length)));
  const w1 = width("section", 14);
  const w2 = width("name", 96);
  const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 3)}...` : s.padEnd(n));
  console.log(`\n${"RESULT".padEnd(7)}${"SECTION".padEnd(w1 + 2)}${"CHECK".padEnd(w2 + 2)}DETAIL`);
  for (const r of rows) console.log(`${r.result.padEnd(7)}${clip(r.section, w1)}  ${clip(r.name, w2)}  ${r.detail}`);
  console.log(`\n${rows.length - failed.length - skipped.length} passed, ${failed.length} failed, ${skipped.length} skipped (of ${rows.length})`);
  console.log(failed.length === 0 ? "All smoke checks passed." : "Smoke checks FAILED.");
  return failed.length === 0 ? 0 : 1;
}

/** A promise that never settles ends a Node process silently with exit code 0: no table printed means failure. */
let reported = false;
process.on("exit", (code) => {
  if (!reported && code === 0) {
    process.exitCode = 1;
    console.error("scripts/smoke-http.ts: the process ended before the table was printed; counted as a failure");
  }
});

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((e) => {
    console.error(e instanceof Error ? (e.stack ?? e.message) : e);
    process.exit(1);
  });
