"use client";

import { useCallback, useRef, useState, type ReactNode } from "react";
import type { ApiResult } from "@/components/shared/api";
import { forgetToken, readSavedToken, saveToken } from "@/components/shared/operator-token";
import { TokenPrompt } from "./token-prompt";

type Action<T> = (token: string) => Promise<ApiResult<T>>;

interface Pending {
  action: Action<unknown>;
  onDone: (result: ApiResult<unknown>) => void;
  reason: string;
  error: string | null;
}

/**
 * Runs an action that needs the operator token. With a token stored in this tab the action runs at once; without one
 * `prompt` shows the token form and the action runs when it is submitted. The server's answer decides: accepted, the token
 * is kept for the tab; a 403, it is forgotten and the form asks again ("That token was not accepted."); anything else is
 * handed to `onDone` as it is. `prompt` is a node to render wherever the form belongs (null when nothing is asked).
 */
export function useTokenAction(): { run: <T>(reason: string, action: Action<T>, onDone: (result: ApiResult<T>) => void) => void; prompt: ReactNode; busy: boolean; cancel: () => void } {
  const [ask, setAsk] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);

  const attempt = useCallback(async (token: string, pending: Pending) => {
    setBusy(true);
    const result = await pending.action(token);
    if (!alive.current) return;
    setBusy(false);
    if (result.ok) {
      saveToken(token);
      setAsk(null);
      pending.onDone(result);
    } else if (result.status === 403) {
      forgetToken();
      setAsk({ ...pending, error: "That token was not accepted." });
    } else {
      setAsk(null);
      pending.onDone(result);
    }
  }, []);

  const run = useCallback(
    <T,>(reason: string, action: Action<T>, onDone: (result: ApiResult<T>) => void) => {
      const pending: Pending = { action: action as Action<unknown>, onDone: onDone as (result: ApiResult<unknown>) => void, reason, error: null };
      const token = readSavedToken();
      if (token === "") setAsk(pending);
      else void attempt(token, pending);
    },
    [attempt],
  );

  const prompt = ask ? <TokenPrompt reason={ask.reason} error={ask.error} busy={busy} onSubmit={(token) => void attempt(token, ask)} /> : null;
  return { run, prompt, busy, cancel: () => setAsk(null) };
}
