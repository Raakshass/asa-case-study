"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { ArrowRight, ChevronRight, TriangleAlert } from "lucide-react";
import { getRuns, unwrap } from "@/components/shared/api";
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorState } from "@/components/shared/error-state";
import { TableSkeleton } from "@/components/shared/skeletons";
import { usePoll } from "@/components/shared/use-poll";
import { Button } from "@/components/ui/button";
import type { DashboardKpis, RunListItem } from "@/lib/types";
import { FilterChips } from "./filter-chips";
import { LedgerBar } from "./ledger-bar";
import { RunsTable } from "./runs-table";
import { WelcomePanel } from "./welcome-panel";
import { filterCount, filterNoun, type DashboardFilter } from "./run-format";

/** The dashboard refreshes this often (docs/CONTRACTS.md section 7). */
const POLL_MS = 3000;

/** Nothing to list: the first-time welcome when no filter is on, else a note that this filter matches nothing. */
function NoRuns({ filter, onShowAll }: { filter: DashboardFilter; onShowAll: () => void }) {
  if (filter === "all") {
    return (
      <EmptyState
        title="No invoices checked yet"
        description="Run a sample invoice, or upload your own, to watch it being screened, read, checked and decided. Every run is listed here."
        action={
          <Button asChild>
            <Link href="/runs/new">
              Try a sample invoice
              <ArrowRight aria-hidden="true" />
            </Link>
          </Button>
        }
      />
    );
  }
  return (
    <EmptyState
      title={`No ${filterNoun(filter)} runs yet`}
      description="Nothing matches this filter at the moment. New runs show up here by themselves."
      action={
        <Button type="button" variant="outline" onClick={onShowAll}>
          Show all runs
        </Button>
      }
    />
  );
}

/** all minus part: the figures of the runs made here, without the pre-loaded history. */
function minus(all: DashboardKpis, part: DashboardKpis | undefined): DashboardKpis {
  if (!part) return all;
  return {
    total: all.total - part.total,
    approved: all.approved - part.approved,
    hold: all.hold - part.hold,
    rejected: all.rejected - part.rejected,
    security_flags: all.security_flags - part.security_flags,
    approved_value: Math.round((all.approved_value - part.approved_value) * 100) / 100,
  };
}

/**
 * The pre-loaded history, folded away under the table: example invoices from before today that the checks compare against
 * (PO money already spent, an earlier invoice for the duplicate check). Closed by default, so a first visit shows the runs
 * made here, or the empty state, not rows that look like someone else's work. A native details element: keyboard and screen
 * readers get the expand control for free.
 */
function HistorySection({ runs }: { runs: RunListItem[] }) {
  if (runs.length === 0) return null;
  return (
    <details data-history className="group rounded-lg bg-muted/40 ring-1 ring-border">
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-lg px-3 py-2.5 text-sm outline-none hover:bg-muted/70 focus-visible:ring-3 focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden">
        <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
        <span>
          <strong className="font-semibold text-foreground">Pre-loaded history</strong>{" "}
          <span className="text-muted-foreground">
            · {runs.length === 1 ? "1 example invoice" : `${runs.length} example invoices`} from before today
          </span>
        </span>
      </summary>
      <div className="space-y-3 px-3 pb-3">
        <p className="text-sm text-muted-foreground">
          They give the checks something real to compare against: purchase-order money already spent, and an earlier invoice for the
          duplicate check to find. They are not counted in the figures above.
        </p>
        <RunsTable runs={runs} label="Pre-loaded history" />
      </div>
    </details>
  );
}

/**
 * The dashboard: the ledger bar, the filter buttons and the table of runs, refreshed every 3 seconds through usePoll.
 * The figures, the buttons' counts and the table cover the runs made here; the pre-loaded history is folded away below.
 *
 * The filter is part of the poll's resetKey, so a change aborts the old request and starts a fresh one for
 * GET /api/runs?decision=...; the table shows its skeleton for that moment. The KPIs do not depend on the
 * filter, so the last figures stay on screen meanwhile. A failed first load shows an error with a retry button;
 * a failed refresh keeps the rows and says that live updates are paused.
 */
export function DashboardView() {
  const [filter, setFilter] = useState<DashboardFilter>("all");
  const [retrying, setRetrying] = useState(false);
  const [lastKpis, setLastKpis] = useState<DashboardKpis | null>(null);

  const { data, error, loading, refresh } = usePoll(
    (signal) => unwrap(getRuns(filter === "all" ? {} : { decision: filter }, signal)),
    { intervalMs: POLL_MS, resetKey: filter },
  );

  const latestKpis = useMemo(() => (data ? minus(data.kpis, data.history_kpis) : null), [data]);
  useEffect(() => {
    if (latestKpis) setLastKpis(latestKpis);
  }, [latestKpis]);
  const kpis = latestKpis ?? lastKpis;

  const retry = useCallback(() => {
    setRetrying(true);
    void refresh().finally(() => setRetrying(false));
  }, [refresh]);

  let body: ReactNode;
  const own = data ? data.runs.filter((r) => !r.is_history) : [];
  const history = data ? data.runs.filter((r) => r.is_history) : [];
  if (data) {
    body = own.length > 0 ? <RunsTable runs={own} /> : <NoRuns filter={filter} onShowAll={() => setFilter("all")} />;
  } else if (error) {
    body = <ErrorState title="Could not load the runs" message={error.message} onRetry={retry} retrying={retrying} />;
  } else {
    body = <TableSkeleton rows={6} columns={7} label="Loading runs" />;
  }

  const shown = data ? own.length : null;
  // The list is capped by the API (the newest 50 by default); say so instead of silently hiding older runs.
  const matching = data ? filterCount(filter, data.kpis) : 0;
  const summary =
    shown === null
      ? ""
      : `Showing ${shown} ${shown === 1 ? "run" : "runs"}${filter === "all" ? "" : `, filter ${filterNoun(filter)}`}.`;

  return (
    <div className="space-y-6">
      <WelcomePanel />
      <LedgerBar kpis={kpis} loading={kpis === null && loading} />
      <div className="space-y-3">
        <FilterChips value={filter} onChange={setFilter} kpis={kpis} />
        {/* Tells screen-reader users what a press of a filter did; announced politely, changes only with the result. */}
        <p role="status" className="sr-only">
          {summary}
        </p>
        {data && error ? (
          <p role="status" className="flex items-start gap-2 text-sm text-hold">
            <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            <span>
              <strong className="font-semibold">Live updates paused.</strong> {error.message} Retrying automatically; the rows below
              may be out of date.
            </span>
          </p>
        ) : null}
        {body}
        {data && matching > data.runs.length ? (
          <p className="text-sm text-muted-foreground">
            Showing the newest {data.runs.length} of {matching} {filterNoun(filter) === "all" ? "" : `${filterNoun(filter)} `}runs.
          </p>
        ) : null}
        <HistorySection runs={history} />
      </div>
    </div>
  );
}
