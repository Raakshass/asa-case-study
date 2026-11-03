/** GET /api/master: vendors (bank masked) and purchase orders with their balances (docs/CONTRACTS.md section 7). */
import { getDb } from "@/lib/db";
import { json, serverError } from "../_lib/http";
import { loadMaster } from "../_lib/views";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    return json(loadMaster(getDb()));
  } catch (e) {
    return serverError("GET /api/master", e);
  }
}
