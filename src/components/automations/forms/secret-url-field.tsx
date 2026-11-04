"use client";

import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { StepSecretState } from "@/lib/types";

export interface SecretEdit {
  url?: string | null;
  signing_secret?: string | null;
}

export interface SecretUrlFieldProps {
  /** what the server says about this step's secrets (never the URL itself) */
  state: StepSecretState | undefined;
  /** what has been typed since the last save (sent with the next save, then cleared) */
  edit: SecretEdit | undefined;
  onEdit: (edit: SecretEdit | undefined) => void;
  allowedHosts: readonly string[];
  sendingEnabled: boolean;
  disabled?: boolean;
}

/**
 * The webhook URL and the optional signing secret of a sending step. The URL is a secret: this shows only the hint the
 * server returned ("hooks.slack.com/…/a1b2") or "No URL set"; Change reveals a password-type field (no autocomplete) and
 * Remove clears it. What is typed stays in the editor until Save, then goes to the server and is never shown again.
 */
export function SecretUrlField({ state, edit, onEdit, allowedHosts, sendingEnabled, disabled = false }: SecretUrlFieldProps) {
  const uid = useId();
  const [changingUrl, setChangingUrl] = useState(false);
  const [changingSecret, setChangingSecret] = useState(false);
  const hasUrl = edit?.url === undefined ? (state?.has_url ?? false) : edit.url !== null;
  const hasSecret = edit?.signing_secret === undefined ? (state?.has_signing_secret ?? false) : edit.signing_secret !== null;
  const pending = edit !== undefined && (edit.url !== undefined || edit.signing_secret !== undefined);
  const set = (patch: SecretEdit): void => onEdit({ ...edit, ...patch });

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <p className="text-sm font-medium">Webhook URL</p>
        <p className="text-sm break-words">
          {edit?.url === undefined
            ? state?.has_url
              ? (state.url_hint ?? "A URL is set")
              : "No URL set"
            : edit.url === null
              ? "No URL set (will be removed on save)"
              : "A new URL (will be saved with the next Save)"}
        </p>
        {changingUrl ? (
          <div className="space-y-1.5">
            <label htmlFor={`${uid}-url`} className="text-sm">
              New URL (https://…)
            </label>
            <Input
              id={`${uid}-url`}
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={edit?.url ?? ""}
              disabled={disabled}
              onChange={(e) => set({ url: e.target.value })}
              className="h-9"
            />
            <Button type="button" variant="outline" size="sm" onClick={() => setChangingUrl(false)} className="h-8 px-3">
              Done
            </Button>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => setChangingUrl(true)} className="h-8 px-3">
              {hasUrl ? "Change" : "Set"}
              <span className="sr-only"> the webhook URL</span>
            </Button>
            {hasUrl ? (
              <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => set({ url: null })} className="h-8 px-3">
                Remove<span className="sr-only"> the webhook URL</span>
              </Button>
            ) : null}
          </div>
        )}
      </div>

      <div className="space-y-1.5">
        <p className="text-sm font-medium">Signing secret (optional)</p>
        <p className="text-sm">{edit?.signing_secret === undefined ? (state?.has_signing_secret ? "A secret is set" : "No secret set") : edit.signing_secret === null ? "No secret set (will be removed on save)" : "A new secret (will be saved with the next Save)"}</p>
        {changingSecret ? (
          <div className="space-y-1.5">
            <label htmlFor={`${uid}-secret`} className="text-sm">
              New signing secret
            </label>
            <Input
              id={`${uid}-secret`}
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={edit?.signing_secret ?? ""}
              disabled={disabled}
              onChange={(e) => set({ signing_secret: e.target.value })}
              className="h-9"
            />
            <Button type="button" variant="outline" size="sm" onClick={() => setChangingSecret(false)} className="h-8 px-3">
              Done
            </Button>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => setChangingSecret(true)} className="h-8 px-3">
              {hasSecret ? "Change" : "Set"}
              <span className="sr-only"> the signing secret</span>
            </Button>
            {hasSecret ? (
              <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => set({ signing_secret: null })} className="h-8 px-3">
                Remove<span className="sr-only"> the signing secret</span>
              </Button>
            ) : null}
          </div>
        )}
        <p className="text-sm text-muted-foreground">When set, each request carries a timestamp and an HMAC-SHA256 signature of it.</p>
      </div>

      {pending ? (
        <Button type="button" variant="ghost" size="sm" onClick={() => onEdit(undefined)} className="h-8 px-3">
          Discard these changes
        </Button>
      ) : null}
      <p className="text-sm text-muted-foreground">{sendingEnabled ? `Allowed hosts on this server: ${allowedHosts.join(", ")}` : "Sending is off on this server."}</p>
    </div>
  );
}
