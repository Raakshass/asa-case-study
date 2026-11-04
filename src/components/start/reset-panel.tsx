"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { CircleCheck, Clock, LoaderCircle, RotateCcw } from "lucide-react";
import { resetDemo } from "@/components/shared/api";
import { ErrorState } from "@/components/shared/error-state";
import { forgetToken, readSavedToken, saveToken } from "@/components/shared/operator-token";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { SeedCounts } from "@/lib/types";
import { describeCounts, resetOutcomeOf } from "./upload-rules";

type Outcome = { kind: "done"; counts: SeedCounts } | { kind: "failed"; message: string } | { kind: "pending"; message: string };

/**
 * "Reset demo data": a button that reveals an inline form for the reset token (a password field; never
 * window.confirm). Confirming POSTs /api/reset with the token in the x-reset-token header. Success lists what the
 * database holds now; a 403 says the token was refused (and forgets a saved one); other failures show the
 * server's message. The reset wipes every run and the uploaded files, which the form says before it asks.
 */
export function ResetPanel({ className }: { className?: string }) {
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState("");
  const [saved, setSaved] = useState(false);
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const wasPending = useRef(false);
  const panelId = useId();
  const inputId = useId();
  const hintId = useId();
  const errorId = useId();

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  useEffect(() => () => controllerRef.current?.abort(), []);

  // The field and the buttons are disabled while the request runs, which drops focus: put it back on the field.
  useEffect(() => {
    const done = wasPending.current && !pending;
    wasPending.current = pending;
    if (done && open && (document.activeElement === null || document.activeElement === document.body)) inputRef.current?.focus();
  }, [pending, open]);

  function toggle() {
    if (open) {
      setOpen(false);
      return;
    }
    const remembered = readSavedToken();
    setToken(remembered);
    setSaved(remembered !== "");
    setOutcome(null);
    setOpen(true);
  }

  function cancel() {
    setOpen(false);
    toggleRef.current?.focus();
  }

  function forget() {
    forgetToken();
    setSaved(false);
    setToken("");
    inputRef.current?.focus();
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setOutcome(null);
    const controller = new AbortController();
    controllerRef.current = controller;
    const result = await resetDemo(token, controller.signal);
    if (controller.signal.aborted) return; // the page was left meanwhile
    controllerRef.current = null;
    setPending(false);
    if (result.ok) {
      saveToken(token.trim());
      setSaved(true);
      setOutcome({ kind: "done", counts: result.data.counts });
    } else {
      if (result.status === 403) {
        forgetToken();
        setSaved(false);
      }
      // a timeout of the browser's own is not a failure: the server finishes the queued runs, then resets (ROUTE-1)
      setOutcome(resetOutcomeOf(result));
    }
  }

  return (
    <section aria-labelledby={`${panelId}-title`} className={className}>
      <div className="rounded-xl border bg-card p-4 sm:p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 space-y-1">
            <h2 id={`${panelId}-title`} className="text-base font-semibold tracking-tight">
              Demo tools
            </h2>
            <p className="max-w-prose text-sm text-muted-foreground">
              Start over for the next walk-through: this deletes every run, removes the uploaded files and restores the vendors,
              purchase orders and pre-loaded history.
            </p>
          </div>
          <Button
            ref={toggleRef}
            type="button"
            variant="outline"
            size="lg"
            aria-expanded={open}
            aria-controls={panelId}
            onClick={toggle}
            className="h-10 shrink-0 self-start px-3"
          >
            <RotateCcw aria-hidden="true" />
            Reset demo data
          </Button>
        </div>

        <div id={panelId} hidden={!open}>
          {open ? (
            <form onSubmit={submit} autoComplete="off" className="mt-4 space-y-3 border-t pt-4">
              <div className="space-y-1.5">
                <label htmlFor={inputId} className="text-sm font-medium">
                  Reset token
                </label>
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  <Input
                    ref={inputRef}
                    id={inputId}
                    name="reset-token"
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    aria-describedby={outcome?.kind === "failed" ? `${hintId} ${errorId}` : hintId}
                    aria-invalid={outcome?.kind === "failed" || undefined}
                    disabled={pending}
                    className="h-10 text-base sm:max-w-sm"
                  />
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      type="submit"
                      variant="destructive"
                      size="lg"
                      disabled={pending}
                      // the stock destructive focus ring is a 20% tint: draw the same solid border and 50% halo as the other buttons
                      className="h-10 px-3 focus-visible:border-destructive focus-visible:ring-destructive/50"
                    >
                      {pending ? <LoaderCircle aria-hidden="true" className="animate-spin" /> : null}
                      {pending ? "Resetting" : "Confirm reset"}
                    </Button>
                    <Button type="button" variant="ghost" size="lg" disabled={pending} onClick={cancel} className="h-10 px-3">
                      Cancel
                    </Button>
                  </div>
                </div>
                <p id={hintId} className="text-xs text-muted-foreground">
                  The token is the DEMO_RESET_TOKEN of this server.{" "}
                  {saved ? (
                    <>
                      The token from your last successful reset is saved for this browser tab only.{" "}
                      <button type="button" onClick={forget} className="rounded-sm underline underline-offset-2 hover:text-foreground">
                        Forget the saved token
                      </button>
                      .
                    </>
                  ) : (
                    "It is kept for this browser tab only, after a successful reset."
                  )}
                </p>
              </div>
            </form>
          ) : null}
        </div>

        {outcome?.kind === "failed" ? (
          <div id={errorId} className="mt-4">
            <ErrorState title="Reset failed" message={outcome.message} />
          </div>
        ) : null}
        {outcome?.kind === "pending" ? (
          <div role="status" data-reset-pending="true" className="mt-4 rounded-xl border border-hold-border bg-hold-soft p-4">
            <p className="flex items-center gap-2 font-medium text-hold">
              <Clock aria-hidden="true" className="size-5 shrink-0" />
              Still resetting
            </p>
            <p className="mt-1 text-sm break-words text-foreground">{outcome.message}</p>
          </div>
        ) : null}
        {outcome?.kind === "done" ? (
          <div role="status" className="mt-4 rounded-xl border border-approve-border bg-approve-soft p-4">
            <p className="flex items-center gap-2 font-medium text-approve">
              <CircleCheck aria-hidden="true" className="size-5 shrink-0" />
              Demo data reset
            </p>
            <p className="mt-1 text-sm text-foreground">The database now holds:</p>
            <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:flex sm:flex-wrap sm:gap-x-6">
              {describeCounts(outcome.counts).map(([label, value]) => (
                <div key={label} className="flex items-baseline gap-1.5">
                  <dt className="text-muted-foreground">{label}</dt>
                  <dd className="font-semibold tabular-nums">{value}</dd>
                </div>
              ))}
            </dl>
          </div>
        ) : null}
      </div>
    </section>
  );
}
