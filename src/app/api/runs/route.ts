/**
 * POST /api/runs: start a run from an uploaded file (multipart field "file", any type: ingest decides) or from a
 * sample ({ "sample": "<file name>" }, closed list). GET /api/runs: the dashboard rows and KPIs.
 * docs/CONTRACTS.md section 7. Everything in the request is untrusted: it is validated before use and never
 * echoed back, and no path is ever built from it.
 *
 * POST, in order (security SEC-6 in the fix round): an upload first needs a place among the uploads in progress
 * (beginUpload: per address and in all; 429 otherwise, counted nowhere); then the rate limit, before the body is read
 * (the per-address minute is recorded, the hourly cap only read); then the body, which must arrive whole within
 * CONFIG.bodyReceiveTimeoutMs (408 otherwise); the hourly slot is taken only right before createRun and given back
 * unless the request answers 202. So a client that stalls or crawls holds no hourly slot and no temp file for long.
 */
import fs from "node:fs";
import { z } from "zod";
import { CONFIG } from "@/lib/config";
import { getDb } from "@/lib/db";
import { sanitizeDisplayName, sha256, tooLargeReason } from "@/lib/pdf";
import { createRun, enqueue } from "@/lib/pipeline";
import { type RateLimitResult, type UploadSlot, beginUpload, checkRateLimit, refundGlobalSlot, takeGlobalSlot } from "@/lib/ratelimit";
import { SampleFileSchema, samplePdfPath } from "@/lib/samples";
import type { CreateRunResponse } from "@/lib/types";
import { apiError, clientIp, json, mediaType, readBody, serverError } from "../_lib/http";
import { oneUploadAtATime, removeQuietly, spoolBody, storeUpload } from "../_lib/uploads";
import { type RunFilter, listRuns } from "../_lib/views";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Room for the multipart framing (boundaries, part headers, other small fields) around a file of maxFileBytes. */
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;
/** A JSON body is {"sample": "<file name>"}; anything near this size is not one. */
const MAX_JSON_BYTES = 8 * 1024;

const SampleBodySchema = z.object({ sample: SampleFileSchema });

const BAD_CONTENT_TYPE = 'Send a multipart upload with a "file" field, or JSON like {"sample": "<sample file name>"}.';

/** When this request took its hourly slot (takeGlobalSlot), so POST can give it back unless a run was created. */
interface HourlySlot {
  at: number | null;
}

/** 429 with Retry-After, from a refusal of the limiter or of the upload cap (fixed text, never the request's). */
function tooMany(limit: RateLimitResult): Response {
  return apiError(429, limit.message, { retryAfterSec: limit.retryAfterSec, headers: { "Retry-After": String(limit.retryAfterSec) } });
}

/** 408: the body did not arrive whole within CONFIG.bodyReceiveTimeoutMs (security SEC-6). Fixed text. */
function tooSlow(what: "upload" | "request"): Response {
  const sec = Math.ceil(CONFIG.bodyReceiveTimeoutMs / 1000);
  return apiError(
    408,
    what === "upload"
      ? `The upload did not arrive within ${sec} s, so it was stopped. Check your connection and try again, or send a smaller file.`
      : `The request did not arrive within ${sec} s, so it was stopped. Check your connection and try again.`,
  );
}

/**
 * Takes the hourly slot, then hashes the bytes, stores them once as uploads/<hash>.pdf, creates the queued run and
 * hands it to the queue (not awaited).
 */
async function startRun(bytes: Uint8Array, fileName: string, hourly: HourlySlot): Promise<Response> {
  // Only now that the whole body is here (security SEC-6: an upload that stalls holds no slot). The cap is checked
  // again: other requests may have taken the last slot since this one passed the door.
  const at = Date.now();
  const slot = takeGlobalSlot(at);
  if (!slot.ok) return tooMany(slot);
  hourly.at = at;
  const hash = sha256(bytes);
  await storeUpload(bytes, hash);
  const runId = createRun(getDb(), { fileName, fileHash: hash });
  void enqueue(runId); // never rejects; the 202 returns at once and the run view polls for progress
  return json({ runId } satisfies CreateRunResponse, { status: 202 });
}

async function fromSample(req: Request, hourly: HourlySlot): Promise<Response> {
  const body = await readBody(req, MAX_JSON_BYTES);
  if (!body.ok) return body.reason === "timeout" ? tooSlow("request") : apiError(413, "The request body is too large.");
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body.bytes));
  } catch {
    return apiError(400, "The request body is not valid JSON.");
  }
  const parsed = SampleBodySchema.safeParse(value);
  if (!parsed.success) return apiError(400, 'Unknown sample. Send {"sample": "<one of the listed sample file names>"}.');
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await fs.promises.readFile(samplePdfPath(parsed.data.sample)));
  } catch {
    return apiError(404, "That sample is not available on this server.");
  }
  return startRun(bytes, parsed.data.sample, hourly);
}

async function fromUpload(req: Request, hourly: HourlySlot): Promise<Response> {
  // The limit is enforced on the bytes that actually arrive, whatever Content-Length claims. The body goes to a temp
  // file as it arrives (slow or many uploads cost disk, not memory) and is parsed one upload at a time (RT-PIPE-02).
  // It must arrive whole within CONFIG.bodyReceiveTimeoutMs; spoolBody removes the temp file when it does not (SEC-6).
  const spooled = await spoolBody(req, CONFIG.maxFileBytes + MULTIPART_OVERHEAD_BYTES);
  if (!spooled.ok) return spooled.reason === "timeout" ? tooSlow("upload") : apiError(413, `${tooLargeReason(CONFIG.maxFileBytes)}.`);
  try {
    return await oneUploadAtATime(async () => {
      let form: FormData;
      try {
        const raw = await fs.promises.readFile(spooled.file);
        form = await new Response(raw, { headers: { "content-type": req.headers.get("content-type") ?? "" } }).formData();
      } catch {
        return apiError(400, "The upload could not be read as multipart form data.");
      }
      const files = form.getAll("file");
      if (files.length === 0) return apiError(400, 'Missing file: send the PDF as the multipart field "file".');
      if (files.length > 1) return apiError(400, 'Send exactly one file in the "file" field.');
      const file = files[0];
      if (typeof file === "string") return apiError(400, 'The "file" field must be a file upload.');
      if (file.size > CONFIG.maxFileBytes) return apiError(413, `${tooLargeReason(CONFIG.maxFileBytes)}.`);
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (bytes.byteLength > CONFIG.maxFileBytes) return apiError(413, `${tooLargeReason(CONFIG.maxFileBytes)}.`);
      return startRun(bytes, sanitizeDisplayName(file.name), hourly);
    });
  } finally {
    await removeQuietly(spooled.file);
  }
}

export async function POST(req: Request): Promise<Response> {
  let upload: UploadSlot | null = null;
  const hourly: HourlySlot = { at: null };
  let created = false;
  try {
    const ip = clientIp(req);
    const kind = mediaType(req);
    if (kind === "multipart/form-data") {
      // A place among the uploads in progress (per address and in all) before anything else: a refusal costs nothing,
      // is counted nowhere and never touches the body (security SEC-6).
      upload = beginUpload(ip);
      if (!upload.ok) return tooMany(upload);
    }
    // Before the body is read: a limited client costs the server nothing. The hourly cap is only read here; the slot
    // is taken in startRun once the body has arrived (SEC-6).
    const limit = checkRateLimit(ip, Date.now(), { recordGlobal: false });
    if (!limit.ok) return tooMany(limit);
    let res: Response;
    switch (kind) {
      case "application/json":
        res = await fromSample(req, hourly);
        break;
      case "multipart/form-data":
        res = await fromUpload(req, hourly);
        break;
      default:
        res = apiError(400, BAD_CONTENT_TYPE);
    }
    created = res.status === 202; // only startRun answers 202, right after createRun
    return res;
  } catch (e) {
    return serverError("POST /api/runs", e);
  } finally {
    upload?.release();
    // the hourly cap protects model credit, so only a request that created a run spends it (RT-PIPE-03)
    if (hourly.at !== null && !created) refundGlobalSlot(hourly.at);
  }
}

const DEFAULT_LIMIT = 50;
const QuerySchema = z.object({
  decision: z.enum(["APPROVE", "HOLD", "REJECT", "security"]).optional(),
  limit: z
    .string()
    .regex(/^\d{1,3}$/)
    .transform(Number)
    .pipe(z.number().int().min(1).max(200))
    .optional(),
});

/** An empty value ("?decision=&limit=50", as in the plan's route table) counts as not given. */
const given = (value: string | null): string | undefined => (value === null || value === "" ? undefined : value);

export async function GET(req: Request): Promise<Response> {
  try {
    const params = new URL(req.url).searchParams;
    const repeated = ["decision", "limit"].some((name) => params.getAll(name).length > 1);
    const parsed = QuerySchema.safeParse({ decision: given(params.get("decision")), limit: given(params.get("limit")) });
    if (repeated || !parsed.success) {
      return apiError(400, "Invalid query: decision must be APPROVE, HOLD, REJECT or security, and limit a whole number from 1 to 200.");
    }
    const filter: RunFilter | null = parsed.data.decision ?? null;
    return json(listRuns(getDb(), { filter, limit: parsed.data.limit ?? DEFAULT_LIMIT }));
  } catch (e) {
    return serverError("GET /api/runs", e);
  }
}
