import type { Metadata } from "next";
import { DataView } from "@/components/data/data-view";
import { PageHeader } from "@/components/shared/page-header";

export const metadata: Metadata = {
  title: "Procurement data",
};

/**
 * `/data` Procurement data (plan section 9): the purchase orders with their remaining balance (the split-PO case)
 * and the vendors. A static shell; DataView (a client component) loads GET /api/master and keeps it fresh.
 */
export default function DataPage() {
  return (
    <>
      <PageHeader
        title="Procurement data"
        description="The purchase orders and vendors every invoice is checked against, with what is left on each purchase order."
      />
      <DataView />
    </>
  );
}
