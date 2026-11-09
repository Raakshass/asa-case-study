import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, Bot, Check, Scale, X } from "lucide-react";
import { DecisionBadge } from "@/components/shared/decision-badge";
import { PageHeader } from "@/components/shared/page-header";
import { STAGE_PLAIN } from "@/components/run/stage-plain";
import { Button } from "@/components/ui/button";
import { STAGES, type Decision, type StageKey } from "@/lib/types";

export const metadata: Metadata = {
  title: "How it works",
};

/** Who makes the call at each check: the model only reads (stage 3) and may suggest a PO from a list (stage 7). */
const WHO: Partial<Record<StageKey, string>> = { extract: "AI reads", po_match: "Rules decide; AI may suggest" };

/** The ten samples by what they show, in the order a demo runs them. */
const SITUATIONS: readonly { sample: string; situation: string; what: string; decision: Decision; by: StageKey }[] = [
  { sample: "01", situation: "A clean, correct invoice", what: "Every check passes; it is queued for payment on its due date.", decision: "APPROVE", by: "decide" },
  { sample: "02", situation: "Price 1.4% above the PO", what: "Within the 2% tolerance: approved, with a note saying so.", decision: "APPROVE", by: "amounts" },
  { sample: "03", situation: "One PO split across invoices, now over budget", what: "Each invoice looks fine alone; together they exceed what is left on the PO. Held, with the exact overrun.", decision: "HOLD", by: "amounts" },
  { sample: "04", situation: "The same invoice sent again, reformatted", what: "INV0042 is INV-0042, already paid. Rejected so it is not paid twice.", decision: "REJECT", by: "duplicate" },
  { sample: "05", situation: "A scanned invoice with no PO number", what: "The PO is inferred from the vendor's open POs; a person confirms it before payment.", decision: "HOLD", by: "po_match" },
  { sample: "06", situation: "New bank details from a known vendor", what: "Payment-fraud pattern: held until someone calls the number on file.", decision: "HOLD", by: "vendor" },
  { sample: "07", situation: "Same amount as last month (a subscription)", what: "Recurring, not a duplicate: 31 days apart. Approved.", decision: "APPROVE", by: "duplicate" },
  { sample: "08", situation: "A vendor we have not approved", what: "Rejected and sent to vendor onboarding.", decision: "REJECT", by: "vendor" },
  { sample: "09", situation: "Hidden text telling the AI to approve it", what: "Caught before the AI reads it, again by the AI, and by checking values against the page. Held with a security flag.", decision: "HOLD", by: "screen" },
  { sample: "10", situation: "A statement, not an invoice", what: "Not a bill to pay: held and routed to statement handling.", decision: "HOLD", by: "validate" },
];

const stageLabel = (key: StageKey): string => STAGES.find((s) => s.key === key)?.label ?? key;

/**
 * `/how-it-works`: the product explained for someone who does not read code: the ten checks as plain questions, the
 * situations the samples show, and where the AI stops and the rules take over. Static.
 */
export default function HowItWorksPage() {
  return (
    <>
      <PageHeader
        title="How Tollgate decides"
        description="Ten checks, in order, for every invoice. The AI only reads the document; plain rules make every decision, and each decision comes with its reasons and the next step."
        actions={
          <Button asChild size="lg" className="cta-gradient h-10 border-0 px-4">
            <Link href="/runs/new">
              Try it with a sample
              <ArrowRight aria-hidden="true" />
            </Link>
          </Button>
        }
      />

      <div className="space-y-12">
        <section aria-labelledby="checks-heading" className="space-y-4">
          <h2 id="checks-heading" className="text-xl font-semibold tracking-tight">
            The 10 checks
          </h2>
          <ol className="grid gap-3 md:grid-cols-2">
            {STAGES.map((stage) => {
              const plain = STAGE_PLAIN[stage.key];
              const Icon = plain.Icon;
              return (
                <li key={stage.key} className="flex gap-3.5 rounded-xl bg-card p-4 ring-1 ring-border">
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-foreground">
                    <Icon aria-hidden="true" className="size-5" />
                  </span>
                  <span className="min-w-0 space-y-1">
                    <span className="flex flex-wrap items-baseline gap-x-2">
                      <span className="text-sm text-muted-foreground tabular-nums">{stage.idx}.</span>
                      <span className="font-semibold">{stage.label}</span>
                      <span className="text-sm text-muted-foreground">{WHO[stage.key] ?? "Rules decide"}</span>
                    </span>
                    <span className="block text-base">{plain.question}</span>
                    <span className="block text-sm text-muted-foreground">{plain.catches}</span>
                  </span>
                </li>
              );
            })}
          </ol>
        </section>

        <section aria-labelledby="situations-heading" className="space-y-4">
          <div className="space-y-1">
            <h2 id="situations-heading" className="text-xl font-semibold tracking-tight">
              The situations it handles
            </h2>
            <p className="max-w-prose text-sm text-muted-foreground">
              Each sample invoice on the New run page shows one of these. Samples 03, 04, 06 and 09 are the hard cases: they look normal until a check
              compares them with the purchase orders, the vendor records or past invoices.
            </p>
          </div>
          <ul className="grid gap-3 lg:grid-cols-2">
            {SITUATIONS.map((s) => (
              <li key={s.sample} className="space-y-2 rounded-xl bg-card p-4 ring-1 ring-border">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <span className="min-w-0 font-semibold">
                    <span className="font-mono text-sm text-muted-foreground">{s.sample} </span>
                    {s.situation}
                  </span>
                  <DecisionBadge decision={s.decision} size="sm" />
                </div>
                <p className="text-sm text-muted-foreground">{s.what}</p>
                <p className="text-sm">
                  <span className="text-muted-foreground">Caught by </span>
                  {stageLabel(s.by)}
                </p>
              </li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="ai-heading" className="space-y-4">
          <h2 id="ai-heading" className="text-xl font-semibold tracking-tight">
            Where the AI stops and the rules take over
          </h2>
          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-2 rounded-xl bg-card p-4 ring-1 ring-border">
              <p className="flex items-center gap-2 font-semibold">
                <Bot aria-hidden="true" className="size-5 text-primary" />
                The AI
              </p>
              <ul className="space-y-1.5 text-sm">
                {["Reads the invoice into a fixed form: vendor, numbers, dates, lines, bank, PO.", "Reports anything that looks like an instruction aimed at it.", "May suggest one PO from a list the rules already narrowed."].map((t) => (
                  <li key={t} className="flex gap-2"><Check aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-approve" />{t}</li>
                ))}
                {["Never sees the rules, the vendor records or the balances.", "Never approves, holds or rejects anything."].map((t) => (
                  <li key={t} className="flex gap-2"><X aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-reject" />{t}</li>
                ))}
              </ul>
            </div>
            <div className="space-y-2 rounded-xl bg-card p-4 ring-1 ring-border">
              <p className="flex items-center gap-2 font-semibold">
                <Scale aria-hidden="true" className="size-5 text-primary" />
                The rules
              </p>
              <ul className="space-y-1.5 text-sm">
                {["Check every number the AI read against the page itself.", "Compare with purchase orders, approved vendors, bank details on file and past invoices.", "Decide: any reject wins, then any hold; otherwise approve. A security flag can never be approved.", "Write the reason for every check and the next step for your team."].map((t) => (
                  <li key={t} className="flex gap-2"><Check aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-approve" />{t}</li>
                ))}
              </ul>
            </div>
          </div>
        </section>
      </div>
    </>
  );
}
