/**
 * Maps a truth file's _meta.layout to its template and wraps the result as a full HTML document.
 * "pdf" = normal Chromium PDF; "scan" = the rotated, greyscale, noisy look screenshotted for the image-only PDF.
 */
import { renderCompact } from "./compact";
import { type DocInput, type TemplateParts, pdfDocument, scanDocument } from "./common";
import { renderItemised } from "./itemised";
import { renderServices } from "./services";
import { renderStatement } from "./statement";

export type { DocInput } from "./common";
export type RenderMode = "pdf" | "scan";

const LAYOUTS: Record<DocInput["meta"]["layout"], (doc: DocInput) => TemplateParts> = {
  itemised: renderItemised,
  services: renderServices,
  compact: renderCompact,
  statement: renderStatement,
};

/** Template output for a document (title, css, body). */
export function renderParts(doc: DocInput): TemplateParts {
  return LAYOUTS[doc.meta.layout](doc);
}

/** The complete HTML document for a sample in the given mode. */
export function renderHtml(doc: DocInput, mode: RenderMode): string {
  const parts = renderParts(doc);
  return mode === "scan" ? scanDocument(parts) : pdfDocument(parts);
}
