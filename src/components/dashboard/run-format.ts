/**
 * Pure display helpers of the dashboard (owner: UI-PAGES). No React and no browser-only API: every function
 * takes plain values and returns a short plain string (or a small object of them), never markup, so untrusted
 * run text can only ever reach the page as React text. Checked by a tsx script outside the repo.
 *
 * Client-safe: from src/lib this file imports only format.ts and types.ts.
 */
import { formatUsd } from "@/lib/format";
import type { DashboardKpis, Decision, RunListItem } from "@/lib/types";

/* ------------------------------------------------------------------------------------------------ untrusted text */

// Control characters, zero-width and soft-hyphen characters and the bidirectional marks, embeddings, overrides and
// isolates: invisible or direction-changing, so they can make two different strings look alike or reorder the
// text around them. Tab, line feed and carriage return are not in the class (they become a space below).
const HIDDEN_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g;

/**
 * Text that comes from an invoice (vendor name, invoice number, a reason that quotes the document, a file name),
 * made fit for a table cell and its title attribute: invisible and direction-changing characters removed, white
 * space collapsed to single spaces, at most `max` characters. It is still only ever rendered as React text; this
 * just keeps a hostile string from reordering or disguising what is around it.
 */
export function displayText(text: string | null | undefined, max = 600): string {
  const clean = (text ?? "").replace(HIDDEN_CHARS, "").replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/* ------------------------------------------------------------------------------------------------ filters */

/** The dashboard filter: every run, one decision, or every security-flagged run (the `decision=` query values). */
export type DashboardFilter = "all" | Decision | "security";

/** The number each filter chip shows. The KPIs always count ALL runs, whatever filter is active. */
export function filterCount(filter: DashboardFilter, kpis: DashboardKpis): number {
  switch (filter) {
    case "all":
      return kpis.total;
    case "APPROVE":
      return kpis.approved;
    case "HOLD":
      return kpis.hold;
    case "REJECT":
      return kpis.rejected;
    case "security":
      return kpis.security_flags;
  }
}

/** Adjective for sentences such as "No held runs yet" and the screen-reader summary. */
export function filterNoun(filter: DashboardFilter): string {
  switch (filter) {
    case "all":
      return "all";
    case "APPROVE":
      return "approved";
    case "HOLD":
      return "held";
    case "REJECT":
      return "rejected";
    case "security":
      return "security-flagged";
  }
}

/** "57% of runs" for a KPI hint, or null when there are no runs (nothing sensible to say). */
export function shareOf(count: number, total: number): string | null {
  if (!Number.isFinite(count) || !Number.isFinite(total) || total <= 0) return null;
  return `${Math.round((count / total) * 100)}% of runs`;
}

/* ------------------------------------------------------------------------------------------------ time */

export interface WhenOptions {
  /** Date only: used for pre-loaded history runs, whose time of day is a placeholder (noon UTC). */
  dateOnly?: boolean;
  /** "Now" in milliseconds since the epoch, used to decide whether the year is shown. Default: the clock. */
  now?: number;
  /** BCP 47 locale. Default: the browser's. */
  locale?: string;
  /** IANA time zone. Default: the browser's. */
  timeZone?: string;
}

export interface WhenView {
  /** Short form for the table cell: "Nov 3, 11:42 AM" (the year is added for another year). */
  text: string;
  /** Full form for the title attribute: "Nov 3, 2026, 11:42:07 AM". */
  full: string;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** Intl formatters are slow to build and a table asks for the same one on every row: build each kind once. */
function formatter(locale: string | undefined, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale ?? ""}|${JSON.stringify(options)}`;
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, options);
    formatters.set(key, f);
  }
  return f;
}

/** A run's creation time as short text, or null when the timestamp cannot be read. */
export function formatWhen(iso: string, options: WhenOptions = {}): WhenView | null {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const zone = options.timeZone ? { timeZone: options.timeZone } : {};
  const yearOf = (d: Date) => formatter("en-US", { year: "numeric", ...zone }).format(d);
  const sameYear = yearOf(new Date(ms)) === yearOf(new Date(options.now ?? Date.now()));
  const text = formatter(options.locale, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" as const }),
    ...(options.dateOnly ? {} : { hour: "numeric" as const, minute: "2-digit" as const }),
    ...zone,
  }).format(new Date(ms));
  const full = formatter(options.locale, { dateStyle: "medium", timeStyle: "medium", ...zone }).format(new Date(ms));
  return { text, full };
}

/* ------------------------------------------------------------------------------------------------ money */

/**
 * The LLM cost of a run. A call costs a fraction of a cent, so below one cent four decimals are shown
 * ("$0.0042"); from one cent up the usual two ("$0.02"). No cost recorded (history runs) is a dash.
 */
export function formatCost(usd: number | null): string {
  if (usd === null || !Number.isFinite(usd)) return "–";
  if (usd <= 0) return formatUsd(0);
  if (usd < 0.0001) return "<$0.0001";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return formatUsd(usd);
}

/** How the Amount cell shows a total: a USD figure, an amount in another currency (text), or nothing. */
export type AmountView =
  | { kind: "none" }
  | { kind: "usd"; value: number }
  | { kind: "foreign"; text: string };

/**
 * USD amounts (or a missing currency, which the pipeline reads as USD) are shown with formatUsd. Any other
 * currency is shown with its own code so a euro invoice never looks like dollars; a currency that is not a
 * three-letter code ("¥", "dollars": the text comes from the invoice) is shown without a sign and flagged.
 */
export function amountView(total: number | null, currency: string | null): AmountView {
  if (total === null || !Number.isFinite(total)) return { kind: "none" };
  const code = (currency ?? "").trim().toUpperCase();
  if (code === "" || code === "USD") return { kind: "usd", value: total };
  if (/^[A-Z]{3}$/.test(code)) {
    try {
      return { kind: "foreign", text: new Intl.NumberFormat("en-US", { style: "currency", currency: code }).format(total) };
    } catch {
      return { kind: "foreign", text: `${total.toFixed(2)} ${code}` };
    }
  }
  return { kind: "foreign", text: `${total.toFixed(2)} (currency unclear)` };
}

/* ------------------------------------------------------------------------------------------------ reason */

export interface ReasonView {
  text: string;
  /** true for the placeholders below (drawn in the muted colour), false for a real reason from the pipeline */
  placeholder: boolean;
}

/**
 * The "Top reason" cell. A decided run shows decision_reasons[0]; an APPROVE with no reasons says all checks
 * passed (the pipeline records no reason for a clean approval); a run still working, or one that stopped
 * without a decision, says so instead of leaving the cell empty.
 */
export function reasonView(run: Pick<RunListItem, "first_reason" | "status" | "decision">): ReasonView {
  const reason = displayText(run.first_reason);
  if (reason) return { text: reason, placeholder: false };
  switch (run.status) {
    case "queued":
      return { text: "Waiting to start", placeholder: true };
    case "running":
      return { text: "Processing", placeholder: true };
    case "error":
      return { text: "The run stopped before it reached a decision", placeholder: true };
    case "done":
      return run.decision === "APPROVE"
        ? { text: "All checks passed", placeholder: true }
        : { text: "No reason recorded", placeholder: true };
  }
}

/** The text of the File link: the (already sanitised) file name, or a stand-in for a pre-loaded history run. */
export function fileLabel(run: Pick<RunListItem, "file_name" | "is_history">): string {
  const name = displayText(run.file_name, 120);
  if (name) return name;
  return run.is_history ? "Pre-loaded record" : "Unnamed file";
}
