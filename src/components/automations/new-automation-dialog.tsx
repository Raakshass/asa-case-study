"use client";

import { useRouter } from "next/navigation";
import { useId, useRef, useState, type FormEvent } from "react";
import { Plus } from "lucide-react";
import { createAutomation, type AutomationStart } from "@/components/shared/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useTokenAction } from "./use-token-action";

interface Template {
  start: AutomationStart;
  name: string;
  title: string;
  description: string;
}

const TEMPLATES: readonly Template[] = [
  { start: "seed:route-holds", name: "Route holds to the right person", title: "Route holds to the right person", description: "Assigns every hold: security, large, the rest." },
  { start: "seed:chat-rejections", name: "Tell the team about rejections", title: "Tell the team about rejections", description: "Posts each rejection to a chat webhook." },
  { start: "seed:daily-holds", name: "Morning summary of holds", title: "Morning summary of holds", description: "Posts the open holds every day at 08:00." },
  { start: "blank:run_finished", name: "My automation", title: "Blank: starts when an invoice is decided", description: "One starting step; add the rest yourself." },
  { start: "blank:schedule", name: "My scheduled automation", title: "Blank: runs on a schedule", description: "One starting step that fires every hour or day." },
];

/**
 * "New automation": a button that opens a native <dialog> (modal; Escape closes it; focus goes to the name and comes back to
 * the button). Choosing a template fills its name unless the person has typed their own. Create needs the operator token,
 * then opens the editor. The name and the template are the whole form: nothing else is needed to start.
 */
export function NewAutomationButton() {
  const router = useRouter();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const openerRef = useRef<HTMLButtonElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const [start, setStart] = useState<AutomationStart>("seed:route-holds");
  const [name, setName] = useState(TEMPLATES[0].name);
  const [edited, setEdited] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { run, prompt, busy, cancel } = useTokenAction();
  const uid = useId();

  function open() {
    setError(null);
    dialogRef.current?.showModal();
    nameRef.current?.focus();
  }
  function close() {
    cancel();
    dialogRef.current?.close();
    openerRef.current?.focus();
  }
  function choose(template: Template) {
    setStart(template.start);
    if (!edited) setName(template.name);
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = name.trim();
    if (trimmed === "" || busy) return;
    setError(null);
    run(
      "to create an automation",
      (token) => createAutomation({ name: trimmed, start }, token),
      (result) => {
        if (result.ok) {
          dialogRef.current?.close();
          router.push(`/automations/${encodeURIComponent(result.data.id)}`);
        } else setError(result.error);
      },
    );
  }

  return (
    <>
      <Button ref={openerRef} type="button" size="lg" onClick={open} className="h-10 px-3">
        <Plus aria-hidden="true" />
        New automation
      </Button>
      <dialog
        ref={dialogRef}
        aria-labelledby={`${uid}-title`}
        onClose={() => openerRef.current?.focus()}
        className="m-auto w-[min(32rem,calc(100vw-2rem))] rounded-xl bg-card p-0 text-foreground shadow-lg ring-1 ring-foreground/15 backdrop:bg-foreground/30"
      >
        <form onSubmit={submit} autoComplete="off" className="space-y-4 p-4 sm:p-5">
          <h2 id={`${uid}-title`} className="text-xl font-semibold">
            New automation
          </h2>
          <div className="space-y-1.5">
            <label htmlFor={`${uid}-name`} className="text-sm font-medium">
              Name
            </label>
            <Input
              ref={nameRef}
              id={`${uid}-name`}
              value={name}
              maxLength={60}
              required
              onChange={(e) => {
                setName(e.target.value);
                setEdited(true);
              }}
              className="h-9"
            />
          </div>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Start from</legend>
            {TEMPLATES.map((t) => (
              <label key={t.start} className="flex min-h-6 cursor-pointer items-start gap-2.5 rounded-md py-1">
                <input type="radio" name={`${uid}-start`} value={t.start} checked={start === t.start} onChange={() => choose(t)} className="mt-1 size-4" />
                <span className="min-w-0">
                  <span className="block text-sm font-medium">{t.title}</span>
                  <span className="block text-sm text-muted-foreground">{t.description}</span>
                </span>
              </label>
            ))}
          </fieldset>
          {prompt}
          {error ? (
            <p role="alert" className="text-sm text-reject">
              {error}
            </p>
          ) : null}
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="outline" size="lg" onClick={close} className="h-10 px-4">
              Cancel
            </Button>
            <Button type="submit" size="lg" disabled={busy || name.trim() === ""} className="h-10 px-4">
              Create
            </Button>
          </div>
        </form>
      </dialog>
    </>
  );
}
