/** GET /api/samples: the sample invoices the start page offers (docs/CONTRACTS.md section 7). */
import { listSamples } from "@/lib/samples";
import { json, serverError } from "../_lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    return json(listSamples());
  } catch (e) {
    return serverError("GET /api/samples", e);
  }
}
