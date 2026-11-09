"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createRunFromFile, createRunFromSample, type ApiResult } from "@/components/shared/api";
import { ErrorState } from "@/components/shared/error-state";
import type { CreateRunResponse, SampleListItem } from "@/lib/types";
import { ResetPanel } from "./reset-panel";
import { SampleSection } from "./sample-grid";
import { UploadZone } from "./upload-zone";
import { pickSingleFile, startFailureMessage, validateInvoiceFile } from "./upload-rules";

type Job = { kind: "upload"; name: string; size: number } | { kind: "sample"; file: string };

/** A message under the upload zone or the sample cards: a short heading and one plain sentence. */
interface Problem {
  title: string;
  message: string;
}

/** A failed sample start: shown under the card that was pressed, where the visitor is looking (routes-ui UI-2). */
interface SampleProblem extends Problem {
  file: string;
}

/**
 * The body of /runs/new: the upload zone, the sample cards and the reset panel.
 *
 * One run is started at a time: while an upload or a sample request is in flight every control that starts a
 * run is switched off. A chosen or dropped file is checked on this side first (PDF name or type, at most 10 MB);
 * what the file contains is the server's business, so a renamed text file still goes through and is rejected by
 * the ingest stage. On 202 the page moves to /runs/<runId>. A failure (429 with its wait, 413, a network error,
 * anything else) is shown in place with a plain sentence; the request is cancelled if the page is left.
 */
export function StartView() {
  const router = useRouter();
  const [job, setJob] = useState<Job | null>(null);
  const [uploadProblem, setUploadProblem] = useState<Problem | null>(null);
  const [sampleProblem, setSampleProblem] = useState<SampleProblem | null>(null);
  const runningRef = useRef(false); // set at once, so two quick presses cannot start two runs before React re-renders
  const controllerRef = useRef<AbortController | null>(null);
  const headingId = useId();

  useEffect(() => () => controllerRef.current?.abort(), []);

  async function start(next: Job, request: (signal: AbortSignal) => Promise<ApiResult<CreateRunResponse>>) {
    if (runningRef.current) return;
    runningRef.current = true;
    setUploadProblem(null);
    setSampleProblem(null);
    setJob(next);
    const controller = new AbortController();
    controllerRef.current = controller;
    const result = await request(controller.signal);
    if (controller.signal.aborted) return; // the page was left while the request ran
    if (result.ok) {
      // Stay "busy" until the navigation replaces this page: no second run from a second click.
      router.push(`/runs/${encodeURIComponent(result.data.runId)}`);
      return;
    }
    controllerRef.current = null;
    runningRef.current = false;
    setJob(null);
    const message = startFailureMessage(result);
    if (next.kind === "upload") setUploadProblem({ title: "Could not start the run", message });
    else setSampleProblem({ title: "Could not start the sample", message, file: next.file });
  }

  function handleFiles(files: File[]) {
    if (runningRef.current) return;
    const picked = pickSingleFile(files);
    if ("problem" in picked) {
      setUploadProblem({ title: "Choose one PDF", message: picked.problem });
      return;
    }
    const problem = validateInvoiceFile(picked.file);
    if (problem) {
      setUploadProblem({ title: "Choose a different file", message: problem });
      return;
    }
    const { file } = picked;
    void start({ kind: "upload", name: file.name, size: file.size }, (signal) => createRunFromFile(file, signal));
  }

  function handleSample(sample: SampleListItem) {
    void start({ kind: "sample", file: sample.file }, (signal) => createRunFromSample(sample.file, signal));
  }

  const busy = job !== null;
  return (
    <div className="space-y-10">
      <section aria-labelledby={`${headingId}-upload`} className="space-y-4">
        <div className="space-y-1">
          <h2 id={`${headingId}-upload`} className="text-xl font-semibold tracking-tight">
            Upload an invoice
          </h2>
          <p className="max-w-prose text-sm text-muted-foreground">
            The file is screened for hidden or malicious content, read by the model and checked by the rules against the
            purchase orders. You watch every stage as it happens.
          </p>
        </div>
        <UploadZone onFiles={handleFiles} disabled={busy} uploading={job?.kind === "upload" ? job : null} />
        {uploadProblem ? <ErrorState title={uploadProblem.title} message={uploadProblem.message} /> : null}
      </section>

      <section aria-labelledby={`${headingId}-samples`} className="space-y-4">
        <div className="space-y-1">
          <h2 id={`${headingId}-samples`} className="text-xl font-semibold tracking-tight">
            Or try a sample
          </h2>
          <p className="max-w-prose text-sm text-muted-foreground">
            Ten generated invoices, one for each situation the rules handle. Press a card to run it and open the live view.
          </p>
          <p className="max-w-prose rounded-lg bg-muted/60 px-3 py-2 text-sm ring-1 ring-border">
            <span className="font-semibold">New here?</span> Start with <span className="font-semibold">Happy path</span>, then try the hard cases:{" "}
            <span className="font-semibold">Split-PO over-billing</span>, <span className="font-semibold">Disguised duplicate</span>,{" "}
            <span className="font-semibold">Bank details changed</span> and <span className="font-semibold">Prompt injection</span>. Each sample can run once; to
            run them again, reset the demo data at the bottom of this page.
          </p>
        </div>
        <SampleSection disabled={busy} startingFile={job?.kind === "sample" ? job.file : null} onPick={handleSample} problem={sampleProblem} />
      </section>

      <ResetPanel />
    </div>
  );
}
