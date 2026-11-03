import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { DecisionBadge } from "@/components/shared/decision-badge";
import { Muted } from "./key-values";
import { displayText, formatDate, formatMoney } from "./run-format";
import type { RunDetail, RunListItem } from "@/lib/types";

export interface HistoryRecordProps {
  run: RunDetail;
  /**
   * The run's row from GET /api/runs (vendor, invoice number, total), or null. The run detail of a pre-loaded
   * record carries none of the invoice's own fields, so the page reads them from the list.
   */
  entry: RunListItem | null;
  /** The list is still being fetched. */
  loading: boolean;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-x-4 gap-y-0.5 py-2.5 sm:grid-cols-[minmax(8rem,12rem)_minmax(0,1fr)]">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-sm font-medium break-words [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}

/**
 * What stands in for the stepper on a pre-loaded history record: the invoice's own facts (the part of the data the
 * demo shows) and a note that no stages ran. No stepper, no extracted-fields table: there was no extraction.
 */
export function HistoryRecord({ run, entry, loading }: HistoryRecordProps) {
  const vendor = displayText(entry?.vendor_name, 200);
  const number = displayText(entry?.invoice_number, 200);
  const amount = formatMoney(entry?.total, entry?.currency);
  const processed = formatDate(run.finished_at ?? run.created_at);
  return (
    <section aria-labelledby="history-heading" className="space-y-4 rounded-xl bg-card p-4 ring-1 ring-foreground/10 sm:p-5">
      <div className="space-y-1">
        <h2 id="history-heading" className="text-base font-semibold">
          Invoice record
        </h2>
        <p className="text-sm text-muted-foreground">The facts kept about this invoice. No stages were run for it, so there is no evidence trail to open.</p>
      </div>
      {entry === null && loading ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading the invoice details...
        </p>
      ) : (
        <dl className="divide-y divide-border">
          <Row label="Vendor">{vendor || <Muted>Not available</Muted>}</Row>
          <Row label="Invoice number">{number || <Muted>Not available</Muted>}</Row>
          <Row label="Amount">{amount ? <span className="tabular-nums">{amount}</span> : <Muted>Not available</Muted>}</Row>
          <Row label="Decision">
            <DecisionBadge decision={run.decision} runStatus={run.status} size="sm" />
          </Row>
          {processed ? <Row label="Processed">{processed}</Row> : null}
        </dl>
      )}
      <Link href="/runs/new" className="inline-flex items-center gap-1.5 rounded-sm text-sm font-medium text-primary underline underline-offset-4 hover:text-primary/80">
        See how a new invoice is processed
        <ArrowRight aria-hidden="true" className="size-3.5" />
      </Link>
    </section>
  );
}
