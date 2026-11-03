import { cn } from "cn";
import { formatUsd } from "@/lib/format";
import type { MasterPo } from "@/lib/types";
import { displayText } from "@/components/dashboard/run-format";
import { poUsage } from "./data-format";

/** One fill per approving invoice, cycling (complete literals so Tailwind finds them). Over a full PO every segment is red. */
const SEGMENT_FILL = ["fill-chart-1", "fill-chart-2", "fill-chart-3", "fill-chart-4"] as const;

export interface PoUsageBarProps {
  po: Pick<MasterPo, "po_number" | "subtotal" | "invoiced" | "remaining" | "approved_breakdown">;
}

/**
 * How much of a purchase order is used, as one bar split by the invoices that used it, and what is left as the empty
 * track: [GLX-301][GLX-302][ left ]. The widths are shares of the PO subtotal (POs are pre-tax, which is why the
 * segments are subtotals). Drawn as SVG rects sized by attributes, never an inline style. role="progressbar" with a
 * spoken value; the caption under the bar says each invoice's amount in words, so the bar is only a second view.
 */
export function PoUsageBar({ po }: PoUsageBarProps) {
  const usage = poUsage(po);
  const total = po.subtotal > 0 ? po.subtotal : 0;
  const over = usage.state === "full" || usage.state === "over";
  let x = 0;
  const segments = total > 0 ? po.approved_breakdown.filter((b) => b.amount > 0) : [];
  const scale = Math.max(total, segments.reduce((sum, b) => sum + b.amount, 0)); // an overdrawn PO fills the bar, never spills out of it
  const rects = segments.map((b, i) => {
    const width = (b.amount / scale) * 100;
    const rect = (
      <rect key={`${b.invoice_number}-${i}`} x={`${x}%`} y="0" width={`${width}%`} height="100%" className={cn("stroke-card stroke-1", over ? "fill-reject-solid" : SEGMENT_FILL[i % SEGMENT_FILL.length])}>
        <title>{`${displayText(b.invoice_number, 60)}: ${formatUsd(b.amount)}`}</title>
      </rect>
    );
    x += width;
    return rect;
  });
  const caption =
    segments.length > 0
      ? segments.map((b) => `${displayText(b.invoice_number, 60)} ${formatUsd(b.amount)}`).join(", ")
      : "none approved yet";
  return (
    <div className="flex min-w-40 flex-col gap-1.5">
      <div
        role="progressbar"
        aria-label={`${po.po_number} used`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={usage.percent}
        aria-valuetext={`${formatUsd(po.invoiced)} of ${formatUsd(po.subtotal)} invoiced, ${usage.percent}% used`}
        className="h-3 w-full overflow-hidden rounded-sm bg-secondary ring-1 ring-border ring-inset"
      >
        <svg aria-hidden="true" focusable="false" className="block h-full w-full">
          {rects}
        </svg>
      </div>
      <span className="text-sm text-muted-foreground tabular-nums">{`${usage.percent}% used`}</span>
      <span className="block max-w-[16rem] text-sm break-words text-muted-foreground" title={caption}>
        {caption}
      </span>
    </div>
  );
}
