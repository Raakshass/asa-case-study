"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import type { MouseEvent } from "react";
import { cn } from "cn";
import { DecisionBadge } from "@/components/shared/decision-badge";
import { Ident } from "@/components/shared/ident";
import { Money } from "@/components/shared/money";
import { SecurityBadge } from "@/components/shared/security-badge";
import { TableFrame } from "@/components/shared/table-frame";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { RunListItem } from "@/lib/types";
import { amountView, displayText, fileLabel, formatCost, formatWhen, reasonView } from "./run-format";

/** Capitalises the first letter (a reason that lost its lead-in prefix). */
function sentence(text: string): string {
  return text === "" ? text : text.charAt(0).toUpperCase() + text.slice(1);
}

/** "–" for a value the run does not have (yet), with a screen-reader word so the cell is never silent. */
function Placeholder({ label }: { label: string }) {
  return (
    <span className="text-muted-foreground">
      <span aria-hidden="true">–</span>
      <span className="sr-only">{label}</span>
    </span>
  );
}

function AmountCell({ run }: { run: RunListItem }) {
  const view = amountView(run.total, run.currency);
  if (view.kind === "none") return <Placeholder label="No amount" />;
  if (view.kind === "usd") return <Money value={view.value} />;
  return <span className="whitespace-nowrap tabular-nums">{view.text}</span>;
}

/**
 * One run. The real anchor in the File cell is the keyboard (and screen-reader) way in; a click anywhere else on
 * the row follows it too, unless it lands on something interactive or the visitor is selecting text. While a
 * link inside the row has focus the Top reason is shown in full (the table keeps it to one line otherwise; the
 * full text is also the cell's title for the mouse).
 */
function RunRow({ run }: { run: RunListItem }) {
  const router = useRouter();
  const href = `/runs/${encodeURIComponent(run.id)}`;
  const when = formatWhen(run.created_at, { dateOnly: run.is_history });
  const reasonRaw = reasonView(run);
  // A pre-loaded record's reason arrives as "Pre-loaded history: processed before the demo.": the line under the vendor already says it.
  const reason = run.is_history ? { ...reasonRaw, text: sentence(reasonRaw.text.replace(/^pre-loaded history:\s*/i, "")) } : reasonRaw;
  const file = fileLabel(run);
  const vendor = displayText(run.vendor_name, 200);
  // Under the vendor: what kind of record it is (history), else the file it came from.
  const sub = run.is_history ? "Pre-loaded history" : vendor ? file : "";
  const invoiceNumber = displayText(run.invoice_number, 200);

  function followRow(event: MouseEvent<HTMLTableRowElement>) {
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.target instanceof Element && event.target.closest("a, button, input, select, textarea, summary")) return;
    if (window.getSelection()?.toString()) return; // the visitor is selecting text, not opening the run
    if (event.metaKey || event.ctrlKey || event.shiftKey) {
      window.open(href, "_blank", "noopener");
      return;
    }
    router.push(href);
  }

  return (
    <TableRow data-run-id={run.id} className="group cursor-pointer focus-within:bg-accent/40" onClick={followRow}>
      <TableCell className="px-3 py-3 whitespace-nowrap text-muted-foreground">
        {when ? (
          <time dateTime={run.created_at} title={when.full}>
            {when.text}
          </time>
        ) : (
          <Placeholder label="Unknown time" />
        )}
      </TableCell>
      <TableCell className="px-3 py-3">
        <div className="flex flex-col gap-0.5">
          {/* The one link of the row: the keyboard and screen-reader way in. A run with no vendor read is named by its file. */}
          <Link
            href={href}
            prefetch={false}
            title={vendor || file}
            className="block max-w-[14rem] truncate rounded-sm py-0.5 font-semibold text-foreground underline-offset-4 hover:underline"
          >
            {vendor || file}
          </Link>
          <span title={sub} className="block max-w-[14rem] truncate text-sm text-muted-foreground">
            {sub}
          </span>
          {/* Below 1024 px the Decision column is off the edge of the table's scroll frame: show the decision here too (UI-1). */}
          <div data-decision-inline="true" className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 lg:hidden">
            <DecisionBadge decision={run.decision} runStatus={run.status} size="sm" />
            {run.security_flag ? <SecurityBadge size="sm" /> : null}
          </div>
        </div>
      </TableCell>
      <TableCell className="px-3 py-3">
        {invoiceNumber ? (
          <span className="block max-w-[10rem] truncate text-sm" title={invoiceNumber}>
            <Ident>{invoiceNumber}</Ident>
          </span>
        ) : (
          <Placeholder label="No invoice number" />
        )}
      </TableCell>
      <TableCell className="px-3 py-3 text-right">
        <AmountCell run={run} />
      </TableCell>
      <TableCell className="px-3 py-3">
        <div className="flex max-w-[10rem] flex-wrap items-center gap-x-3 gap-y-1">
          <DecisionBadge decision={run.decision} runStatus={run.status} size="sm" />
          {run.security_flag ? <SecurityBadge size="sm" /> : null}
        </div>
      </TableCell>
      <TableCell className="w-full max-w-0 min-w-[12rem] px-3 py-3">
        <span
          title={reason.text}
          className={cn("block truncate group-focus-within:whitespace-normal", reason.placeholder && "text-muted-foreground")}
        >
          {reason.text}
        </span>
      </TableCell>
      <TableCell className="px-3 py-3 text-right text-muted-foreground tabular-nums">{formatCost(run.cost_usd)}</TableCell>
    </TableRow>
  );
}

export interface RunsTableProps {
  runs: RunListItem[];
}

/**
 * The dashboard table: Date, Vendor (with the file or "Pre-loaded history" under it), Invoice no., Amount, Decision (+ shield), Reason, Cost. It scrolls
 * inside its own frame on a narrow screen (the page never scrolls sideways); below 1024 px the decision is repeated
 * under the vendor, so a phone shows what happened to each invoice without scrolling the table. Every run text
 * is plain React text.
 */
export function RunsTable({ runs }: RunsTableProps) {
  return (
    <TableFrame label="Recent runs">
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead scope="col" className="px-3">
            Date
          </TableHead>
          <TableHead scope="col" className="px-3">
            Vendor
          </TableHead>
          <TableHead scope="col" className="px-3">
            Invoice no.
          </TableHead>
          <TableHead scope="col" className="px-3 text-right">
            Amount
          </TableHead>
          <TableHead scope="col" className="px-3">
            Decision
          </TableHead>
          <TableHead scope="col" className="px-3">
            Reason
          </TableHead>
          <TableHead scope="col" className="px-3 text-right">
            Cost
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {runs.map((run) => (
          <RunRow key={run.id} run={run} />
        ))}
      </TableBody>
    </TableFrame>
  );
}
