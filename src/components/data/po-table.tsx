import { Lock, TriangleAlert } from "lucide-react";
import { Money } from "@/components/shared/money";
import { ProgressBar } from "@/components/shared/progress-bar";
import { TableFrame } from "@/components/shared/table-frame";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatUsd } from "@/lib/format";
import type { MasterPo } from "@/lib/types";
import { describeLines, poUsage, summarizeInvoices, type PoUsage } from "./data-format";

/** Marks a PO that no longer accepts invoices (its status is closed). */
function ClosedTag() {
  return (
    <span className="inline-flex h-5 shrink-0 items-center gap-1 rounded-full border border-border bg-muted px-1.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
      <Lock aria-hidden="true" className="size-3" />
      Closed
    </span>
  );
}

/**
 * The Remaining cell, the one the split-PO story is about:
 *  - a balance left: the amount, in bold;
 *  - nothing left: "$0.00" and "fully used";
 *  - more approved than the PO holds (a few dollars, from an invoice inside the 2% tolerance): a triangle icon and
 *    the words "over by $24.00" in red, never a bare negative number and never colour alone.
 * A closed PO adds "closed to new invoices" under whatever the amount is.
 */
function RemainingCell({ po, usage }: { po: MasterPo; usage: PoUsage }) {
  const closed = po.status === "closed";
  return (
    <div className="flex flex-col items-end gap-0.5">
      {usage.state === "over" ? (
        <span className="inline-flex items-center gap-1.5 font-semibold text-reject">
          <TriangleAlert aria-hidden="true" className="size-4 shrink-0" />
          <span>
            over by <Money value={usage.overBy} />
          </span>
        </span>
      ) : (
        <Money value={po.remaining} className={closed ? "text-muted-foreground" : "font-semibold"} />
      )}
      {usage.state === "full" ? <span className="text-xs text-muted-foreground">fully used</span> : null}
      {closed ? <span className="text-xs text-muted-foreground">closed to new invoices</span> : null}
    </div>
  );
}

function PoRow({ po }: { po: MasterPo }) {
  const usage = poUsage(po);
  const closed = po.status === "closed";
  const lines = describeLines(po.lines);
  return (
    <TableRow data-po={po.po_number} data-state={usage.state} className={closed ? "text-muted-foreground" : undefined}>
      <TableCell className="px-3 py-3">
        <div className="flex flex-col gap-0.5">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-foreground">{po.po_number}</span>
            {closed ? <ClosedTag /> : null}
          </div>
          <span className="block max-w-[18rem] truncate text-xs text-muted-foreground" title={lines}>
            {lines}
          </span>
          {/* Below 1024 px the Remaining column is off the edge of the table's scroll frame: repeat it here (UI-1). */}
          <span data-remaining-inline="true" className="flex flex-wrap items-center gap-1 text-sm lg:hidden">
            <span className="text-muted-foreground">Remaining</span>
            {usage.state === "over" ? (
              <span className="inline-flex items-center gap-1 font-semibold text-reject">
                <TriangleAlert aria-hidden="true" className="size-3.5 shrink-0" />
                <span>
                  over by <Money value={usage.overBy} />
                </span>
              </span>
            ) : (
              <Money value={po.remaining} className={closed ? "text-muted-foreground" : "font-semibold text-foreground"} />
            )}
            {usage.state === "full" ? <span className="text-xs text-muted-foreground">(fully used)</span> : null}
          </span>
        </div>
      </TableCell>
      <TableCell className="px-3 py-3">
        <div className="flex flex-col gap-0.5">
          <span>{po.vendor_name ?? "Unknown vendor"}</span>
          <span className="text-xs text-muted-foreground tabular-nums">{po.vendor_id}</span>
        </div>
      </TableCell>
      <TableCell className="px-3 py-3 text-right">
        <Money value={po.subtotal} />
      </TableCell>
      <TableCell className="px-3 py-3 text-right">
        <div className="flex flex-col items-end gap-0.5">
          <Money value={po.invoiced} />
          <span className="block max-w-[14rem] truncate text-xs text-muted-foreground" title={summarizeInvoices(po.approved_invoices, 99)}>
            {summarizeInvoices(po.approved_invoices)}
          </span>
        </div>
      </TableCell>
      <TableCell className="px-3 py-3 text-right">
        <RemainingCell po={po} usage={usage} />
      </TableCell>
      <TableCell className="px-3 py-3">
        <div className="flex min-w-32 flex-col gap-1.5">
          <ProgressBar
            value={po.invoiced}
            max={po.subtotal}
            label={`${po.po_number} used`}
            valueText={`${formatUsd(po.invoiced)} of ${formatUsd(po.subtotal)} invoiced, ${usage.percent}% used`}
            tone={usage.tone}
          />
          <span className="text-xs text-muted-foreground tabular-nums">{usage.percent}% used</span>
        </div>
      </TableCell>
    </TableRow>
  );
}

export interface PoTableProps {
  purchaseOrders: MasterPo[];
}

/**
 * The purchase orders: PO number (with its lines), vendor, total, invoiced so far (with the approving invoice
 * numbers), REMAINING and a progress bar. Scrolls inside its own frame on a narrow screen; below 1024 px the remaining
 * balance is repeated under the PO number, so a phone shows it without scrolling the table. Server-safe.
 */
export function PoTable({ purchaseOrders }: PoTableProps) {
  return (
    <TableFrame label="Purchase orders">
      <TableHeader>
        <TableRow className="bg-muted/50 hover:bg-muted/50">
          <TableHead scope="col" className="px-3">
            PO
          </TableHead>
          <TableHead scope="col" className="px-3">
            Vendor
          </TableHead>
          <TableHead scope="col" className="px-3 text-right">
            PO total
          </TableHead>
          <TableHead scope="col" className="px-3 text-right">
            Invoiced so far
          </TableHead>
          <TableHead scope="col" className="px-3 text-right">
            Remaining
          </TableHead>
          <TableHead scope="col" className="px-3">
            Used
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {purchaseOrders.map((po) => (
          <PoRow key={po.po_number} po={po} />
        ))}
      </TableBody>
    </TableFrame>
  );
}
