import { ShieldAlert } from "lucide-react";
import { cn } from "cn";
import { SOFT_TONE, SOLID_TONE } from "./tones";

const SIZE = {
  sm: "h-5 gap-1 px-1.5 text-[11px] [&_svg]:size-3",
  md: "h-6 gap-1.5 px-2.5 text-xs [&_svg]:size-3.5",
  lg: "h-10 gap-2 px-4 text-base [&_svg]:size-5",
} as const;

export interface SecurityBadgeProps {
  /** Text next to the shield. Default "Security flag". */
  label?: string;
  size?: keyof typeof SIZE;
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
        "inline-flex w-fit shrink-0 items-center justify-center rounded-full border font-semibold tracking-wide whitespace-nowrap uppercase",
        SIZE[size],
        (variant === "solid" ? SOLID_TONE : SOFT_TONE).security,
        className,
      )}
    >
      <ShieldAlert aria-hidden="true" />
      <span>{label}</span>
    </span>
  );
}
