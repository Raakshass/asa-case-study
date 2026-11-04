import type { ReactNode } from "react";
import { cn } from "cn";

/** An identifier compared character by character (invoice, PO, account number): Atkinson Hyperlegible Mono, so O/0 and l/1 differ. */
export function Ident({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("font-mono text-[0.95em]", className)}>{children}</span>;
}
