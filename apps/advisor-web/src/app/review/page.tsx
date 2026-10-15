"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { reviewApi, type CacheStats, type Lesson } from "@/lib/memory/client";
import { cn } from "@/lib/utils";

const KEY_STORAGE = "advisor-agent:review-key";
const STATUSES: Lesson["status"][] = ["unverified", "approved", "rejected"];

// Notes that consultants wrote after a thumbs down. They are used at once, as unverified concerns; only the ones
// confirmed here are treated as corrections by the agent. Thumbs-up answers are saved without any review.
// The page is for reviewers only; the backend checks the review key on every call.
export default function ReviewPage() {
  const [key, setKey] = useState("");
  const [status, setStatus] = useState<Lesson["status"]>("unverified");
  const [lessons, setLessons] = useState<Lesson[] | null>(null);
  const [message, setMessage] = useState("");
  const [stats, setStats] = useState<CacheStats | null>(null);

  const load = useCallback(async (reviewKey: string, wanted: Lesson["status"]) => {
    if (!reviewKey) return;
    setMessage("");
    const res = await reviewApi.list(reviewKey, wanted);
    if (res.ok) {
      setLessons(res.data.lessons);
      reviewApi.stats(reviewKey).then((r) => setStats(r.ok ? r.data : null));
      try {
        sessionStorage.setItem(KEY_STORAGE, reviewKey);
      } catch {
        // storage blocked: the key must be typed again after a reload
      }
    } else {
      setLessons(null);
      setMessage(res.status === 401 ? "Wrong review key." : res.status === 503 ? "Review is switched off on the server (no REVIEW_API_KEY)." : "Could not load the lessons.");
    }
  }, []);

  useEffect(() => {
    try {
      const saved = sessionStorage.getItem(KEY_STORAGE);
      if (saved) {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setKey(saved);
        load(saved, "unverified");
      }
    } catch {
      // nothing saved
    }
  }, [load]);

  return (
    <main className="mx-auto max-w-3xl space-y-6 px-4 py-8">
      <div>
        <h1 className="text-xl font-semibold">Feedback review</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          These are notes from consultants who gave a thumbs down. Until you look at them they count only as unverified concerns: the agent
          uses them to double-check later answers and never states them as fact. Confirm a note (fix the wording first) to make it a
          correction that the agent follows for its customer and IFS version, or dismiss it.
        </p>
      </div>

      {stats && (
        <p className="rounded-lg border bg-card p-3 text-sm text-muted-foreground">
          Saved answers (last {stats.days} days): {stats.hits} of {stats.hits + stats.misses} repeatable questions were answered without the AI
          ({Math.round(stats.hitRate * 100)}%), about {stats.estimatedTokensSaved.toLocaleString("en")} tokens saved (an estimate).{" "}
          {stats.savedAnswers} answers are saved, {stats.switchedOff} switched off after a thumbs down.
        </p>
      )}

      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          load(key.trim(), status);
        }}
      >
        <input
          type="password"
          className="h-9 min-w-0 flex-1 rounded-md border bg-card px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
          placeholder="Review key"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          autoComplete="off"
        />
        <Button type="submit">Open</Button>
      </form>

      {message && (
        <p role="alert" className="text-sm text-destructive">
          {message}
        </p>
      )}

      {lessons && (
        <>
          <div className="flex gap-2" role="tablist">
            {STATUSES.map((s) => (
              <Button
                key={s}
                variant={s === status ? "default" : "outline"}
                size="sm"
                role="tab"
                aria-selected={s === status}
                onClick={() => {
                  setStatus(s);
                  load(key.trim(), s);
                }}
              >
                {s[0].toUpperCase() + s.slice(1)}
              </Button>
            ))}
          </div>

          {lessons.length === 0 ? (
            <p className="text-sm text-muted-foreground">No {status} lessons.</p>
          ) : (
            <ul className="space-y-4">
              {lessons.map((lesson) => (
                <LessonCard
                  key={lesson.id}
                  lesson={lesson}
                  onDecide={async (input) => {
                    const res = await reviewApi.decide(key.trim(), lesson.id, input);
                    if (res.ok) setLessons((cur) => cur?.filter((l) => l.id !== lesson.id) ?? null);
                    else setMessage(res.error);
                  }}
                />
              ))}
            </ul>
          )}
        </>
      )}
    </main>
  );
}

function LessonCard({ lesson, onDecide }: { lesson: Lesson; onDecide: (input: { status: "approved" | "rejected"; correction?: string; note?: string }) => Promise<void> }) {
  const [text, setText] = useState(lesson.correction);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const decide = async (status: "approved" | "rejected") => {
    setBusy(true);
    await onDecide({ status, correction: text, note });
    setBusy(false);
  };

  return (
    <li className="space-y-3 rounded-xl border bg-card p-4">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span className={cn("rounded-full border px-2 py-0.5 font-medium", lesson.rating === "down" ? "text-destructive" : "text-emerald-600")}>
          {lesson.rating === "down" ? "Not right" : "Good answer"}
        </span>
        <span>Customer: {lesson.customer || "all"}</span>
        <span>Version: {lesson.ifsVersion || "all"}</span>
        <span>{new Date(lesson.createdAt).toLocaleString()}</span>
      </div>
      <div>
        <div className="text-xs font-medium text-muted-foreground">Question</div>
        <p className="mt-0.5 text-sm whitespace-pre-wrap">{lesson.question}</p>
      </div>
      {lesson.answer && (
        <details className="text-sm">
          <summary className="cursor-pointer text-xs font-medium text-muted-foreground">Answer that was rated</summary>
          <p className="mt-1 max-h-48 overflow-auto rounded-md bg-muted/50 p-2 text-xs whitespace-pre-wrap">{lesson.answer}</p>
        </details>
      )}
      <div>
        <div className="text-xs font-medium text-muted-foreground">Lesson (edit the wording if needed)</div>
        <textarea
          className="mt-1 min-h-24 w-full resize-y rounded-md border bg-background p-2 text-sm leading-snug outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
          value={text}
          maxLength={4000}
          onChange={(e) => setText(e.target.value)}
          disabled={lesson.status !== "unverified"}
        />
      </div>
      {lesson.status === "unverified" ? (
        <div className="flex flex-wrap items-center gap-2">
          <input
            className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
            placeholder="Note (optional)"
            value={note}
            maxLength={500}
            onChange={(e) => setNote(e.target.value)}
          />
          <Button size="sm" onClick={() => decide("approved")} disabled={busy || text.trim().length < 8}>
            <Check /> Confirm
          </Button>
          <Button size="sm" variant="outline" onClick={() => decide("rejected")} disabled={busy}>
            <X /> Dismiss
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          {lesson.reviewNote && <p className="text-xs text-muted-foreground">Note: {lesson.reviewNote}</p>}
          {lesson.status === "approved" && (
            <Button size="sm" variant="outline" onClick={() => decide("rejected")} disabled={busy}>
              <X /> Revoke
            </Button>
          )}
        </div>
      )}
    </li>
  );
}
