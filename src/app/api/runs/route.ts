/**
 * POST /api/runs: start a run from an uploaded file (multipart field "file", any type: ingest decides) or from a
 * sample ({ "sample": "<file name>" }, closed list). GET /api/runs: the dashboard rows and KPIs.
 * docs/CONTRACTS.md section 7. Everything in the request is untrusted: it is validated before use and never
 * echoed back, and no path is ever built from it.
 */
import fs from "node:fs";
import { z } from "zod";
import { CONFIG } from "@/lib/config";
import { getDb } from "@/lib/db";
import { sanitizeDisplayName, sha256, tooLargeReason } from "@/lib/pdf";
import { createRun, enqueue } from "@/lib/pipeline";
import { checkRateLimit, refundGlobalSlot } from "@/lib/ratelimit";
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

/** Hash the bytes, store them once as uploads/<hash>.pdf, create the queued run and hand it to the queue (not awaited). */
async function startRun(bytes: Uint8Array, fileName: string): Promise<Response> {
  const hash = sha256(bytes);
  await storeUpload(bytes, hash);
  const runId = createRun(getDb(), { fileName, fileHash: hash });
  void enqueue(runId); // never rejects; the 202 returns at once and the run view polls for progress
  return json({ runId } satisfies CreateRunResponse, { status: 202 });
}

async function fromSample(req: Request): Promise<Response> {
  const body = await readBody(req, MAX_JSON_BYTES);
  if (!body.ok) return apiError(413, "The request body is too large.");
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
  return startRun(bytes, parsed.data.sample);
}

async function fromUpload(req: Request): Promise<Response> {
  // The limit is enforced on the bytes that actually arrive, whatever Content-Length claims. The body goes to a temp
  // file as it arrives (slow or many uploads cost disk, not memory) and is parsed one upload at a time (RT-PIPE-02).
  const spooled = await spoolBody(req, CONFIG.maxFileBytes + MULTIPART_OVERHEAD_BYTES);
  if (!spooled.ok) return apiError(413, `${tooLargeReason(CONFIG.maxFileBytes)}.`);
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
      return startRun(bytes, sanitizeDisplayName(file.name));
    });
  } finally {
    await removeQuietly(spooled.file);
  }
}

export async function POST(req: Request): Promise<Response> {
  const at = Date.now();
  let allowed = false;
  let created = false;
  try {
    // Before the body is read: a limited client costs the server nothing.
    const limit = checkRateLimit(clientIp(req), at);
    if (!limit.ok) {
      return apiError(429, limit.message, { retryAfterSec: limit.retryAfterSec, headers: { "Retry-After": String(limit.retryAfterSec) } });
    }
    allowed = true;
    let res: Response;
    switch (mediaType(req)) {
      case "application/json":
        res = await fromSample(req);
        break;
      case "multipart/form-data":
        res = await fromUpload(req);
        break;
      default:
        res = apiError(400, BAD_CONTENT_TYPE);
    }
    created = res.status === 202; // only startRun answers 202, right after createRun
    return res;
  } catch (e) {
    return serverError("POST /api/runs", e);
  } finally {
    // the hourly cap protects model credit, so only a request that created a run spends it (RT-PIPE-03)
    if (allowed && !created) refundGlobalSlot(at);
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
