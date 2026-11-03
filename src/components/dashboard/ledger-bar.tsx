import { Money } from "@/components/shared/money";
import type { DashboardKpis } from "@/lib/types";

export interface LedgerBarProps {
  /** The figures over ALL runs (the filter does not change them). null until the first response. */
  kpis: DashboardKpis | null;
  /** true until the first response settles: the figures show skeletons. */
  loading: boolean;
}

const NO_FIGURE = "–";

/** One big figure and the word for it: "4 processed", "$30,030.00 approved". `kpi` is the name the browser checks read. */
function Figure({ kpi, loading, figure, word, note }: { kpi: string; loading: boolean; figure: React.ReactNode; word: string; note?: string }) {
  return (
    <p data-kpi={kpi} aria-busy={loading || undefined} className="flex min-w-0 flex-wrap items-baseline gap-x-2">
      <span className="text-[1.75rem] leading-none font-semibold tracking-tight tabular-nums">
        {/* a span, not the Skeleton div: a div cannot sit inside a paragraph (React hydration error 418) */}
        {loading ? <span aria-hidden="true" className="inline-block h-7 w-20 animate-pulse rounded-md bg-border align-middle" /> : figure}
      </span>
      <span className="text-base text-muted-foreground">{word}</span>
      {note ? <span className="text-sm text-muted-foreground">{note}</span> : null}
    </p>
  );
}

/**
 * The mix of outcomes as one thin strip: approved, on hold and rejected in proportion. Drawn as SVG rects sized by
 * attributes (never an inline style), and only a second view of the counts, which the filter buttons below print as text.
 */
function OutcomeStrip({ kpis }: { kpis: DashboardKpis }) {
  const total = kpis.approved + kpis.hold + kpis.rejected;
  if (total <= 0) return null;
  const parts = [
    { name: "approved", count: kpis.approved, fill: "fill-approve-solid" },
    { name: "on hold", count: kpis.hold, fill: "fill-hold-solid" },
    { name: "rejected", count: kpis.rejected, fill: "fill-reject-solid" },
  ];
  let x = 0;
  return (
    <svg role="img" aria-label={`Outcomes: ${parts.map((p) => `${p.count} ${p.name}`).join(", ")}`} className="block h-1.5 w-full overflow-hidden rounded-sm bg-border">
      {parts.map((p) => {
        const width = (p.count / total) * 100;
        const rect = p.count > 0 ? <rect key={p.name} x={`${x}%`} y="0" width={`${width}%`} height="100%" className={p.fill} /> : null;
        x += width;
        return rect;
      })}
    </svg>
  );
}

/**
 * The ledger bar: how many invoices were processed and what the approved ones add up to, with the mix of outcomes as a strip
 * under them. It replaces the six KPI tiles; the per-outcome counts are on the filter buttons (filter-chips.tsx), which
 * carry the same `data-kpi` names the tiles had. Without figures (the first request failed) every figure shows a dash.
 * Server-safe (no state, no effects).
 */
export function LedgerBar({ kpis, loading }: LedgerBarProps) {
  return (
    <section aria-label="Key figures" className="space-y-3">
      <div className="flex flex-wrap items-baseline gap-x-10 gap-y-2">
        <Figure kpi="Total processed" loading={loading} figure={kpis ? kpis.total : NO_FIGURE} word="processed" />
        <Figure
          kpi="Value approved"
          loading={loading}
          figure={kpis ? <Money value={kpis.approved_value} /> : NO_FIGURE}
          word="approved"
          note="invoice totals, tax included"
        />
      </div>
      {kpis ? <OutcomeStrip kpis={kpis} /> : null}
    </section>
  );
}
