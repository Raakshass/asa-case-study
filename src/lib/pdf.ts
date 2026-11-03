/**
 * PDF file handling: upload validation (stage 1), hashing, display names, the pdf.js text layer and
 * encryption detection. Server-only.
 *
 * OWNER: Phase 4 (guardrails + pdf). The primitives (sha256, sanitizeDisplayName, hasPdfMagic,
 * getTextItems, isEncryptedPdf, isPasswordError, isInvalidPdfError) keep their signatures; validateUpload is
 * implemented here (docs/notes-unpdf.md "Suggested ingest order", IMPLEMENTATION_PLAN.md section 6.1).
 * Everything derived from the file (bytes, pdf.js / pdf-lib error text, the file name) is untrusted: no
 * reason string below ever contains it.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { PDFDocument } from "pdf-lib";
import { getDocumentProxy } from "unpdf";
import { CONFIG, paths } from "./config";
import type { TextItem, UploadFailureCode, UploadValidation } from "./types";

export type { TextItem, UploadValidation };

/** Lowercase hex sha256 of the bytes (runs.file_hash, uploads/<hash>.pdf). */
export function sha256(buf: Uint8Array): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/**
 * Display-only file name (plan section 6.1): NFKC, characters outside [A-Za-z0-9_.- ] removed, spaces
 * collapsed, at most 100 characters; "upload.pdf" if nothing is left. Never use it as a path.
 */
export function sanitizeDisplayName(name: string | null | undefined): string {
  const cleaned = (typeof name === "string" ? name : "")
    .normalize("NFKC")
    .replace(/[^\w.\- ]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, CONFIG.maxDisplayNameChars)
    .trim();
  return cleaned || "upload.pdf";
}

/** First 5 bytes are "%PDF-". */
export function hasPdfMagic(buf: Uint8Array): boolean {
  return buf.length >= 5 && Buffer.from(buf.buffer, buf.byteOffset, 5).toString("latin1") === "%PDF-";
}

/* ------------------------------------------------------------------------------------------------
 * pdf.js text layer
 * ---------------------------------------------------------------------------------------------- */

/** Raised inside the text reader when a limit is hit; mapped to an upload failure, never shown. */
class PdfLimitError extends Error {
  constructor(
    readonly kind: "pages" | "size" | "time",
    /** the page count pdf.js reported, for kind "pages" */
    readonly pages: number | null = null,
  ) {
    super(`PDF limit exceeded: ${kind}`);
    this.name = "PdfLimitError";
  }
}

interface ReadLimits {
  maxPages: number;
  maxItems: number;
  maxChars: number;
}

/** Cooperative cancellation: `stopped` is set by the deadline timer, `deadline` is a performance.now() time in ms. */
interface Abort {
  stopped: boolean;
  deadline: number;
}

const NO_LIMITS: ReadLimits = { maxPages: Infinity, maxItems: Infinity, maxChars: Infinity };
const NEVER_ABORT: Abort = { stopped: false, deadline: Infinity };

function checkAbort(abort: Abort): void {
  if (abort.stopped || performance.now() > abort.deadline) throw new PdfLimitError("time");
}

/** The pdf.js text item fields this module reads (TextMarkedContent has no `str`). */
interface RawTextItem {
  str?: unknown;
  transform?: unknown;
  hasEOL?: unknown;
}

/**
 * Reads the text layer with a private copy of the bytes (pdf.js rejects Node Buffers and detaches what it
 * is given). Consumes pdf.js's chunked text stream so a hostile file can be cut off as soon as it exceeds
 * `limits` (item count, characters) or the abort state fires, instead of materialising everything first.
 */
async function readPdfText(
  buf: Uint8Array,
  limits: ReadLimits,
  abort: Abort,
): Promise<{ items: TextItem[]; pageCount: number }> {
  const pdf = await getDocumentProxy(new Uint8Array(buf), { verbosity: 0 });
  let failed = true;
  try {
    checkAbort(abort);
    if (pdf.numPages > limits.maxPages) throw new PdfLimitError("pages", pdf.numPages);
    const out: TextItem[] = [];
    let chars = 0;
    for (let p = 1; p <= pdf.numPages; p++) {
      checkAbort(abort);
      const page = await pdf.getPage(p);
      const unit = page.userUnit || 1;
      const reader = page.streamTextContent().getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          for (const it of (value as { items: RawTextItem[] }).items) {
            if (typeof it.str !== "string" || !Array.isArray(it.transform)) continue; // TextMarkedContent
            const [, , c, d, x, y] = it.transform as number[];
            const str = it.str + (it.hasEOL ? "\n" : "");
            out.push({ str, height: Math.hypot(c, d) * unit, x, y, page: p });
            chars += str.length;
          }
          if (out.length > limits.maxItems || chars > limits.maxChars) throw new PdfLimitError("size");
          checkAbort(abort);
        }
      } finally {
        // pdf.js asserts that a cancel reason is an Error and silently drops the cancel without one, which
        // leaves its worker task waiting for a consumer that is gone (and destroy() waiting for that task).
        void reader.cancel(new Error("text extraction stopped")).catch(() => undefined); // a no-op once the stream is done
      }
    }
    checkAbort(abort); // a parse that only finished after its deadline is not trusted
    failed = false;
    return { items: out, pageCount: pdf.numPages };
  } finally {
    const destroyed = pdf.destroy().catch(() => undefined);
    if (!failed) await destroyed; // after an error never wait for a worker that may still be mid-task
  }
}

/**
 * Every text item pdf.js finds, page by page, in content order (docs/notes-unpdf.md, tested helper).
 * Passes pdf.js a private copy: it rejects Node Buffers and detaches the array it is given, so the
 * caller's bytes stay intact. Throws pdf.js errors: name "PasswordException" (encrypted with a user
 * password) or "InvalidPDFException" (empty, not a PDF, damaged or truncated). No size limits: use
 * validateUpload for untrusted files.
 */
export async function getTextItems(buf: Uint8Array): Promise<TextItem[]> {
  return (await readPdfText(buf, NO_LIMITS, NEVER_ABORT)).items;
}

/* ------------------------------------------------------------------------------------------------
 * The whole parse (pdf-lib structure + the same text read), isolated in a worker thread (validateUpload only)
 * ---------------------------------------------------------------------------------------------- */

/** Plain-JS worker next to this file (src/lib/pdf-text-worker.mjs); it mirrors loadStructure + getPageCount, then readPdfText item for item. */
const TEXT_WORKER_FILE = "pdf-text-worker.mjs";
/** Heap cap of one text-parse worker. A 5-page invoice needs a few MB; a hostile file stops here, not at the machine's limit. */
export const TEXT_WORKER_HEAP_MB = 256;
/**
 * How much the process may grow (RSS) because of one text read: the growth while it runs, minus what the main
 * thread's own heap and external memory grew by meanwhile (other requests, uploads), see workerGrowthBytes. pdf.js
 * decodes content streams into buffers that live outside the capped heap: in-process, a 157 KB operator flood grew
 * the process by ~450 MB. Measured growth for real files: under 50 MB (a 99,000-item text layer: 43 MB, including a
 * worker start).
 */
export const TEXT_WORKER_MAX_GROWTH_MB = 256;
const MEMORY_CHECK_MS = 50;

/**
 * What pdf-lib says about the file (pdf-text-worker.mjs readStructure, or loadStructure + getPageCount in-process):
 * parsed at all, encrypted, and its page leaves (null when the count cannot be read).
 */
interface PdfStructureInfo {
  parsed: boolean;
  encrypted: boolean;
  libPages: number | null;
}

/** One inspection of an upload: the structure, and the text layer when the structure did not already decide. */
interface Inspection {
  structure: PdfStructureInfo;
  items: TextItem[] | null;
  pageCount: number | null;
}

type WorkerReply =
  | { ok: true; structure?: unknown; items?: TextItem[] | null; pageCount?: number | null }
  | { ok: false; error?: { name?: unknown; kind?: unknown; pages?: unknown } };

/** The worker's structure answer, read defensively (a reply of another shape is treated as "not parseable"). */
function structureFrom(value: unknown): PdfStructureInfo {
  const v = (value !== null && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const libPages = typeof v.libPages === "number" && Number.isFinite(v.libPages) ? v.libPages : null;
  return { parsed: v.parsed === true, encrypted: v.encrypted === true, libPages };
}

let textWorkerPath: string | null | undefined;
/** One warm worker kept between uploads (starting one costs ~150 ms). A busy, failed or killed worker is never reused. */
let idleWorker: Worker | null = null;
let warnedInProcess = false;
/**
 * Text reads run ONE AT A TIME (the pipeline is serial anyway). Besides keeping a single worker, this is what makes
 * the memory watchdog meaningful: it measures the whole process, and eight workers starting at once grew it by
 * ~300 MB and tripped it on ordinary files (measured). A read that waits here still honours its own deadline.
 */
let textQueue: Promise<void> = Promise.resolve();

/** Resolves true when `previous` settles first, false when the deadline (a performance.now() time) comes first. */
function waitTurn(previous: Promise<void>, deadline: number): Promise<boolean> {
  const left = deadline - performance.now();
  if (!Number.isFinite(left)) return previous.then(() => true);
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), Math.min(Math.max(left, 0), 2_147_483_647));
  });
  return Promise.race([previous.then(() => true), expired]).finally(() => clearTimeout(timer));
}

function findTextWorker(): string | null {
  if (textWorkerPath !== undefined) return textWorkerPath;
  const candidates = [path.join(paths.root, "src", "lib", TEXT_WORKER_FILE)];
  if (typeof __dirname === "string") candidates.unshift(path.join(__dirname, TEXT_WORKER_FILE)); // tsx; a bundle's __dirname has no such file
  textWorkerPath =
    candidates.find((file) => {
      try {
        return fs.statSync(file).isFile();
      } catch {
        return false;
      }
    }) ?? null;
  return textWorkerPath;
}

function takeTextWorker(file: string): Worker {
  const warm = idleWorker;
  if (warm !== null) {
    idleWorker = null;
    warm.ref();
    return warm;
  }
  const worker = new Worker(file, { resourceLimits: { maxOldGenerationSizeMb: TEXT_WORKER_HEAP_MB, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 } });
  worker.on("error", () => undefined); // handled per job below; an idle worker that dies is simply dropped
  worker.on("exit", () => {
    if (idleWorker === worker) idleWorker = null;
  });
  return worker;
}

function releaseTextWorker(worker: Worker): void {
  if (idleWorker === null) {
    worker.unref(); // an idle worker never keeps a script alive
    idleWorker = worker;
  } else {
    void worker.terminate().catch(() => undefined);
  }
}

function errorFromWorker(e: { name?: unknown; kind?: unknown; pages?: unknown } | undefined): Error {
  if (e?.name === "PdfLimitError" && (e.kind === "pages" || e.kind === "size" || e.kind === "time")) {
    return new PdfLimitError(e.kind, typeof e.pages === "number" ? e.pages : null);
  }
  // only the name crosses over (PasswordException / InvalidPDFException / ...); never the worker's message text
  return Object.assign(new Error("PDF text layer could not be read"), { name: typeof e?.name === "string" ? e.name : "Error" });
}

/**
 * The whole parse of an upload in a worker thread with a HARD deadline: pdf-lib's structure (encryption, page leaves)
 * and then the pdf.js text layer, as ONE job (one queue slot, one deadline, one memory watchdog). Both parsers can run
 * synchronously for as long as a hostile file wants: in-process, a 157 KB file of non-text operators blocked the whole
 * event loop for 8.5 s in pdf.js (RG-1), and a ~3 KB page tree that lists the same child twice per level kept pdf-lib's
 * getPageCount busy for 2^depth visits (13 s at depth 26, days at depth 40) while a 1 KB object-stream bomb inflated
 * 256 MB during PDFDocument.load (SEC-1). Here the deadline terminates the worker (Worker#terminate stops even a
 * synchronous loop), its heap is capped at TEXT_WORKER_HEAP_MB, and a watchdog terminates it when the process grows by
 * more than TEXT_WORKER_MAX_GROWTH_MB (decoded streams live outside the heap). Falls back to the in-process parse (old
 * behaviour, logged once) only when no worker can be started.
 */
async function inspectIsolated(buf: Uint8Array, limits: ReadLimits, abort: Abort): Promise<Inspection> {
  const file = findTextWorker();
  if (file === null) return inspectInProcess(buf, limits, abort);
  const previous = textQueue;
  let release: () => void = () => undefined;
  textQueue = new Promise<void>((resolve) => (release = resolve));
  try {
    if (!(await waitTurn(previous, abort.deadline))) throw new PdfLimitError("time");
    checkAbort(abort);
    let worker: Worker;
    try {
      worker = takeTextWorker(file);
    } catch {
      return await inspectInProcess(buf, limits, abort);
    }
    return await inspectOnWorker(worker, buf, limits, abort);
  } finally {
    void previous.then(release); // the next parse starts only after this one AND the one before it are done
  }
}

/** The same inspection on the main thread: only when no worker can be started (the deadline cannot interrupt it). */
async function inspectInProcess(buf: Uint8Array, limits: ReadLimits, abort: Abort): Promise<Inspection> {
  if (!warnedInProcess) {
    warnedInProcess = true;
    console.warn("pdf.ts: no text-parse worker could be started; PDFs are parsed in-process (the upload deadline cannot interrupt pdf-lib or pdf.js)");
  }
  const loaded = await loadStructure(buf);
  let libPages: number | null = null;
  if (loaded.doc !== null && !loaded.encrypted) {
    try {
      libPages = loaded.doc.getPageCount(); // throws TypeError on a header-only file
    } catch {
      libPages = null;
    }
  }
  const structure: PdfStructureInfo = { parsed: loaded.doc !== null, encrypted: loaded.encrypted, libPages };
  if (!structure.parsed || structure.encrypted || libPages === null || libPages < 1 || libPages > limits.maxPages) {
    return { structure, items: null, pageCount: null };
  }
  checkAbort(abort);
  const { items, pageCount } = await readPdfText(buf, limits, abort);
  return { structure, items, pageCount };
}

/** What the main thread itself holds: its V8 heap and its external memory (Buffers, ArrayBuffers, Blobs). */
function mainThreadBytes(): number {
  const m = process.memoryUsage();
  return m.heapTotal + m.external;
}

/**
 * How much of the process growth since the read started the worker caused. RSS is process-wide, so on its own it
 * also counts what the main thread allocates meanwhile (an upload finishing costs it tens of MB): red team RT-PIPE-01,
 * where eight uploads completing during one read got a valid invoice rejected as damaged. `process.memoryUsage()`
 * fields other than rss refer to the CALLING thread only, so the main thread's own growth is taken off; memory it
 * frees is never added back (RSS rarely shrinks when it does).
 */
function workerGrowthBytes(start: { rss: number; main: number }): number {
  return process.memoryUsage.rss() - start.rss - Math.max(0, mainThreadBytes() - start.main);
}

/** One job on a worker: resolves with the inspection or rejects (limit, deadline, crash); the worker is kept only when healthy. */
function inspectOnWorker(worker: Worker, buf: Uint8Array, limits: ReadLimits, abort: Abort): Promise<Inspection> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const start = { rss: process.memoryUsage.rss(), main: mainThreadBytes() };
    const memory = setInterval(() => {
      if (workerGrowthBytes(start) > TEXT_WORKER_MAX_GROWTH_MB * 1024 * 1024) settle(false, () => reject(new PdfLimitError("size")));
    }, MEMORY_CHECK_MS);
    const settle = (keepWorker: boolean, finish: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(memory);
      worker.off("message", onMessage);
      worker.off("error", onFailure);
      worker.off("exit", onFailure);
      if (keepWorker) releaseTextWorker(worker);
      else void worker.terminate().catch(() => undefined);
      finish();
    };
    const onMessage = (reply: WorkerReply) =>
      settle(true, () => {
        if (abort.stopped || performance.now() > abort.deadline) reject(new PdfLimitError("time")); // never accepted late
        else if (reply?.ok === true) {
          const items = Array.isArray(reply.items) ? reply.items : null;
          const pageCount = typeof reply.pageCount === "number" ? reply.pageCount : null;
          resolve({ structure: structureFrom(reply.structure), items, pageCount });
        } else reject(errorFromWorker(reply?.error));
      });
    const onFailure = () => settle(false, () => reject(new Error("text worker failed"))); // crash, heap cap, early exit
    worker.on("message", onMessage);
    worker.on("error", onFailure);
    worker.on("exit", onFailure);
    const left = abort.deadline - performance.now();
    if (Number.isFinite(left)) {
      timer = setTimeout(() => settle(false, () => reject(new PdfLimitError("time"))), Math.min(Math.max(left, 0), 2_147_483_647));
    }
    try {
      const copy = new Uint8Array(buf); // private copy, moved to the worker: the caller's bytes stay attached
      worker.postMessage({ bytes: copy, limits }, [copy.buffer]);
    } catch {
      settle(false, () => reject(new Error("text worker unavailable")));
    }
  });
}

/* ------------------------------------------------------------------------------------------------
 * Encryption
 * ---------------------------------------------------------------------------------------------- */

interface PdfStructure {
  /** the pdf-lib document, or null when pdf-lib could not parse the bytes at all */
  doc: PDFDocument | null;
  encrypted: boolean;
}

/**
 * One pdf-lib parse shared by isEncryptedPdf and validateUpload. Plain load() throws a generic Error on
 * encrypted files (instanceof EncryptedPDFError is false in pdf-lib 1.17.1), so it loads with
 * ignoreEncryption and reads the flag. Never throws; falls back to a raw "/Encrypt" byte scan only when
 * pdf-lib cannot parse the file at all.
 */
async function loadStructure(buf: Uint8Array): Promise<PdfStructure> {
  try {
    const doc = await PDFDocument.load(buf, { ignoreEncryption: true, updateMetadata: false });
    return { doc, encrypted: doc.isEncrypted };
  } catch {
    return { doc: null, encrypted: Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength).includes("/Encrypt") };
  }
}

/**
 * True if the file has an encryption dictionary, including owner-password-only PDFs that open
 * without a password (flagged on purpose: conservative). Falls back to a raw "/Encrypt" byte scan only
 * when pdf-lib cannot parse the file at all.
 */
export async function isEncryptedPdf(buf: Uint8Array): Promise<boolean> {
  return (await loadStructure(buf)).encrypted;
}

/** pdf.js errors are Error instances; match on name, not class. */
export const isPasswordError = (e: unknown): boolean => e instanceof Error && e.name === "PasswordException";
export const isInvalidPdfError = (e: unknown): boolean => e instanceof Error && e.name === "InvalidPDFException";

/* ------------------------------------------------------------------------------------------------
 * Stage 1: upload validation
 * ---------------------------------------------------------------------------------------------- */

export interface UploadLimits {
  maxBytes: number;
  maxPages: number;
}

/** Wall-clock budget for the whole structural + text parse (see validateUpload). */
export const UPLOAD_TIMEOUT_MS = 10_000;
/** A 5-page invoice has a few thousand text items; this only stops text floods (memory) from tiny files. */
export const MAX_TEXT_ITEMS = 100_000;
export const MAX_TEXT_CHARS = 1_000_000;

/** The fixed reasons (docs/CONTRACTS.md). The size and page-count reasons carry a number: see below. */
export const UPLOAD_REASONS = {
  empty: "Empty file",
  not_pdf: "Not a PDF",
  encrypted: "Password-protected PDF, request an unlocked copy",
  damaged: "PDF is damaged or unreadable",
} as const;

function describeBytes(n: number): string {
  const mb = n / (1024 * 1024);
  if (mb >= 1) return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`;
  const kb = n / 1024;
  return `${Number.isInteger(kb) ? kb : kb.toFixed(1)} KB`;
}

/** "File is larger than 10 MB" for the default limit. */
export const tooLargeReason = (maxBytes: number): string => `File is larger than ${describeBytes(maxBytes)}`;
/** "PDF has 6 pages; the limit is 5". */
export const tooManyPagesReason = (pages: number, maxPages: number): string =>
  `PDF has ${pages} pages; the limit is ${maxPages}`;

type UploadFailure = Extract<UploadValidation, { ok: false }>;

function fail(code: UploadFailureCode, reason: string, sizeBytes: number, pageCount: number | null = null): UploadFailure {
  return { ok: false, code, outcome: code === "encrypted" ? "hold" : "reject", reason, sizeBytes, pageCount };
}

/**
 * Maps whatever the text reader threw to a readable failure; the error's own text is never used.
 * PasswordException (the pdf-lib check missed an encrypted file) -> HOLD; a page-count limit -> too many
 * pages; InvalidPDFException, a size or time limit and anything unexpected -> damaged.
 */
export function uploadFailureFromError(e: unknown, sizeBytes: number, maxPages: number): UploadFailure {
  if (isPasswordError(e)) return fail("encrypted", UPLOAD_REASONS.encrypted, sizeBytes);
  if (e instanceof PdfLimitError && e.kind === "pages" && e.pages !== null) {
    return fail("too_many_pages", tooManyPagesReason(e.pages, maxPages), sizeBytes, e.pages);
  }
  return fail("damaged", UPLOAD_REASONS.damaged, sizeBytes);
}

/** The raw "/Encrypt" fallback for bytes pdf-lib cannot parse at all (linear, cheap: it stays on the main thread). */
function hasEncryptMarker(buf: Uint8Array): boolean {
  return Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength).includes("/Encrypt");
}

/**
 * The slow, possibly hostile part: pdf-lib structure, then the pdf.js text layer, once, both in the worker
 * (inspectIsolated). The verdicts and their order are those of the in-process version they replace: encrypted ->
 * HOLD; not parseable or no readable page count -> damaged; too many pages; no pages -> damaged; then the text layer;
 * then the two parsers' page counts must agree.
 */
async function inspectPdf(buf: Uint8Array, maxPages: number, abort: Abort): Promise<UploadValidation> {
  const sizeBytes = buf.byteLength;
  const { structure, items, pageCount } = await inspectIsolated(buf, { maxPages, maxItems: MAX_TEXT_ITEMS, maxChars: MAX_TEXT_CHARS }, abort);
  if (structure.encrypted || (!structure.parsed && hasEncryptMarker(buf))) return fail("encrypted", UPLOAD_REASONS.encrypted, sizeBytes);
  if (!structure.parsed) return fail("damaged", UPLOAD_REASONS.damaged, sizeBytes);
  const libPages = structure.libPages;
  if (libPages === null) return fail("damaged", UPLOAD_REASONS.damaged, sizeBytes); // getPageCount threw (a header-only file)
  if (libPages > maxPages) return fail("too_many_pages", tooManyPagesReason(libPages, maxPages), sizeBytes, libPages);
  if (libPages < 1) return fail("damaged", UPLOAD_REASONS.damaged, sizeBytes);
  checkAbort(abort);
  if (items === null || pageCount === null) return fail("damaged", UPLOAD_REASONS.damaged, sizeBytes);
  // pdf-lib counts page leaves, pdf.js reads /Count. They agree on every sane file; a file where they differ
  // shows each parser different pages, so it is treated as damaged rather than trusted.
  if (pageCount !== libPages) return fail("damaged", UPLOAD_REASONS.damaged, sizeBytes);
  return { ok: true, sizeBytes, pageCount, textItems: items };
}

/**
 * Same as validateUpload with an explicit wall-clock budget in milliseconds (validateUpload uses
 * UPLOAD_TIMEOUT_MS; tests use a tiny one). When the budget runs out the result is the "damaged" rejection,
 * even if the parse finally completes: a file that needed longer than its budget is never accepted.
 *
 * How the bound is enforced: the whole parse, pdf-lib's structure step and the pdf.js text read, runs in ONE job on a
 * worker thread (inspectIsolated) that is terminated at the deadline, so neither a synchronous pdf.js run (measured
 * in-process: 40 million non-text operators in a 157 KB file blocked the event loop for 8.5 s) nor a pdf-lib page-tree
 * walk or object-stream inflate (red team SEC-1: a ~3 KB file froze the server for 13 s and more) blocks the server;
 * the main thread stays responsive and the upload is rejected at its deadline, with no parse left running behind it.
 * Text floods are still cut off early by the item and character caps, inside the worker. Only when no worker can be
 * started does the parse run in-process again (logged once), where the deadline cannot interrupt it.
 */
export async function validateUploadWithin(
  buf: Uint8Array,
  timeoutMs: number,
  limits?: Partial<UploadLimits>,
): Promise<UploadValidation> {
  const sizeBytes = buf instanceof Uint8Array ? buf.byteLength : 0;
  try {
    if (!(buf instanceof Uint8Array) || sizeBytes === 0) return fail("empty", UPLOAD_REASONS.empty, 0);
    if (!hasPdfMagic(buf)) return fail("not_pdf", UPLOAD_REASONS.not_pdf, sizeBytes);
    const maxBytes = limits?.maxBytes ?? CONFIG.maxFileBytes;
    const maxPages = limits?.maxPages ?? CONFIG.maxPages;
    if (sizeBytes > maxBytes) return fail("too_large", tooLargeReason(maxBytes), sizeBytes);

    const ms = Number.isNaN(timeoutMs) ? 0 : Math.min(Math.max(timeoutMs, 0), 2_147_483_647); // setTimeout's maximum
    const abort: Abort = { stopped: false, deadline: performance.now() + ms };
    const work = inspectPdf(buf, maxPages, abort).catch((e: unknown) => uploadFailureFromError(e, sizeBytes, maxPages));
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<UploadValidation>((resolve) => {
      timer = setTimeout(() => {
        abort.stopped = true;
        resolve(fail("damaged", UPLOAD_REASONS.damaged, sizeBytes));
      }, ms);
    });
    try {
      return await Promise.race([work, expired]);
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return fail("damaged", UPLOAD_REASONS.damaged, sizeBytes);
  }
}

/**
 * Stage 1 file validation (plan section 6.1 + docs/notes-unpdf.md "Suggested ingest order"). Never throws.
 * Order: empty -> "%PDF-" magic -> size -> isEncryptedPdf (HOLD) -> pdf-lib page count in try/catch
 * (> maxPages REJECT) -> getTextItems once (PasswordException -> HOLD, InvalidPDFException -> REJECT).
 * Reasons (exact): "Empty file" | "Not a PDF" | "File is larger than 10 MB" |
 * "PDF has N pages; the limit is 5" | "Password-protected PDF, request an unlocked copy" |
 * "PDF is damaged or unreadable". On success the text items are returned for stages 2 and 4.
 *
 * Also "PDF is damaged or unreadable": any other parse failure, a page count that pdf-lib and pdf.js disagree
 * on, a text layer over MAX_TEXT_ITEMS / MAX_TEXT_CHARS, and a parse that outlives UPLOAD_TIMEOUT_MS
 * (validateUploadWithin documents what that time bound can and cannot interrupt). Owner-password-only PDFs
 * open without a password but are still HOLD (encrypted), on purpose.
 *
 * OWNER: Phase 4.
 */
export async function validateUpload(buf: Uint8Array, limits?: Partial<UploadLimits>): Promise<UploadValidation> {
  return validateUploadWithin(buf, UPLOAD_TIMEOUT_MS, limits);
}
