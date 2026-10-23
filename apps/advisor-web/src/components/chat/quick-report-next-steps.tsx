"use client";

import { useEffect, useReducer, useRef } from "react";
import { Check, Download, FileDown, LoaderCircle, MonitorPlay, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/components/language-provider";
import { checkDesign, runOption } from "@/lib/quick-report/client";
import { downloadFile } from "@/lib/quick-report/download";
import { QuickReportTestRun } from "./quick-report-test-run";
import { initialNextState, lostRunMessage, nextStepsReducer, runRequest, type NextState, type OptionId, type Validation } from "@/lib/quick-report/next-steps";
import { cn } from "@/lib/utils";

const card = "rounded-xl border bg-card p-4 text-sm shadow-xs";

// Under the latest design of a Quick Reports chat: is it ready, then approve, then the consultant chooses Option A or B. The state machine
// (lib/quick-report/next-steps.ts) decides what each click may do; nothing is sent to the run endpoint before a choice (and for A a confirmation).
export function QuickReportNextSteps({ design }: { design: string }) {
  const { t } = useLanguage();
  const [state, dispatch] = useReducer(nextStepsReducer, initialNextState);
  const running = useRef(false);
  // the texts of the current language, for the callbacks below that must not run again when the language changes
  const texts = useRef(t);
  useEffect(() => {
    texts.current = t;
  }, [t]);

  // the check only reads: it never touches IFS
  useEffect(() => {
    if (state.step !== "checking") return;
    let cancelled = false;
    checkDesign(design, texts.current.nextCheckFailed).then(
      (info) => !cancelled && dispatch({ type: "checked", info }),
      (err: unknown) => !cancelled && dispatch({ type: "checkFailed", message: err instanceof Error ? err.message : texts.current.nextCheckFailed }),
    );
    return () => {
      cancelled = true;
    };
  }, [state.step, design]);

  // runs the chosen option once; the request is built from the state in which the consultant chose
  const launch = async (from: NextState) => {
    const request = runRequest(from, design);
    if (!request || running.current) return;
    running.current = true;
    try {
      dispatch({ type: "finished", result: await runOption(request, lostRunMessage(request.option, texts.current)) });
    } catch (err) {
      dispatch({ type: "failed", message: err instanceof Error ? err.message : lostRunMessage(request.option, texts.current) });
    } finally {
      running.current = false;
    }
  };

  const choose = (option: OptionId) => {
    dispatch({ type: "choose", option });
    void launch(nextStepsReducer(state, { type: "choose", option }));
  };
  const confirm = () => {
    dispatch({ type: "confirm" });
    void launch(nextStepsReducer(state, { type: "confirm" }));
  };

  const note = (v: Validation) => t.nextValidation(v.dictionary.checked, v.dictionary.unknownViews, v.dictionary.unknownColumns);

  if (state.step === "checking") {
    return (
      <section className={cn(card, "flex items-center gap-2 text-muted-foreground")} aria-live="polite">
        <LoaderCircle className="size-4 animate-spin" /> {t.nextChecking}
      </section>
    );
  }

  if (state.step === "unavailable") {
    return (
      <section className={card} role="alert">
        <p className="flex items-center gap-2 font-medium"><TriangleAlert className="size-4 text-destructive" /> {state.message}</p>
        <Button variant="outline" size="sm" className="mt-3" onClick={() => dispatch({ type: "recheck" })}>{t.nextRetry}</Button>
      </section>
    );
  }

  const { info } = state;

  if (state.step === "blocked") {
    return (
      <section className={card} aria-live="polite">
        <p className="flex items-center gap-2 font-medium"><TriangleAlert className="size-4 text-amber-500" /> {t.nextBlockedTitle}</p>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-muted-foreground">
          {info.blockers.map((b) => <li key={b}>{b}</li>)}
        </ul>
        <Button variant="outline" size="sm" className="mt-3" onClick={() => dispatch({ type: "recheck" })}>{t.nextRetry}</Button>
      </section>
    );
  }

  if (state.step === "review") {
    return (
      <section className={card} aria-live="polite">
        <p className="flex items-center gap-2 font-medium"><Check className="size-4 text-primary" /> {t.nextReadyTitle}</p>
        <p className="mt-1 text-muted-foreground">{t.nextReadySub}</p>
        {info.openQuestions.length > 0 && (
          <div className="mt-3">
            <p className="text-xs font-medium text-muted-foreground">{t.nextOpenQuestions}</p>
            <ul className="mt-1 list-disc space-y-1 pl-5 text-muted-foreground">
              {info.openQuestions.map((q) => <li key={q}>{q}</li>)}
            </ul>
          </div>
        )}
        <p className="mt-3 text-xs text-muted-foreground">{note(info.validation)}</p>
        <Button className="mt-3" onClick={() => dispatch({ type: "approve" })}>{t.nextApprove}</Button>
      </section>
    );
  }

  if (state.step === "running") {
    return (
      <section className={cn(card, "flex items-center gap-2 text-muted-foreground")} aria-live="polite">
        <LoaderCircle className="size-4 animate-spin" /> {t.nextRunning} ({state.option === "A" ? t.nextOptionATitle : t.nextOptionBTitle})
      </section>
    );
  }

  if (state.step === "confirmA") {
    const target = info.options.A.target ?? "IFS";
    // a rehearsal cancels the dialog and saves nothing; only when it is switched off does the report get saved
    const rehearsal = info.options.A.mode !== "create";
    return (
      <section className={cn(card, rehearsal ? "border-primary/40" : "border-amber-500/50")} role="alertdialog" aria-labelledby="qr-confirm-title">
        <p id="qr-confirm-title" className="flex items-center gap-2 font-medium"><TriangleAlert className={cn("size-4", rehearsal ? "text-primary" : "text-amber-500")} /> {rehearsal ? t.nextConfirmTitleRehearsal : t.nextConfirmTitle}</p>
        <p className="mt-1 text-muted-foreground">{rehearsal ? t.nextConfirmBodyRehearsal(target) : t.nextConfirmBody(target)}</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button onClick={confirm}>{rehearsal ? t.nextConfirmYesRehearsal : t.nextConfirmYes}</Button>
          <Button variant="outline" onClick={() => dispatch({ type: "cancel" })}>{t.nextCancel}</Button>
        </div>
      </section>
    );
  }

  if (state.step === "done" || state.step === "failed") {
    const result = state.step === "done" ? state.result : null;
    return (
      <section className={card} aria-live="polite">
        <p className="flex items-center gap-2 font-medium">
          {result?.ok ? <Check className="size-4 text-primary" /> : <TriangleAlert className="size-4 text-amber-500" />} {t.nextResultTitle}
        </p>
        <p className="mt-1">{result ? result.message : state.step === "failed" ? state.message : ""}</p>
        {result && result.steps.length > 0 && (
          <ul className="mt-3 space-y-1.5 text-muted-foreground">
            {result.steps.map((s) => (
              <li key={s.name}>
                <span className="font-medium text-foreground">{s.name}</span>
                {" — "}
                {s.status === "ok" ? t.nextStepOk : s.status === "failed" ? t.nextStepFailed : s.status === "not done" ? t.nextStepNotDone : s.status}
                {": "}
                {s.detail}
              </li>
            ))}
          </ul>
        )}
        {result?.warnings && result.warnings.length > 0 && (
          <div className="mt-3">
            <p className="text-xs font-medium text-muted-foreground">{t.nextWarnings}</p>
            <ul className="mt-1 list-disc space-y-1 pl-5 text-muted-foreground">
              {result.warnings.map((w) => <li key={w}>{w}</li>)}
            </ul>
          </div>
        )}
        {result?.file && (
          <Button className="mt-3" onClick={() => downloadFile(result.file!)}>
            <Download className="size-4" /> {t.nextDownload} ({result.file.name})
          </Button>
        )}
        {result?.instructions && result.instructions.length > 0 && (
          <div className="mt-3">
            <p className="text-xs font-medium text-muted-foreground">{t.nextHowToImport}</p>
            <ol className="mt-1 list-decimal space-y-1 pl-5 text-muted-foreground">
              {result.instructions.map((i) => <li key={i}>{i}</li>)}
            </ol>
          </div>
        )}
        {result && <p className="mt-3 text-xs text-muted-foreground">{t.nextTouched(result.touchedIfs)}</p>}
        <p className="mt-1 text-xs text-muted-foreground">{note((result ?? { validation: info.validation }).validation)} </p>
        {result && (result.outcome === "created" || result.outcome === "exported") && (
          <QuickReportTestRun design={design} info={info} initialReportId={result.reportId ? String(result.reportId) : ""} exported={result.outcome === "exported"} />
        )}
        <Button variant="outline" size="sm" className="mt-3" onClick={() => dispatch({ type: "back" })}>{t.nextBack}</Button>
      </section>
    );
  }

  // the options: both are shown, neither is chosen for the consultant
  const options: { id: OptionId; title: string; description: string; label: string; Icon: typeof MonitorPlay }[] = [
    { id: "A", title: t.nextOptionATitle, description: t.nextOptionADesc, label: t.nextChooseA, Icon: MonitorPlay },
    { id: "B", title: t.nextOptionBTitle, description: t.nextOptionBDesc, label: t.nextChooseB, Icon: FileDown },
  ];
  return (
    <section className={card} aria-labelledby="qr-options-title">
      <p id="qr-options-title" className="font-medium">{t.nextOptionsTitle}</p>
      <p className="mt-1 text-muted-foreground">{t.nextNothingYet}</p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        {options.map(({ id, title, description, label, Icon }) => {
          const availability = info.options[id];
          return (
            <div key={id} className="flex flex-col gap-2 rounded-lg border p-3">
              <p className="flex items-center gap-2 font-medium"><Icon className="size-4 text-primary" /> {title}</p>
              <p className="text-muted-foreground">{description}</p>
              {!availability.available && (
                <div className="text-xs text-muted-foreground">
                  <p className="font-medium">{t.nextNeeds}</p>
                  <ul className="mt-1 list-disc space-y-1 pl-4">
                    {availability.missing.map((m) => <li key={m}>{m}</li>)}
                  </ul>
                </div>
              )}
              <Button className="mt-auto" variant={id === "A" ? "default" : "outline"} disabled={!availability.available} onClick={() => choose(id)}>{label}</Button>
            </div>
          );
        })}
      </div>
    </section>
  );
}
