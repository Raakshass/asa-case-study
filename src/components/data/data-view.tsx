"use client";

import { useCallback, useId, useState, type ReactNode } from "react";
import { TriangleAlert } from "lucide-react";
import { getMaster, unwrap } from "@/components/shared/api";
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorState } from "@/components/shared/error-state";
import { TableSkeleton } from "@/components/shared/skeletons";
import { usePoll } from "@/components/shared/use-poll";
import { countLabel } from "./data-format";
import { PoTable } from "./po-table";
import { VendorsTable } from "./vendors-table";

/** The balances change when a run is approved, so the page checks now and then; an unchanged answer redraws nothing. */
const POLL_MS = 5000;

function Section({ id, title, count, description, children }: { id: string; title: string; count: string; description: ReactNode; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="space-y-3">
      <div className="space-y-1">
        <h2 id={id} className="flex flex-wrap items-baseline gap-x-3 text-lg font-semibold tracking-tight">
          {title}{" "}
          <span className="text-sm font-normal text-muted-foreground">{count}</span>
        </h2>
        <p className="max-w-prose text-sm text-muted-foreground">{description}</p>
      </div>
      {children}
    </section>
  );
}

/**
 * The body of /data: the purchase orders (with their remaining balance, the split-PO case) and the vendors, from
 * GET /api/master, refreshed every 5 seconds. A skeleton while loading, an error with a retry button when the
 * first load fails, and a note (the old figures stay) when a refresh fails.
 */
export function DataView() {
  const [retrying, setRetrying] = useState(false);
  const headingId = useId();
  const { data, error, loading, refresh } = usePoll((signal) => unwrap(getMaster(signal)), { intervalMs: POLL_MS });

  const retry = useCallback(() => {
    setRetrying(true);
    void refresh().finally(() => setRetrying(false));
  }, [refresh]);

  if (loading) {
    return (
      <div className="space-y-10">
        <TableSkeleton rows={8} columns={6} label="Loading purchase orders" />
        <TableSkeleton rows={5} columns={4} label="Loading vendors" />
      </div>
    );
  }
  if (!data) {
    return <ErrorState title="Could not load the procurement data" message={error?.message ?? "No data was received."} onRetry={retry} retrying={retrying} />;
  }

  const pos = data.purchase_orders;
  const vendors = data.vendors;
  return (
    <div className="space-y-10">
      {error ? (
        <p role="status" className="flex items-start gap-2 text-sm text-hold">
          <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span>
            <strong className="font-semibold">Live updates paused.</strong> {error.message} Retrying automatically; the figures
            below may be out of date.
          </span>
        </p>
      ) : null}

      <Section
        id={`${headingId}-pos`}
        title="Purchase orders"
        count={countLabel(pos.length, "order")}
        description="Amounts are before tax. Only approved invoices use up a purchase order: invoices on hold or rejected do not count towards Invoiced so far, and an approval inside the 2% tolerance can leave a balance slightly below zero."
      >
        {pos.length > 0 ? (
          <PoTable purchaseOrders={pos} />
        ) : (
          <EmptyState title="No purchase orders" description="The procurement data has not been loaded on this server." />
        )}
      </Section>

      <Section
        id={`${headingId}-vendors`}
        title="Vendors"
        count={countLabel(vendors.length, "vendor")}
        description="The vendors the rules know. A bank account is only ever read from here (masked on screen); the phone number is the one to call to verify a bank change."
      >
        {vendors.length > 0 ? (
          <VendorsTable vendors={vendors} />
        ) : (
          <EmptyState title="No vendors" description="The procurement data has not been loaded on this server." />
        )}
      </Section>
    </div>
  );
}
