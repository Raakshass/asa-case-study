/**
 * The uploads directory (DATA_DIR/uploads/<sha256>.pdf), content-addressed: the file name is the hash of its own
 * bytes and nothing the client sent is ever part of a path. Server-only.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CONFIG, paths, uploadPath } from "@/lib/config";
import { type BodyFailure, bodyDeadline, declaredLength } from "./http";

/** The only names the reset route is allowed to delete. */
export const UPLOAD_FILE_RE = /^[a-f0-9]{64}\.pdf$/;

export type SpooledBody = { ok: true; file: string; size: number } | { ok: false; reason: BodyFailure };

/**
 * Streams the request body into a new temp file in the uploads directory, never more than `maxBytes`, without
 * holding it in memory (red team RT-PIPE-02: buffering every upload whole cost ~37 MB of RSS per 10 MB upload, so 60
 * at once added 2.2 GB). A declared Content-Length above the limit is refused before a byte is read; the bytes that
 * arrive are counted too (the header can lie, or be absent) and reading stops as soon as the limit is crossed
 * ("too_large"). The whole body must arrive within `timeoutMs` (default CONFIG.bodyReceiveTimeoutMs, read at call
 * time; security SEC-6): otherwise reading stops and the result is "timeout". On either failure the temp file is
 * already removed. The caller owns a returned file and must remove it (removeQuietly). The name never matches
 * UPLOAD_FILE_RE.
 */
export async function spoolBody(req: Request, maxBytes: number, timeoutMs: number = CONFIG.bodyReceiveTimeoutMs): Promise<SpooledBody> {
  const declared = declaredLength(req);
  if (declared !== null && declared > maxBytes) return { ok: false, reason: "too_large" };
  const dir = paths.uploadsDir;
  await fs.promises.mkdir(dir, { recursive: true });
  const file = path.join(dir, `.incoming-${crypto.randomUUID()}.tmp`);
  const handle = await fs.promises.open(file, "wx");
  let kept = false;
  try {
    let size = 0;
    if (req.body !== null) {
      const reader = req.body.getReader();
      const deadline = bodyDeadline(reader, timeoutMs);
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (deadline.expired()) return { ok: false, reason: "timeout" };
          if (done) break;
          size += value.byteLength;
          if (size > maxBytes) {
            await reader.cancel().catch(() => undefined);
            return { ok: false, reason: "too_large" };
          }
          for (let at = 0; at < value.byteLength; ) at += (await handle.write(value, at, value.byteLength - at)).bytesWritten;
        }
      } finally {
        deadline.stop();
      }
    }
    kept = true;
    return { ok: true, file, size };
  } finally {
    await handle.close().catch(() => undefined);
    if (!kept) await removeQuietly(file);
  }
}

/** Deletes a temp file; a file that is already gone is fine. */
export async function removeQuietly(file: string): Promise<void> {
  await fs.promises.rm(file, { force: true }).catch(() => undefined);
}

let parseTail: Promise<void> = Promise.resolve();

/**
 * Runs `task` after every task handed in before it has finished: one upload is parsed at a time. Parsing a multipart
 * body needs it whole in memory (about four times the file while the parser and the File copy exist), so this bounds
 * the memory uploads use to one upload's worth, however many arrive at once (RT-PIPE-02). A task takes milliseconds.
 */
export async function oneUploadAtATime<T>(task: () => Promise<T>): Promise<T> {
  const previous = parseTail;
  let release: () => void = () => undefined;
  parseTail = new Promise<void>((resolve) => (release = resolve));
  try {
    await previous;
    return await task();
  } finally {
    release();
  }
}

/**
 * Stores `bytes` as uploads/<hash>.pdf when that file is not there yet. Atomic: the bytes go to a temp file in
 * the same directory (a name the reset sweep never matches) and are renamed into place, so a reader or a crash
 * never sees half a file. `hash` must be the sha256 of `bytes`; uploadPath() throws on anything but 64 hex chars.
 */
export async function storeUpload(bytes: Uint8Array, hash: string): Promise<void> {
  const target = uploadPath(hash);
  const dir = paths.uploadsDir;
  await fs.promises.mkdir(dir, { recursive: true });
  try {
    await fs.promises.access(target);
    return; // same bytes already stored
  } catch {
    // not there yet
  }
  const temp = path.join(dir, `.upload-${crypto.randomUUID()}.tmp`);
  try {
    await fs.promises.writeFile(temp, bytes, { flag: "wx" });
    await fs.promises.rename(temp, target);
  } catch (e) {
    await fs.promises.rm(temp, { force: true }).catch(() => undefined);
    throw e;
  }
}

/** Deletes the regular files named <64 hex>.pdf in the uploads directory and nothing else. Returns how many. */
export async function wipeUploads(): Promise<number> {
  const dir = paths.uploadsDir;
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return 0; // no uploads directory yet
  }
  let deleted = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !UPLOAD_FILE_RE.test(entry.name)) continue; // symlinks, directories and other names stay
    try {
      await fs.promises.unlink(path.join(dir, entry.name));
      deleted++;
    } catch {
      // already gone
    }
  }
  return deleted;
}
