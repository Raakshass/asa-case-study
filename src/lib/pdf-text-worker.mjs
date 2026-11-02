/**
 * Worker thread for pdf.ts: reads the pdf.js text layer of ONE untrusted upload away from the main event loop.
 *
 * Why a worker: pdf.js interprets a page's content stream in one synchronous run that the main thread cannot
 * interrupt. A small file of non-text operators (a Flate-compressed "q Q" flood) kept the event loop blocked for
 * tens of seconds and grew the process to ~1 GB, so the 10 s upload deadline and every HTTP request waited for
 * it. Here the parse runs in its own thread: pdf.ts terminates the thread at the deadline (Worker#terminate
 * stops even a synchronous loop) and caps its heap with resourceLimits.
 *
 * Plain JavaScript on purpose: the file is loaded by Node directly, under tsx and under `next start` alike, so
 * it needs no TypeScript loader and no bundler. It must produce exactly the items readPdfText (pdf.ts) produces;
 * scripts/checks/guardrails.ts compares the two on every sample.
 *
 * Protocol: one message in, { bytes: Uint8Array, limits: { maxPages, maxItems, maxChars } }; one message out,
 * { ok: true, items, pageCount } or { ok: false, error: { name, kind, pages } }. No error text crosses over:
 * pdf.js messages may quote file content, and pdf.ts never shows them anyway.
 */
import { parentPort } from "node:worker_threads";
import { getDocumentProxy } from "unpdf";

/** Same shape as pdf.ts PdfLimitError, sent back as { name: "PdfLimitError", kind, pages }. */
function limitError(kind, pages = null) {
  return Object.assign(new Error(`PDF limit exceeded: ${kind}`), { name: "PdfLimitError", kind, pages });
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
    const { items, pageCount } = await readText(job.bytes, job.limits);
    parentPort?.postMessage({ ok: true, items, pageCount });
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
