import Link from "next/link";
import { FileCheck2 } from "lucide-react";
import { NavLinks } from "./nav-links";

/**
 * The site header (banner landmark): the app name on the left, the main navigation on the right. On a phone
 * the navigation drops to a second row. Sticky from the md breakpoint up. Server component; the active-link
 * logic lives in the NavLinks client component.
 */
export function AppHeader() {
  return (
    <header className="z-40 border-b bg-card md:sticky md:top-0">
      <div className="mx-auto flex w-full max-w-[90rem] flex-wrap items-center justify-between gap-x-6 gap-y-1 px-4 py-2 sm:px-6 lg:px-8">
        <Link href="/" className="flex items-center gap-3 rounded-lg py-1">
          <span
            aria-hidden="true"
            className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground"
          >
            <FileCheck2 className="size-5" />
          </span>
          <span className="flex flex-col leading-tight">
            <span className="text-base font-semibold tracking-tight">Invoice AP Agent</span>
            <span className="hidden text-xs text-muted-foreground sm:block">The model reads, the rules decide</span>
          </span>
        </Link>
        <NavLinks />
      </div>
    </header>
  );
}
