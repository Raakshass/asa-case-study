import Link from "next/link";
import { PRODUCT_TAGLINE } from "@/components/brand/brand";
import { Logo } from "@/components/brand/logo";
import { NavLinks } from "./nav-links";

/**
 * The site header (banner landmark): the Tollgate logo on the left, the main navigation on the right. On a phone the
 * navigation drops to a second row. Sticky from the md breakpoint up, a translucent dark bar with a faint gradient line
 * under it. Server component; the active-link logic lives in the NavLinks client component.
 */
export function AppHeader() {
  return (
    <header className="relative z-40 border-b border-border bg-background/80 backdrop-blur-md md:sticky md:top-0">
      <div className="mx-auto flex w-full max-w-[90rem] flex-wrap items-center justify-between gap-x-6 gap-y-1 px-4 py-2 sm:px-6 lg:px-8">
        {/* Named by its visible text (axe's label-content-name-mismatch), plus "home" for screen readers. */}
        <Link href="/" className="rounded-md py-1">
          <Logo showTagline tagline={PRODUCT_TAGLINE} />
          <span className="sr-only">, home</span>
        </Link>
        <NavLinks />
      </div>
      <div aria-hidden="true" className="brand-fill pointer-events-none absolute inset-x-0 -bottom-px h-px opacity-50" />
    </header>
  );
}
