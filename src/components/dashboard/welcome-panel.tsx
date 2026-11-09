"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowRight, BookOpen, FileUp, Gavel, Sparkles, X } from "lucide-react";
import { PRODUCT_PITCH } from "@/components/brand/brand";
import { DotWordmark } from "@/components/brand/dot-wordmark";
import { Button } from "@/components/ui/button";

const HIDDEN_KEY = "tollgate:welcome-hidden";

const STEPS = [
  { Icon: FileUp, title: "Bring an invoice", text: "Upload a PDF, or pick one of ten sample invoices, each built to show one situation." },
  { Icon: Sparkles, title: "Watch the 10 checks", text: "It screens the file, the AI reads it, and the rules check it against your POs, vendors and past invoices, live." },
  { Icon: Gavel, title: "Get a decision you can defend", text: "Approve, Hold or Reject, with every reason and the next step for your team." },
] as const;

function readHidden(): boolean {
  try {
    return window.localStorage.getItem(HIDDEN_KEY) === "1";
  } catch {
    return false;
  }
}
function writeHidden(hidden: boolean): void {
  try {
    if (hidden) window.localStorage.setItem(HIDDEN_KEY, "1");
    else window.localStorage.removeItem(HIDDEN_KEY);
  } catch {
    // storage blocked: the panel simply shows again next time
  }
}

/**
 * The dashboard's welcome for a first-time visitor: the animated wordmark, what the product does in one sentence, the
 * three steps, and where to start. It can be hidden (remembered in this browser only) and brought back with one click.
 * Shown by default, so the server render and a first visit match; a visitor who hid it sees the short strip instead.
 */
export function WelcomePanel() {
  const [hidden, setHidden] = useState(false);
  useEffect(() => setHidden(readHidden()), []);

  if (hidden) {
    return (
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
        New here?
        <button type="button" onClick={() => (writeHidden(false), setHidden(false))} className="min-h-6 rounded-sm font-medium text-primary underline underline-offset-4">
          Show the introduction
        </button>
        <Link href="/how-it-works" className="min-h-6 rounded-sm font-medium text-primary underline underline-offset-4">
          How it works
        </Link>
      </p>
    );
  }

  return (
    <section aria-labelledby="welcome-heading" className="brand-border relative overflow-hidden rounded-2xl p-5 sm:p-7">
      <div aria-hidden="true" className="pointer-events-none absolute -top-24 -right-24 size-72 rounded-full bg-[radial-gradient(closest-side,var(--glow),transparent)]" />
      <button
        type="button"
        onClick={() => (writeHidden(true), setHidden(true))}
        className="absolute top-3 right-3 inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
        aria-label="Hide the introduction"
      >
        <X aria-hidden="true" className="size-4" />
      </button>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] lg:items-center">
        <div className="min-w-0 space-y-4">
          <DotWordmark height={110} className="max-w-[30rem]" />
          <h2 id="welcome-heading" className="text-2xl leading-tight font-semibold tracking-tight sm:text-[1.75rem]">
            Invoices in. <span className="brand-text">Decisions out</span>, with every reason.
          </h2>
          <p className="max-w-prose text-base text-muted-foreground">{PRODUCT_PITCH}</p>
          <div className="flex flex-wrap gap-2 pt-1">
            <Button asChild size="lg" className="cta-gradient h-10 border-0 px-4">
              <Link href="/runs/new">
                Try a sample invoice
                <ArrowRight aria-hidden="true" />
              </Link>
            </Button>
            <Button asChild size="lg" variant="outline" className="h-10 px-4">
              <Link href="/how-it-works">
                <BookOpen aria-hidden="true" />
                How it decides
              </Link>
            </Button>
          </div>
        </div>
        <ol className="grid gap-3 sm:grid-cols-3 lg:grid-cols-1">
          {STEPS.map(({ Icon, title, text }, i) => (
            <li key={title} className="flex gap-3 rounded-xl bg-muted/60 p-3.5 ring-1 ring-border">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-foreground">
                <Icon aria-hidden="true" className="size-5" />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-semibold">
                  <span className="text-muted-foreground">{i + 1}. </span>
                  {title}
                </span>
                <span className="mt-0.5 block text-sm text-muted-foreground">{text}</span>
              </span>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
