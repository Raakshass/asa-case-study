import type { Metadata } from "next";
import "./globals.css";
import { PRODUCT_NAME, PRODUCT_TAGLINE } from "@/components/brand/brand";
import { AppHeader } from "@/components/shared/app-header";
import { TooltipProvider } from "@/components/ui/tooltip";

// Fonts are self-hosted (src/app/fonts, declared in globals.css): no external request, so the app works offline
// and under a strict Content-Security-Policy.

export const metadata: Metadata = {
  title: {
    default: `${PRODUCT_NAME}: ${PRODUCT_TAGLINE}`,
    template: `%s | ${PRODUCT_NAME}`,
  },
  description:
    "Screens, reads and checks vendor invoices against purchase orders, vendors and past invoices, then decides Approve, Hold or Reject with every reason: the model reads, the rules decide.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="flex min-h-dvh flex-col">
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-lg focus:bg-primary focus:px-4 focus:py-2.5 focus:text-sm focus:font-medium focus:text-primary-foreground focus:shadow-lg"
        >
          Skip to content
        </a>
        {/* Tooltip (shadcn) only works inside a provider; renders no DOM of its own. */}
        <TooltipProvider delayDuration={300}>
          <AppHeader />
          {/* Pages render their content only: never a second <main>. */}
          <main
            id="main-content"
            tabIndex={-1}
            className="mx-auto w-full max-w-[90rem] flex-1 px-4 py-6 outline-none sm:px-6 sm:py-8 lg:px-8"
          >
            {children}
          </main>
        </TooltipProvider>
      </body>
    </html>
  );
}
