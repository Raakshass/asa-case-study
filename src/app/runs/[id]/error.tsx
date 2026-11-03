"use client";

import { ErrorState } from "@/components/shared/error-state";
import { PageHeader } from "@/components/shared/page-header";

/**
 * Catches anything that throws while the run view is drawn (a stored value of a shape nobody expected, say), so a
 * visitor sees a notice with a retry instead of a blank page. The error itself is not shown or logged here: its
 * message may quote text from the invoice, which is untrusted.
 */
export default function RunError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <>
      <PageHeader title="Invoice run" />
      <ErrorState
        title="This page hit a problem"
        message="Something went wrong while showing this run. The run itself is not affected: try again, or open it from the dashboard."
        onRetry={reset}
      />
    </>
  );
}
