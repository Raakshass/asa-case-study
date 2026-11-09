import type { Metadata } from "next";
import Link from "next/link";
import { Upload } from "lucide-react";
import { DashboardView } from "@/components/dashboard/dashboard-view";
import { PageHeader } from "@/components/shared/page-header";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = {
  title: "Dashboard",
};

/**
 * `/` Dashboard (plan section 9): the ledger bar, the filter buttons and the table of runs. The page itself is a
 * static shell; DashboardView (a client component) loads and refreshes the data through GET /api/runs.
 */
export default function DashboardPage() {
  return (
    <>
      <PageHeader
        title="Dashboard"
        description="Every invoice Tollgate has checked, newest first, with its decision and why. It refreshes by itself."
        actions={
          <Button asChild size="lg">
            <Link href="/runs/new">
              <Upload aria-hidden="true" />
              New run
            </Link>
          </Button>
        }
      />
      <DashboardView />
    </>
  );
}
