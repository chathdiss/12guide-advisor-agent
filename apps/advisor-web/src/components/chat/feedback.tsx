"use client";

import { useState } from "react";
import { Check, ThumbsDown, ThumbsUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/components/language-provider";
import type { Message } from "@/lib/chat/types";
import { memoryApi, type Scope } from "@/lib/memory/client";
import { cn } from "@/lib/utils";

type Props = {
  question: string;
  message: Message;
  scope: Scope;
  // the messages before the question, and whether files were attached in this chat so far
  context: { history: { role: "user" | "assistant"; content: string }[]; hadAttachments: boolean };
};

const MIN_CHARS = 8;

type Done = "saved" | "not-saved" | "reported";

// Thumbs under an answer.
//   Thumbs up: one click. The answer is saved at once, with no review, and shown again when the same question is
//   asked later for the same customer and IFS version (the AI is not called then).
//   Thumbs down: the consultant says what is wrong, unsupported or missing. It is kept with the question and the
//   answer, helps check later answers, and is not treated as a verified correction.
export function Feedback({ question, message, scope, context }: Props) {
  const { t, lang } = useLanguage();
  const [asking, setAsking] = useState(false);
  const [text, setText] = useState("");
  const [state, setState] = useState<"idle" | "sending">("idle");
  const [done, setDone] = useState<Done | null>(null);
  const [problem, setProblem] = useState("");

  const base = {
    customer: scope.customer,
    ifsVersion: scope.ifsVersion,
    language: lang,
    question,
    answer: message.content,
    sources: message.sources,
    tier: message.tier,
    tierReason: message.tierReason,
    followUps: message.followUps,
    history: context.history,
    hadAttachments: context.hadAttachments,
    cacheId: message.cached?.id,
  };

  async function thumbsUp() {
    if (state === "sending") return;
    setAsking(false);
    setProblem("");
    setState("sending");
    const res = await memoryApi.sendFeedback({ ...base, rating: "up" });
    setState("idle");
    if (res.ok) setDone(res.data.saved ? "saved" : "not-saved");
    else setProblem(t.feedbackFailed);
  }

  async function sendProblem() {
    if (text.trim().length < MIN_CHARS) {
      setProblem(t.feedbackTooShort);
      return;
    }
    setProblem("");
    setState("sending");
    const res = await memoryApi.sendFeedback({ ...base, rating: "down", comment: text.trim() });
    setState("idle");
    if (res.ok) setDone("reported");
    else setProblem(t.feedbackFailed);
  }

  if (done) {
    return (
      <span className="inline-flex max-w-prose items-center gap-1.5 px-2 text-xs text-muted-foreground">
        <Check className="size-3.5 shrink-0 text-emerald-500" />
        {done === "saved" ? t.feedbackSaved : done === "not-saved" ? t.feedbackNotSaved : t.feedbackReported}
      </span>
    );
  }

  return (
    <>
      <Button
        variant="ghost"
        size="xs"
        className="text-muted-foreground"
        aria-label={t.feedbackGood}
        title={t.feedbackGood}
        disabled={state === "sending"}
        onClick={thumbsUp}
      >
        <ThumbsUp />
      </Button>
      <Button
        variant="ghost"
        size="xs"
        className={cn("text-muted-foreground", asking && "text-destructive")}
        aria-label={t.feedbackBad}
        aria-pressed={asking}
        title={t.feedbackBad}
        onClick={() => {
          setAsking((v) => !v);
          setProblem("");
        }}
      >
        <ThumbsDown />
      </Button>
      {problem && !asking && (
        <span role="alert" className="px-2 text-xs text-destructive">
          {problem}
        </span>
      )}

      {asking && (
        <div className="mt-2 w-full basis-full pl-2">
          <div className="rounded-xl border bg-card p-3">
            <p className="mb-2 text-xs text-muted-foreground">{t.feedbackPromptBad}</p>
            <textarea
              className="min-h-20 w-full resize-y rounded-md border bg-background p-2 text-sm leading-snug outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
              value={text}
              maxLength={4000}
              placeholder={t.feedbackPlaceholder}
              onChange={(e) => setText(e.target.value)}
            />
            <div className="mt-2 flex items-center gap-3">
              <Button size="sm" onClick={sendProblem} disabled={state === "sending"}>
                {t.feedbackSend}
              </Button>
              {problem && (
                <span role="alert" className="text-xs text-destructive">
                  {problem}
                </span>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
