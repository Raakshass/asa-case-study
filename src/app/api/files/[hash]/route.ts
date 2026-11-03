/**
 * GET /api/files/:hash: the stored bytes of an upload, for the run view's PDF frame (docs/CONTRACTS.md section 7).
 * HEAD answers the same headers without a body. The hash must be 64 lowercase hex characters, so nothing but a
 * content address ever reaches the file system; files are only read from the uploads directory and no message ever
 * contains a path.
 */
import fs from "node:fs";
import { z } from "zod";
import { uploadPath } from "@/lib/config";
import { SHA256_HEX_RE } from "@/lib/types";
import { apiError, serverError } from "../../_lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HashSchema = z.string().regex(SHA256_HEX_RE);
const CHUNK_BYTES = 64 * 1024;

type Context = { params: Promise<{ hash: string }> };
type Found = { ok: true; file: string; size: number } | { ok: false; res: Response };

/** Validates the hash and stats the stored file (no file handle is opened here). */
async function locate(context: Context): Promise<Found> {
  const params = await context.params;
  const parsed = HashSchema.safeParse(params.hash);
  if (!parsed.success) return { ok: false, res: apiError(400, "Invalid file hash.") };
  const file = uploadPath(parsed.data);
  try {
    const stat = await fs.promises.stat(file);
    if (!stat.isFile()) throw new Error("not a file");
    return { ok: true, file, size: stat.size };
  } catch {
    return { ok: false, res: apiError(404, "File not found.") };
  }
}

function pdfHeaders(size: number): Record<string, string> {
  return {
    "content-type": "application/pdf",
    "x-content-type-options": "nosniff",
    "content-disposition": "inline",
    "content-length": String(size),
    // the URL is the sha256 of the bytes, so what it serves can never change
    "cache-control": "private, max-age=3600, immutable",
  };
}

/**
 * The file as a stream that opens its handle on the FIRST read and closes it at the end, on an error and when the
 * reader cancels. A body that is never read never opens a handle: Next answers HEAD (and any response whose body it
 * drops) without reading or cancelling it, and an eagerly opened FileHandle then stayed open until garbage collection
 * (red team RT-PIPE-06, Node's DEP0137 warning). Never sends more than the `size` the headers announced.
 */
function lazyFileStream(file: string, size: number): ReadableStream<Uint8Array> {
  let handle: fs.promises.FileHandle | null = null;
  let position = 0;
  const close = async (): Promise<void> => {
    const h = handle;
    handle = null;
    if (h !== null) await h.close().catch(() => undefined);
  };
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          handle ??= await fs.promises.open(file, "r");
          const want = Math.min(CHUNK_BYTES, size - position);
          const chunk = new Uint8Array(Math.max(want, 0));
          const { bytesRead } = want > 0 ? await handle.read(chunk, 0, want, position) : { bytesRead: 0 };
          if (bytesRead === 0) {
            await close();
            controller.close();
            return;
          }
          position += bytesRead;
          controller.enqueue(bytesRead === chunk.byteLength ? chunk : chunk.subarray(0, bytesRead));
        } catch {
          await close();
          controller.error(new Error("read failed"));
        }
      },
      cancel: close,
    },
    { highWaterMark: 0 }, // nothing is read (and no handle opened) until the consumer asks
  );
}

export async function GET(_req: Request, context: Context): Promise<Response> {
  try {
    const found = await locate(context);
    if (!found.ok) return found.res;
    return new Response(lazyFileStream(found.file, found.size), { status: 200, headers: pdfHeaders(found.size) });
  } catch (e) {
    return serverError("GET /api/files/:hash", e);
  }
}

export async function HEAD(_req: Request, context: Context): Promise<Response> {
  try {
    const found = await locate(context);
    if (!found.ok) return new Response(null, { status: found.res.status, headers: found.res.headers });
    return new Response(null, { status: 200, headers: pdfHeaders(found.size) });
  } catch (e) {
    const res = serverError("HEAD /api/files/:hash", e);
    return new Response(null, { status: res.status, headers: res.headers });
  }
}
