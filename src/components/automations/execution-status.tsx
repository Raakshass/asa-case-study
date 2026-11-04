import { CircleCheck, CircleX, LoaderCircle, type LucideIcon } from "lucide-react";
import { cn } from "cn";
import { INK_TONE, type Tone } from "@/components/shared/tones";
import type { ExecutionStatus } from "@/lib/types";

export const EXECUTION_STATUS_WORD: Record<ExecutionStatus, string> = { queued: "Queued", running: "Running", success: "Succeeded", error: "Failed" };

const VIEW: Record<ExecutionStatus, { Icon: LucideIcon; tone: Tone; spin: boolean }> = {
  queued: { Icon: LoaderCircle, tone: "info", spin: false },
  running: { Icon: LoaderCircle, tone: "info", spin: true },
  success: { Icon: CircleCheck, tone: "approve", spin: false },
  error: { Icon: CircleX, tone: "reject", spin: false },
};

/** An execution's status as an icon and a word, never colour alone. Server-safe. */
export function ExecutionStatusMark({ status, className }: { status: ExecutionStatus; className?: string }) {
  const { Icon, tone, spin } = VIEW[status];
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-sm font-medium whitespace-nowrap", INK_TONE[tone], className)}>
      <Icon aria-hidden="true" className={cn("size-4", spin && "animate-spin motion-reduce:animate-none")} />
      {EXECUTION_STATUS_WORD[status]}
    </span>
  );
}
