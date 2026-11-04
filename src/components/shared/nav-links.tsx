"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Database, LayoutDashboard, Upload, Workflow, type LucideIcon } from "lucide-react";
import { cn } from "cn";

interface NavItem {
  href: string;
  label: string;
  Icon: LucideIcon;
  /** True when `pathname` belongs to this item's section. */
  isActive: (pathname: string) => boolean;
}

const isNewRun = (pathname: string) => pathname === "/runs/new" || pathname.startsWith("/runs/new/");

/** The four top-level pages. A run page (/runs/<id>) counts as part of the dashboard it is opened from. */
const NAV_ITEMS: readonly NavItem[] = [
  {
    href: "/",
    label: "Dashboard",
    Icon: LayoutDashboard,
    isActive: (p) => p === "/" || (p.startsWith("/runs/") && !isNewRun(p)),
  },
  { href: "/runs/new", label: "New run", Icon: Upload, isActive: isNewRun },
  { href: "/data", label: "Procurement data", Icon: Database, isActive: (p) => p === "/data" || p.startsWith("/data/") },
  { href: "/automations", label: "Automations", Icon: Workflow, isActive: (p) => p === "/automations" || p.startsWith("/automations/") },
];

/**
 * Main navigation: Dashboard, New run, Procurement data, Automations. The current page gets aria-current="page", a tinted
 * background and bolder text (not colour alone). Wraps onto a second line on narrow screens instead of
 * scrolling sideways. Client component because it reads the pathname.
 */
export function NavLinks({ className }: { className?: string }) {
  const pathname = usePathname() ?? "";
  return (
    <nav aria-label="Main" className={className}>
      <ul className="flex flex-wrap items-center gap-1">
        {NAV_ITEMS.map(({ href, label, Icon, isActive }) => {
          const active = isActive(pathname);
          return (
            <li key={href}>
              <Link
                href={href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "inline-flex h-10 items-center gap-2 rounded-md px-3 text-sm whitespace-nowrap transition-colors",
                  active
                    ? "bg-accent font-semibold text-accent-foreground"
                    : "font-medium text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                <Icon aria-hidden="true" className="hidden size-4 sm:block" />
                {label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
