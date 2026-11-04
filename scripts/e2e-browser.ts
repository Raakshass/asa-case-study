/**
 * npx tsx scripts/e2e-browser.ts [section ...]
 *
 * Real-browser end-to-end check of a RUNNING server (production `next start` or `next dev`, started with
 * EXTRACT_MOCK=1), driven with Playwright's Chromium, headless. It clicks through the app the way a person does and
 * prints a PASS / FAIL table; exit code 1 on any failure.
 *
 *   BASE_URL            default http://127.0.0.1:3100
 *   SMOKE_RESET_TOKEN   the server's DEMO_RESET_TOKEN. Required: every click-through starts from a reset done in the UI.
 *   E2E_SHOTS           folder for the PNG screenshots (default <os tmp>/e2e-browser-shots)
 *   E2E_DATA_DIR        the server's DATA_DIR. Enables the "xss" section, which writes hostile rows straight into the
 *                       server's SQLite file (the repo's db helpers) and checks they render as plain text, and the
 *                       unhappy section's stored-file check, which deletes the stored copy of one upload of its own
 *                       from <DATA_DIR>/uploads while the server runs.
 *   E2E_PASSES          full click-throughs of the 10 samples (default 2: the plan's "two clean runs in a row")
 *
 * Sections (default: all, in this order): reset, samples (E2E_PASSES passes, a reset before each), dashboard, data,
 * narrow (375 px), keyboard, unhappy (bad links, wrong files, 429), xss.
 *
 * Every browser context sends its own x-forwarded-for address, as a proxy in front of the app would, so the 10 runs
 * per minute per address of POST /api/runs never couples two samples or two sections (the route reads the last
 * x-forwarded-for entry when there is no x-real-ip). The expected decisions come from the truth files
 * (data/samples/truth/NN.json _meta) and the expected stage statuses from scripts/rehearse.ts (run as a child
 * process, like scripts/test-api.ts does); the samples are dated 2026-10-20..31, so they decide as expected until
 * 2027-10-20. The browser must never see a console error or warning (hydration included) or a failed request it did
 * not cause on purpose.
 */
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { type Browser, type BrowserContext, type Locator, type Page, type Request as PwRequest, type Response as PwResponse, chromium } from "playwright";
import { type TruthSample, loadTruthSamples, samplePdfPath } from "../src/lib/samples";
import { STAGES, STAGE_KEYS, type StageKey } from "../src/lib/types";

const ROOT = path.resolve(__dirname, "..");
const BASE = (process.env.BASE_URL ?? "http://127.0.0.1:3100").replace(/\/+$/, "");
const TOKEN = process.env.SMOKE_RESET_TOKEN ?? "";
const SHOTS = process.env.E2E_SHOTS ?? path.join(os.tmpdir(), "e2e-browser-shots");
const DATA_DIR = process.env.E2E_DATA_DIR ?? "";
const PASSES = Math.max(1, Number.parseInt(process.env.E2E_PASSES ?? "2", 10) || 2);
const RUN_TIMEOUT_MS = 60_000;
const SECTIONS = ["reset", "samples", "dashboard", "data", "narrow", "keyboard", "unhappy", "xss", "automations", "review"] as const;
type Section = (typeof SECTIONS)[number];

/* ================================================================================================
 * Runner
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
const ok = (cond: unknown, message: string): void => {
  if (!cond) fail(message);
};
const show = (v: unknown): string => {
  const s = JSON.stringify(v);
  return s === undefined ? String(v) : s.length > 220 ? `${s.slice(0, 217)}...` : s;
};
const eq = (actual: unknown, expected: unknown, message: string): void => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(`${message}: expected ${show(expected)}, got ${show(actual)}`);
};
const has = (haystack: string, needle: string, message: string): void => {
  if (!haystack.toLowerCase().includes(needle.toLowerCase())) fail(`${message}: ${show(needle)} not found in ${show(haystack.slice(0, 300))}`);
};

async function check(section: string, name: string, fn: () => Promise<void>): Promise<void> {
  const started = Date.now();
  try {
    await fn();
    rows.push({ result: "PASS", section, name, detail: "" });
    console.log(`  PASS  ${section} > ${name} (${Date.now() - started} ms)`);
  } catch (e) {
    const detail = e instanceof Error ? (e instanceof Failed ? e.message : `${e.name}: ${e.message.split("\n")[0]}`) : String(e);
    rows.push({ result: "FAIL", section, name, detail });
    console.log(`  FAIL  ${section} > ${name}: ${detail}`);
  }
}
function skip(section: string, name: string, why: string): void {
  rows.push({ result: "SKIP", section, name, detail: why });
  console.log(`  SKIP  ${section} > ${name}: ${why}`);
}

/* ================================================================================================
 * Browser helpers
 * ============================================================================================== */

let ipCounter = Math.floor(Math.random() * 200);
/** A fresh client address (as a proxy would send it) for the next context or sample. */
const nextIp = (): string => `198.18.${Math.floor(ipCounter / 250) % 250}.${(ipCounter++ % 250) + 1}`;

/** Everything a page did wrong: console errors and warnings, uncaught errors, failed or 5xx requests. */
interface Watch {
  problems: string[];
  /** responses by path (for "the PDF frame loaded"; the method tells the frame's GET from the panel's HEAD probe) */
  responses: { url: string; status: number; type: string; method: string }[];
  /** paths whose 4xx is expected in the current check */
  allow4xx: RegExp[];
}
const watches = new WeakMap<Page, Watch>();

function watch(page: Page): Watch {
  const w: Watch = { problems: [], responses: [], allow4xx: [] };
  watches.set(page, w);
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") w.problems.push(`console.${m.type()}: ${m.text().slice(0, 300)}`);
  });
  page.on("pageerror", (e) => w.problems.push(`pageerror: ${e.message.slice(0, 300)}`));
  page.on("requestfailed", (r: PwRequest) => {
    if (!r.url().startsWith(new URL(BASE).origin)) return; // e.g. the browser's own PDF viewer frame, aborted on navigation
    const failure = r.failure()?.errorText ?? "failed";
    // a poll or a prefetch aborted by a navigation or an unmount is the app working as intended
    if (failure.includes("ERR_ABORTED") && (r.resourceType() === "fetch" || r.url().includes("_rsc="))) return;
    w.problems.push(`request failed: ${r.method()} ${new URL(r.url()).pathname} (${failure})`);
  });
  page.on("response", (r: PwResponse) => {
    const url = new URL(r.url());
    if (url.origin !== new URL(BASE).origin) return;
    w.responses.push({ url: url.pathname, status: r.status(), type: r.headers()["content-type"] ?? "", method: r.request().method() });
    if (r.status() >= 500 || (r.status() >= 400 && !w.allow4xx.some((re) => re.test(url.pathname)))) {
      w.problems.push(`HTTP ${r.status()} for ${r.request().method()} ${url.pathname}`);
    }
  });
  return w;
}
const watchOf = (page: Page): Watch => watches.get(page) as Watch;
/** The problems collected since the last call (and forgets them). */
const takeProblems = (page: Page): string[] => watchOf(page).problems.splice(0);

let browser: Browser;
async function launch(): Promise<Browser> {
  // The full Chromium build (new headless mode) has the PDF viewer; the headless shell has none. Fall back to it.
  try {
    return await chromium.launch({ channel: "chromium" });
  } catch {
    return await chromium.launch();
  }
}

async function newContext(opts: { width?: number; height?: number; ip?: string } = {}): Promise<BrowserContext> {
  const ctx = await browser.newContext({
    viewport: { width: opts.width ?? 1366, height: opts.height ?? 900 },
    extraHTTPHeaders: { "x-forwarded-for": opts.ip ?? nextIp() },
    locale: "en-US",
    timezoneId: "UTC",
  });
  // tsx (esbuild) wraps named functions inside page.evaluate callbacks in a __name() helper that the page lacks
  await ctx.addInitScript({ content: "globalThis.__name = (fn) => fn;" });
  return ctx;
}

async function newPage(ctx: BrowserContext): Promise<Page> {
  const page = await ctx.newPage();
  watch(page);
  return page;
}

async function shot(page: Page, name: string): Promise<string> {
  fs.mkdirSync(SHOTS, { recursive: true });
  const file = path.join(SHOTS, `${name}.png`);
  // from the top: a full-page capture of a scrolled page paints the sticky header in the middle of the image
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(100);
  await page.screenshot({ path: file, fullPage: true });
  return file;
}

const textOf = async (page: Page, selector = "main"): Promise<string> => ((await page.locator(selector).first().innerText()) ?? "").replace(/\s+/g, " ");

/** No horizontal page scroll: the document is never wider than the viewport. */
async function pageScroll(page: Page): Promise<{ scrollWidth: number; clientWidth: number }> {
  return page.evaluate(() => {
    const el = document.scrollingElement ?? document.documentElement;
    return { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth };
  });
}

/* ================================================================================================
 * Expectations: truth files and the offline rehearsal
 * ============================================================================================== */

const samples: TruthSample[] = loadTruthSamples();
const STATUS_OF: Record<string, string> = { p: "pass", w: "warn", F: "fail", "-": "skipped", E: "error" };

/** Stage statuses 1-9 per sample id, from what scripts/rehearse.ts prints (the offline run of the same pipeline). */
function rehearsedStages(): Map<string, string[]> {
  const cli = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
  const res = spawnSync(process.execPath, [cli, path.join(ROOT, "scripts", "rehearse.ts")], {
    cwd: ROOT,
    env: { ...process.env, EXTRACT_MOCK: "1" },
    encoding: "utf8",
    timeout: 120_000,
  });
  if (res.status !== 0) throw new Error(`scripts/rehearse.ts exited with ${res.status}`);
  const out = new Map<string, string[]>();
  for (const line of res.stdout.split("\n")) {
    const m = /^(\d{2})\s+(?:APPROVE|HOLD|REJECT)\s+(?:APPROVE|HOLD|REJECT)\s+(?:yes|no)\s+.+?\s{2,}([pwF\-E]{9})\s+ok\s/.exec(line);
    if (m) out.set(m[1], [...m[2]].map((c) => STATUS_OF[c]));
  }
  if (out.size !== 10) throw new Error(`scripts/rehearse.ts printed ${out.size} rows that agree with _meta, not 10`);
  return out;
}

const sampleHash = (s: TruthSample): string => crypto.createHash("sha256").update(fs.readFileSync(samplePdfPath(s.file))).digest("hex");

/* ================================================================================================
 * The app, through the UI
 * ============================================================================================== */

/** Start page -> "Reset demo data" -> token -> "Confirm reset", and wait for the success note. */
async function resetViaUi(page: Page): Promise<void> {
  await page.goto(`${BASE}/runs/new`);
  await page.getByRole("button", { name: "Reset demo data" }).click();
  await page.getByLabel("Reset token").fill(TOKEN);
  await page.getByRole("button", { name: "Confirm reset" }).click();
  await page.getByRole("status").filter({ hasText: "Demo data reset" }).waitFor({ timeout: 70_000 });
}

/** The decision card of a finished run (its heading is exactly "Decision"). */
const decisionCard = (page: Page) => page.locator("section").filter({ has: page.locator("h2", { hasText: /^Decision$/ }) });

/** A list in the decision card, by its heading (fix round UI-5: "Why it is on hold" / "Why it was rejected", "Also noted"). */
const reasonList = (page: Page, card: Locator, heading: RegExp) => card.locator("section").filter({ has: page.locator("h3", { hasText: heading }) });
const WHY_HEADING = /^Why it (is on hold|was rejected)$/;
const NOTES_HEADING = /^Also noted$/;

interface SampleResult {
  id: string;
  runId: string;
  decision: string;
  statuses: string[];
  shot: string;
  checks: string;
}

/** Clicks the sample's card at /runs/new, waits for the final decision card and checks everything the run view shows. */
async function runSampleViaUi(page: Page, s: TruthSample, expectedStages: string[], pass: number): Promise<SampleResult> {
  const m = s.meta;
  await page.context().setExtraHTTPHeaders({ "x-forwarded-for": nextIp() });
  await page.goto(`${BASE}/runs/new`);
  const card = page.locator(`button[data-sample="${s.file}"]`);
  await card.waitFor();
  await card.click();
  await page.waitForURL(/\/runs\/[0-9a-f-]{36}$/, { timeout: 30_000 });
  const runId = page.url().split("/").pop() as string;
  const final = decisionCard(page);
  await final.waitFor({ timeout: RUN_TIMEOUT_MS });
  const decision = await final.locator("[data-decision]").first().getAttribute("data-decision");
  eq(decision, m.expectedDecision, `#${s.id} decision`);
  const cardText = (await final.innerText()).replace(/\s+/g, " ");
  for (const phrase of m.expectedReasonIncludes) has(cardText, phrase, `#${s.id} reason`);
  has(cardText, m.expectedNextActionIncludes, `#${s.id} next action`);
  if (m.expectedSecurityFlag) ok((await final.getByText("Security flag").count()) > 0, `#${s.id}: the shield badge is shown`);

  // fix round UI-5: on a hold or a reject, a reason that only comes from a note (a warning with severity info, or a
  // passed or skipped stage) is listed under "Also noted" and never under "Why it is ..."; every other reason is listed
  // under "Why it is ..." (the reasons and the stages come from the API: what is stored is unchanged)
  const flat = (t: string): string => t.replace(/\s+/g, " ").trim();
  const whyBox = reasonList(page, final, WHY_HEADING);
  const notesBox = reasonList(page, final, NOTES_HEADING);
  if (m.expectedDecision !== "APPROVE") {
    const api = (await (await page.request.get(`${BASE}/api/runs/${runId}`)).json()) as {
      decision_reasons: string[];
      security_flag: boolean;
      steps: { key: string; status: string; severity: string | null; reason: string | null }[];
    };
    eq(await whyBox.count(), 1, `#${s.id} one list under "${m.expectedDecision === "HOLD" ? "Why it is on hold" : "Why it was rejected"}"`);
    const why = flat(await whyBox.innerText());
    const notes = (await notesBox.count()) > 0 ? flat(await notesBox.innerText()) : "";
    const isNote = (st: { status: string; severity: string | null }) =>
      (st.status === "warn" && (st.severity === "info" || st.severity === null)) || st.status === "pass" || st.status === "skipped";
    // a flagged run's screen and extract reasons quote the hidden text; they are checked with fix round UI-6 below
    const quoting = new Set(api.security_flag ? api.steps.filter((st) => st.key === "screen" || st.key === "extract").map((st) => st.reason) : []);
    for (const reason of api.decision_reasons) {
      const from = api.steps.filter((st) => st.key !== "decide" && st.reason === reason);
      if (from.length > 0 && from.every(isNote)) {
        ok(!why.toLowerCase().includes(flat(reason).toLowerCase()), `#${s.id} the note "${reason.slice(0, 60)}" is not listed under the 'Why' heading`);
        has(notes, flat(reason), `#${s.id} the note is listed under 'Also noted'`);
      } else if (!quoting.has(reason)) {
        has(why, flat(reason), `#${s.id} the cause is listed under the 'Why' heading`);
      }
    }
    if (m.render === "scanned") {
      // the finding's own case (#5): "No text layer to verify against (scanned)" read as if scans were held
      ok(!why.toLowerCase().includes("no text layer"), `#${s.id} the scan's note is not under 'Why it is on hold' (${why.slice(0, 160)})`);
      has(why, "inferred", `#${s.id} the inferred PO is the cause`);
      has(why, m.expectedPo?.po_number ?? "PO-", `#${s.id} the cause names the inferred PO`);
      eq(await notesBox.count(), 1, `#${s.id} one list under "Also noted"`);
      has(notes, "No text layer to verify against", `#${s.id} the scan's note is under 'Also noted'`);
    }
  }

  // the stepper: every stage's status, as the truth and the rehearsal expect
  const stages = page.locator("li[data-stage]");
  eq(await stages.count(), 10, `#${s.id} ten stages`);
  const statuses: string[] = [];
  for (const key of STAGE_KEYS) statuses.push((await page.locator(`li[data-stage="${key}"]`).getAttribute("data-status")) ?? "?");
  eq(statuses, [...expectedStages, "pass"], `#${s.id} stage statuses`);
  for (const [key, want] of Object.entries(m.expectedSteps) as [StageKey, { status?: string; reasonIncludes?: string }][]) {
    const row = page.locator(`li[data-stage="${key}"]`);
    if (want.status !== undefined) eq(await row.getAttribute("data-status"), want.status, `#${s.id} ${key} status`);
    if (want.reasonIncludes !== undefined) has((await row.innerText()).replace(/\s+/g, " "), want.reasonIncludes, `#${s.id} ${key} reason`);
  }
  // the status is text, not only an icon: each started stage names its status (or, for decide, the decision)
  for (const key of STAGE_KEYS.slice(0, 9)) {
    const t = (await page.locator(`li[data-stage="${key}"]`).innerText()).toLowerCase();
    ok(/passed|warning|failed|skipped|system error/.test(t), `#${s.id} ${key}: the status is written out (${t.slice(0, 60)})`);
  }

  // the PO the run ends on
  const poRow = (await page.locator('li[data-stage="po_match"]').innerText()).replace(/\s+/g, " ");
  if (m.expectedPo !== null) {
    has(poRow, m.expectedPo.po_number, `#${s.id} PO shown in the PO match stage`);
    if (m.expectedPo.inferred) {
      has(poRow, "inferred", `#${s.id} inferred PO`);
      const poButton = page.locator('li[data-stage="po_match"] > button');
      if ((await poButton.getAttribute("aria-expanded")) !== "true") await poButton.click(); // a held stage opens by itself (review round U4)
      const panel = page.locator('li[data-stage="po_match"] > [role="region"]');
      await panel.waitFor();
      const p = (await panel.innerText()).replace(/\s+/g, " ");
      has(p, "Reasoning of the matcher", `#${s.id} the inferred PO's reasoning is shown`);
      has(p, m.expectedPo.po_number, `#${s.id} the reasoning names the PO`);
    }
  } else {
    ok(["fail", "skipped"].includes(statuses[6]), `#${s.id}: no PO is matched (PO match is ${statuses[6]})`);
  }

  // #9: the shield banner quotes the hidden instruction
  if (m.hiddenText !== null) {
    const banner = page.getByRole("alert").filter({ hasText: "Suspicious content detected" });
    await banner.waitFor();
    const b = (await banner.innerText()).replace(/\s+/g, " ");
    has(b, m.hiddenText.replace(/\s+/g, " ").slice(0, 120), `#${s.id} hidden instruction quoted in the banner`);
    // fix round UI-6: the card quoted the instruction four times (the banner, the scan's and the tiny-text check's
    // quotes in the screen reason, the model's in the extract reason). It quotes it once, in the banner; the list of
    // causes keeps what each check found, without the quote. The stages below keep every reason verbatim.
    const phrase = flat(m.hiddenText).split(" ").slice(2, 6).join(" ").replace(/[.,;:]+$/, "");
    ok(phrase.split(" ").length === 4 && b.toLowerCase().includes(phrase.toLowerCase()), `#${s.id} "${phrase}" is in the banner`);
    const times = (hay: string) => hay.toLowerCase().split(phrase.toLowerCase()).length - 1;
    eq(times(flat(await final.innerText())), 1, `#${s.id} times the decision card quotes "${phrase}"`);
    eq(await whyBox.count(), 1, `#${s.id} one list under "Why it is on hold"`);
    const why = flat(await whyBox.innerText());
    eq(times(why), 0, `#${s.id} times the causes quote "${phrase}"`);
    has(why, "suspicious", `#${s.id} the causes still say what the checks found`);
    has(why, "quoted in the security banner above", `#${s.id} the causes point at the banner's quote`);
    ok(!/\(\+\d+ more\)/.test(why), `#${s.id} the folded causes keep no "(+N more)" that counts from a quote they no longer show`);
    has(flat(await page.locator('li[data-stage="screen"]').innerText()), phrase, `#${s.id} the screen stage keeps its reason verbatim`);
  }

  // the PDF frame points at the stored file and the file was served as a PDF
  const hash = sampleHash(s);
  // (fix round UI-4: the frame opens the viewer without its thumbnail pane, fitted to the width; the fragment is not sent)
  const frame = page.locator(`iframe[src="/api/files/${hash}#navpanes=0&view=FitH"]`);
  eq(await frame.count(), 1, `#${s.id} PDF iframe on /api/files/<hash>#navpanes=0&view=FitH`);
  ok((await frame.getAttribute("title"))?.includes("Invoice PDF"), `#${s.id} the frame has a title`);
  // (fix round UI-3: the panel first sends a HEAD to see whether the file is still stored; the frame's own GET is what counts)
  for (let i = 0; i < 50 && !watchOf(page).responses.some((r) => r.url === `/api/files/${hash}` && r.method === "GET"); i++) await page.waitForTimeout(100);
  const served = watchOf(page).responses.find((r) => r.url === `/api/files/${hash}` && r.method === "GET");
  ok(served !== undefined && served.status === 200 && served.type.includes("application/pdf"), `#${s.id} the PDF was served (${show(served)})`);
  // Chrome paints the PDF viewer of a frame only once it is on screen (#9's frame starts below the fold)
  await frame.scrollIntoViewIfNeeded();
  await page.waitForTimeout(1200);

  const file = await shot(page, `pass${pass}-${s.id}-${m.expectedDecision.toLowerCase()}`);
  await page.waitForTimeout(150);
  const problems = takeProblems(page);
  eq(problems, [], `#${s.id} browser console and network`);
  return { id: s.id, runId, decision: decision as string, statuses, shot: file, checks: "ok" };
}

/* ================================================================================================
 * Sections
 * ============================================================================================== */

const results: Map<number, SampleResult[]> = new Map();

async function sectionReset(page: Page): Promise<void> {
  await check("reset", "reset through the start page's 'Reset demo data' form; the dashboard then lists only the 4 pre-loaded history rows", async () => {
    await resetViaUi(page);
    await page.goto(`${BASE}/`);
    const table = page.getByRole("region", { name: "Recent runs" });
    await table.waitFor();
    await page.waitForFunction(() => document.querySelectorAll("tr[data-run-id]").length > 0);
    const n = await page.locator("tr[data-run-id]").count();
    eq(n, 4, "rows after a reset");
    eq(await page.locator("tr[data-run-id]", { hasText: "history" }).count(), 4, "every row is tagged history");
    const total = await page.locator('[data-kpi="Total processed"]').innerText();
    has(total, "4", "Total processed tile");
    await shot(page, "reset-dashboard");
    eq(takeProblems(page), [], "browser console and network");
  });
}

async function sectionSamples(ctx: BrowserContext): Promise<void> {
  let stages: Map<string, string[]>;
  try {
    stages = rehearsedStages();
  } catch (e) {
    await check("samples", "expected stage statuses from scripts/rehearse.ts", async () => fail(e instanceof Error ? e.message : String(e)));
    return;
  }
  for (let pass = 1; pass <= PASSES; pass++) {
    const page = await newPage(ctx);
    await check(`pass ${pass}`, "reset through the UI before the pass", async () => {
      await resetViaUi(page);
      eq(takeProblems(page), [], "browser console and network");
    });
    const out: SampleResult[] = [];
    for (const s of samples) {
      await check(`pass ${pass}`, `#${s.id} ${s.file}: card click -> ${s.meta.expectedDecision}, reasons, next action, PO, stages, PDF, clean console`, async () => {
        out.push(await runSampleViaUi(page, s, stages.get(s.id) as string[], pass));
      });
    }
    results.set(pass, out);
    await page.close();
  }
  if (PASSES > 1) {
    await check("samples", "every pass reached the same decisions and stage statuses (clean passes in a row)", async () => {
      const first = results.get(1) ?? [];
      eq(first.length, 10, "pass 1 finished all 10 samples");
      for (let pass = 2; pass <= PASSES; pass++) {
        const other = results.get(pass) ?? [];
        eq(other.map((r) => [r.id, r.decision, r.statuses.join(",")]), first.map((r) => [r.id, r.decision, r.statuses.join(",")]), `pass ${pass} equals pass 1`);
      }
    });
  }
  // Review round B8: after the click-through, every sample card says it already ran and links to its newest run.
  await check("samples", "B8: a sample that has run shows \"Open result\" with a link to its newest run", async () => {
    const newest = (results.get(PASSES) ?? []).find((r) => r.id === "01");
    if (newest === undefined) return fail("the last pass did not finish sample 01");
    const page = await newPage(ctx);
    await page.goto(`${BASE}/runs/new`);
    const note = page.locator('[data-sample-result="01-happy-northwind.pdf"]');
    await note.waitFor();
    const link = note.getByRole("link", { name: "Open result" });
    eq(await link.getAttribute("href"), `/runs/${newest.runId}`, "Open result points at the newest run of sample 01");
    ok(/^Ran .+: (Approved|On hold|Rejected)/.test(await note.innerText()), "the line says when it ran and what it decided");
    const box = await link.boundingBox();
    ok(box !== null && box.height >= 24, "the link is at least 24 px tall");
    eq(await page.locator("[data-sample-result]").count(), 10, "all ten samples show a result line after the click-through");
    eq(takeProblems(page), [], "browser console and network");
    await page.close();
  });
}

/** KPI figures the truth files predict after one click-through (history rows included). */
function expectedKpis(): { total: number; approved: number; hold: number; rejected: number; security: number } {
  const count = (d: string) => samples.filter((s) => s.meta.expectedDecision === d).length;
  return { total: 4 + samples.length, approved: 4 + count("APPROVE"), hold: count("HOLD"), rejected: count("REJECT"), security: samples.filter((s) => s.meta.expectedSecurityFlag).length };
}

async function sectionDashboard(page: Page): Promise<void> {
  const want = expectedKpis();
  await check("dashboard", "KPI tiles match the decisions of the click-through (and the API)", async () => {
    await page.goto(`${BASE}/`);
    await page.waitForFunction(() => document.querySelectorAll("tr[data-run-id]").length >= 14);
    const api = (await (await page.request.get(`${BASE}/api/runs?limit=200`)).json()) as { kpis: Record<string, number> };
    const tile = async (label: string) => (await page.locator(`[data-kpi="${label}"]`).innerText()).replace(/\s+/g, " ");
    has(await tile("Total processed"), String(want.total), "Total processed");
    has(await tile("Approved"), String(want.approved), "Approved");
    has(await tile("On hold"), String(want.hold), "On hold");
    has(await tile("Rejected"), String(want.rejected), "Rejected");
    has(await tile("Security flags"), String(want.security), "Security flags");
    eq([api.kpis.total, api.kpis.approved, api.kpis.hold, api.kpis.rejected, api.kpis.security_flags], [want.total, want.approved, want.hold, want.rejected, want.security], "API KPIs");
    const value = `$${api.kpis.approved_value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    has(await tile("Value approved"), value, "Value approved");
    await shot(page, "dashboard-all");
  });
  await check("dashboard", "every filter chip shows exactly its runs (and its count)", async () => {
    const counts: Record<string, number> = { all: want.total, APPROVE: want.approved, HOLD: want.hold, REJECT: want.rejected, security: want.security };
    for (const chip of ["APPROVE", "HOLD", "REJECT", "security", "all"]) {
      await page.locator(`button[data-filter="${chip}"]`).click();
      await page.waitForFunction((c) => document.querySelector(`button[data-filter="${c}"]`)?.getAttribute("aria-pressed") === "true", chip);
      await page.waitForFunction((n) => document.querySelectorAll("tr[data-run-id]").length === n, counts[chip], { timeout: 10_000 });
      const badges = await page.locator("tr[data-run-id] [data-decision]").evaluateAll((els) => els.map((e) => e.getAttribute("data-decision")));
      if (chip === "security") {
        eq(await page.locator("tr[data-run-id]").filter({ hasText: "Security flag" }).count(), counts[chip], "every security row has the shield");
      } else if (chip !== "all") {
        ok(badges.every((b) => b === chip), `filter ${chip}: rows show ${show(badges)}`);
      }
      has(await page.locator(`button[data-filter="${chip}"]`).innerText(), String(counts[chip]), `chip ${chip} count`);
      await shot(page, `dashboard-filter-${chip.toLowerCase()}`);
    }
  });
  await check("dashboard", "history rows are tagged; a click on a row (not on its link) opens that run", async () => {
    eq(await page.locator("tr[data-run-id]").filter({ hasText: "history" }).count(), 4, "four history rows");
    const row = page.locator("tr[data-run-id]").first();
    const id = await row.getAttribute("data-run-id");
    await row.locator("td").nth(2).click(); // the Invoice no. cell (review round U5)
    await page.waitForURL(`${BASE}/runs/${id}`);
    await decisionCard(page).waitFor();
    eq(takeProblems(page), [], "browser console and network");
  });
  await check("dashboard", "a history row's link opens the pre-loaded record: its facts, no stepper, no PDF", async () => {
    await page.goto(`${BASE}/`);
    const history = page.locator("tr[data-run-id]").filter({ hasText: "INV-0042" }).filter({ hasText: "history" });
    await history.waitFor();
    const id = await history.getAttribute("data-run-id");
    await history.getByRole("link").click();
    await page.waitForURL(`${BASE}/runs/${id}`);
    await page.getByRole("heading", { name: "Processed before the demo", exact: true }).waitFor();
    // the record's facts come from a second request, made once the first answer says the run is history: wait for the
    // list they render in before reading the page (the heading alone appears one round trip earlier)
    await page.locator('section[aria-labelledby="history-heading"] dl').waitFor();
    const text = await textOf(page);
    has(text, "Acme Office Supplies", "vendor of the record");
    has(text, "INV-0042", "invoice number of the record");
    has(text, "$3,190.00", "amount of the record");
    has(text, "No PDF stored", "no PDF for a pre-loaded record");
    eq(await page.locator("li[data-stage]").count(), 0, "no pipeline stages");
    await shot(page, "history-record");
    eq(takeProblems(page), [], "browser console and network");
  });
}

async function sectionData(page: Page): Promise<void> {
  await check("data", "PO balances after the click-through; PO-1007 shows 'over by $24.00', never a negative amount", async () => {
    await page.goto(`${BASE}/data`);
    await page.locator("tr[data-po]").first().waitFor();
    const master = (await (await page.request.get(`${BASE}/api/master`)).json()) as { purchase_orders: { po_number: string; remaining: number }[] };
    const want: Record<string, number> = { "PO-1001": 0, "PO-1002": 2300, "PO-1003": 6000, "PO-1004": 6000, "PO-1005": 3000, "PO-1006": 4000, "PO-1007": -24, "PO-1008": 4200 };
    eq(Object.fromEntries(master.purchase_orders.map((p) => [p.po_number, p.remaining])), want, "API balances");
    for (const [po, remaining] of Object.entries(want)) {
      const text = (await page.locator(`tr[data-po="${po}"]`).innerText()).replace(/\s+/g, " ");
      if (remaining < 0) has(text, `over by $${(-remaining).toFixed(2)}`, `${po} overdrawn`);
      else has(text, `$${remaining.toLocaleString("en-US", { minimumFractionDigits: 2 })}`, `${po} remaining`);
    }
    has((await page.locator('tr[data-po="PO-1001"]').innerText()).replace(/\s+/g, " "), "fully used", "PO-1001 used up");
    ok(!(await textOf(page)).includes("-$24.00"), "no bare negative amount on the page");
    await shot(page, "data-page");
    eq(takeProblems(page), [], "browser console and network");
  });
}

async function sectionNarrow(): Promise<void> {
  const ctx = await newContext({ width: 375, height: 812 });
  const page = await newPage(ctx);
  const runs = (await (await page.request.get(`${BASE}/api/runs?limit=200`)).json()) as { runs: { id: string; file_name: string | null }[] };
  const nine = runs.runs.find((r) => r.file_name === "09-prompt-injection.pdf");
  const five = runs.runs.find((r) => r.file_name === "05-scanned-no-po.pdf");
  // Automations (plan A13): the seed's id comes from the API, so a missing seed is itself a failing check
  const autos = (await (await page.request.get(`${BASE}/api/automations`)).json()) as { automations: { id: string; seed_key: string | null }[] };
  const routeHolds = autos.automations.find((a) => a.seed_key === "route-holds");
  await check("narrow", "the route-holds seed automation exists", async () => ok(routeHolds !== undefined, "no automation with seed_key route-holds"));
  const targets: [string, string, string?][] = [
    ["dashboard", "/"],
    ["start page", "/runs/new"],
    ["run view (#9, the longest)", nine ? `/runs/${nine.id}` : "/runs/new"],
    ["data page", "/data"],
    ["automations list", "/automations", "narrow-automations"],
    ...(routeHolds ? ([["automation editor", `/automations/${routeHolds.id}`, "narrow-automation-editor"]] as [string, string, string][]) : []),
    // fix round UI-5: the decision card's "Also noted" list (only #5 has one among the samples)
    ["run view (#5, a cause and an 'Also noted' note)", five ? `/runs/${five.id}` : "/runs/new", "narrow-run-05"],
  ];
  for (const [what, url, shotName] of targets) {
    await check("narrow", `375 px: ${what} has no horizontal page scroll, readable text, usable tap targets`, async () => {
      await page.goto(`${BASE}${url}`);
      await page.waitForLoadState("networkidle");
      if (url.startsWith("/runs/") && url !== "/runs/new") {
        await decisionCard(page).waitFor();
        await page.getByRole("button", { name: "Expand all" }).click(); // the widest state of the run view
        await page.waitForTimeout(300);
      }
      if (url.startsWith("/automations/")) {
        await page.getByText("The canvas opens on wider screens").waitFor();
        eq(await page.locator(".react-flow").count(), 0, "no canvas at 375 px");
      }
      const { scrollWidth, clientWidth } = await pageScroll(page);
      ok(scrollWidth <= clientWidth, `page is ${scrollWidth} px wide in a ${clientWidth} px viewport`);
      const report = await page.evaluate(() => {
        const visible = (el: Element) => {
          const r = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none" && !el.closest('[aria-hidden="true"], .sr-only');
        };
        let minFont = 99;
        let minFontText = "";
        for (const el of Array.from(document.querySelectorAll("body *"))) {
          const own = Array.from(el.childNodes).some((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? "").trim() !== "");
          if (!own || !visible(el)) continue;
          const size = Number.parseFloat(getComputedStyle(el).fontSize);
          if (size < minFont) {
            minFont = size;
            minFontText = (el.textContent ?? "").trim().slice(0, 40);
          }
        }
        const small: string[] = [];
        for (const el of Array.from(document.querySelectorAll("button, a[href], input:not([type=hidden]), select, textarea, [role=button]"))) {
          if (!visible(el)) continue;
          const r = el.getBoundingClientRect();
          const inline = el.tagName === "A" && getComputedStyle(el).display === "inline"; // links inside running text are exempt (WCAG 2.5.8)
          if (!inline && (r.width < 24 || r.height < 24)) small.push(`${el.tagName.toLowerCase()} "${(el.textContent ?? "").trim().slice(0, 30)}" ${Math.round(r.width)}x${Math.round(r.height)}`);
        }
        return { minFont, minFontText, small };
      });
      ok(report.minFont >= 11, `smallest text is ${report.minFont}px ("${report.minFontText}")`);
      eq(report.small, [], "tap targets smaller than 24x24 px");
      await shot(page, shotName ?? `narrow-${what.split(" ")[0]}${what.includes("run view") ? "-run" : ""}`);
      eq(takeProblems(page), [], "browser console and network");
    });
  }
  // fix round UI-1: the column a phone needs most was off the edge of the table's scroll frame (Decision at x=737,
  // Remaining at x=702 in a 16-359 frame). Each row must show it inside the frame without scrolling the table.
  await check("narrow", "fix round UI-1: 375 px: each dashboard row shows its decision, and each PO its remaining balance, inside the table's visible frame", async () => {
    await page.goto(`${BASE}/`);
    await page.waitForFunction(() => document.querySelectorAll("tr[data-run-id]").length > 0);
    const rows = await page.evaluate(() => {
      const frame = document.querySelector('[role="region"][aria-label="Recent runs"]')?.getBoundingClientRect();
      if (!frame) return null;
      return Array.from(document.querySelectorAll("tr[data-run-id]")).map((tr) =>
        Array.from(tr.querySelectorAll("[data-decision]")).some((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && getComputedStyle(el).display !== "none" && r.left >= frame.left - 1 && r.right <= frame.right + 1;
        }),
      );
    });
    ok(rows !== null && rows.length > 0, "the Recent runs table is there");
    eq(rows?.filter((visible) => !visible).length, 0, `rows whose decision is outside the visible frame (of ${rows?.length})`);
    const master = (await (await page.request.get(`${BASE}/api/master`)).json()) as { purchase_orders: { po_number: string; remaining: number }[] };
    await page.goto(`${BASE}/data`);
    await page.locator("tr[data-po]").first().waitFor();
    const missing: string[] = [];
    for (const po of master.purchase_orders) {
      const amount = `$${Math.abs(po.remaining).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      const shown = await page.evaluate(
        ([poNumber, text]) => {
          const frame = document.querySelector('[role="region"][aria-label="Purchase orders"]')?.getBoundingClientRect();
          const tr = document.querySelector(`tr[data-po="${poNumber}"]`);
          if (!frame || !tr) return false;
          return Array.from(tr.querySelectorAll("*")).some((el) => {
            const own = Array.from(el.childNodes).some((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? "").includes(text));
            const r = el.getBoundingClientRect();
            return own && r.width > 0 && r.height > 0 && r.left >= frame.left - 1 && r.right <= frame.right + 1;
          });
        },
        [po.po_number, amount] as const,
      );
      if (!shown) missing.push(`${po.po_number} (${amount})`);
    }
    eq(missing, [], "POs whose remaining balance is outside the visible frame");
    eq(takeProblems(page), [], "browser console and network");
  });
  await ctx.close();
}

/** Where the keyboard focus is, and whether it is drawn (an outline or a ring). */
async function focusInfo(page: Page): Promise<{ tag: string; text: string; visible: boolean; drawn: boolean; sample: string | null }> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return { tag: "body", text: "", visible: false, drawn: false, sample: null };
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const outline = cs.outlineStyle !== "none" && Number.parseFloat(cs.outlineWidth) > 0;
    const ring = cs.boxShadow !== "none" && cs.boxShadow !== "";
    return {
      tag: el.tagName.toLowerCase(),
      text: (el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 40),
      visible: r.width > 0 && r.height > 0,
      drawn: outline || ring,
      sample: el.getAttribute("data-sample"),
    };
  });
}

async function sectionKeyboard(page: Page): Promise<void> {
  await check("keyboard", "start page: Tab reaches the reset toggle and every sample card, and focus is always drawn", async () => {
    await page.goto(`${BASE}/runs/new`);
    await page.locator("button[data-sample]").first().waitFor();
    const seen: string[] = [];
    const undrawn: string[] = [];
    const cards = new Set<string>();
    // 25 stops were enough until review round B8: each sample that has run now adds an "Open result" link to the Tab order, so
    // the loop runs for one full pass (it stops when Tab comes round to the first stop again) instead of a fixed count.
    for (let i = 0; i < 60; i++) {
      await page.keyboard.press("Tab");
      await page.waitForTimeout(220); // buttons animate their ring in over 150 ms
      const f = await focusInfo(page);
      const entry = `${f.tag}:${f.text}`;
      if (seen.length > 0 && entry === seen[0]) break;
      seen.push(entry);
      if (f.sample !== null && f.tag === "button") cards.add(f.sample);
      if (f.tag !== "body" && (!f.visible || !f.drawn)) undrawn.push(`${f.tag} "${f.text}"`);
    }
    eq(undrawn, [], "focused elements without a visible focus indicator");
    ok(seen.some((x) => x.includes("Reset demo data")), `the reset toggle is reachable (${show(seen)})`);
    eq(cards.size, samples.length, "every sample card is a reachable <button>");
    const resultLinks = await page.locator("[data-sample-result] a").count();
    eq(seen.filter((x) => x === "a:Open result").length, resultLinks, "every 'Open result' link is reachable by Tab (its focus ring was checked with the rest above)");
    const fakeButtons = await page.locator('[role="button"]:not(button)').count();
    eq(fakeButtons, 0, "role=button on something that is not a <button>");
  });
  await check("keyboard", "run view: Tab reaches the stepper; a failed stage starts open, Enter closes it, Space opens it; focus is always drawn", async () => {
    const runs = (await (await page.request.get(`${BASE}/api/runs?limit=200`)).json()) as { runs: { id: string; file_name: string | null }[] };
    const three = runs.runs.find((r) => r.file_name === "03-split-po-overbill.pdf");
    ok(three, "a run of #3 exists");
    await page.goto(`${BASE}/runs/${three?.id}`);
    await decisionCard(page).waitFor();
    const undrawn: string[] = [];
    let reached = false;
    for (let i = 0; i < 40 && !reached; i++) {
      await page.keyboard.press("Tab");
      await page.waitForTimeout(120);
      const f = await focusInfo(page);
      if (f.tag !== "body" && f.tag !== "iframe" && (!f.visible || !f.drawn)) undrawn.push(`${f.tag} "${f.text}"`);
      reached = await page.evaluate(() => document.activeElement?.closest('li[data-stage="amounts"]') !== null && document.activeElement?.tagName === "BUTTON");
    }
    ok(reached, "Tab reaches the Amounts stage button");
    eq(undrawn, [], "focused elements without a visible focus indicator");
    const button = page.locator('li[data-stage="amounts"] > button');
    eq(await button.getAttribute("aria-expanded"), "true", "a failed stage is open at first");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(150);
    eq(await button.getAttribute("aria-expanded"), "false", "Enter closes it");
    await page.keyboard.press("Space");
    await page.locator('li[data-stage="amounts"] > [role="region"]').waitFor();
    eq(await button.getAttribute("aria-expanded"), "true", "Space opens it");
    has(await page.locator('li[data-stage="amounts"] > [role="region"]').innerText(), "remaining", "the evidence shows the balance maths");
    eq(await page.locator('[role="button"]:not(button)').count(), 0, "role=button on something that is not a <button>");
    eq(takeProblems(page), [], "browser console and network");
  });
  const axePath = (() => {
    try {
      return require.resolve("axe-core/axe.min.js", { paths: [ROOT] });
    } catch {
      return null;
    }
  })();
  if (axePath === null) {
    skip("keyboard", "axe-core scan", "axe-core is not installed");
    return;
  }
  const source = fs.readFileSync(axePath, "utf8");
  const listed = (await (await page.request.get(`${BASE}/api/runs?limit=200`)).json()) as { runs: { id: string; file_name: string | null }[] };
  const nine = listed.runs.find((r) => r.file_name === "09-prompt-injection.pdf");
  const pages: [string, string][] = [
    ["dashboard", "/"],
    ["start page", "/runs/new"],
    ["data page", "/data"],
  ];
  if (nine) pages.push(["run view of #9, every stage open", `/runs/${nine.id}`]);
  // fix round UI-5: the decision card with an "Also noted" list
  const five = listed.runs.find((r) => r.file_name === "05-scanned-no-po.pdf");
  if (five) pages.push(["run view of #5 (with an 'Also noted' list), every stage open", `/runs/${five.id}`]);
  for (const [what, url] of pages) {
    await check("keyboard", `axe-core: no WCAG A/AA violations on the ${what}`, async () => {
      await page.goto(`${BASE}${url}`);
      await page.waitForLoadState("networkidle");
      if (url.startsWith("/runs/") && url !== "/runs/new") {
        await decisionCard(page).waitFor();
        await page.getByRole("button", { name: "Expand all" }).click();
        await page.waitForTimeout(300);
      }
      await page.addScriptTag({ content: source });
      const violations = await page.evaluate(async () => {
        const axe = (window as unknown as { axe: { run: (ctx: Document, opts: unknown) => Promise<{ violations: { id: string; nodes: unknown[] }[] }> } }).axe;
        const r = await axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] } });
        return r.violations.map((v) => `${v.id} (${v.nodes.length})`);
      });
      eq(violations, [], "axe violations");
    });
  }
}

async function sectionUnhappy(): Promise<void> {
  const ctx = await newContext();
  const page = await newPage(ctx);
  await check("unhappy", "/runs/not-a-uuid: a friendly 'not a valid run link' page, and no API call", async () => {
    await page.goto(`${BASE}/runs/not-a-uuid`);
    await page.getByText("That is not a valid run link").waitFor();
    ok(!watchOf(page).responses.some((r) => r.url.startsWith("/api/runs/")), "the malformed id was not sent to the API");
    ok((await page.getByRole("link", { name: /dashboard/i }).count()) > 0, "a way back to the dashboard");
    await shot(page, "unhappy-invalid-id");
    eq(takeProblems(page), [], "browser console and network");
  });
  await check("unhappy", "a valid but unknown run id: 'Run not found' with a way home", async () => {
    watchOf(page).allow4xx = [/^\/api\/runs\/[0-9a-f-]{36}$/];
    await page.goto(`${BASE}/runs/00000000-0000-4000-8000-000000000000`);
    await page.getByText("Run not found").waitFor();
    await shot(page, "unhappy-unknown-id");
    const problems = takeProblems(page).filter((p) => !/Failed to load resource: the server responded with a status of 404/.test(p));
    eq(problems, [], "browser console and network (the API's own 404 aside)");
    watchOf(page).allow4xx = [];
  });
  const drop = async (name: string, type: string, size: number) => {
    // the innermost element that holds the Choose a PDF button and its hint: the drop zone itself (resolved once:
    // its prompt text changes while something is dragged over it)
    const zone = await page
      .locator("div", { has: page.getByRole("button", { name: "Choose a PDF" }) })
      .filter({ hasText: "one file at a time" })
      .last()
      .elementHandle();
    if (zone === null) fail("no drop zone on the start page");
    const transfer = await page.evaluateHandle(
      ([n, t, s]) => {
        const dt = new DataTransfer();
        dt.items.add(new File([new Uint8Array(s as number)], n as string, { type: t as string }));
        return dt;
      },
      [name, type, size],
    );
    await zone.dispatchEvent("dragenter", { dataTransfer: transfer });
    await zone.dispatchEvent("dragover", { dataTransfer: transfer });
    await zone.dispatchEvent("drop", { dataTransfer: transfer });
  };
  await check("unhappy", "dropping a file that is not a PDF on the drop zone: a clear inline message, no upload", async () => {
    await page.goto(`${BASE}/runs/new`);
    await page.locator("button[data-sample]").first().waitFor();
    const posts = () => watchOf(page).responses.filter((r) => r.url === "/api/runs").length;
    const before = posts();
    await drop("notes.txt", "text/plain", 1200);
    await page.getByText('"notes.txt" is not a PDF. Choose a file that ends in .pdf.').waitFor();
    eq(posts(), before, "nothing was uploaded");
    await shot(page, "unhappy-not-a-pdf");
    eq(takeProblems(page), [], "browser console and network");
  });
  await check("unhappy", "dropping an 11 MB PDF: 'too large' inline, no upload", async () => {
    const before = watchOf(page).responses.filter((r) => r.url === "/api/runs").length;
    await drop("big-scan.pdf", "application/pdf", 11 * 1024 * 1024);
    await page.getByText(/"big-scan\.pdf" is too large \(.+\)\. The limit is 10 MB\./).waitFor();
    eq(watchOf(page).responses.filter((r) => r.url === "/api/runs").length, before, "nothing was uploaded");
    await shot(page, "unhappy-too-large");
    eq(takeProblems(page), [], "browser console and network");
  });
  await check("unhappy", "after 10 quick runs from one address, the 11th shows the 429 message with the wait (sent by script, then the UI)", async () => {
    const ip = nextIp();
    await ctx.setExtraHTTPHeaders({ "x-forwarded-for": ip });
    for (let i = 0; i < 10; i++) {
      // 10 calls the limiter allows (malformed, so they create no run and do not spend the hourly cap)
      const r = await page.request.post(`${BASE}/api/runs`, { headers: { "content-type": "application/json", "x-forwarded-for": ip }, data: '{"sample":"nope"}' });
      eq(r.status(), 400, `call ${i + 1}`);
    }
    watchOf(page).allow4xx = [/^\/api\/runs$/];
    await page.goto(`${BASE}/runs/new`);
    const card = page.locator('button[data-sample="01-happy-northwind.pdf"]');
    await card.waitFor();
    await card.click();
    await page.getByText(/Too many runs were started in a short time\. Please wait \d+ seconds? and try again\./).waitFor();
    ok(page.url().endsWith("/runs/new"), "the page stays on the start page");
    ok(await card.isEnabled(), "the card can be pressed again");
    await shot(page, "unhappy-429");
    const problems = takeProblems(page).filter((p) => !/status of 429/.test(p));
    eq(problems, [], "browser console and network (the 429 itself aside)");
    watchOf(page).allow4xx = [];
  });
  await ctx.close();
  // fix round UI-2: the message of a failed sample start was rendered ABOVE the grid, off screen for every card below
  // the first row or two (top -1458 px at 375x812 for the last card, under the sticky header at 1440x900).
  for (const [width, height] of [
    [375, 812],
    [1440, 900],
  ] as const) {
    await check("unhappy", `fix round UI-2: ${width}x${height}: a 429 on the LAST sample card shows its message next to that card, in view`, async () => {
      const ip = nextIp();
      const narrowCtx = await newContext({ width, height, ip });
      try {
        const p = await newPage(narrowCtx);
        for (let i = 0; i < 10; i++) {
          const r = await p.request.post(`${BASE}/api/runs`, { headers: { "content-type": "application/json", "x-forwarded-for": ip }, data: '{"sample":"nope"}' });
          eq(r.status(), 400, `call ${i + 1}`);
        }
        watchOf(p).allow4xx = [/^\/api\/runs$/];
        await p.goto(`${BASE}/runs/new`);
        const last = samples[samples.length - 1].file;
        const card = p.locator(`button[data-sample="${last}"]`);
        await card.waitFor();
        await card.click(); // Playwright scrolls the card into view, as a visitor would
        const alert = p.getByRole("alert").filter({ hasText: /Too many runs were started in a short time/ });
        await alert.waitFor();
        await p.waitForTimeout(300); // let the scroll into view settle
        const geometry = await alert.evaluate((el) => {
          const r = el.getBoundingClientRect();
          const header = document.querySelector("header");
          const sticky = header !== null && ["sticky", "fixed"].includes(getComputedStyle(header).position);
          return { top: r.top, bottom: r.bottom, viewport: window.innerHeight, headerBottom: sticky && header ? header.getBoundingClientRect().bottom : 0 };
        });
        ok(geometry.top >= geometry.headerBottom - 1 && geometry.bottom <= geometry.viewport + 1, `the message is in view below the header: ${JSON.stringify(geometry)}`);
        const cardBox = await card.boundingBox();
        ok(cardBox !== null && geometry.top >= cardBox.y + cardBox.height - 1 && geometry.top - (cardBox.y + cardBox.height) < 48, `the message sits right under the pressed card (card ${JSON.stringify(cardBox)})`);
        ok(await card.isEnabled(), "the card can be pressed again");
        await shot(p, `unhappy-429-last-card-${width}`);
        eq(takeProblems(p).filter((x) => !/status of 429/.test(x)), [], "browser console and network (the 429 itself aside)");
      } finally {
        await narrowCtx.close();
      }
    });
  }
  // fix round UI-3: when a run's stored PDF was gone, the panel framed /api/files/<hash> and the browser showed the
  // API's JSON ({"error":"File not found."}). A PDF no other check uses is run, shown, then deleted from the server's
  // DATA_DIR while the server runs, and the page is loaded again.
  const goneName = "fix round UI-3: a run whose stored PDF was deleted says 'The stored file is no longer available' (no frame on the API's 404)";
  if (DATA_DIR === "") {
    skip("unhappy", goneName, "set E2E_DATA_DIR to the server's DATA_DIR to run this check");
    return;
  }
  await check("unhappy", goneName, async () => {
    const ip = nextIp();
    const storedCtx = await newContext({ ip });
    const freshCtx = await newContext({ ip }); // its own HTTP cache: it never loaded the file
    try {
      const p = await newPage(storedCtx);
      const doc = await PDFDocument.create();
      const font = await doc.embedFont(StandardFonts.Helvetica);
      doc.addPage([595, 842]).drawText(`e2e stored-file check ${crypto.randomUUID()}`, { x: 56, y: 780, size: 12, font });
      const bytes = Buffer.from(await doc.save());
      const hash = crypto.createHash("sha256").update(bytes).digest("hex");
      const res = await p.request.post(`${BASE}/api/runs`, { headers: { "x-forwarded-for": ip }, multipart: { file: { name: "stored-file-check.pdf", mimeType: "application/pdf", buffer: bytes } } });
      eq(res.status(), 202, "the upload was accepted");
      const { runId } = (await res.json()) as { runId: string };
      let status = "";
      for (let i = 0; i < 240 && status !== "done" && status !== "error"; i++) {
        if (i > 0) await p.waitForTimeout(250);
        status = ((await (await p.request.get(`${BASE}/api/runs/${runId}`)).json()) as { status: string }).status;
      }
      eq(status, "done", "the run finished");
      // with the file stored: the frame
      await p.goto(`${BASE}/runs/${runId}`);
      await decisionCard(p).waitFor();
      await p.locator(`iframe[src="/api/files/${hash}#navpanes=0&view=FitH"]`).waitFor();
      eq(await p.getByText("The stored file is no longer available").count(), 0, "no 'no longer available' note while the file is stored");
      const before = watchOf(p).responses.filter((r) => r.url === `/api/files/${hash}`).map((r) => `${r.method} ${r.status}`);
      eq(takeProblems(p), [], "browser console and network (file stored)");
      // the stored copy deleted while the server runs, then the run opened in a browser that never loaded it
      const stored = path.join(DATA_DIR, "uploads", `${hash}.pdf`);
      ok(fs.existsSync(stored), `the upload is stored in E2E_DATA_DIR (${stored})`);
      fs.rmSync(stored);
      const q = await newPage(freshCtx);
      watchOf(q).allow4xx = [new RegExp(`^/api/files/${hash}$`)];
      await q.goto(`${BASE}/runs/${runId}`);
      await decisionCard(q).waitFor();
      // the panel settles on the note, or (the defect) on a frame whose document is the API's JSON 404
      const gone = q.getByText("The stored file is no longer available");
      const frames = q.locator('iframe[src^="/api/files/"]');
      for (let i = 0; i < 100 && (await gone.count()) === 0 && (await frames.count()) === 0; i++) await q.waitForTimeout(100);
      await q.waitForTimeout(500);
      eq(await frames.count(), 0, "frames on the deleted file (each shows the API's JSON 404)");
      eq(await gone.count(), 1, "'The stored file is no longer available' notes");
      eq(await q.getByRole("link", { name: /Open in a new tab/ }).count(), 0, "links to the deleted file");
      ok(!(await textOf(q)).includes("File not found"), "the API's JSON error is not on the page");
      // how: the panel asks with HEAD first and frames the file only when it is there
      const after = watchOf(q).responses.filter((r) => r.url === `/api/files/${hash}`).map((r) => `${r.method} ${r.status}`);
      eq(after, ["HEAD 404"], "requests for the deleted file");
      ok(before.includes("HEAD 200") && before.includes("GET 200"), `with the file stored, the panel's HEAD found it and the frame loaded it (${show(before)})`);
      await shot(q, "unhappy-stored-file-gone");
      eq(takeProblems(q).filter((x) => !/status of 404/.test(x)), [], "browser console and network (the HEAD's own 404 aside)");
    } finally {
      await storedCtx.close();
      await freshCtx.close();
    }
  });
}

/* ---- XSS: hostile rows written straight into the server's database ---- */

const HOSTILE = {
  img: '<img src=x onerror="window.__xss=1">',
  script: "<script>window.__xss=1</script>",
  js: "javascript:window.__xss=1",
  long: `W${"x".repeat(4999)}`,
  bidi: "‮fdp.exe​‍ INVOICE ⁧RTL⁩ فاتورة",
};

/** Automations (plan A13): the list, the editor (canvas and Steps view), undo and redo, save, a test with a past invoice, the run page. */
async function sectionAutomations(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  let routeId = "";
  const askToken = async () => {
    // in a full run the token is usually stored already (the reset used the same tab): the prompt may not appear
    const prompt = page.getByLabel("Operator token");
    if (await prompt.isVisible({ timeout: 1000 }).catch(() => false)) {
      await prompt.fill(TOKEN);
      await page.getByRole("button", { name: "Continue" }).click();
    }
  };
  await check("automations", "the list shows the three seed automations; 'Route holds to the right person' is On", async () => {
    takeProblems(page);
    await page.goto(`${BASE}/automations`);
    await page.locator("table tbody tr").first().waitFor();
    eq(await page.locator("table tbody tr").count(), 3, "three rows");
    const row = page.locator("table tbody tr").filter({ hasText: "Route holds to the right person" });
    has(await row.innerText(), "On", "the first seed is on");
    eq(await page.locator('[role="button"]:not(button)').count(), 0, "role=button on something that is not a <button>");
    const href = await row.getByRole("link", { name: "Route holds to the right person" }).getAttribute("href");
    routeId = (href ?? "").split("/").pop() ?? "";
    ok(/^[0-9a-f-]{36}$/.test(routeId), `the row links to the editor (${href})`);
    await shot(page, "automations-list");
  });
  await check("automations", "the editor draws 7 steps on the canvas with Yes and No outputs, and the same 7 in the Steps view", async () => {
    await page.goto(`${BASE}/automations/${routeId}`);
    await page.locator(".react-flow__node").first().waitFor();
    eq(await page.locator(".react-flow__node").count(), 7, "seven steps on the canvas");
    const canvasText = await page.locator(".react-flow").innerText();
    has(canvasText, "Yes", "an output labelled Yes");
    has(canvasText, "No", "an output labelled No");
    eq(await page.locator('[role="button"]:not(button)').count(), 0, "role=button on something that is not a <button> (canvas view)");
    await page.getByRole("button", { name: "Steps", exact: true }).click();
    await page.locator("ol[data-steps-list]").waitFor();
    eq(await page.locator("ol[data-steps-list] > li[data-step-row]").count(), 7, "seven steps in the list");
    await shot(page, "automation-editor-steps");
    await page.getByRole("button", { name: "Canvas", exact: true }).click();
    await page.locator(".react-flow__node").first().waitFor();
    await page.waitForTimeout(1200); // the fit-to-view animation, on a busy machine
    await shot(page, "automation-editor-canvas");
  });
  await check("automations", "editing: change a step's setting, undo and redo with the buttons, save", async () => {
    await page.locator(".react-flow__node").filter({ hasText: "Assign to AP lead" }).first().click();
    const assignee = page.getByLabel("Assign to", { exact: true });
    await assignee.waitFor();
    eq(await assignee.inputValue(), "AP lead", "the step starts as the seed made it");
    await assignee.fill("AP lead (Sam)");
    await assignee.press("Tab");
    await page.waitForTimeout(500); // the 400 ms undo step
    ok(await page.getByRole("button", { name: "Save", exact: true }).isEnabled(), "Save is enabled once something changed");
    await page.getByRole("button", { name: "Undo", exact: true }).click(); // the button, not the shortcut: shortcuts are ignored while a field has focus
    eq(await assignee.inputValue(), "AP lead", "undo");
    await page.getByRole("button", { name: "Redo", exact: true }).click();
    eq(await assignee.inputValue(), "AP lead (Sam)", "redo");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await askToken();
    await page.getByText(/^Saved/).first().waitFor();
  });
  await check("automations", "Test with an invoice: sample 3's run, the History panel shows Succeeded, 'Not written (test).' and what would be assigned", async () => {
    await page.getByRole("button", { name: "Test with an invoice" }).click();
    const dialog = page.getByRole("dialog");
    const select = dialog.getByLabel("Invoice");
    await select.waitFor();
    const value = await select.locator("option", { hasText: "GLX-303" }).first().getAttribute("value");
    ok(value, "an option for sample 3 (GLX-303)");
    await select.selectOption(value as string);
    await dialog.getByRole("button", { name: "Run test" }).click();
    await askToken();
    await page.getByText("Succeeded").first().waitFor();
    const text = await page.locator("main").innerText();
    has(text, "Not written (test).", "a test writes nothing");
    has(text, '"would_assign": "AP lead (Sam)"', "what would have been assigned");
    await shot(page, "automation-history-overlay");
    await page.getByRole("button", { name: "Back to editing" }).click();
  });
  await check("automations", "Steps view: Add after, After No, Add a note: focus lands on the new step's Edit button, the problem is named, Undo restores", async () => {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Steps", exact: true }).click();
    await page.locator("ol[data-steps-list]").waitFor();
    const row = page.locator('li[data-step-row="if-security"]');
    await row.locator("summary", { hasText: "Add after" }).click();
    await row.locator("summary", { hasText: "After No" }).click();
    await row.getByRole("button", { name: "Add a note to the invoice" }).click();
    await page.locator('li[data-step-row="note-1"]').waitFor();
    await page.waitForFunction(() => document.activeElement?.getAttribute("data-edit") === "note-1", undefined, { timeout: 5000 }).catch(() => undefined);
    eq(await page.evaluate(() => document.activeElement?.getAttribute("data-edit")), "note-1", "focus is on the new step's Edit button");
    await page.getByText("Write the note's text.").first().waitFor();
    await page.getByRole("button", { name: "1 problem" }).waitFor();
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    eq(await page.locator('li[data-step-row="note-1"]').count(), 0, "undo removed the new step (it is not saved)");
  });
  await check("automations", "sample 3's run page lists the automation that ran for it, with 'Assigned to AP lead'", async () => {
    const runs = (await (await page.request.get(`${BASE}/api/runs?limit=200`)).json()) as { runs: { id: string; file_name: string | null }[] };
    const three = runs.runs.find((r) => r.file_name === "03-split-po-overbill.pdf");
    ok(three, "a run of #3 exists");
    await page.goto(`${BASE}/runs/${three?.id}`, { waitUntil: "domcontentloaded" });
    await decisionCard(page).waitFor();
    await page.getByText("Assigned to AP lead").waitFor({ timeout: 10_000 });
    has(await page.getByRole("heading", { name: "Automations" }).innerText(), "Automations", "the section's heading");
    const one = runs.runs.find((r) => r.file_name === "01-happy-northwind.pdf");
    await page.goto(`${BASE}/runs/${one?.id}`, { waitUntil: "domcontentloaded" });
    await page.getByText("No automation ran for this invoice.").waitFor({ timeout: 10_000 });
    eq(takeProblems(page), [], "browser console and network");
  });
}

/** Review round B4: a person resolves sample 5's hold in the browser (approve, PO-1005) and the page, the PO balance and the stamp follow. */
async function sectionReview(page: Page): Promise<void> {
  await check("review", "resolve sample 5's hold: approve after review with PO-1005; the stamp, the PO balance and the page follow", async () => {
    type Listed = { runs: { id: string; file_name: string | null; decision: string | null; reviewed: string | null }[] };
    const listed = (await (await page.request.get(`${BASE}/api/runs?limit=200`)).json()) as Listed;
    let runId = listed.runs.find((r) => r.file_name === "05-scanned-no-po.pdf" && r.decision === "HOLD" && r.reviewed === null)?.id;
    if (runId === undefined) {
      // run on its own (npm run e2e -- review): no earlier run of sample 5 to resolve, so start one
      const started = await page.request.post(`${BASE}/api/runs`, { data: { sample: "05-scanned-no-po.pdf" } });
      eq(started.status(), 202, "sample 5 was started");
      runId = ((await started.json()) as { runId: string }).runId;
      let status = "";
      for (let i = 0; i < 240 && status !== "done" && status !== "error"; i++) {
        if (i > 0) await page.waitForTimeout(250);
        status = ((await (await page.request.get(`${BASE}/api/runs/${runId}`)).json()) as { status: string }).status;
      }
      eq(status, "done", "the run finished");
    }
    takeProblems(page);
    await page.goto(`${BASE}/runs/${runId}`);
    await decisionCard(page).waitFor();
    eq(await decisionCard(page).locator("[data-decision]").first().getAttribute("data-decision"), "HOLD", "the machine's hold comes first");
    await page.getByRole("button", { name: "Resolve this hold" }).click();
    await page.getByLabel("Approve after review").check();
    const choice = page.getByLabel("PO", { exact: true });
    if ((await choice.evaluate((el) => el.tagName)) === "SELECT") await choice.selectOption("PO-1005");
    else await choice.fill("PO-1005");
    await page.getByLabel("What was checked").fill("Confirmed PO-1005 with the buyer by phone.");
    await page.getByLabel("Operator token").fill(TOKEN);
    await page.getByRole("button", { name: "Save review" }).click();
    await page.locator('[data-decision="APPROVE"]').first().waitFor();
    has(await decisionCard(page).innerText(), "Approved after review", "the card says who decided");
    has(await decisionCard(page).innerText(), "Confirmed PO-1005 with the buyer by phone.", "the card shows the comment");
    has(await decisionCard(page).innerText(), "Queue for payment.", "the next action follows the review");
    eq(await page.getByRole("button", { name: "Resolve this hold" }).count(), 0, "the form is gone once reviewed");
    await page.goto(`${BASE}/data`);
    const row = page.locator('tr[data-po="PO-1005"]');
    await row.waitFor();
    has(await row.innerText(), "$1,500.00", "PO-1005 has $1,500.00 left");
    await page.goto(BASE);
    const dashRow = page.locator(`tr[data-run-id="${runId}"]`);
    await dashRow.waitFor();
    has(await dashRow.innerText(), "reviewed", "the dashboard row says it was reviewed");
    eq(takeProblems(page), [], "browser console and network");
  });
}

async function sectionXss(): Promise<void> {
  if (DATA_DIR === "") {
    skip("xss", "hostile rows render as text", "set E2E_DATA_DIR to the server's DATA_DIR to run this section");
    return;
  }
  const runId = crypto.randomUUID();
  await check("xss", "insert hostile runs, steps, invoices, a vendor and a PO into the server's database", async () => {
    const { openDb } = await import("../src/lib/db");
    const db = openDb(path.join(DATA_DIR, "app.db"));
    try {
      const now = new Date().toISOString();
      const { img, script, js, long, bidi } = HOSTILE;
      const extraction = {
        document_type: "invoice",
        vendor_name: `${img} ${bidi}`,
        invoice_number: `${script}`,
        invoice_date: "2026-10-28",
        due_date: js,
        po_reference: `${js} ${img}`,
        currency: "USD",
        line_items: [{ description: `${img} ${script} ${long}`, quantity: 1, unit_price: 10, amount: 10 }],
        subtotal: 10,
        tax: 1,
        total: 11,
        tax_inclusive: false,
        bank_account: `${script}`,
        confidence: { vendor_name: 0.95, invoice_number: 0.95, invoice_date: 0.95, po_reference: 0.95, total: 0.95 },
        suspicious_content: [`${img} ${script}`, long],
        notes: `${js} ${bidi}`,
      };
      db.prepare(
        "INSERT INTO runs (id, file_name, file_hash, status, decision, decision_reasons, next_action, security_flag, extraction, model, prompt_version, cost_usd, created_at, finished_at) VALUES (?, ?, NULL, 'done', 'HOLD', ?, ?, 1, ?, ?, 'extract-v1', 0, ?, ?)",
      ).run(runId, `${img}${script}.pdf`, JSON.stringify([`${img} reason ${script}`, long, `${js} ${bidi}`]), `${script} ${js}`, JSON.stringify(extraction), `${img}`, now, now);
      const add = db.prepare("INSERT INTO run_steps (run_id, idx, key, label, status, severity, reason, detail, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
      const detail: Record<string, unknown> = {
        ingest: { size_bytes: 10, page_count: 1, file_hash: script },
        screen: { isImageOnly: false, textChars: 100, injectionHits: [`${img} ${script}`, long], hiddenText: [`${bidi} ${script}`] },
        extract: { model: img, latency_ms: 1, cost_usd: 0, attempts: [], suspicious_content: [`${img} ${script}`, long] },
        validate: {
          problems: [`${img} problem`],
          warnings: [long],
          grounding: { fields: [{ field: "invoice_number", value: script, status: "missing", matchedToken: img }], misses: [img] },
        },
        normalize: { vendor_name_norm: img, [`${script}`]: js },
        vendor: { vendor_id: null, name: img, note: long },
        po_match: { po_number: js, inferred: true, candidates: [img], confidence: 0.5, reasoning: `${img} ${script} ${long}` },
        amounts: { po_number: img, po_subtotal: 10, already_approved: 0, approved_invoices: [script, img], remaining: 10, invoice_subtotal: 10, over_by: null, over_pct: null },
        duplicate: { match: { kind: "hard", invoice_number: img, invoice_date: js, run_id: "not-a-uuid" }, recurring: null },
        decide: { decision: "HOLD", reasons: [img], next_action: script, security_flag: true },
      };
      for (const stage of STAGES) {
        const last = stage.key === "decide";
        const reason = `${img} ${script} ${stage.key === "validate" ? long : bidi}`;
        add.run(runId, stage.idx, stage.key, stage.label, last ? "pass" : "fail", last ? null : "hold", reason, JSON.stringify(detail[stage.key]), now, now);
      }
      db.prepare(
        "INSERT INTO invoices (id, run_id, vendor_id, invoice_number, invoice_number_norm, invoice_date, po_number, po_inferred, subtotal, tax, total, currency, bank_account, file_hash, decision, created_at) VALUES (?, ?, 'V004', ?, 'XSS1', '2026-10-28', 'PO-1004', 0, 1, 0.1, 1.1, 'USD', NULL, NULL, 'APPROVE', ?)",
      ).run(runId, runId, `${img}${script}`, now);
      db.prepare("INSERT OR REPLACE INTO vendors (id, name, aliases, approved, bank_account, phone_on_file) VALUES ('V999', ?, ?, 1, ?, ?)").run(`${img} ${long}`, JSON.stringify([script, bidi]), `${script}1234`, js);
      db.prepare("INSERT OR REPLACE INTO purchase_orders (po_number, vendor_id, lines, subtotal, currency, status) VALUES ('PO-9999', 'V999', ?, 100, 'USD', 'open')").run(
        JSON.stringify([{ description: `${img} ${script} ${long}`, quantity: 1, unit_price: 100, amount: 100 }]),
      );
    } finally {
      db.close();
    }
  });
  for (const [desktop, width] of [
    [true, 1366],
    [false, 375],
  ] as const) {
    const ctx = await newContext({ width, height: 900 });
    const page = await newPage(ctx);
    for (const [what, url] of [
      ["dashboard", "/"],
      ["run view", `/runs/${runId}`],
      ["data page", "/data"],
    ] as const) {
      await check("xss", `${what} at ${width} px: no script runs, the markup shows as literal text, the layout holds`, async () => {
        await page.goto(`${BASE}${url}`);
        await page.waitForLoadState("networkidle");
        if (url.startsWith("/runs/")) {
          await page.getByRole("button", { name: "Expand all" }).click();
          await page.waitForTimeout(300);
          const raw = page.getByRole("button", { name: /raw|JSON/i });
          for (let i = 0; i < Math.min(await raw.count(), 12); i++) await raw.nth(i).click().catch(() => undefined);
          await page.waitForTimeout(200);
        }
        const state = await page.evaluate(() => ({
          xss: (window as unknown as { __xss?: unknown }).__xss,
          jsLinks: Array.from(document.querySelectorAll("a[href]")).filter((a) => /^\s*javascript:/i.test(a.getAttribute("href") ?? "")).length,
          injected: document.querySelectorAll('main img[src="x"], main script:not([src])').length,
          text: document.body.innerText,
        }));
        eq(state.xss, undefined, "window.__xss");
        eq(state.jsLinks, 0, "javascript: links");
        eq(state.injected, 0, "elements created from the hostile markup");
        has(state.text, "<img src=x onerror=", "the <img> markup appears as text");
        if (what !== "data page") has(state.text, "<script>window.__xss=1</script>", "the <script> markup appears as text");
        const { scrollWidth, clientWidth } = await pageScroll(page);
        ok(scrollWidth <= clientWidth, `page is ${scrollWidth} px wide in a ${clientWidth} px viewport`);
        await shot(page, `xss-${what.replace(" ", "-")}-${desktop ? "desktop" : "375"}`);
        eq(takeProblems(page), [], "browser console and network");
      });
    }
    await ctx.close();
  }
}

/* ================================================================================================
 * main
 * ============================================================================================== */

function printTables(): void {
  for (const [pass, list] of results) {
    console.log(`\nPass ${pass}: sample  decision  stages 1-10 (p pass, w warn, F fail, - skipped)  screenshot`);
    const letter: Record<string, string> = { pass: "p", warn: "w", fail: "F", skipped: "-", error: "E" };
    for (const r of list) console.log(`  #${r.id}  ${r.decision.padEnd(8)}  ${r.statuses.map((x) => letter[x] ?? "?").join("")}  ${r.shot}`);
  }
  console.log(`\n${"RESULT".padEnd(7)}${"SECTION".padEnd(12)}CHECK`);
  for (const r of rows) console.log(`${r.result.padEnd(7)}${r.section.padEnd(12)}${r.name.slice(0, 110)}${r.detail ? `\n${" ".repeat(19)}${r.detail.slice(0, 400)}` : ""}`);
  const passed = rows.filter((r) => r.result === "PASS").length;
  const failed = rows.filter((r) => r.result === "FAIL").length;
  const skipped = rows.filter((r) => r.result === "SKIP").length;
  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped (of ${rows.length}); screenshots in ${SHOTS}`);
}

async function main(): Promise<number> {
  const wanted = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  const unknown = wanted.filter((a) => !(SECTIONS as readonly string[]).includes(a));
  if (unknown.length > 0) throw new Error(`unknown section(s): ${unknown.join(", ")} (known: ${SECTIONS.join(", ")})`);
  const run = (s: Section) => wanted.length === 0 || wanted.includes(s);
  if (TOKEN === "") throw new Error("SMOKE_RESET_TOKEN is required: the click-through starts from a reset done in the UI");
  if (samples.length !== 10 || samples.some((s) => !s.pdfExists)) throw new Error("the 10 samples are needed (npm run gen)");
  const ping = await fetch(`${BASE}/api/samples`).catch(() => null);
  if (ping === null || ping.status !== 200) throw new Error(`no server answers at ${BASE}`);
  console.log(`e2e-browser against ${BASE}; screenshots in ${SHOTS}`);
  browser = await launch();
  try {
    const ctx = await newContext();
    const page = await newPage(ctx);
    if (run("reset")) await sectionReset(page);
    if (run("samples")) await sectionSamples(ctx);
    if (run("dashboard")) await sectionDashboard(page);
    if (run("data")) await sectionData(page);
    if (run("narrow")) await sectionNarrow();
    if (run("keyboard")) await sectionKeyboard(page);
    if (run("unhappy")) await sectionUnhappy();
    if (run("xss")) await sectionXss();
    if (run("automations")) await sectionAutomations(page);
    if (run("review")) await sectionReview(page); // last: it changes the counts the sections above assert
    await ctx.close();
  } finally {
    await browser.close();
  }
  printTables();
  return rows.some((r) => r.result === "FAIL") ? 1 : 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  });
