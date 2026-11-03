/**
 * Pure rules and message texts of the start page (owner: UI-PAGES): which files the upload zone accepts, how
 * a failed request is worded, how long to wait after a 429. No React and no browser-only API; checked by a tsx
 * script outside the repo. Every text is a short plain sentence meant to be shown as React text.
 *
 * Client-safe: from src/lib this file imports only types.ts (types).
 */
import { UPLOAD_BUSY_PREFIXES, type SeedCounts } from "@/lib/types";

/** The upload limit. Mirrors CONFIG.maxFileBytes (10 MB); config.ts is server-only, so the number is repeated here. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const MAX_UPLOAD_LABEL = "10 MB";

/** The `accept` of the file input: the PDF media type and the extension (some systems report no type). */
export const ACCEPT_PDF = "application/pdf,.pdf";

/** "812 B", "3.4 KB", "412 KB", "9.7 MB". */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "unknown size";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) {
    const kb = bytes / 1024;
    return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Control characters and the bidirectional overrides that could make a file name read differently than it is.
const UNSAFE_NAME_CHARS = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;

/** A file name made fit to quote in a message: no control or direction characters, one line, at most `max` characters. */
export function clipName(name: string, max = 60): string {
  const clean = name.replace(UNSAFE_NAME_CHARS, "").replace(/\s+/g, " ").trim();
  if (clean === "") return "This file";
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/** The size of a file that is over the limit, in words that differ from the limit even when it is just over. */
function overLimitSize(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb < 10.05 ? `just over ${MAX_UPLOAD_LABEL}` : `${mb.toFixed(1)} MB`;
}

/**
 * Checks a chosen or dropped file before anything is sent: it must look like a PDF (a .pdf name or the PDF media
 * type) and be within the size limit. Returns the message to show, or null when the file may be uploaded.
 *
 * It deliberately does NOT look inside the file: a text file renamed to .pdf goes through, because the server's
 * ingest stage is what rejects it ("Not a PDF"), and that rejection is part of what the run view shows.
 */
export function validateInvoiceFile(file: { name: string; type: string; size: number }): string | null {
  const label = clipName(file.name);
  const looksLikePdf = /\.pdf$/i.test(file.name.trim()) || file.type.toLowerCase() === "application/pdf";
  if (!looksLikePdf) return `"${label}" is not a PDF. Choose a file that ends in .pdf.`;
  if (file.size > MAX_UPLOAD_BYTES) {
    return `"${label}" is too large (${overLimitSize(file.size)}). The limit is ${MAX_UPLOAD_LABEL}.`;
  }
  return null;
}

/** What to do with the files of one choose or drop event: exactly one file is expected. */
export function pickSingleFile(files: readonly File[]): { file: File } | { problem: string } {
  if (files.length === 0) return { problem: "No file was received. Drop a PDF here or use the Choose a PDF button." };
  if (files.length > 1) return { problem: `${files.length} files were dropped. Add one PDF at a time.` };
  return { file: files[0] };
}

/** "a moment", "42 seconds", "3 minutes", "2 hours": a wait in words (the server's Retry-After, in seconds). */
export function describeWait(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) return "a moment";
  const s = Math.ceil(seconds);
  if (s < 120) return `${s} ${s === 1 ? "second" : "seconds"}`;
  const m = Math.ceil(s / 60);
  if (m < 120) return `${m} minutes`;
  const h = Math.ceil(m / 60);
  return `${h} hours`;
}

/** The shape of a failed ApiResult (shared/api.ts) that these messages read. */
export interface Failure {
  status: number;
  error: string;
  retryAfterSec?: number;
  /** the browser stopped waiting (its own timeout): the server may still be working on the request */
  timedOut?: true;
}

/**
 * The message under the upload zone or the sample cards when POST /api/runs failed.
 * 429 names the wait (from retryAfterSec) or, for an upload-cap refusal, shows the server's own text; 413 names the limit, a network failure keeps api.ts's own wording,
 * and any other 4xx shows what the server said.
 */
export function startFailureMessage(failure: Failure): string {
  if (failure.status === 429) {
    // The upload-cap refusals say why (too many files at once); only the run rate limit is "too many runs" (review round B9).
    if (UPLOAD_BUSY_PREFIXES.some((p) => failure.error.startsWith(p))) return failure.error;
    return `Too many runs were started in a short time. Please wait ${describeWait(failure.retryAfterSec)} and try again.`;
  }
  if (failure.status === 413) return `That file is larger than ${MAX_UPLOAD_LABEL}. Choose a smaller PDF.`;
  if (failure.status >= 500) {
    return `The server had a problem and could not start the run (HTTP ${failure.status}). Try again in a moment.`;
  }
  return failure.error;
}

/**
 * How the reset form reads a failed POST /api/reset. A timeout of the browser's own is NOT a failure: the server
 * waits for the runs already queued and then wipes, and keeps going after the browser stops waiting (routes-ui
 * ROUTE-1: the form said "Reset failed" while the reset finished seconds later). Everything else is a failure with
 * resetFailureMessage's sentence.
 */
export function resetOutcomeOf(failure: Failure): { kind: "pending" | "failed"; message: string } {
  if (failure.timedOut === true) {
    return {
      kind: "pending",
      message:
        "The server is still finishing the runs that were already queued; the reset follows them and completes by itself. Wait a minute before starting new runs: the dashboard then lists only the 4 pre-loaded records.",
    };
  }
  return { kind: "failed", message: resetFailureMessage(failure) };
}

/** The message under the reset form when POST /api/reset failed. */
export function resetFailureMessage(failure: Failure): string {
  if (failure.status === 403) return "The reset was refused. The token is wrong, or reset is turned off on this server.";
  if (failure.status >= 500) {
    return `The server had a problem and could not reset the data (HTTP ${failure.status}). Try again in a moment.`;
  }
  return failure.error;
}

/** The rows of the "what the database holds now" list after a reset: [label, count]. */
export function describeCounts(counts: SeedCounts): [label: string, value: number][] {
  return [
    ["Vendors", counts.vendors],
    ["Purchase orders", counts.purchase_orders],
    ["Invoices", counts.invoices],
    ["Runs", counts.runs],
  ];
}
