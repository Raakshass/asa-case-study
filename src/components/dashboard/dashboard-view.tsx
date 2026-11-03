"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ArrowRight, TriangleAlert } from "lucide-react";
import { getRuns, unwrap } from "@/components/shared/api";
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorState } from "@/components/shared/error-state";
import { TableSkeleton } from "@/components/shared/skeletons";
import { usePoll } from "@/components/shared/use-poll";
import { Button } from "@/components/ui/button";
import type { DashboardKpis } from "@/lib/types";
import { FilterChips } from "./filter-chips";
import { KpiRow } from "./kpi-row";
import { RunsTable } from "./runs-table";
import { filterCount, filterNoun, type DashboardFilter } from "./run-format";

/** The dashboard refreshes this often (docs/CONTRACTS.md section 7). */
const POLL_MS = 3000;

/** Nothing to list: the first-time welcome when no filter is on, else a note that this filter matches nothing. */
function NoRuns({ filter, onShowAll }: { filter: DashboardFilter; onShowAll: () => void }) {
  if (filter === "all") {
    return (
      <EmptyState
        title="No invoices yet"
        description="Run one of the sample invoices to watch it being screened, read, checked and decided."
        action={
          <Button asChild>
            <Link href="/runs/new">
              Try a sample
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

/**
 * The dashboard: KPI tiles, filter chips and the table of runs, refreshed every 3 seconds through usePoll.
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

  const latestKpis = data?.kpis ?? null;
  useEffect(() => {
    if (latestKpis) setLastKpis(latestKpis);
  }, [latestKpis]);
  const kpis = latestKpis ?? lastKpis;

  const retry = useCallback(() => {
    setRetrying(true);
    void refresh().finally(() => setRetrying(false));
  }, [refresh]);

  let body: ReactNode;
  if (data) {
    body = data.runs.length > 0 ? <RunsTable runs={data.runs} /> : <NoRuns filter={filter} onShowAll={() => setFilter("all")} />;
  } else if (error) {
    body = <ErrorState title="Could not load the runs" message={error.message} onRetry={retry} retrying={retrying} />;
  } else {
    body = <TableSkeleton rows={6} columns={8} label="Loading runs" />;
  }

  const shown = data ? data.runs.length : null;
  // The list is capped by the API (the newest 50 by default); say so instead of silently hiding older runs.
  const matching = data ? filterCount(filter, data.kpis) : 0;
  const summary =
    shown === null
      ? ""
      : `Showing ${shown} ${shown === 1 ? "run" : "runs"}${filter === "all" ? "" : `, filter ${filterNoun(filter)}`}.`;

  return (
    <div className="space-y-6">
      <KpiRow kpis={kpis} loading={kpis === null && loading} />
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
          <p className="text-xs text-muted-foreground">
            Showing the newest {data.runs.length} of {matching} {filterNoun(filter) === "all" ? "" : `${filterNoun(filter)} `}runs.
          </p>
        ) : null}
      </div>
    </div>
  );
}
