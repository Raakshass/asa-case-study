import type { Metadata } from "next";
import { RunView } from "@/components/run/run-view";

export const metadata: Metadata = {
  title: "Live run",
};

/**
 * `/runs/:id` the live run view (plan section 9, the screen the demo lives on). The page is a static shell: RunView (a
 * client component) polls GET /api/runs/:id every 400 ms and draws the decision card, the stepper, the PDF and the
 * extracted fields. The id is only ever passed on to the API (which validates it); it is keyed so that moving from
 * one run to another starts with a clean slate (no stage left expanded, nothing polled for the old id).
 */
export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <RunView key={id} id={id} />;
}
