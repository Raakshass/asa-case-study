import type { ReactNode } from "react";
import { ShieldAlert } from "lucide-react";
import { cn } from "cn";

/** The banner's headline (plan section 9). */
export const SECURITY_BANNER_TITLE = "Suspicious content detected: this invoice tried to instruct the AI";

export interface SecurityBannerProps {
  /** Replaces the default headline. Plain text. */
  title?: string;
  /** Evidence slot: put EvidenceQuote blocks (or short plain-text paragraphs) here. */
  children?: ReactNode;
  className?: string;
}

/**
 * The shield banner for a security-flagged run: violet surface, shield icon, bold headline and a slot for the
 * quoted evidence (full width on a phone, aligned under the headline from the sm breakpoint). It is an alert
 * region, so it is announced when it appears while a run finishes. Server-safe (no state, no effects).
 */
export function SecurityBanner({ title = SECURITY_BANNER_TITLE, children, className }: SecurityBannerProps) {
  return (
    <div
      role="alert"
      data-security-banner="true"
      className={cn("rounded-xl border border-security-border bg-security-soft p-4 text-foreground sm:p-5", className)}
    >
      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className="flex size-10 shrink-0 items-center justify-center rounded-full bg-security-solid text-security-solid-foreground"
        >
          <ShieldAlert className="size-6" />
        </span>
        <p className="min-w-0 flex-1 pt-1.5 text-base font-semibold text-security sm:text-lg">{title}</p>
      </div>
      {children ? <div className="mt-3 min-w-0 space-y-3 text-sm sm:pl-13">{children}</div> : null}
    </div>
  );
}

export interface EvidenceQuoteProps {
  /** The quoted text. A string on purpose: untrusted text is rendered as plain React text, never as HTML. */
  children: string;
  /** Small caption above the quote, e.g. "Hidden text found in the PDF". */
  label?: string;
  className?: string;
}

/**
 * A verbatim quote of untrusted invoice content (hidden text, an injection phrase, a model-reported
 * suspicious snippet): monospace, original line breaks kept, long words wrapped so it never widens the page.
 * Server-safe.
 */
export function EvidenceQuote({ children, label, className }: EvidenceQuoteProps) {
  return (
    <figure className={cn("min-w-0 space-y-1", className)}>
      {label ? (
        <figcaption className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{label}</figcaption>
      ) : null}
      <blockquote className="rounded-md border border-security-border border-l-4 border-l-security-solid bg-card px-3 py-2 font-mono text-[13px] leading-relaxed break-words whitespace-pre-wrap text-foreground">
        {children}
      </blockquote>
    </figure>
  );
}
