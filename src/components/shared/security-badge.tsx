import { ShieldAlert } from "lucide-react";
import { cn } from "cn";
import { INK_TONE, STAMP_TONE } from "./tones";

const SIZE = {
  sm: "gap-1 text-sm [&_svg]:size-4",
  md: "gap-1.5 text-sm [&_svg]:size-4",
  lg: "gap-2 text-base [&_svg]:size-5",
} as const;

export interface SecurityBadgeProps {
  /** Text next to the shield. Default "Security flag". */
  label?: string;
  size?: keyof typeof SIZE;
  /** soft: quiet icon and word (default). solid: a violet stamp. */
  variant?: "soft" | "solid";
  className?: string;
}

/**
 * Shield icon + text, shown next to the decision badge of a security-flagged run (violet, never colour alone).
 * Server-safe (no state, no effects).
 */
export function SecurityBadge({ label = "Security flag", size = "md", variant = "soft", className }: SecurityBadgeProps) {
  return (
    <span
      data-security-flag="true"
      className={cn(
        "inline-flex w-fit shrink-0 items-center whitespace-nowrap",
        variant === "solid" ? ["stamp", STAMP_TONE.security] : ["font-semibold", SIZE[size], INK_TONE.security],
        className,
      )}
    >
      <ShieldAlert aria-hidden="true" />
      <span>{label}</span>
    </span>
  );
}
