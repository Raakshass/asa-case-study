/**
 * npm run gen  (tsx scripts/gen-invoices.ts)
 *
 * Renders the 10 sample invoices: data/samples/<_meta.file> for every data/samples/truth/NN.json.
 * The truth files are the single source of each document's content; the HTML templates in
 * scripts/templates/ only decide how it looks (layout named by _meta.layout, vendor brand from the vendor name).
 *
 *  - render "text":    HTML -> PDF with Playwright's Chromium (A4, backgrounds on, exactly one page, real text layer).
 *  - render "scanned": the same HTML rotated 0.7 degrees (zoomed 2% so the tilted sheet fills the frame),
 *                      greyscale, contrast 1.15, a slight blur and a faint noise overlay, screenshotted to JPEG
 *                      (quality 80) and embedded with pdf-lib into an image-only PDF. No text layer at all.
 *  - hiddenText (sample 09): the template adds that exact sentence as white text at CSS 1px (0.75pt) inside
 *                      the printable page, over white paper: invisible to a reader, present in the text layer.
 *
 * Safe to run twice: every file is written to a temp name and renamed over the old one. The run fails if the
 * PDFs together reach 3 MB. Run it from the project root. Needs Chromium: npx playwright install chromium.
 * Check the output with: npx tsx scripts/verify-samples.ts
 *
 * The PDF dates are pinned to the invoice date, so two runs on the same machine (same Chromium and fonts)
 * write byte-identical files; on another machine the fonts, and so the bytes, may differ.
 */
import fs from "node:fs";
import path from "node:path";
import { PDFDocument } from "pdf-lib";
import { type Browser, chromium } from "playwright";
import { paths } from "../src/lib/config";
import { type TruthSample, isSampleFile, loadTruthSamples } from "../src/lib/samples";
import { type DocInput, renderHtml } from "./templates";

/** A4 in PDF points (210 x 297 mm). */
const A4_WIDTH_PT = 595.28;
const A4_HEIGHT_PT = 841.89;
/** A4 in CSS pixels at 96 dpi (what the templates are laid out in). */
const A4_WIDTH_PX = 794;
const A4_HEIGHT_PX = 1123;
/** Total budget for data/samples/*.pdf. */
const MAX_TOTAL_BYTES = 3 * 1024 * 1024;
/** Scan: device pixels per CSS pixel (2 = about 190 dpi) and JPEG quality. */
const SCAN_SCALE = 2;
const SCAN_JPEG_QUALITY = 80;

function docOf(s: TruthSample): DocInput {
  return { id: s.id, data: s.extraction, meta: s.meta };
}

/** Stamp the PDF's dates with the invoice date so two runs differ as little as possible. */
function documentDate(doc: DocInput): Date {
  const iso = doc.data.invoice_date;
  const d = new Date(`${iso ?? "2026-10-31"}T09:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? new Date("2026-10-31T09:00:00.000Z") : d;
}

/** HTML -> one-page A4 PDF with a real text layer. */
async function renderTextPdf(browser: Browser, doc: DocInput): Promise<Uint8Array> {
  const context = await browser.newContext({ viewport: { width: A4_WIDTH_PX, height: A4_HEIGHT_PX }, offline: true, javaScriptEnabled: false });
  try {
    const page = await context.newPage();
    await page.setContent(renderHtml(doc, "pdf"), { waitUntil: "load" });
    const raw = await page.pdf({
      format: "A4",
      printBackground: true,
      preferCSSPageSize: true,
      margin: { top: "0", right: "0", bottom: "0", left: "0" },
    });
    // Pin the dates (Chromium stamps "now") and keep the title; nothing else is touched.
    const pdf = await PDFDocument.load(raw, { updateMetadata: false });
    const stamp = documentDate(doc);
    pdf.setCreationDate(stamp);
    pdf.setModificationDate(stamp);
    return await pdf.save({ useObjectStreams: false });
  } finally {
    await context.close();
  }
}

/** HTML -> rotated, noisy greyscale JPEG -> image-only one-page A4 PDF (no text layer). */
async function renderScannedPdf(browser: Browser, doc: DocInput): Promise<Uint8Array> {
  const context = await browser.newContext({
    viewport: { width: A4_WIDTH_PX, height: A4_HEIGHT_PX },
    deviceScaleFactor: SCAN_SCALE,
    offline: true,
    javaScriptEnabled: false,
  });
  try {
    const page = await context.newPage();
    await page.setContent(renderHtml(doc, "scan"), { waitUntil: "load" });
    const jpeg = await page.screenshot({
      type: "jpeg",
      quality: SCAN_JPEG_QUALITY,
      clip: { x: 0, y: 0, width: A4_WIDTH_PX, height: A4_HEIGHT_PX },
    });
    const pdf = await PDFDocument.create({ updateMetadata: false });
    const stamp = documentDate(doc);
    pdf.setTitle("Scanned document");
    pdf.setProducer("Document scanner");
    pdf.setCreator("Document scanner");
    pdf.setCreationDate(stamp);
    pdf.setModificationDate(stamp);
    const image = await pdf.embedJpg(jpeg);
    const sheet = pdf.addPage([A4_WIDTH_PT, A4_HEIGHT_PT]);
    sheet.drawImage(image, { x: 0, y: 0, width: A4_WIDTH_PT, height: A4_HEIGHT_PT });
    return await pdf.save({ useObjectStreams: false });
  } finally {
    await context.close();
  }
}

/** Temp file + rename, so a failed run never leaves a half-written PDF behind. */
function writeAtomic(file: string, bytes: Uint8Array): void {
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, bytes);
    fs.renameSync(tmp, file);
  } finally {
    if (fs.existsSync(tmp)) fs.rmSync(tmp, { force: true });
  }
}

async function main(): Promise<void> {
  if (!fs.existsSync(paths.truthDir)) {
    throw new Error(`No truth files at ${paths.truthDir}. Run this from the project root after Phase 1a.`);
  }
  const samples = loadTruthSamples();
  if (samples.length === 0) throw new Error("No truth files found in data/samples/truth.");
  fs.mkdirSync(paths.samplesDir, { recursive: true });

  let browser: Browser;
  try {
    browser = await chromium.launch();
  } catch (e) {
    throw new Error(`Could not start Chromium (${(e as Error).message.split("\n")[0]}). Install it with: npx playwright install chromium`);
  }

  let total = 0;
  try {
    for (const s of samples) {
      // The output name comes from validated _meta (an enum of SAMPLE_FILES); re-check before using it as a path.
      const file = s.meta.file;
      if (!isSampleFile(file) || path.basename(file) !== file) throw new Error(`Refusing to write ${JSON.stringify(file)}`);
      const doc = docOf(s);
      const scanned = s.meta.render === "scanned";
      const bytes = scanned ? await renderScannedPdf(browser, doc) : await renderTextPdf(browser, doc);
      const check = await PDFDocument.load(bytes, { updateMetadata: false });
      if (check.getPageCount() !== 1) throw new Error(`${file}: expected 1 page, got ${check.getPageCount()}`);
      writeAtomic(path.join(paths.samplesDir, file), bytes);
      total += bytes.length;
      console.log(`${file.padEnd(34)} ${s.meta.layout.padEnd(9)} ${scanned ? "scanned" : "text   "} ${(bytes.length / 1024).toFixed(1).padStart(7)} KB  1 page`);
    }
  } finally {
    await browser.close();
  }

  console.log(`${samples.length} PDFs, ${(total / 1024).toFixed(1)} KB in total (limit ${MAX_TOTAL_BYTES / 1024 / 1024} MB)`);
  if (total >= MAX_TOTAL_BYTES) throw new Error("The sample PDFs together reach 3 MB; lower the scan scale or quality.");
  console.log("Check them against the truth files with: npx tsx scripts/verify-samples.ts");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
