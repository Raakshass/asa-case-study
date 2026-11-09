import type { Metadata } from "next";
import { PageHeader } from "@/components/shared/page-header";
import { StartView } from "@/components/start/start-view";

export const metadata: Metadata = {
  title: "New run",
};

/**
 * `/runs/new` Start a run (plan section 9): upload a PDF or run a sample, and the reset control. The page is a
 * static shell; StartView (a client component) does the uploading and the navigation to /runs/<id>.
 */
export default function NewRunPage() {
  return (
    <>
      <PageHeader
        title="Start a run"
        description="Upload a vendor invoice PDF, or run one of the ready-made samples. You will watch all 10 checks run, then get the decision and the reasons."
      />
      <StartView />
    </>
  );
}
