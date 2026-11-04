"use client";

import { useId, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export interface TokenPromptProps {
  /** What the token is for, in one short sentence ("to turn it on"). */
  reason: string;
  /** Called with what was typed. The caller decides whether it is accepted. */
  onSubmit: (token: string) => void;
  /** "That token was not accepted." after a refusal. */
  error?: string | null;
  busy?: boolean;
  className?: string;
}

/**
 * A small inline form shown when an action needs the operator token and none is stored in this tab: a password field and
 * a Continue button (never window.prompt). The token goes to the caller only; it is kept in sessionStorage by the caller
 * once the server accepted it, and forgotten when the server refuses it.
 */
export function TokenPrompt({ reason, onSubmit, error, busy = false, className }: TokenPromptProps) {
  const [token, setToken] = useState("");
  const id = useId();
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (token.trim() !== "" && !busy) onSubmit(token.trim());
  }
  return (
    <form onSubmit={submit} autoComplete="off" className={className ?? "flex flex-col gap-2 rounded-lg bg-card p-3 ring-1 ring-foreground/10 sm:flex-row sm:items-end"}>
      <div className="min-w-0 flex-1 space-y-1">
        <label htmlFor={id} className="text-sm font-medium">
          Operator token
        </label>
        <Input id={id} name="operator-token" type="password" autoComplete="off" spellCheck={false} value={token} onChange={(e) => setToken(e.target.value)} className="h-9 sm:max-w-xs" required />
        <p className="text-sm text-muted-foreground">Needed {reason}. It is the same token as for resetting the demo.</p>
        {error ? (
          <p role="alert" className="text-sm text-reject">
            {error}
          </p>
        ) : null}
      </div>
      <Button type="submit" size="lg" disabled={busy || token.trim() === ""} className="h-10 px-4">
        {busy ? "Checking..." : "Continue"}
      </Button>
    </form>
  );
}
