"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export interface UsePollOptions<T> {
  /**
   * Pause between the END of one request and the START of the next, in milliseconds (so requests can never
   * overlap). Zero, negative or non-finite: fetch once, then only on refresh().
   */
  intervalMs: number;
  /** false: no requests at all (an in-flight one is aborted) and refresh() does nothing. data and error are kept. Default true. */
  enabled?: boolean;
  /** Called with every successful response. Returning true stops the polling (refresh() still works). */
  until?: (data: T) => boolean;
  /** Called with every failure. Returning true gives up (e.g. a 404 that will not fix itself). Default: never give up. */
  stopOnError?: (error: Error) => boolean;
  /**
   * Identifies what is polled (for example the run id). When it changes, data and error are cleared at once,
   * the in-flight request is aborted and polling starts over. Not needed when the target never changes.
   */
  resetKey?: string | number | null;
}

export interface UsePollResult<T> {
  /** The latest successful response; kept while the next request is running and after a failed one. null until the first success. */
  data: T | null;
  /** The latest failure, cleared by the next success. Network errors are transient: polling continues. */
  error: Error | null;
  /** True only until the first request settles (success or failure): show a skeleton, not a spinner on every poll. */
  loading: boolean;
  /**
   * Fetches again now (immediately, or right after the request in flight) and resolves when that request has
   * settled. Never starts a second request in parallel. Resolves at once when disabled or unmounted.
   */
  refresh: () => Promise<void>;
}

interface PollState<T> {
  key: string | number | null;
  data: T | null;
  error: Error | null;
  settled: boolean;
}

/** After failures the pause grows (x2 per failure) but never beyond max(intervalMs, this), so recovery stays quick. */
const BACKOFF_CAP_MS = 2000;

function toError(e: unknown): Error {
  if (e instanceof Error) return e;
  return new Error(typeof e === "string" && e ? e : "Request failed");
}

/** Equal JSON means equal data: keeping the old object stops a poll that changed nothing from re-rendering. */
function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

/**
 * Polls `fetcher` and keeps the latest result in state (client components only).
 *
 * - Fetches immediately on mount, then `intervalMs` after each request has finished: one request at a time.
 * - Aborts the in-flight request (its `signal`) and stops on unmount, when `enabled` turns false and when
 *   `resetKey` changes.
 * - Stops when `until(data)` is true. Keeps the previous `data` while refetching and after errors.
 * - A failed request (network error, HTTP error, anything thrown) is transient: `error` is set, `data` stays and
 *   polling continues (a little slower while it keeps failing) unless `stopOnError` says to give up.
 * - The identity of `fetcher`, `until` and `stopOnError` may change on every render (inline arrows are fine):
 *   the latest ones are used and nothing restarts. Only `enabled`, `intervalMs` and `resetKey` restart polling.
 *
 * The fetcher should throw on failure. To use the helpers of ./api.ts, wrap them in unwrap():
 *
 *   const { data, error, loading, refresh } = usePoll(
 *     (signal) => unwrap(getRun(id, signal)),
 *     { intervalMs: 400, resetKey: id, until: (run) => run.status === "done" || run.status === "error" },
 *   );
 */
export function usePoll<T>(fetcher: (signal: AbortSignal) => Promise<T>, options: UsePollOptions<T>): UsePollResult<T> {
  const { intervalMs, enabled = true, resetKey = null } = options;

  const fetcherRef = useRef(fetcher);
  const untilRef = useRef(options.until);
  const stopOnErrorRef = useRef(options.stopOnError);
  // Declared before the polling effect so the refs are current when its first request starts.
  useEffect(() => {
    fetcherRef.current = fetcher;
    untilRef.current = options.until;
    stopOnErrorRef.current = options.stopOnError;
  });

  const [state, setState] = useState<PollState<T>>({ key: resetKey, data: null, error: null, settled: false });
  // State that belongs to a previous resetKey is ignored on the very render where the key changes (no stale flash).
  const current: PollState<T> =
    state.key === resetKey ? state : { key: resetKey, data: null, error: null, settled: false };

  const controlRef = useRef<{ refresh: () => Promise<void> } | null>(null);
  const refresh = useCallback(() => controlRef.current?.refresh() ?? Promise.resolve(), []);

  useEffect(() => {
    if (!enabled) return;

    const repeat = Number.isFinite(intervalMs) && intervalMs > 0;
    let disposed = false;
    let inFlight = false;
    let stopped = false;
    let wantRefresh = false;
    let failures = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let controller: AbortController | null = null;
    let waiters: Array<() => void> = [];
    let waitingForVisible = false;

    const clearTimer = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };

    /** What to do when a request has settled: a requested refresh first, else the next poll unless stopped. */
    const afterRun = () => {
      if (wantRefresh) {
        void run();
        return;
      }
      if (stopped || !repeat) return;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        // a hidden tab does not poll; the next request goes out when it is shown again (review round B11)
        if (!waitingForVisible) {
          waitingForVisible = true;
          document.addEventListener("visibilitychange", onVisible);
        }
        return;
      }
      const delay =
        failures === 0
          ? intervalMs
          : Math.min(intervalMs * 2 ** Math.min(failures, 4), Math.max(intervalMs, BACKOFF_CAP_MS));
      timer = setTimeout(() => {
        timer = null;
        void run();
      }, delay);
    };

    const run = async (): Promise<void> => {
      if (disposed || inFlight) return;
      clearTimer();
      inFlight = true;
      wantRefresh = false;
      const served = waiters;
      waiters = [];
      const ctl = new AbortController();
      controller = ctl;
      try {
        const data = await fetcherRef.current(ctl.signal);
        if (disposed || ctl.signal.aborted) return;
        failures = 0;
        setState((prev) =>
          prev.key === resetKey && prev.settled && prev.error === null && sameJson(prev.data, data)
            ? prev
            : { key: resetKey, data, error: null, settled: true },
        );
        try {
          stopped = untilRef.current ? Boolean(untilRef.current(data)) : false;
        } catch {
          stopped = false; // a throwing predicate must not kill the polling loop
        }
      } catch (e) {
        if (disposed || ctl.signal.aborted) return;
        failures += 1;
        const error = toError(e);
        setState((prev) =>
          prev.key === resetKey && prev.settled && prev.error?.message === error.message
            ? prev
            : { key: resetKey, data: prev.key === resetKey ? prev.data : null, error, settled: true },
        );
        try {
          stopped = stopOnErrorRef.current ? Boolean(stopOnErrorRef.current(error)) : false;
        } catch {
          stopped = false;
        }
      } finally {
        inFlight = false;
        if (controller === ctl) controller = null;
        for (const done of served) done();
        if (!disposed) afterRun();
      }
    };

    const onVisible = () => {
      if (document.visibilityState === "hidden") return;
      document.removeEventListener("visibilitychange", onVisible);
      waitingForVisible = false;
      void run();
    };

    controlRef.current = {
      refresh: () =>
        new Promise<void>((resolve) => {
          if (disposed) {
            resolve();
            return;
          }
          waiters.push(resolve);
          if (inFlight) {
            wantRefresh = true; // the request in flight may predate the change: fetch once more right after it
            return;
          }
          void run();
        }),
    };

    void run();

    return () => {
      disposed = true;
      clearTimer();
      document.removeEventListener("visibilitychange", onVisible);
      controller?.abort();
      controlRef.current = null;
      for (const done of waiters) done();
      waiters = [];
    };
  }, [enabled, intervalMs, resetKey]);

  return { data: current.data, error: current.error, loading: enabled && !current.settled, refresh };
}
