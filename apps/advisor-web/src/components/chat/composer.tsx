"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowUp, FileText, Paperclip, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/components/language-provider";
import { MAX_ATTACHMENTS } from "@/lib/chat/api-types";
import { ACCEPT, AttachmentError, processFile, type PendingAttachment } from "@/lib/chat/attachments";
import { cn } from "@/lib/utils";

type Props = {
  onSend: (text: string, attachments: PendingAttachment[]) => void;
  disabled: boolean;
};

export function Composer({ onSend, disabled }: Props) {
  const { t } = useLanguage();
  const [value, setValue] = useState("");
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const canSend = !disabled && (value.trim().length > 0 || attachments.length > 0);

  // ready to type on load, and again as soon as an answer has arrived
  useEffect(() => {
    if (!disabled) ref.current?.focus();
  }, [disabled]);

  const addFiles = async (files: File[]) => {
    if (files.length === 0) return;
    const room = MAX_ATTACHMENTS - attachments.length;
    const problems: string[] = [];
    if (files.length > room) problems.push(t.attachmentProblem({ kind: "tooMany", max: MAX_ATTACHMENTS }));

    const added: PendingAttachment[] = [];
    for (const file of files.slice(0, Math.max(0, room))) {
      try {
        added.push(await processFile(file));
      } catch (err) {
        problems.push(err instanceof AttachmentError ? t.attachmentProblem(err.problem) : t.attachmentProblem({ kind: "unreadableImage", file: file.name }));
      }
    }
    setAttachments((prev) => [...prev, ...added].slice(0, MAX_ATTACHMENTS));
    setErrors(problems);
  };

  const submit = () => {
    if (!canSend) return;
    onSend(value, attachments);
    setValue("");
    setAttachments([]);
    setErrors([]);
    if (ref.current) ref.current.style.height = "auto";
  };

  return (
    <div className="mx-auto w-full max-w-3xl px-4 pt-2 pb-[max(1rem,env(safe-area-inset-bottom))]">
      <div
        className={cn(
          "rounded-2xl border bg-card p-2 shadow-sm transition-shadow focus-within:border-primary/50 focus-within:ring-4 focus-within:ring-primary/10",
          dragging && "border-primary ring-2 ring-primary/30",
        )}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes("Files")) {
            e.preventDefault();
            setDragging(true);
          }
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          void addFiles(Array.from(e.dataTransfer.files));
        }}
      >
        {attachments.length > 0 && (
          <ul className="flex flex-wrap gap-2 px-1 pb-2">
            {attachments.map((a) => (
              <li key={a.id} className="flex items-center gap-2 rounded-lg border bg-muted/50 py-1 pl-1 pr-2 text-xs">
                {a.thumbnail ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={a.thumbnail} alt="" className="size-8 rounded object-cover" />
                ) : (
                  <FileText className="size-8 p-1.5 text-muted-foreground" />
                )}
                <span className="max-w-40 truncate">{a.name}</span>
                <button
                  aria-label={t.removeFile(a.name)}
                  className="text-muted-foreground hover:text-foreground"
                  onClick={() => setAttachments((prev) => prev.filter((x) => x.id !== a.id))}
                >
                  <X className="size-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="flex items-end gap-2">
          <input
            ref={fileInput}
            type="file"
            multiple
            accept={ACCEPT}
            className="hidden"
            onChange={(e) => {
              void addFiles(Array.from(e.target.files ?? []));
              e.target.value = "";
            }}
          />
          <Button
            variant="ghost"
            size="icon"
            className="size-9 shrink-0 rounded-full"
            aria-label={t.attachFiles}
            disabled={attachments.length >= MAX_ATTACHMENTS}
            onClick={() => fileInput.current?.click()}
          >
            <Paperclip className="size-4" />
          </Button>
          <textarea
            ref={ref}
            value={value}
            rows={1}
            placeholder={t.placeholder}
            className="max-h-48 min-h-9 flex-1 resize-none bg-transparent px-1 py-2 text-sm outline-none"
            onChange={(e) => {
              setValue(e.target.value);
              e.target.style.height = "auto";
              e.target.style.height = `${e.target.scrollHeight}px`;
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            onPaste={(e) => {
              // pasted screenshots arrive as files; normal text pastes are left alone
              const files = Array.from(e.clipboardData.files);
              if (files.length > 0 && !e.clipboardData.getData("text")) {
                e.preventDefault();
                void addFiles(files);
              }
            }}
          />
          <Button size="icon" className="size-9 shrink-0 rounded-full" disabled={!canSend} onClick={submit} aria-label={t.send} title={t.enterHint}>
            <ArrowUp className="size-4" />
          </Button>
        </div>
      </div>

      {errors.length > 0 && (
        <ul className="mt-2 space-y-0.5 text-xs text-destructive">
          {errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}

      <p className="mt-2 text-center text-xs text-muted-foreground">
        {t.disclaimer}
      </p>
    </div>
  );
}
