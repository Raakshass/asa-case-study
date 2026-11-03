/**
 * Pure display logic of the procurement data page (owner: UI-PAGES): how much of a purchase order is used up,
 * how an overdrawn one is described, and a few text helpers. No React and no browser-only API; checked by a
 * tsx script outside the repo. Money is compared in whole cents so float noise ("-24.000000000000227") can
 * never decide between "fully used" and "over by".
 *
 * Client-safe: from src/lib this file imports only types.ts (types). Tone is a type-only import.
 */
import { displayText } from "@/components/dashboard/run-format";
import type { Tone } from "@/components/shared/tones";
import type { MasterPo, PoLine } from "@/lib/types";

/** The bar turns amber from this share of the PO total (the split-PO story: PO-1003 is at 80% after history). */
export const NEARLY_USED_FRACTION = 0.8;

/**
 * unused: nothing approved yet. partial: some used. nearly: 80% or more used. full: nothing left (exactly 0).
 * over: more was approved than the PO holds (an invoice inside the 2% tolerance can overdraw it by a few dollars).
 */
export type PoState = "unused" | "partial" | "nearly" | "full" | "over";

export interface PoUsage {
  state: PoState;
  /** Share of the PO total that is used, 0..1 (clamped; the bar's fill). */
  fraction: number;
  /** Whole percent for the text, 0..100. 0 only when nothing is used, 100 only when nothing is left (29,999 of 30,000 says 99). */
  percent: number;
  /** Dollars over the PO total: greater than 0 only when `state` is "over", else 0. */
  overBy: number;
  /** Bar colour: info (accent) normally, hold (amber) when nearly used, reject (red) when full or over. */
  tone: Tone;
}

const toCents = (dollars: number): number => (Number.isFinite(dollars) ? Math.round(dollars * 100) : 0);

/** Usage of one PO from the figures of GET /api/master. */
export function poUsage(po: Pick<MasterPo, "subtotal" | "invoiced" | "remaining">): PoUsage {
  const subtotal = toCents(po.subtotal);
  const invoiced = Math.max(0, toCents(po.invoiced));
  const remaining = toCents(po.remaining);

  if (remaining < 0) return { state: "over", fraction: 1, percent: 100, overBy: -remaining / 100, tone: "reject" };
  if (invoiced === 0) return { state: "unused", fraction: 0, percent: 0, overBy: 0, tone: "info" };
  if (remaining === 0) return { state: "full", fraction: 1, percent: 100, overBy: 0, tone: "reject" };

  const fraction = subtotal > 0 ? Math.min(1, invoiced / subtotal) : 1;
  const percent = Math.max(1, Math.min(99, Math.round(fraction * 100))); // something is used: never 0%, and 100% only when nothing is left
  const nearly = fraction >= NEARLY_USED_FRACTION;
  return { state: nearly ? "nearly" : "partial", fraction, percent, overBy: 0, tone: nearly ? "hold" : "info" };
}

/**
 * The approving invoice numbers for the "Invoiced so far" cell: "none approved yet", "GLX-301, GLX-302", or the
 * first `max` followed by "and N more" (the list is not capped by the API). The numbers come from invoices, so
 * the result is shown as plain text only.
 */
export function summarizeInvoices(numbers: readonly string[], max = 3): string {
  const clean = numbers.map((n) => displayText(n, 60)).filter((n) => n !== "");
  if (clean.length === 0) return "none approved yet";
  if (clean.length <= max) return clean.join(", ");
  return `${clean.slice(0, max).join(", ")} and ${clean.length - max} more`;
}

/** The PO's line descriptions on one line: "Printer paper box; Toner cartridge". */
export function describeLines(lines: readonly Pick<PoLine, "description">[]): string {
  const parts = lines.map((line) => line.description.trim()).filter((text) => text !== "");
  return parts.length > 0 ? parts.join("; ") : "No lines";
}

/**
 * The last characters of a masked account ("••••2233" gives "2233"), so a screen reader can say "ending in 2233"
 * instead of reading four bullets. null when the text is not in the masked form.
 */
export function accountTail(masked: string | null): string | null {
  if (masked === null) return null;
  const match = /^•+(.+)$/.exec(masked);
  return match ? match[1] : null;
}

/** "5 vendors", "1 purchase order". */
export function countLabel(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}
