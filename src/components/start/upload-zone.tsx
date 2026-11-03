"use client";

import { useEffect, useId, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import { FileUp, LoaderCircle, Upload } from "lucide-react";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { ACCEPT_PDF, MAX_UPLOAD_LABEL, clipName, formatFileSize } from "./upload-rules";

export interface UploadZoneProps {
  /** One or more files were chosen with the button or dropped. Checking them is the parent's job. */
  onFiles: (files: File[]) => void;
  /** A run is being started (an upload or a sample): the button and the drop target are switched off. */
  disabled?: boolean;
  /** The file being sent right now (shows the progress line), or null when no upload is running. */
  uploading?: { name: string; size: number } | null;
  className?: string;
}

/** Disabling the button that has focus drops focus to the page: true when that happened (and nothing else took it). */
function focusWasLost(): boolean {
  return document.activeElement === null || document.activeElement === document.body;
}

/** A drag that carries files (not selected text or a link). */
function carriesFiles(event: { dataTransfer: DataTransfer | null }): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes("Files");
}

/**
 * The upload area of the start page: a dashed drop target plus a real "Choose a PDF" button and a real file
 * input (PDF only, the 10 MB limit is explained in the text). The button, not the dashed box, is the keyboard
 * and screen-reader control; dropping is the mouse shortcut. While `disabled` the button is off and a drop is
 * refused. A file dropped just outside the box is ignored instead of making the browser open it in the tab.
 *
 * The file input itself is out of the tab order and hidden from assistive technology (the button replaces it).
 */
export function UploadZone({ onFiles, disabled = false, uploading = null, className }: UploadZoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const wasUploading = useRef(false);
  const hintId = useId();
  const [dragging, setDragging] = useState(false);

  // A failed upload re-enables the button, which lost focus while it was disabled: give focus back to it.
  const uploadingNow = uploading !== null;
  useEffect(() => {
    if (wasUploading.current && !uploadingNow && focusWasLost()) buttonRef.current?.focus();
    wasUploading.current = uploadingNow;
  }, [uploadingNow]);

  // Without this a PDF dropped a few pixels outside the box replaces the whole page with the PDF.
  useEffect(() => {
    const ignoreFileDrag = (event: Event) => {
      const transfer = (event as unknown as { dataTransfer: DataTransfer | null }).dataTransfer;
      if (carriesFiles({ dataTransfer: transfer })) event.preventDefault();
    };
    window.addEventListener("dragover", ignoreFileDrag);
    window.addEventListener("drop", ignoreFileDrag);
    return () => {
      window.removeEventListener("dragover", ignoreFileDrag);
      window.removeEventListener("drop", ignoreFileDrag);
    };
  }, []);

  function handleDragOver(event: DragEvent<HTMLDivElement>) {
    if (!carriesFiles(event)) return;
    event.preventDefault(); // required for the drop event to fire at all
    event.dataTransfer.dropEffect = disabled ? "none" : "copy";
    if (!disabled) setDragging(true);
  }

  function handleDragLeave(event: DragEvent<HTMLDivElement>) {
    // Moving over a child element also fires dragleave on the box: only a real exit ends the highlight.
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
    setDragging(false);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    setDragging(false);
    if (disabled) return;
    onFiles(Array.from(event.dataTransfer.files));
  }

  function handleChoose(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = ""; // so choosing the same file again (after an error) fires change again
    if (files.length > 0) onFiles(files);
  }

  const busy = uploading !== null;
  return (
    <div
      data-dragging={dragging || undefined}
      aria-busy={busy || undefined}
      onDragEnter={handleDragOver}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={cn(
        "flex flex-col items-center gap-3 rounded-xl border-2 border-dashed border-input bg-card px-4 py-10 text-center transition-colors sm:px-6",
        dragging && "border-primary bg-accent",
        disabled && !busy && "opacity-70",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className="flex size-12 items-center justify-center rounded-full bg-accent text-accent-foreground [&_svg]:size-6"
      >
        {busy ? <LoaderCircle className="animate-spin" /> : <Upload />}
      </span>
      {busy ? (
        <p role="status" className="max-w-full text-base font-medium break-words">
          Sending {clipName(uploading.name)} ({formatFileSize(uploading.size)}) to the server. The run opens as soon as it has
          started.
        </p>
      ) : (
        <>
          <p className="text-base font-medium">
            {dragging ? "Drop the PDF to start the run" : "Drag and drop an invoice PDF here"}
          </p>
          <p className="text-sm text-muted-foreground">or choose one from your computer</p>
        </>
      )}
      <Button
        ref={buttonRef}
        type="button"
        size="lg"
        disabled={disabled}
        aria-describedby={hintId}
        onClick={() => inputRef.current?.click()}
        className="h-10 px-4"
      >
        <FileUp aria-hidden="true" />
        Choose a PDF
      </Button>
      <p id={hintId} className="text-xs text-muted-foreground">
        PDF only, up to {MAX_UPLOAD_LABEL}, one file at a time.
      </p>
      <input
        ref={inputRef}
        type="file"
        name="file"
        accept={ACCEPT_PDF}
        disabled={disabled}
        onChange={handleChoose}
        tabIndex={-1}
        aria-hidden="true"
        className="sr-only"
      />
    </div>
  );
}
