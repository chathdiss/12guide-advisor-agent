// The test run of a quick report that exists in IFS: the consultant types the id of the report and the values of its parameters, confirms, and IFS runs the
// SQL. As in next-steps.ts, every step is an explicit action, and an action that does not fit the state changes nothing. The rows and the screenshot that come
// back live in this state only: they are not stored, not logged, and not part of the chat.
import type { RunStep, Validation } from "./next-steps";

export type TestRunResult = {
  ok: boolean;
  outcome: string;
  touchedIfs: string;
  steps: RunStep[];
  message: string;
  result?: { columns: string[]; expectedColumns: string[]; columnsMatch: boolean; rows: string[][]; rowCount: number; moreRows: boolean; seconds: number };
  screenshot?: string | null;
  validation: Validation;
};

export type TestRunState =
  | { step: "idle" }
  | { step: "confirming" }
  | { step: "running" }
  | { step: "done"; result: TestRunResult }
  | { step: "failed"; message: string };

export type TestRunAction =
  | { type: "start" }
  | { type: "confirm" }
  | { type: "cancel" }
  | { type: "finished"; result: TestRunResult }
  | { type: "failed"; message: string }
  | { type: "reset" };

export const initialTestRunState: TestRunState = { step: "idle" };

export function testRunReducer(state: TestRunState, action: TestRunAction): TestRunState {
  switch (action.type) {
    case "start":
      return state.step === "idle" ? { step: "confirming" } : state;
    case "confirm":
      return state.step === "confirming" ? { step: "running" } : state;
    case "cancel":
      return state.step === "confirming" ? { step: "idle" } : state;
    case "finished":
      return state.step === "running" ? { step: "done", result: action.result } : state;
    case "failed":
      return state.step === "running" ? { step: "failed", message: action.message } : state;
    case "reset":
      return state.step === "done" || state.step === "failed" ? { step: "idle" } : state;
    default:
      return state;
  }
}

// what may not be in a value that is typed into a parameter: it is put into the SQL as text (the backend refuses the same)
export const UNSAFE_VALUE = /['";&]|--|\/\*|\*\//;
export const MAX_VALUE_CHARS = 100;

export type ParameterInfo = { name: string; mandatory: boolean };

// the parameters of the design (its JSON text), or none when it cannot be read
export function parametersOf(design: string): ParameterInfo[] {
  try {
    const parsed = JSON.parse(design);
    return (Array.isArray(parsed.parameters) ? parsed.parameters : []).map((p: { name?: unknown; mandatory?: unknown }) => ({ name: String(p.name), mandatory: p.mandatory === true }));
  } catch {
    return [];
  }
}

export type InputProblems = { problems: { code: string; name?: string }[]; warnings: { code: "empty"; name: string }[] };

// What is wrong with what the consultant typed, and what deserves a warning: an optional parameter that is empty may return every row.
export function checkTestInputs(parameters: ParameterInfo[], values: Record<string, string>, reportId: string): InputProblems {
  const problems: InputProblems["problems"] = [];
  const warnings: InputProblems["warnings"] = [];
  if (!/^\d{1,12}$/.test(reportId.trim())) problems.push({ code: "id" });
  for (const p of parameters) {
    const value = values[p.name] ?? "";
    if (value.length > MAX_VALUE_CHARS) problems.push({ code: "long", name: p.name });
    else if (UNSAFE_VALUE.test(value)) problems.push({ code: "unsafe", name: p.name });
    else if (value === "" && p.mandatory) problems.push({ code: "mandatory", name: p.name });
    else if (value === "") warnings.push({ code: "empty", name: p.name });
  }
  return { problems, warnings };
}

// The body of the request that runs the test. Only built from the state in which the consultant has confirmed.
export function testRequest(
  state: TestRunState,
  input: { design: string; designHash: string | null; reportId: string; parameters: ParameterInfo[]; values: Record<string, string> },
): { design: string; designHash: string; approved: true; confirmed: true; reportId: string; params: Record<string, string> } | null {
  if (state.step !== "running" || !input.designHash) return null;
  const params: Record<string, string> = {};
  for (const p of input.parameters) params[p.name] = input.values[p.name] ?? "";
  return { design: input.design, designHash: input.designHash, approved: true, confirmed: true, reportId: input.reportId.trim(), params };
}
