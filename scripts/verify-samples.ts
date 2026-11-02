/**
 * npx tsx scripts/verify-samples.ts
 *
 * Checks every data/samples/*.pdf against its truth file (Phase 1b), the way the app will see it:
 * through pdf.js (src/lib/pdf.ts getTextItems), with the same tokenising rules the grounding check uses
 * (whole whitespace tokens; identifiers compared with normId; amounts numerically within
 * CONFIG.groundingAmountTolerance; every item under CONFIG.tinyTextMaxPt left out of the visible text).
 *
 * Prints verdicts and counts only, never document text. Exit code 1 on any failure.
 * Run `npm run gen` first.
 */
import fs from "node:fs";
import path from "node:path";
import { PDFDocument } from "pdf-lib";
import { getDocumentProxy } from "unpdf";
import { CONFIG, paths } from "../src/lib/config";
import { normId } from "../src/lib/format";
import { getTextItems, hasPdfMagic } from "../src/lib/pdf";
import { SAMPLE_FILES, type TruthSample, loadTruthSamples } from "../src/lib/samples";
import type { TextItem } from "../src/lib/types";

const MAX_TOTAL_BYTES = 3 * 1024 * 1024;

interface Result {
  sample: string;
  name: string;
  ok: boolean;
  detail: string;
}
const results: Result[] = [];

function record(sample: string, name: string, ok: boolean, detail = ""): void {
  results.push({ sample, name, ok, detail });
}

/** pdf.js items joined the way unpdf joins them (each item's str already carries its own end-of-line). */
function joinItems(items: readonly TextItem[]): string {
  return items.map((i) => i.str).join("");
}

/** A non-blank item under the tiny-text size: hidden-text territory, never part of the visible text. */
function isTiny(i: TextItem): boolean {
  return i.str.trim() !== "" && i.height < CONFIG.tinyTextMaxPt;
}

/** What the grounding check may see: every tiny item replaced by a space. */
function visibleText(items: readonly TextItem[]): string {
  return items.map((i) => (isTiny(i) ? " " : i.str)).join("");
}

/** Runs of consecutive tiny items per page (blank items neither start nor break a run), joined and whitespace-collapsed. */
function tinyRuns(items: readonly TextItem[]): { text: string; words: number; items: number; maxHeight: number }[] {
  const runs: { text: string; words: number; items: number; maxHeight: number }[] = [];
  let cur = "";
  let count = 0;
  let maxH = 0;
  let page = 0;
  const flush = () => {
    const text = cur.replace(/\s+/g, " ").trim();
    if (text !== "") runs.push({ text, words: text.split(" ").length, items: count, maxHeight: maxH });
    cur = "";
    count = 0;
    maxH = 0;
  };
  for (const it of items) {
    if (it.page !== page) {
      flush();
      page = it.page;
    }
    if (it.str.trim() === "") {
      if (cur !== "") cur += it.str;
      continue;
    }
    if (it.height < CONFIG.tinyTextMaxPt) {
      cur += it.str;
      count += 1;
      maxH = Math.max(maxH, it.height);
    } else {
      flush();
    }
  }
  flush();
  return runs;
}

const tokensOf = (text: string): string[] => text.split(/\s+/).filter(Boolean);

function parseAmount(token: string): number | null {
  const t = token.replace(/[$,]/g, "");
  return /^\d+(?:\.\d+)?$/.test(t) ? Number(t) : null;
}

const hasAmountToken = (tokens: readonly string[], value: number): boolean =>
  tokens.some((t) => {
    const n = parseAmount(t);
    return n !== null && Math.abs(n - value) <= CONFIG.groundingAmountTolerance;
  });

const hasIdToken = (tokens: readonly string[], value: string): boolean => tokens.some((t) => normId(t) === normId(value));

/** CONFIG.injectionPatterns on NFKC text with whitespace collapsed to single spaces (plan section 6.2). */
function injectionHits(text: string): number {
  const collapsed = text.normalize("NFKC").replace(/\s+/g, " ");
  return CONFIG.injectionPatterns.filter((re) => re.test(collapsed)).length;
}

const collapse = (s: string): string => s.normalize("NFKC").replace(/\s+/g, " ").trim();

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** Every way the templates print an ISO date: "October 24, 2026", "22 Oct 2026", "26 October 2026", "10/26/2026", "2026-10-23". */
function dateForms(iso: string): string[] {
  const [y, m, d] = iso.split("-");
  const month = MONTHS[Number(m) - 1] ?? m;
  const day = Number(d);
  return [`${month} ${day}, ${y}`, `${day} ${month.slice(0, 3)} ${y}`, `${day} ${month} ${y}`, `${m}/${d}/${y}`, iso];
}

async function pdfJsPageCount(bytes: Uint8Array): Promise<number> {
  const doc = await getDocumentProxy(new Uint8Array(bytes), { verbosity: 0 });
  try {
    return doc.numPages;
  } finally {
    await doc.destroy();
  }
}

async function verifySample(s: TruthSample, allInvoiceNumbers: readonly string[]): Promise<number> {
  const id = s.id;
  const t = s.extraction;
  const file = path.join(paths.samplesDir, s.meta.file);
  if (!fs.existsSync(file)) {
    record(id, "file exists", false, s.meta.file);
    return 0;
  }
  const bytes = new Uint8Array(fs.readFileSync(file));
  record(id, "starts with %PDF-", hasPdfMagic(bytes));

  let libPages = -1;
  try {
    libPages = (await PDFDocument.load(bytes, { updateMetadata: false })).getPageCount();
  } catch {
    /* recorded below */
  }
  let jsPages = -1;
  try {
    jsPages = await pdfJsPageCount(bytes);
  } catch {
    /* recorded below */
  }
  record(id, "exactly 1 page, loads in pdf-lib and pdf.js", libPages === 1 && jsPages === 1, `pdf-lib ${libPages}, pdf.js ${jsPages}`);

  let items: TextItem[] = [];
  try {
    items = await getTextItems(bytes);
  } catch {
    record(id, "getTextItems opens the file", false);
    return bytes.length;
  }
  const all = joinItems(items);
  const visible = visibleText(items);
  const tokens = tokensOf(visible);
  const chars = all.replace(/\s+/g, "").length;
  const tiny = tinyRuns(items);

  // ---- text layer: none (scan) or real ----
  if (s.meta.render === "scanned") {
    record(id, `image-only: < ${CONFIG.imageOnlyMaxChars} characters of text`, chars < CONFIG.imageOnlyMaxChars, `${chars} chars, ${items.length} items`);
    const hasJpeg = Buffer.from(bytes).includes("/DCTDecode");
    record(id, "page is a JPEG image", hasJpeg);
  } else {
    record(id, `has a text layer (>= ${CONFIG.imageOnlyMaxChars} characters)`, chars >= CONFIG.imageOnlyMaxChars, `${chars} chars`);
  }

  // ---- injection scan ----
  const hitsAll = injectionHits(all);
  const hitsVisible = injectionHits(visible);
  if (s.meta.hiddenText === null) {
    record(id, "no injection pattern matches the text layer", hitsAll === 0, `${hitsAll} patterns`);
  } else {
    record(id, "injection patterns match the hidden text only", hitsAll >= 1 && hitsVisible === 0, `all ${hitsAll}, visible ${hitsVisible}`);
  }

  // ---- hidden text ----
  if (s.meta.hiddenText === null) {
    record(id, "no tiny (< 3pt) text", tiny.length === 0 && !items.some(isTiny), `${tiny.length} runs`);
  } else {
    const want = collapse(s.meta.hiddenText);
    const run = tiny.length === 1 ? tiny[0] : null;
    record(
      id,
      `one tiny run (< ${CONFIG.tinyTextMaxPt}pt, >= ${CONFIG.tinyTextMinWords} words) equal to _meta.hiddenText`,
      run !== null && run.words >= CONFIG.tinyTextMinWords && run.maxHeight < CONFIG.tinyTextMaxPt && collapse(run.text) === want,
      run === null ? `${tiny.length} runs` : `${run.items} item(s), ${run.words} words, height ${run.maxHeight.toFixed(2)}pt, equal ${collapse(run.text) === want}`,
    );
    const inPage = items.filter(isTiny).every((i) => i.y > 0 && i.y < 842);
    record(id, "hidden text is inside the page box", inPage && items.some(isTiny));
    const injected = s.meta.injectedValues;
    const noFour = !/400/.test(visible);
    const noPo = !/PO[-\s]?1003/i.test(visible) && !/1003/.test(visible);
    record(id, "visible text has no 400 and no PO-1003 (not even as a substring)", noFour && noPo && injected !== null, `400 absent ${noFour}, PO-1003 absent ${noPo}`);
    if (injected !== null) {
      const tokenFour = injected.total !== undefined && hasAmountToken(tokens, injected.total);
      const tokenPo = injected.po_reference !== undefined && hasIdToken(tokens, injected.po_reference);
      record(id, "injected values are not visible tokens", !tokenFour && !tokenPo, `total token ${tokenFour}, PO token ${tokenPo}`);
    }
  }

  if (s.meta.render !== "text") return bytes.length;

  // ---- content: whole visible tokens ----
  if (t.invoice_number !== null) record(id, "invoice number is a whole visible token (normId)", hasIdToken(tokens, t.invoice_number));
  if (t.po_reference !== null) record(id, "PO reference is a whole visible token", hasIdToken(tokens, t.po_reference));
  else record(id, "no PO number printed", !/\bPO[-\s]?\d{3,}\b/i.test(visible));
  if (t.total !== null) record(id, "total is a whole visible token", hasAmountToken(tokens, t.total));
  if (t.subtotal !== null) record(id, "subtotal is a whole visible token", hasAmountToken(tokens, t.subtotal));
  if (t.tax !== null) record(id, "tax is a whole visible token", hasAmountToken(tokens, t.tax));
  if (t.bank_account !== null) record(id, "bank account is a whole visible token", hasIdToken(tokens, t.bank_account));
  else record(id, "no bank account printed", !/ACC-?\d/i.test(visible));

  const collapsedVisible = collapse(visible).toLowerCase();
  if (t.vendor_name !== null) record(id, "vendor name is printed", collapsedVisible.includes(collapse(t.vendor_name).toLowerCase()));
  if (t.line_items.length > 0) {
    const missing = t.line_items.filter((li) => !collapsedVisible.includes(collapse(li.description).toLowerCase())).length;
    record(id, "every line item description is printed", missing === 0, `${missing} missing`);
    const missingAmounts = t.line_items.filter((li) => !hasAmountToken(tokens, li.amount)).length;
    record(id, "every line amount is a whole visible token", missingAmounts === 0, `${missingAmounts} missing`);
    const missingRates = t.line_items.filter(
      (li) => (li.unit_price !== null && !hasAmountToken(tokens, li.unit_price)) || (li.quantity !== null && !tokens.includes(String(li.quantity))),
    ).length;
    record(id, "every line quantity and unit price is a whole visible token", missingRates === 0, `${missingRates} missing`);
  }
  if (t.invoice_date !== null) record(id, "invoice (or statement) date is printed", dateForms(t.invoice_date).some((f) => visible.includes(f)));
  if (t.due_date !== null) record(id, "due date is printed", dateForms(t.due_date).some((f) => visible.includes(f)));
  if (t.currency !== null) record(id, "currency code is a whole visible token", tokens.includes(t.currency));
  if (t.notes.trim() !== "") record(id, "notes are printed as a visible notice", collapsedVisible.includes(collapse(t.notes).toLowerCase()));

  // ---- the wrong document: nothing that looks like an invoice ----
  if (t.document_type === "statement") {
    const others = allInvoiceNumbers.filter((n) => hasIdToken(tokens, n));
    record(id, "no invoice number printed (no other sample's number either)", t.invoice_number === null && others.length === 0 && !/invoice/i.test(visible), `${others.length} numbers found`);
    record(id, "no tax, total or due date printed", !/\btax\b/i.test(visible) && !/\btotal\b/i.test(visible) && !/\bdue\b/i.test(visible));
    record(id, "says it is a statement of account", /statement of account/i.test(visible));
  }

  return bytes.length;
}

async function main(): Promise<void> {
  const samples = loadTruthSamples();
  record("all", "10 truth files for the 10 sample names", samples.length === SAMPLE_FILES.length && samples.every((s, i) => s.meta.file === SAMPLE_FILES[i]));

  const allInvoiceNumbers = samples.map((s) => s.extraction.invoice_number).filter((n): n is string => n !== null);
  let total = 0;
  for (const s of samples) total += await verifySample(s, allInvoiceNumbers);

  const onDisk = fs.existsSync(paths.samplesDir) ? fs.readdirSync(paths.samplesDir).filter((f) => f.toLowerCase().endsWith(".pdf")) : [];
  record("all", "data/samples holds exactly the 10 sample PDFs", onDisk.length === SAMPLE_FILES.length && onDisk.every((f) => (SAMPLE_FILES as readonly string[]).includes(f)), `${onDisk.length} files`);
  record("all", "total size under 3 MB", total < MAX_TOTAL_BYTES, `${(total / 1024).toFixed(0)} KB`);

  // ---- report ----
  const ids = [...new Set(results.map((r) => r.sample))];
  let failed = 0;
  for (const sid of ids) {
    const rs = results.filter((r) => r.sample === sid);
    const bad = rs.filter((r) => !r.ok);
    failed += bad.length;
    const label = sid === "all" ? "all" : `${sid} ${samples.find((s) => s.id === sid)?.meta.file ?? ""}`;
    console.log(`${bad.length === 0 ? "PASS" : "FAIL"}  ${label}  (${rs.length - bad.length}/${rs.length} checks)`);
    for (const r of rs) {
      if (process.argv.includes("--verbose") || !r.ok) console.log(`      ${r.ok ? "ok  " : "FAIL"} ${r.name}${r.detail ? ` [${r.detail}]` : ""}`);
    }
  }
  console.log(`${results.length - failed}/${results.length} checks passed, ${(total / 1024).toFixed(0)} KB of PDFs`);
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
