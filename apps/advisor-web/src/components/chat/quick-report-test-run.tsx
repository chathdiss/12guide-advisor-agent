"use client";

import { useMemo, useReducer, useRef, useState } from "react";
import { Check, LoaderCircle, Play, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/components/language-provider";
import { testRun } from "@/lib/quick-report/client";
import type { CheckInfo, RunStep } from "@/lib/quick-report/next-steps";
import { checkTestInputs, initialTestRunState, parametersOf, testRequest, testRunReducer } from "@/lib/quick-report/test-run";
import { cn } from "@/lib/utils";

const input = "w-full rounded-md border bg-background px-2 py-1.5 text-sm outline-none focus-visible:outline-2 focus-visible:outline-ring";

// Under the result of a report that was created (Option A) or exported (Option B): the consultant types the id of the report and the values of its
// parameters, confirms, and IFS runs the SQL. What comes back (rows, screenshot) is shown here only. The state machine (lib/quick-report/test-run.ts)
// decides what each click may do: nothing is sent before the confirmation.
export function QuickReportTestRun({ design, info, initialReportId, exported }: { design: string; info: CheckInfo; initialReportId: string; exported: boolean }) {
  const { t } = useLanguage();
  const parameters = useMemo(() => parametersOf(design), [design]);
  const [reportId, setReportId] = useState(initialReportId);
  const [values, setValues] = useState<Record<string, string>>({});
  const [state, dispatch] = useReducer(testRunReducer, initialTestRunState);
  const running = useRef(false);

  const execute = info.options.A.testMode === "execute";
  const target = info.options.A.target ?? "IFS";
  const { problems, warnings } = checkTestInputs(parameters, values, reportId);

  // the request is built from the state after the confirmation, and sent once
  const confirm = () => {
    const next = testRunReducer(state, { type: "confirm" });
    dispatch({ type: "confirm" });
    const request = testRequest(next, { design, designHash: info.designHash, reportId, parameters, values });
    if (!request || running.current) return;
    running.current = true;
    testRun(request, t.nextTestLost)
      .then((result) => dispatch({ type: "finished", result }))
      .catch((err: unknown) => dispatch({ type: "failed", message: err instanceof Error ? err.message : t.nextTestLost }))
      .finally(() => {
        running.current = false;
      });
  };

  const status = (s: RunStep["status"]) => (s === "ok" ? t.nextStepOk : s === "failed" ? t.nextStepFailed : s === "not done" ? t.nextStepNotDone : s);

  return (
    <div className="mt-4 rounded-lg border p-3" aria-labelledby="qr-test-title">
      <p id="qr-test-title" className="flex items-center gap-2 font-medium"><Play className="size-4 text-primary" /> {t.nextTestTitle}</p>

      {state.step === "idle" && (
        <>
          <p className="mt-1 text-muted-foreground">{t.nextTestIntro}</p>
          {exported && <p className="mt-1 text-muted-foreground">{t.nextTestImportFirst}</p>}
          {!execute && <p className="mt-1 text-xs text-muted-foreground">{t.nextTestRehearsalMode}</p>}
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <label className="text-xs font-medium text-muted-foreground">
              {t.nextTestReportId}
              <input className={cn(input, "mt-1")} inputMode="numeric" value={reportId} onChange={(e) => setReportId(e.target.value)} />
              <span className="mt-1 block font-normal">{t.nextTestReportIdHint}</span>
            </label>
          </div>
          {parameters.length > 0 && (
            <div className="mt-3">
              <p className="text-xs font-medium text-muted-foreground">{t.nextTestParameters}</p>
              <div className="mt-1 grid gap-3 sm:grid-cols-2">
                {parameters.map((p) => (
                  <label key={p.name} className="text-xs font-medium text-muted-foreground">
                    {p.name}{p.mandatory ? " *" : ""}
                    <input className={cn(input, "mt-1")} value={values[p.name] ?? ""} onChange={(e) => setValues((v) => ({ ...v, [p.name]: e.target.value }))} />
                  </label>
                ))}
              </div>
            </div>
          )}
          {problems.length > 0 && (
            <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-destructive">
              {problems.map((p) => <li key={`${p.code}-${p.name ?? ""}`}>{t.nextTestProblem(p.code, p.name)}</li>)}
            </ul>
          )}
          {warnings.length > 0 && (
            <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-muted-foreground">
              {warnings.map((w) => <li key={w.name}>{t.nextTestEmpty(w.name)}</li>)}
            </ul>
          )}
          <Button className="mt-3" disabled={problems.length > 0} onClick={() => dispatch({ type: "start" })}>{t.nextTestStart}</Button>
        </>
      )}

      {state.step === "confirming" && (
        <div className="mt-2" role="alertdialog" aria-labelledby="qr-test-confirm">
          <p id="qr-test-confirm" className="flex items-center gap-2 font-medium"><TriangleAlert className={cn("size-4", execute ? "text-amber-500" : "text-primary")} /> {execute ? t.nextTestConfirmTitleRun : t.nextTestConfirmTitleRehearsal}</p>
          <p className="mt-1 text-muted-foreground">{execute ? t.nextTestConfirmBodyRun(target) : t.nextTestConfirmBodyRehearsal(target)}</p>
          <p className="mt-1 text-xs text-muted-foreground">{t.nextTestPrivacy}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button onClick={confirm}>{execute ? t.nextTestYesRun : t.nextTestYesRehearsal}</Button>
            <Button variant="outline" onClick={() => dispatch({ type: "cancel" })}>{t.nextCancel}</Button>
          </div>
        </div>
      )}

      {state.step === "running" && (
        <p className="mt-2 flex items-center gap-2 text-muted-foreground" aria-live="polite"><LoaderCircle className="size-4 animate-spin" /> {t.nextTestRunning}</p>
      )}

      {state.step === "failed" && (
        <div className="mt-2" role="alert">
          <p className="flex items-center gap-2"><TriangleAlert className="size-4 text-amber-500" /> {state.message}</p>
          <Button variant="outline" size="sm" className="mt-3" onClick={() => dispatch({ type: "reset" })}>{t.nextBack}</Button>
        </div>
      )}

      {state.step === "done" && (
        <div className="mt-2" aria-live="polite">
          <p className="flex items-center gap-2 font-medium">
            {state.result.ok ? <Check className="size-4 text-primary" /> : <TriangleAlert className="size-4 text-amber-500" />} {t.nextTestResultTitle}
          </p>
          <p className="mt-1">{state.result.message}</p>
          {state.result.result && (
            <div className="mt-3">
              <p className="text-xs text-muted-foreground">
                {state.result.result.columnsMatch ? t.nextTestColumnsMatch : t.nextTestColumnsDiffer} · {t.nextTestRows(state.result.result.rowCount, state.result.result.moreRows)} · {t.nextTestSeconds(state.result.result.seconds)}
              </p>
              <div className="mt-2 overflow-x-auto rounded-md border">
                <table className="w-full text-left text-xs">
                  <thead className="bg-muted/50">
                    <tr>{state.result.result.columns.map((c, i) => <th key={`${c}-${i}`} className="px-2 py-1 font-medium">{c}</th>)}</tr>
                  </thead>
                  <tbody>
                    {state.result.result.rows.map((row, r) => (
                      <tr key={r} className="border-t">{row.map((cell, c) => <td key={c} className="px-2 py-1">{cell}</td>)}</tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          {state.result.screenshot && (
            // a screenshot of IFS: shown here only, never stored
            // eslint-disable-next-line @next/next/no-img-element
            <img src={state.result.screenshot} alt={t.nextTestScreenshot} className="mt-3 max-h-96 rounded-md border" />
          )}
          {state.result.steps.length > 0 && (
            <ul className="mt-3 space-y-1.5 text-muted-foreground">
              {state.result.steps.map((s) => (
                <li key={s.name}>
                  <span className="font-medium text-foreground">{s.name}</span>{" — "}{status(s.status)}{": "}{s.detail}
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-xs text-muted-foreground">{t.nextTouched(state.result.touchedIfs)}</p>
          <p className="mt-1 text-xs text-muted-foreground">{t.nextTestRealEnvironment}: {state.result.validation.realEnvironment}</p>
          <Button variant="outline" size="sm" className="mt-3" onClick={() => dispatch({ type: "reset" })}>{t.nextTestAgain}</Button>
        </div>
      )}
    </div>
  );
}
