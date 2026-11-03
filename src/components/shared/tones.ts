/**
 * Colour tones shared by the badges, chips and tiles (owner: UI-foundation).
 *
 * Every string is a complete, literal Tailwind class list (never built from pieces), so Tailwind's source
 * scan finds the classes. The colours come from the semantic tokens in src/app/globals.css, which are
 * checked for WCAG AA: soft = ink on a pale surface (7:1 or better), solid = white or dark text on a fill.
 *
 * Colour is only ever a second signal: components that use a tone always add an icon and a text label.
 */

/** approve = green, hold = amber, reject = red, security = violet, info = the accent blue, neutral = grey. */
export type Tone = "approve" | "hold" | "reject" | "security" | "info" | "neutral";

/** Pale surface, tinted border, dark ink: the default look of badges and chips. */
export const SOFT_TONE: Record<Tone, string> = {
  approve: "border-approve-border bg-approve-soft text-approve",
  hold: "border-hold-border bg-hold-soft text-hold",
  reject: "border-reject-border bg-reject-soft text-reject",
  security: "border-security-border bg-security-soft text-security",
  info: "border-primary/25 bg-accent text-accent-foreground",
  neutral: "border-border bg-muted text-muted-foreground",
};

/** Saturated fill with a contrasting text colour: for the one big badge that must be seen from across the room. */
export const SOLID_TONE: Record<Tone, string> = {
  approve: "border-transparent bg-approve-solid text-approve-solid-foreground",
  hold: "border-transparent bg-hold-solid text-hold-solid-foreground",
  reject: "border-transparent bg-reject-solid text-reject-solid-foreground",
  security: "border-transparent bg-security-solid text-security-solid-foreground",
  info: "border-transparent bg-primary text-primary-foreground",
  neutral: "border-transparent bg-foreground text-background",
};

/** Text and icon colour only, for use on white or page-grey surfaces (every ink is 4.5:1 or better there). */
export const INK_TONE: Record<Tone, string> = {
  approve: "text-approve",
  hold: "text-hold",
  reject: "text-reject",
  security: "text-security",
  info: "text-primary",
  neutral: "text-muted-foreground",
};
