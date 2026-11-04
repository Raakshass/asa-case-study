/**
 * Small pure helpers shared by server modules and client components (no Node APIs).
 * Owner: contracts step (docs/CONTRACTS.md). Every module that normalizes identifiers or prints money
 * uses these, so dedup keys and reason texts match across modules.
 */

/**
 * Canonical identifier form: NFKC, uppercase, every non-alphanumeric removed.
 * "INV-0042" -> "INV0042", "po 1003" -> "PO1003". Used for invoice_number_norm (stored in invoices),
 * PO references, bank accounts and the grounding check. normalize.ts MUST use this function.
 */
export function normId(value: string): string {
  return value.normalize("NFKC").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** Rounds to cents (avoids float noise in balances: 0.1 + 0.2). */
export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

/** "$3,000.00", "-$50.00". Use for every amount in reasons, evidence and the UI. */
export function formatUsd(n: number): string {
  return USD.format(n);
}

/** "1.4%" from 0.0137 (one decimal). */
export function formatPct(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

/** Masks all but the last 4 characters: "ACC-11-2233" -> "••••2233". A value of 6 or fewer characters is fully masked. null stays null. */
export function maskAccount(value: string | null): string | null {
  if (value === null) return null;
  return value.length <= 6 ? "••••" : `••••${value.slice(-4)}`; // a short value would be shown nearly whole (review round B12)
}

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True for a real calendar date in YYYY-MM-DD form. */
export function isIsoDate(value: string): boolean {
  const m = ISO_DATE_RE.exec(value);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === value;
}

function isoToUtcMs(iso: string): number {
  if (!isIsoDate(iso)) throw new Error(`Not an ISO date: ${JSON.stringify(iso)}`);
  return Date.parse(`${iso}T00:00:00.000Z`);
}

/** "2026-10-05" + 30 -> "2026-11-04" (UTC, no time-zone drift). Throws on a non-ISO date. */
export function addDaysIso(iso: string, days: number): string {
  return new Date(isoToUtcMs(iso) + days * 86_400_000).toISOString().slice(0, 10);
}

/** Whole days from a to b (b - a), both YYYY-MM-DD. Throws on a non-ISO date. */
export function daysBetweenIso(a: string, b: string): number {
  return Math.round((isoToUtcMs(b) - isoToUtcMs(a)) / 86_400_000);
}

/** UTC calendar date of a Date: 2026-11-02T23:00:00Z -> "2026-11-02". */
export function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Confidence chip thresholds (plan section 9). CONFIDENCE_TONE.medium must equal CONFIG.minFieldConfidence. */
export const CONFIDENCE_TONE = { high: 0.9, medium: 0.75 } as const;

/** green >= 0.9, amber 0.75-0.9, red < 0.75 */
export function confidenceTone(c: number): "high" | "medium" | "low" {
  if (c >= CONFIDENCE_TONE.high) return "high";
  if (c >= CONFIDENCE_TONE.medium) return "medium";
  return "low";
}
