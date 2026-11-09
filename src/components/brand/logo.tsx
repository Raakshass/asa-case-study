import { cn } from "cn";
import { PRODUCT_NAME } from "./brand";

/** The dots of the mark: a "T" (the gate's posts and its bar) drawn as a 5 by 5 dot matrix, like the wordmark animation. */
const DOTS: readonly { x: number; y: number; o: number }[] = [
  // the bar
  { x: 8, y: 10, o: 0.75 },
  { x: 14, y: 10, o: 0.9 },
  { x: 20, y: 10, o: 1 },
  { x: 26, y: 10, o: 0.9 },
  { x: 32, y: 10, o: 0.75 },
  // the post
  { x: 20, y: 16, o: 1 },
  { x: 20, y: 22, o: 0.95 },
  { x: 20, y: 28, o: 0.9 },
  // the checked notch: the invoice that passed
  { x: 26, y: 24, o: 0.55 },
  { x: 32, y: 18, o: 0.4 },
];

/**
 * The Tollgate mark: a dot-matrix "T" on a tile filled with the brand gradient (teal, violet, coral). `title` gives it an
 * accessible name; without one it is decorative (the wordmark next to it already says the name). Server-safe.
 */
export function LogoMark({ className, title }: { className?: string; title?: string }) {
  const id = "tollgate-mark";
  return (
    <svg viewBox="0 0 40 40" className={cn("shrink-0", className)} role={title ? "img" : undefined} aria-hidden={title ? undefined : true} aria-label={title}>
      <defs>
        <linearGradient id={`${id}-fill`} x1="0" y1="0" x2="40" y2="40" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#2dd4bf" />
          <stop offset="0.5" stopColor="#7c6cff" />
          <stop offset="1" stopColor="#ff7a6b" />
        </linearGradient>
        <radialGradient id={`${id}-shine`} cx="0.3" cy="0.2" r="0.9">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.28" />
          <stop offset="0.6" stopColor="#ffffff" stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect width="40" height="40" rx="10" fill={`url(#${id}-fill)`} />
      <rect width="40" height="40" rx="10" fill={`url(#${id}-shine)`} />
      {DOTS.map((d) => (
        <circle key={`${d.x}-${d.y}`} cx={d.x} cy={d.y} r="2.35" fill="#ffffff" fillOpacity={d.o} />
      ))}
    </svg>
  );
}

/** The mark with the name next to it. */
export function Logo({ className, showTagline = false, tagline }: { className?: string; showTagline?: boolean; tagline?: string }) {
  return (
    <span className={cn("flex items-center gap-2.5", className)}>
      <LogoMark className="size-9" />
      <span className="flex flex-col leading-tight">
        <span className="text-[1.05rem] font-bold tracking-tight">{PRODUCT_NAME}</span>
        {showTagline && tagline ? <span className="hidden text-xs text-muted-foreground sm:block">{tagline}</span> : null}
      </span>
    </span>
  );
}
