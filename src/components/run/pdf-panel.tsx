"use client";

import { useSyncExternalStore } from "react";
import { ExternalLink, FileText, FileX } from "lucide-react";
import { fileUrl } from "@/components/shared/api";
import { Button } from "@/components/ui/button";
import type { RunDetail } from "@/lib/types";
import { displayText } from "./run-format";

/**
 * Phones and tablets: a touch screen with no hover. Mobile browsers cannot show a PDF inside a page (iOS Safari
 * draws the first page as a picture that traps the scroll, Chrome for Android has no viewer and downloads the
 * file), so there the PDF is offered as a button instead of being embedded. A narrow desktop window still embeds it.
 */
const TOUCH_QUERY = "(hover: none) and (pointer: coarse)";

function subscribe(onChange: () => void): () => void {
  const query = window.matchMedia(TOUCH_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

const isTouchPrimary = (): boolean => window.matchMedia(TOUCH_QUERY).matches;
/** On the server nothing is embedded: the file is only requested once the browser knows what it can show. */
const isTouchPrimaryOnServer = (): boolean => true;

export interface PdfPanelProps {
  run: Pick<RunDetail, "file_hash" | "file_name" | "is_history">;
}

/**
 * The invoice as the browser's own PDF viewer shows it (an iframe on /api/files/<hash>). The hash is only used
 * when it is a 64-character lowercase hex string (fileUrl), so no other address can reach the frame. A pre-loaded
 * history record keeps no file: it says so. On a touch screen the PDF is a button that opens it in its own tab.
 */
/**
 * PDF open parameters for the browser's viewer: no thumbnail pane, page fitted to the width. Chrome otherwise opens a
 * framed PDF with its thumbnail sidebar, which leaves the invoice page about 240 px wide (routes-ui UI-4). A fragment
 * is never sent to the server, so the request is still exactly /api/files/<hash>.
 */
const VIEWER_PARAMS = "#navpanes=0&view=FitH";

export function PdfPanel({ run }: PdfPanelProps) {
  const touch = useSyncExternalStore(subscribe, isTouchPrimary, isTouchPrimaryOnServer);
  const file = fileUrl(run.file_hash);
  const url = file === null ? null : `${file}${VIEWER_PARAMS}`;
  const name = displayText(run.file_name, 100);
  const embedded = url !== null && !touch;
  return (
    <section aria-labelledby="pdf-heading" className="overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-border px-4 py-3 sm:px-5">
        <div className="min-w-0">
          <h2 id="pdf-heading" className="text-base font-semibold">
            Invoice PDF
          </h2>
          {name ? (
            <p className="truncate text-xs text-muted-foreground" title={name}>
              {name}
            </p>
          ) : null}
        </div>
        {embedded ? (
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-6 shrink-0 items-center gap-1.5 rounded-sm text-sm font-medium text-primary underline underline-offset-4 hover:text-primary/80"
          >
            Open in a new tab
            <ExternalLink aria-hidden="true" className="size-3.5" />
          </a>
        ) : null}
      </div>
      {embedded ? (
        <iframe
          src={url}
          title={name ? `Invoice PDF: ${name}` : "Invoice PDF"}
          referrerPolicy="no-referrer"
          className="block h-[34rem] w-full bg-muted sm:h-[38rem] lg:h-[44rem]"
        />
      ) : url !== null ? (
        <div className="flex flex-col items-center gap-3 px-6 py-10 text-center">
          <span aria-hidden="true" className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <FileText className="size-6" />
          </span>
          <div className="space-y-1">
            <p className="text-base font-medium">Open the invoice PDF</p>
            <p className="mx-auto max-w-xs text-sm text-muted-foreground">A phone or tablet cannot show a PDF inside the page, so it opens in its own tab.</p>
          </div>
          <Button asChild size="lg">
            <a href={url} target="_blank" rel="noopener noreferrer">
              Open the PDF
              <ExternalLink aria-hidden="true" />
            </a>
          </Button>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-3 px-6 py-14 text-center">
          <span aria-hidden="true" className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <FileX className="size-6" />
          </span>
          <div className="space-y-1">
            <p className="text-base font-medium">No PDF stored</p>
            <p className="mx-auto max-w-xs text-sm text-muted-foreground">
              {run.is_history ? "Pre-loaded history records were processed before the demo and keep no file." : "No file is stored for this run."}
            </p>
          </div>
        </div>
      )}
    </section>
  );
}
