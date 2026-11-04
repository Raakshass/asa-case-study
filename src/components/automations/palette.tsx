"use client";

import { Building, CalendarClock, GitBranch, Inbox, ListChecks, MessageSquareText, ReceiptText, Split, StickyNote, UserCheck, UserRound, Webhook, type LucideIcon } from "lucide-react";
import { NODE_SPECS, type NodeType } from "@/lib/workflow-graph";

/** The dataTransfer type the canvas reads on a drop (it equals PALETTE_DRAG_TYPE of canvas.tsx). */
export const PALETTE_DRAG_MIME = "application/x-automation-step";

/** The icon of each step type (a shape as well as a colour tells the kinds apart). */
export const NODE_ICON: Record<NodeType, LucideIcon> = {
  "trigger.run_finished": Inbox,
  "trigger.review_saved": UserCheck,
  "trigger.schedule": CalendarClock,
  "logic.if": GitBranch,
  "logic.switch_decision": Split,
  "data.vendor": Building,
  "data.po_balance": ReceiptText,
  "data.summarize": ListChecks,
  "action.note": StickyNote,
  "action.assign": UserRound,
  "action.webhook": Webhook,
  "action.chat": MessageSquareText,
};

/** The palette's groups. Starting steps are never in it: the starting step is changed in its own settings. */
export const PALETTE_GROUPS: readonly { title: string; types: readonly NodeType[] }[] = [
  { title: "Decide", types: ["logic.if", "logic.switch_decision"] },
  { title: "Look up", types: ["data.vendor", "data.po_balance", "data.summarize"] },
  { title: "Do", types: ["action.note", "action.assign", "action.webhook", "action.chat"] },
];

export interface PaletteProps {
  onAdd: (type: NodeType) => void;
  disabled?: boolean;
}

/**
 * The steps that can be added. Each is a real button: Enter or a click adds the step after the selected one (the editor
 * decides where); dragging one onto the canvas drops it unconnected where it lands.
 */
export function Palette({ onAdd, disabled = false }: PaletteProps) {
  return (
    <nav aria-label="Steps to add" className="space-y-4">
      <h2 className="text-base font-semibold">Steps to add</h2>
      {PALETTE_GROUPS.map((group) => (
        <div key={group.title} className="space-y-1.5">
          <h3 className="text-sm font-semibold text-muted-foreground">{group.title}</h3>
          <ul className="space-y-1">
            {group.types.map((type) => {
              const Icon = NODE_ICON[type];
              return (
                <li key={type}>
                  <button
                    type="button"
                    draggable={!disabled}
                    disabled={disabled}
                    title={NODE_SPECS[type].description}
                    data-palette={type}
                    onClick={() => onAdd(type)}
                    onDragStart={(e) => {
                      e.dataTransfer.setData(PALETTE_DRAG_MIME, type);
                      e.dataTransfer.effectAllowed = "copy";
                    }}
                    className="flex min-h-8 w-full items-center gap-2 rounded-md bg-card px-2 py-1 text-left text-sm ring-1 ring-foreground/10 hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none disabled:opacity-60"
                  >
                    <Icon aria-hidden="true" className="size-4 shrink-0" />
                    {NODE_SPECS[type].label}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
