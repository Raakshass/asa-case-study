import { cn } from "cn";
import { formatUsd } from "@/lib/format";

export interface MoneyProps {
  /** Amount in USD. null, undefined or a non-finite number shows `fallback`. */
  value: number | null | undefined;
  /** Shown when there is no amount. Default "–". */
  fallback?: string;
  className?: string;
}

/**
 * A USD amount via formatUsd ("$3,000.00"), in tabular figures so columns line up and without wrapping.
 * A negative amount keeps formatUsd's minus sign ("-$24.00"), is tinted red AND carries a screen-reader
 * label "Negative", so the sign never depends on colour. Server-safe (no state, no effects).
 */
export function Money({ value, fallback = "–", className }: MoneyProps) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return (
      <span className={cn("whitespace-nowrap text-muted-foreground", className)}>
        <span aria-hidden="true">{fallback}</span>
        <span className="sr-only">No amount</span>
      </span>
    );
  }
  // Intl prints negative zero as "-$0.00"; show plain zero instead.
  const text = formatUsd(Object.is(value, -0) ? 0 : value);
  const negative = text.startsWith("-");
  return (
    <span
      data-negative={negative ? "true" : undefined}
      className={cn("whitespace-nowrap tabular-nums", negative && "text-reject", className)}
    >
      {negative ? <span className="sr-only">Negative </span> : null}
      {text}
    </span>
  );
}
