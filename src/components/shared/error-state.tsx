"use client";

import { CircleAlert, RotateCw } from "lucide-react";
import { cn } from "cn";
import { Button } from "@/components/ui/button";

export interface ErrorStateProps {
  /** Short heading. Default "Something went wrong". */
  title?: string;
  /** What happened, as plain text (it is rendered as text, never as HTML). */
  message: string;
  /** Adds a "Try again" button that calls this. Omit for errors that retrying cannot fix. */
  onRetry?: () => void;
  /** Button text. Default "Try again". */
  retryLabel?: string;
  /** Disables the button and spins its icon while a retry is running. */
  retrying?: boolean;
  className?: string;
}

/**
 * Red notice with an icon, a message and an optional retry button (a real <button>). It is an alert region,
 * so it is announced when it appears. Client component only because of the button's click handler.
 */
export function ErrorState({
  title = "Something went wrong",
  message,
  onRetry,
  retryLabel = "Try again",
  retrying = false,
  className,
}: ErrorStateProps) {
  return (
    <div
      role="alert"
      data-error-state="true"
      className={cn(
        "flex flex-col gap-3 rounded-xl border border-reject-border bg-reject-soft p-4 sm:flex-row sm:items-center sm:gap-4",
        className,
      )}
    >
      <CircleAlert aria-hidden="true" className="size-5 shrink-0 text-reject" />
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="font-medium text-reject">{title}</p>
        <p className="text-sm break-words text-foreground">{message}</p>
      </div>
      {onRetry ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={retrying}
          onClick={() => onRetry()}
          className="shrink-0 self-start sm:self-center"
        >
          <RotateCw aria-hidden="true" className={retrying ? "animate-spin" : undefined} />
          {retrying ? "Retrying" : retryLabel}
        </Button>
      ) : null}
    </div>
  );
}
