/**
 * Typed, never-throwing fetch helpers for the HTTP API of docs/CONTRACTS.md section 7 (owner: UI-foundation).
 *
 * Browser only: the URLs are relative. Every helper resolves to
 *   { ok: true, data }   or   { ok: false, status, error, retryAfterSec? }
 * and never rejects: a network failure is status 0 with a plain message, a non-JSON body (an HTML error page
 * from a proxy, say) becomes a generic message for its status, and a JSON body that does not have the expected
 * top-level shape is reported as an unexpected response instead of crashing the page later.
 *
 * Each helper takes an optional AbortSignal (usePoll passes its own) and has its own timeout.
 * Error texts are short plain sentences meant to be shown as text, never as HTML.
 *
 * From src/lib this file imports only types.ts (client components may import only types.ts and format.ts).
 */
import {
  SHA256_HEX_RE,
  type CreateRunResponse,
  type Decision,
  type MasterResponse,
  type ResetResponse,
  type RunDetail,
  type RunsListResponse,
  type SampleListItem,
} from "@/lib/types";

/**
 * What every helper resolves to. `status` is 0 when no HTTP response arrived (offline, timeout, aborted); `timedOut`
 * is set when it was this helper's own timeout, i.e. the server may still be working on the request (a reset that
 * waits for queued runs keeps going on the server after the browser stops waiting: routes-ui ROUTE-1).
 */
export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; error: string; retryAfterSec?: number; timedOut?: true };

/** The filter values of GET /api/runs?decision=. */
export type RunsFilter = Decision | "security";

export interface RunsQuery {
  decision?: RunsFilter;
  /** 1..200; the server's default is 50. */
  limit?: number;
}

const GET_TIMEOUT_MS = 15_000;
const CREATE_SAMPLE_TIMEOUT_MS = 30_000;
const UPLOAD_TIMEOUT_MS = 120_000;
/** Reset waits for the pipeline queue to drain, so it may take a while. */
const RESET_TIMEOUT_MS = 60_000;
const MAX_ERROR_CHARS = 300;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/* Shallow shape guards: just enough that the pages can rely on the top-level fields they read. */
const isCreateRun = (v: unknown): v is CreateRunResponse => isRecord(v) && typeof v.runId === "string";
const isRunsList = (v: unknown): v is RunsListResponse =>
  isRecord(v) && Array.isArray(v.runs) && isRecord(v.kpis);
const isRunDetail = (v: unknown): v is RunDetail =>
  isRecord(v) &&
  typeof v.id === "string" &&
  typeof v.status === "string" &&
  Array.isArray(v.steps) &&
  Array.isArray(v.decision_reasons);
const isSampleList = (v: unknown): v is SampleListItem[] => Array.isArray(v);
const isMaster = (v: unknown): v is MasterResponse =>
  isRecord(v) && Array.isArray(v.vendors) && Array.isArray(v.purchase_orders);
const isReset = (v: unknown): v is ResetResponse => isRecord(v) && v.ok === true;

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function clip(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > MAX_ERROR_CHARS ? `${clean.slice(0, MAX_ERROR_CHARS - 1)}…` : clean;
}

/** The message shown when the body has no usable `error` string. */
function defaultMessage(status: number): string {
  if (status === 400) return "The request was not accepted.";
  if (status === 403) return "Not allowed.";
  if (status === 404) return "Not found.";
  if (status === 413) return "That file is too large.";
  if (status === 429) return "Too many requests. Wait a moment and try again.";
  if (status >= 500) return `The server had a problem (HTTP ${status}). Try again in a moment.`;
  return `The request failed (HTTP ${status}).`;
}

function fail<T>(status: number, error: string, retryAfterSec?: number): ApiResult<T> {
  return retryAfterSec !== undefined ? { ok: false, status, error, retryAfterSec } : { ok: false, status, error };
}

function positiveSeconds(v: unknown): number | undefined {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.ceil(n) : undefined;
}

/** An AbortController that fires when `external` aborts or after `ms`, and remembers which one it was. */
function withTimeout(external: AbortSignal | undefined, ms: number) {
  const ctl = new AbortController();
  let timedOut = false;
  const onAbort = () => ctl.abort();
  if (external) {
    if (external.aborted) ctl.abort();
    else external.addEventListener("abort", onAbort, { once: true });
  }
  const timer = setTimeout(() => {
    timedOut = true;
    ctl.abort();
  }, ms);
  return {
    signal: ctl.signal,
    timedOut: () => timedOut,
    cleanup: () => {
      clearTimeout(timer);
      external?.removeEventListener("abort", onAbort);
    },
  };
}

interface RequestSpec<T> {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: BodyInit;
  signal?: AbortSignal;
  timeoutMs: number;
  guard: (v: unknown) => v is T;
}

async function request<T>(url: string, spec: RequestSpec<T>): Promise<ApiResult<T>> {
  const link = withTimeout(spec.signal, spec.timeoutMs);
  try {
    const res = await fetch(url, {
      method: spec.method ?? "GET",
      headers: { Accept: "application/json", ...spec.headers },
      body: spec.body,
      signal: link.signal,
      cache: "no-store",
    });
    const body = parseJson(await res.text());
    if (!res.ok) {
      const message = isRecord(body) && typeof body.error === "string" && body.error.trim() ? clip(body.error) : defaultMessage(res.status);
      const retryAfter = positiveSeconds(isRecord(body) ? body.retryAfterSec : undefined) ?? positiveSeconds(res.headers.get("retry-after"));
      return fail(res.status, message, retryAfter);
    }
    if (!spec.guard(body)) return fail(res.status, "The server sent an unexpected response.");
    return { ok: true, data: body };
  } catch {
    // fetch rejects for network failures, aborts and timeouts; a body that cannot be read lands here too.
    if (link.timedOut()) return { ok: false, status: 0, error: "The server took too long to respond. Try again.", timedOut: true };
    if (spec.signal?.aborted) return fail(0, "The request was cancelled.");
    return fail(0, "Could not reach the server. Check your connection and try again.");
  } finally {
    link.cleanup();
  }
}

/** POST /api/runs with a sample file name from GET /api/samples. Resolves `{ runId }` (HTTP 202). */
export function createRunFromSample(sample: string, signal?: AbortSignal): Promise<ApiResult<CreateRunResponse>> {
  return request("/api/runs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sample }),
    signal,
    timeoutMs: CREATE_SAMPLE_TIMEOUT_MS,
    guard: isCreateRun,
  });
}

/** POST /api/runs with the file as multipart field `file`. Resolves `{ runId }`; 413 and 429 arrive as `ok: false`. */
export async function createRunFromFile(file: File, signal?: AbortSignal): Promise<ApiResult<CreateRunResponse>> {
  const form = new FormData();
  try {
    form.append("file", file, file.name);
  } catch {
    return fail(0, "That file could not be read.");
  }
  return request("/api/runs", {
    method: "POST",
    body: form, // no Content-Type header: the browser adds the multipart boundary
    signal,
    timeoutMs: UPLOAD_TIMEOUT_MS,
    guard: isCreateRun,
  });
}

/** GET /api/runs: the newest runs (optionally one decision, or "security") and the KPIs over all runs. */
export function getRuns(query: RunsQuery = {}, signal?: AbortSignal): Promise<ApiResult<RunsListResponse>> {
  const params = new URLSearchParams();
  if (query.decision) params.set("decision", query.decision);
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  const qs = params.toString();
  return request(qs ? `/api/runs?${qs}` : "/api/runs", { signal, timeoutMs: GET_TIMEOUT_MS, guard: isRunsList });
}

/** GET /api/runs/:id: one run with its steps. The id is URL-encoded; the server validates it as a UUID (400 / 404). */
export async function getRun(id: string, signal?: AbortSignal): Promise<ApiResult<RunDetail>> {
  let segment: string;
  try {
    segment = encodeURIComponent(id);
  } catch {
    return fail(400, "That is not a valid run id."); // a lone surrogate cannot be encoded
  }
  return request(`/api/runs/${segment}`, { signal, timeoutMs: GET_TIMEOUT_MS, guard: isRunDetail });
}

/** GET /api/samples: the sample invoice cards (file, title, scenario, expected decision, edge case). */
export function getSamples(signal?: AbortSignal): Promise<ApiResult<SampleListItem[]>> {
  return request("/api/samples", { signal, timeoutMs: GET_TIMEOUT_MS, guard: isSampleList });
}

/** GET /api/master: vendors (bank masked) and purchase orders with invoiced and remaining amounts. */
export function getMaster(signal?: AbortSignal): Promise<ApiResult<MasterResponse>> {
  return request("/api/master", { signal, timeoutMs: GET_TIMEOUT_MS, guard: isMaster });
}

/** POST /api/reset with the token in the `x-reset-token` header. 403 (wrong or disabled) arrives as `ok: false`. */
export async function resetDemo(token: string, signal?: AbortSignal): Promise<ApiResult<ResetResponse>> {
  const trimmed = token.trim();
  if (!trimmed) return fail(0, "Enter the reset token.");
  // A header value must be printable ASCII: anything else would make fetch itself throw.
  if (!/^[\x20-\x7e]+$/.test(trimmed)) return fail(0, "The reset token contains characters that cannot be sent.");
  return request("/api/reset", {
    method: "POST",
    headers: { "x-reset-token": trimmed },
    signal,
    timeoutMs: RESET_TIMEOUT_MS,
    guard: isReset,
  });
}

/** `/api/files/<hash>` for an <iframe src> or a link, or null when `hash` is not a 64-character lowercase hex hash. */
export function fileUrl(hash: string | null | undefined): string | null {
  return typeof hash === "string" && SHA256_HEX_RE.test(hash) ? `/api/files/${hash}` : null;
}

/** What unwrap() throws: the `ok: false` fields of an ApiResult as an Error (message = the error text). */
export class ApiFailure extends Error {
  readonly status: number;
  readonly retryAfterSec?: number;

  constructor(message: string, status: number, retryAfterSec?: number) {
    super(message);
    this.name = "ApiFailure";
    this.status = status;
    this.retryAfterSec = retryAfterSec;
  }
}

/**
 * Turns an ApiResult into its data, or throws ApiFailure. This is the bridge to usePoll, whose fetcher must
 * throw on failure: usePoll((signal) => unwrap(getRun(id, signal)), { ... }).
 */
export async function unwrap<T>(result: Promise<ApiResult<T>>): Promise<T> {
  const r = await result;
  if (r.ok) return r.data;
  throw new ApiFailure(r.error, r.status, r.retryAfterSec);
}
