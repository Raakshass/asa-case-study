import type { Metadata } from "next";
import { AutomationEditor } from "@/components/automations/editor";

export const metadata: Metadata = {
  title: "Automation",
};

/**
 * `/automations/[id]`: the editor (plan A10). A static shell; AutomationEditor (a client component) loads the automation and
 * owns everything after that. Next.js 15 passes `params` as a Promise.
 */
export default async function AutomationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <AutomationEditor id={id} />;
}
