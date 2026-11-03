/**
 * How the decision card lists the reasons of a run that holds or rejects (owner: UI-RUN; fix round routes-ui UI-5 and
 * UI-6). Pure: plain values in, plain strings out, rendered as React text only.
 *
 * Display only. decision_reasons, the steps and next_action are never changed: they are the audit trail, and the stage
 * rows and the raw data show them verbatim. The rules are conservative in one direction: a reason that cannot be matched
 * to a stage stays a cause, and a cause is never dropped or listed as a note.
 *
 * Client-safe: from src/lib this file imports only types.ts.
 */
import type { RunDetail, StepView } from "@/lib/types";
import { displayText } from "./run-format";

/** A reason is shown up to this many characters (as the card always did). */
const REASON_CHARS = 1200;

/** Closes the merged security entry: the banner above the reasons holds the quote. */
export const SECURITY_QUOTE_NOTE = "The flagged text is quoted in the security banner above.";

export interface ReasonGroups {
  /** What decided the run, display-ready: listed under "Why it is on hold" / "Why it was rejected". */
  causes: string[];
  /** Notes that did not decide it, display-ready: listed under "Also noted". */
  notes: string[];
}

/** A stage whose reason is only a note: a warning with severity info (or none), or a stage that passed or was skipped. */
function isNoteStep(step: Pick<StepView, "status" | "severity">): boolean {
  if (step.status === "warn") return step.severity === "info" || step.severity === null;
  return step.status === "pass" || step.status === "skipped";
}

/* ------------------------------------------------------------------------------------------------ quotes (UI-6) */

const QUOTE_MARKS = new Set(["'", '"', "‘", "’", "“", "”"]);
const CLOSING_MARK: Readonly<Record<string, string>> = { "'": "'", '"': '"', "‘": "’", "“": "”" };
/** A reason with more quote marks than this is left as it is (every pairing is tried, so the work stays small). */
const MAX_QUOTE_MARKS = 24;
/** A quote must have at least this many letters and digits before it counts as one the banner already shows. */
const MIN_QUOTE_CHARS = 12;
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
/** An opening quote mark: one that does not follow a letter or digit (an apostrophe in "model's" does). */
const OPENING_QUOTE = /(?:^|[^\p{L}\p{N}])['"‘“]/u;

const isWordChar = (ch: string | undefined): boolean => ch !== undefined && LETTER_OR_DIGIT.test(ch);

/**
 * Letters and digits only, NFKC, lower case. A reason quotes a detector's text cut to a length (with an ellipsis) and
 * starting where its rule chose; the banner shows the detectors' own strings. Compared this way, the reason's quote is
 * a plain substring of the string it was cut from, whatever its punctuation, spacing or invisible characters.
 */
function loose(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

/**
 * `text` (a reason, display-ready) with every quote the banner already shows removed, or null when it has none or
 * when any quote in it is not shown in the banner (then the reason stays exactly as it is). A quote opens with a mark
 * that does not follow a letter or digit and closes with its matching mark that is not followed by one; of the
 * possible closing marks the farthest one whose passage the banner shows wins, so an apostrophe inside the quote does
 * not cut it short. The words that introduced or listed the quotes are tidied: "found: 'x' (+1 more)." becomes
 * "found.", and `(3): "a"; "b"; and 1 more.` becomes "(3).". The count of further quotes goes with the quote it
 * counts from: with the first one shown in the banner, "(+1 more)" would point at nothing in the sentence.
 */
function withoutBannerQuotes(text: string, banner: readonly string[]): string | null {
  const inBanner = (inner: string): boolean => {
    const q = loose(inner);
    return q.length >= MIN_QUOTE_CHARS && banner.some((b) => b.includes(q));
  };
  const marks: number[] = [];
  for (let i = 0; i < text.length; i++) if (QUOTE_MARKS.has(text[i])) marks.push(i);
  if (marks.length === 0 || marks.length > MAX_QUOTE_MARKS) return null;
  const ranges: Array<[number, number]> = [];
  let from = 0;
  for (const open of marks) {
    const close = CLOSING_MARK[text[open]];
    if (open < from || close === undefined || isWordChar(text[open - 1])) continue;
    for (let k = marks.length - 1; k >= 0 && marks[k] > open; k--) {
      const end = marks[k];
      if (text[end] === close && !isWordChar(text[end + 1]) && inBanner(text.slice(open + 1, end))) {
        ranges.push([open, end + 1]);
        from = end + 1;
        break;
      }
    }
  }
  if (ranges.length === 0) return null;
  const parts: string[] = [];
  let at = 0;
  for (const [start, end] of ranges) {
    parts.push(text.slice(at, start));
    at = end;
  }
  parts.push(text.slice(at));
  // a quote that is still there (an opening mark that does not follow a letter or digit) is not in the banner: keep all
  if (parts.some((part) => OPENING_QUOTE.test(part))) return null;
  let out = "";
  for (let i = 0; i < parts.length; i++) {
    let part = parts[i];
    const last = i === parts.length - 1;
    if (i > 0) {
      if (!last && /^\s*[;,]\s*$/.test(part)) continue; // the separator between two removed quotes
      part = part.replace(/^\s*[;,]\s*and \d+ more\b/, ""); // the rest of a list of quotes
      part = part.replace(/^\s*\(\+\d+ more\)/, ""); // the count of further quotes, which counted from the removed one
      if (/^\s*[.,;:)]/.test(part)) part = part.trimStart();
    }
    if (!last) part = part.replace(/\s*:\s*$/, ""); // the colon that introduced the removed quote
    out += part;
  }
  return out
    .replace(/\(\s*\)/g, "")
    .replace(/\s+([.,;:)])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Display-ready reasons, in order, with the security reasons that quote what the banner shows folded into ONE entry:
 * each one's own statement without the quote, then SECURITY_QUOTE_NOTE, at the place of the first of them.
 */
function present(reasons: readonly string[], security: ReadonlySet<string>, banner: readonly string[]): string[] {
  const out: string[] = [];
  const statements: string[] = [];
  let merged = -1;
  for (const reason of reasons) {
    const text = displayText(reason, REASON_CHARS);
    if (text === "") continue;
    const folded = security.has(reason) && banner.length > 0 ? withoutBannerQuotes(text, banner) : null;
    if (folded === null) {
      out.push(text);
      continue;
    }
    if (merged === -1) {
      merged = out.length;
      out.push("");
    }
    if (folded !== "") statements.push(folded);
  }
  if (merged !== -1) out[merged] = [...statements, SECURITY_QUOTE_NOTE].join(" ");
  return out;
}

/**
 * The reasons of a finished run that holds or rejects, split for the decision card (fix round routes-ui UI-5, UI-6):
 *
 * - a reason is a note only when it equals the reason of a stage that is a note (a warning with severity info, or a
 *   passed or skipped stage) and of no other stage; anything else, including a reason that matches no stage (the
 *   security hold, "<stage> needs manual review"), is a cause. If nothing would be left as a cause, every reason is one.
 * - on a security-flagged run, the reasons of the screen and extract stages whose quotes the banner already shows
 *   (`bannerQuotes`: the strings the banner's quotes were merged from) become one entry without those quotes.
 */
export function groupReasons(
  run: Pick<RunDetail, "decision_reasons" | "steps" | "security_flag">,
  bannerQuotes: readonly string[],
): ReasonGroups {
  const noteReasons = new Set<string>();
  const causeReasons = new Set<string>();
  const security = new Set<string>();
  for (const step of run.steps) {
    if (step.key === "decide" || typeof step.reason !== "string") continue;
    (isNoteStep(step) ? noteReasons : causeReasons).add(step.reason);
    if (run.security_flag && (step.key === "screen" || step.key === "extract")) security.add(step.reason);
  }
  const causes: string[] = [];
  const notes: string[] = [];
  for (const reason of run.decision_reasons) {
    if (typeof reason !== "string") continue;
    (noteReasons.has(reason) && !causeReasons.has(reason) ? notes : causes).push(reason);
  }
  const banner = bannerQuotes.map(loose).filter((b) => b !== "");
  if (causes.length === 0) return { causes: present(notes, security, banner), notes: [] };
  return { causes: present(causes, security, banner), notes: present(notes, security, banner) };
}
