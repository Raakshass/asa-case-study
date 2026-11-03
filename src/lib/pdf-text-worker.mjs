/**
 * Worker thread for pdf.ts: parses ONE untrusted upload away from the main event loop, structure and text alike.
 *
 * Why a worker: both parsers can run for a long time in one synchronous stretch that the main thread cannot
 * interrupt. pdf.js interprets a page's content stream in one run (a Flate-compressed "q Q" flood kept the event
 * loop blocked for tens of seconds and grew the process to ~1 GB), and pdf-lib walks a page tree recursively with no
 * visited set (a ~3 KB file whose /Pages nodes list the same child twice costs 2^depth visits: depth 26 froze the
 * server for 13 s, depth 40 for days) and inflates every object stream while it loads (a 1 KB file grew the process by
 * 500 MB): red team SEC-1. Here the whole parse runs in its own thread: pdf.ts terminates the thread at the deadline
 * (Worker#terminate stops even a synchronous loop), caps its heap with resourceLimits and watches the process growth.
 *
 * Plain JavaScript on purpose: the file is loaded by Node directly, under tsx and under `next start` alike, so it needs
 * no TypeScript loader and no bundler. Its text read must produce exactly the items readPdfText (pdf.ts) produces, and
 * its structure step must answer what pdf.ts loadStructure + getPageCount answer; scripts/checks/guardrails.ts compares
 * them on every sample and fixture.
 *
 * Protocol: one message in, { bytes: Uint8Array, limits: { maxPages, maxItems, maxChars } }; one message out,
 * { ok: true, structure: { parsed, encrypted, libPages }, items, pageCount } (items and pageCount are null when the
 * structure already decides: not parseable, encrypted, a page count that is unreadable or out of range) or
 * { ok: false, error: { name, kind, pages } }. No error text crosses over: parser messages may quote file content, and
 * pdf.ts never shows them anyway.
 */
import { parentPort } from "node:worker_threads";
import { PDFDocument } from "pdf-lib";
import { getDocumentProxy } from "unpdf";

// pdf-lib prints a console.warn line for every object it cannot parse: a 1 MB file of broken objects printed 100,000
// lines (5 MB) into the server log (SEC-1). Nothing a parser of an untrusted file prints belongs in the log (plan 6.9).
for (const method of ["log", "info", "warn", "error", "debug", "trace"]) console[method] = () => undefined;

/** Same shape as pdf.ts PdfLimitError, sent back as { name: "PdfLimitError", kind, pages }. */
function limitError(kind, pages = null) {
  return Object.assign(new Error(`PDF limit exceeded: ${kind}`), { name: "PdfLimitError", kind, pages });
}

/**
 * Mirrors pdf.ts loadStructure + getPageCount: pdf-lib with ignoreEncryption (plain load() throws a generic Error on an
 * encrypted file), the encryption flag, then the page leaves. A file pdf-lib cannot parse is { parsed: false } (pdf.ts
 * then scans the bytes for "/Encrypt" itself); a page count that throws (a header-only file) is libPages null.
 */
async function readStructure(bytes) {
  let doc;
  try {
    doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  } catch {
    return { parsed: false, encrypted: false, libPages: null };
  }
  if (doc.isEncrypted) return { parsed: true, encrypted: true, libPages: null };
  let libPages = null;
  try {
    libPages = doc.getPageCount();
  } catch {
    libPages = null;
  }
  return { parsed: true, encrypted: false, libPages: typeof libPages === "number" && Number.isFinite(libPages) ? libPages : null };
}

/** Mirrors readPdfText in pdf.ts (minus the cooperative deadline: the parent terminates this thread instead). */
async function readText(bytes, limits) {
  const pdf = await getDocumentProxy(new Uint8Array(bytes), { verbosity: 0 });
  let failed = true;
  try {
    if (pdf.numPages > limits.maxPages) throw limitError("pages", pdf.numPages);
    const out = [];
    let chars = 0;
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const unit = page.userUnit || 1;
      const reader = page.streamTextContent().getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          for (const it of value.items) {
            if (typeof it.str !== "string" || !Array.isArray(it.transform)) continue; // TextMarkedContent
            const [, , c, d, x, y] = it.transform;
            const str = it.str + (it.hasEOL ? "\n" : "");
            out.push({ str, height: Math.hypot(c, d) * unit, x, y, page: p });
            chars += str.length;
          }
          if (out.length > limits.maxItems || chars > limits.maxChars) throw limitError("size");
        }
      } finally {
        // pdf.js drops a cancel without an Error reason (see pdf.ts)
        void reader.cancel(new Error("text extraction stopped")).catch(() => undefined);
      }
    }
    failed = false;
    return { items: out, pageCount: pdf.numPages };
  } finally {
    const destroyed = pdf.destroy().catch(() => undefined);
    if (!failed) await destroyed;
  }
}

parentPort?.on("message", async (job) => {
  try {
    const structure = await readStructure(job.bytes);
    const pages = structure.libPages;
    if (!structure.parsed || structure.encrypted || pages === null || pages < 1 || pages > job.limits.maxPages) {
      parentPort?.postMessage({ ok: true, structure, items: null, pageCount: null });
      return;
    }
    const { items, pageCount } = await readText(job.bytes, job.limits);
    parentPort?.postMessage({ ok: true, structure, items, pageCount });
  } catch (e) {
    const err = e !== null && typeof e === "object" ? e : {};
    parentPort?.postMessage({
      ok: false,
      error: {
        name: typeof err.name === "string" ? err.name : "Error",
        kind: typeof err.kind === "string" ? err.kind : null,
        pages: typeof err.pages === "number" ? err.pages : null,
      },
    });
  }
});
