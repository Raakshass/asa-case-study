import type { Metadata } from "next";
import { AutomationsList } from "@/components/automations/automations-list";
import { NewAutomationButton } from "@/components/automations/new-automation-dialog";
import { PageHeader } from "@/components/shared/page-header";

export const metadata: Metadata = {
  title: "Automations",
};

/**
 * `/automations`: the automations (plan A7). A static shell; AutomationsList (a client component) loads
 * GET /api/automations and keeps it fresh. Automations only route what the agent decided: they never change a decision.
 */
export default function AutomationsPage() {
  return (
    <>
      <PageHeader
        title="Automations"
        description="Steps that run by themselves after an invoice is decided: notes, assignments and messages to other tools. They never change a decision."
        actions={<NewAutomationButton />}
      />
      <AutomationsList />
    </>
  );
}
