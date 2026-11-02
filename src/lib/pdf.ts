/**
 * PDF file handling: upload validation (stage 1), hashing, display names, the pdf.js text layer and
 * encryption detection. Server-only.
 *
 * OWNER: Phase 4 (guardrails + pdf). Already implemented by the contracts step because other phases
 * need them now (tested in docs/notes-unpdf.md): sha256, sanitizeDisplayName, hasPdfMagic,
 * getTextItems, isEncryptedPdf, isPasswordError, isInvalidPdfError. Phase 4 implements validateUpload
 * and may refine internals, but must keep every exported signature (docs/CONTRACTS.md).
 */
import crypto from "node:crypto";
import { PDFDocument } from "pdf-lib";
import { getDocumentProxy } from "unpdf";
import { CONFIG } from "./config";
import type { TextItem, UploadValidation } from "./types";

export type { TextItem, UploadValidation };

function notImplemented(what: string, ...args: unknown[]): never {
  void args;
  throw new Error(`NOT_IMPLEMENTED: ${what}`);
}

/** Lowercase hex sha256 of the bytes (runs.file_hash, uploads/<hash>.pdf). */
export function sha256(buf: Uint8Array): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/**
 * Display-only file name (plan section 6.1): NFKC, characters outside [A-Za-z0-9_.- ] removed, spaces
 * collapsed, at most 100 characters; "upload.pdf" if nothing is left. Never use it as a path.
 */
export function sanitizeDisplayName(name: string | null | undefined): string {
  const cleaned = (name ?? "")
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

/**
 * Every text item pdf.js finds, page by page, in content order (docs/notes-unpdf.md, tested helper).
 * Passes pdf.js a private copy: it rejects Node Buffers and detaches the array it is given, so the
 * caller's bytes stay intact. Throws pdf.js errors: name "PasswordException" (encrypted with a user
 * password) or "InvalidPDFException" (empty, not a PDF, damaged or truncated).
 */
export async function getTextItems(buf: Uint8Array): Promise<TextItem[]> {
  const pdf = await getDocumentProxy(new Uint8Array(buf), { verbosity: 0 });
  try {
    const out: TextItem[] = [];
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const unit = page.userUnit || 1;
      const { items } = await page.getTextContent();
      for (const it of items) {
        if (!("str" in it)) continue; // TextMarkedContent only appears with includeMarkedContent
        const [, , c, d, x, y] = it.transform as number[];
        out.push({ str: it.str + (it.hasEOL ? "\n" : ""), height: Math.hypot(c, d) * unit, x, y, page: p });
      }
    }
    return out;
  } finally {
    await pdf.destroy();
  }
}

/**
 * True if the file has an encryption dictionary, including owner-password-only PDFs that open
 * without a password (flagged on purpose: conservative). Falls back to a raw "/Encrypt" byte scan only
 * when pdf-lib cannot parse the file at all.
 */
export async function isEncryptedPdf(buf: Uint8Array): Promise<boolean> {
  try {
    // Plain load() throws a generic Error on encrypted files (instanceof EncryptedPDFError is false in
    // pdf-lib 1.17.1), so load with ignoreEncryption and read the flag instead.
    const doc = await PDFDocument.load(buf, { ignoreEncryption: true, updateMetadata: false });
    return doc.isEncrypted;
  } catch {
    return Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength).includes("/Encrypt");
  }
}

/** pdf.js errors are Error instances; match on name, not class. */
export const isPasswordError = (e: unknown): boolean => e instanceof Error && e.name === "PasswordException";
export const isInvalidPdfError = (e: unknown): boolean => e instanceof Error && e.name === "InvalidPDFException";

export interface UploadLimits {
  maxBytes: number;
  maxPages: number;
}

/**
 * Stage 1 file validation (plan section 6.1 + docs/notes-unpdf.md "Suggested ingest order"). Never throws.
 * Order: empty -> "%PDF-" magic -> size -> isEncryptedPdf (HOLD) -> pdf-lib page count in try/catch
 * (> maxPages REJECT) -> getTextItems once (PasswordException -> HOLD, InvalidPDFException -> REJECT).
 * Reasons (exact): "Empty file" | "Not a PDF" | "File is larger than 10 MB" |
 * "PDF has N pages; the limit is 5" | "Password-protected PDF, request an unlocked copy" |
 * "PDF is damaged or unreadable". On success the text items are returned for stages 2 and 4.
 *
 * OWNER: Phase 4.
 */
export async function validateUpload(buf: Uint8Array, limits?: Partial<UploadLimits>): Promise<UploadValidation> {
  return notImplemented("pdf.validateUpload", buf, limits);
}
