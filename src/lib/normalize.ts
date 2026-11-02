/**
 * Stage 5 normalization (IMPLEMENTATION_PLAN.md section 7): dates to ISO, invoice number to its
 * canonical form, vendor resolution against the master. Pure functions (no fs/db/network/clock).
 *
 * OWNER: Phase 3. normalizeInvoiceNumber is final (it must equal format.ts normId, which the seed uses
 * for history rows); the rest are stubs. Keep every exported signature (docs/CONTRACTS.md).
 */
import { normId } from "./format";
import type { InvoiceExtraction, NormalizedInvoice, Vendor } from "./types";

function notImplemented(what: string, ...args: unknown[]): never {
  void args;
  throw new Error(`NOT_IMPLEMENTED: ${what}`);
}

/** Legal suffixes stripped from vendor names before matching (plan section 7, stage 5). */
export const VENDOR_SUFFIXES = ["inc", "llc", "ltd", "co", "corp", "pty"] as const;

/** "INV-0042" -> "INV0042"; null or no alphanumerics -> null. Equal to normId so history rows match. */
export function normalizeInvoiceNumber(value: string | null): string | null {
  if (value === null) return null;
  const n = normId(value);
  return n === "" ? null : n;
}

/**
 * Printed date -> "YYYY-MM-DD", or null when missing or ambiguous/unparseable. Accepts ISO already, and
 * unambiguous forms such as "28 Oct 2026", "October 28, 2026", "2026/10/28". Never guesses dd/mm vs mm/dd.
 */
export function normalizeDate(value: string | null): string | null {
  return notImplemented("normalize.normalizeDate", value);
}

/** Lowercase, punctuation removed, whitespace collapsed, trailing VENDOR_SUFFIXES removed. */
export function normalizeVendorName(value: string | null): string | null {
  return notImplemented("normalize.normalizeVendorName", value);
}

/** Exact match of normalizeVendorName(name) against each vendor's normalized name and aliases; else null. */
export function resolveVendor(name: string | null, vendors: readonly Vendor[]): Vendor | null {
  return notImplemented("normalize.resolveVendor", name, vendors);
}

/** normId of the printed PO reference ("PO 1003" -> "PO1003"); null when absent or empty. */
export function normalizePoReference(value: string | null): string | null {
  return notImplemented("normalize.normalizePoReference", value);
}

/** Uppercase 3-letter ISO 4217 ("usd" -> "USD"; "$"/"US$" may map to "USD" in this USD-only demo); null when missing or unrecognised. */
export function normalizeCurrency(value: string | null): string | null {
  return notImplemented("normalize.normalizeCurrency", value);
}

/** All of the above for one extraction. */
export function normalizeInvoice(extraction: InvoiceExtraction, vendors: readonly Vendor[]): NormalizedInvoice {
  return notImplemented("normalize.normalizeInvoice", extraction, vendors);
}
