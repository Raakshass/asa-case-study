"use client";

import Link from "next/link";
import { useCallback, useState } from "react";
import { TriangleAlert, Workflow } from "lucide-react";
import { cn } from "cn";
import { getAutomations, setAutomationEnabled, unwrap } from "@/components/shared/api";
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorState } from "@/components/shared/error-state";
import { TableFrame } from "@/components/shared/table-frame";
import { TableSkeleton } from "@/components/shared/skeletons";
import { usePoll } from "@/components/shared/use-poll";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { AutomationListItem } from "@/lib/types";
import { formatWhen, displayText } from "@/components/dashboard/run-format";
import { ExecutionStatusMark } from "./execution-status";
import { NewAutomationButton } from "./new-automation-dialog";
import { useTokenAction } from "./use-token-action";

const POLL_MS = 5000;

/** "2 problems" under a name that cannot be turned on yet. */
const problemsText = (n: number): string => `${n} ${n === 1 ? "problem" : "problems"}`;

/**
 * The on/off switch: a real button with role="switch", the visible words On and Off, and a name that says what pressing it
 * does ("Turn <name> on"). Turning it on or off needs the operator token (asked for inline when this tab has none).
 */
function Switch({ item, busy, onToggle }: { item: AutomationListItem; busy: boolean; onToggle: (item: AutomationListItem) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={item.enabled}
      aria-label={`Turn ${displayText(item.name, 60)} ${item.enabled ? "off" : "on"}`}
      disabled={busy}
      onClick={() => onToggle(item)}
      className={cn(
        "inline-flex h-8 min-w-[4.25rem] items-center justify-center gap-1.5 rounded-md border px-3 text-sm font-semibold transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-60",
        item.enabled ? "border-primary bg-primary text-primary-foreground" : "border-border bg-card text-foreground hover:bg-muted",
      )}
    >
      <span aria-hidden="true">{item.enabled ? "■" : "□"}</span>
      {item.enabled ? "On" : "Off"}
    </button>
  );
}

function LastRun({ item }: { item: AutomationListItem }) {
  if (item.last_execution === null) return <span className="text-muted-foreground">Never</span>;
  const when = formatWhen(item.last_execution.created_at);
  return (
    <span className="flex flex-col gap-0.5">
      <span className="text-muted-foreground">{when?.text ?? "Unknown time"}</span>
      <ExecutionStatusMark status={item.last_execution.status} />
    </span>
  );
}

/**
 * The body of /automations: every automation with what starts it, whether it is on, when it last ran and how often in the
 * last 24 hours. A table from 640 px, a list below it (no sideways scrolling at 375 px). A refresh every 5 seconds.
 */
export function AutomationsList() {
  const { data, error, loading, refresh } = usePoll((signal) => unwrap(getAutomations(signal)), { intervalMs: POLL_MS });
  const { run, prompt, busy } = useTokenAction();
  const [notice, setNotice] = useState<{ message: string; id: string | null } | null>(null);
  const [retrying, setRetrying] = useState(false);

  const retry = useCallback(() => {
    setRetrying(true);
    void refresh().finally(() => setRetrying(false));
  }, [refresh]);

  function toggle(item: AutomationListItem) {
    setNotice(null);
    run(
      item.enabled ? "to turn it off" : "to turn it on",
      (token) => setAutomationEnabled(item.id, !item.enabled, token),
      (result) => {
        if (result.ok) void refresh();
        else setNotice({ message: result.error, id: result.status === 409 ? item.id : null });
      },
    );
  }

  if (loading) return <TableSkeleton rows={3} columns={5} label="Loading automations" />;
  if (!data) return <ErrorState title="Could not load the automations" message={error?.message ?? "No data was received."} onRetry={retry} retrying={retrying} />;

  const list = data.automations;
  return (
    <div className="space-y-4">
      {!data.sending_enabled ? (
        <p className="flex items-start gap-2 text-sm text-muted-foreground">
          <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span>Sending to other servers is off on this server. Webhook and chat steps can be tested but not sent.</span>
        </p>
      ) : null}
      {!data.automations_enabled ? (
        <p role="status" className="flex items-start gap-2 text-sm text-hold">
          <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span>Automations are switched off on this server (AUTOMATIONS_ENABLED=false): none will run until it is switched on.</span>
        </p>
      ) : null}
      {error ? (
        <p role="status" className="flex items-start gap-2 text-sm text-hold">
          <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span>
            <strong className="font-semibold">Live updates paused.</strong> {error.message} Retrying automatically.
          </span>
        </p>
      ) : null}

      {list.length === 0 ? (
        <EmptyState
          title="No automations yet"
          description="An automation routes what the agent decided: assign a hold to someone, note it on the invoice, or tell a chat. Start from a template."
          icon={<Workflow />}
          action={<NewAutomationButton />}
        />
      ) : (
        <>
          {/* from 640 px: a table */}
          <div className="hidden sm:block">
            <TableFrame label="Automations">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead scope="col" className="px-3">Name</TableHead>
                  <TableHead scope="col" className="px-3">Starts</TableHead>
                  <TableHead scope="col" className="px-3">On</TableHead>
                  <TableHead scope="col" className="px-3">Last run</TableHead>
                  <TableHead scope="col" className="px-3 text-right">Last 24 h</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.map((item) => (
                  <TableRow key={item.id} data-automation={item.id}>
                    <TableCell className="px-3 py-3">
                      <div className="flex flex-col gap-0.5">
                        <Link href={`/automations/${encodeURIComponent(item.id)}`} prefetch={false} className="max-w-[20rem] truncate rounded-sm py-0.5 font-semibold text-foreground underline-offset-4 hover:underline" title={item.name}>
                          {displayText(item.name, 60)}
                        </Link>
                        {item.problem_count > 0 ? <span className="text-sm text-reject">{problemsText(item.problem_count)}</span> : null}
                      </div>
                    </TableCell>
                    <TableCell className="px-3 py-3 text-muted-foreground">{item.trigger_summary}</TableCell>
                    <TableCell className="px-3 py-3">
                      <Switch item={item} busy={busy} onToggle={toggle} />
                    </TableCell>
                    <TableCell className="px-3 py-3 text-sm">
                      <LastRun item={item} />
                    </TableCell>
                    <TableCell className="px-3 py-3 text-right tabular-nums">{item.executions_24h}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </TableFrame>
          </div>

          {/* below 640 px: a list */}
          <ul className="space-y-3 sm:hidden" aria-label="Automations">
            {list.map((item) => (
              <li key={item.id} className="space-y-2 rounded-xl bg-card p-4 ring-1 ring-foreground/10">
                <div className="space-y-0.5">
                  <Link href={`/automations/${encodeURIComponent(item.id)}`} prefetch={false} className="block rounded-sm py-0.5 font-semibold text-foreground underline-offset-4 hover:underline">
                    {displayText(item.name, 60)}
                  </Link>
                  {item.problem_count > 0 ? <p className="text-sm text-reject">{problemsText(item.problem_count)}</p> : null}
                  <p className="text-sm text-muted-foreground">{item.trigger_summary}</p>
                </div>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                  <Switch item={item} busy={busy} onToggle={toggle} />
                  <span className="text-sm">
                    <LastRun item={item} />
                  </span>
                  <span className="text-sm text-muted-foreground tabular-nums">{item.executions_24h} in 24 h</span>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      {prompt}
      {notice ? (
        <p role="alert" className="text-sm text-reject">
          {notice.message}{" "}
          {notice.id !== null ? (
            <Link href={`/automations/${encodeURIComponent(notice.id)}`} prefetch={false} className="font-medium underline underline-offset-4">
              Open it to fix them
            </Link>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}
