// What happens after a quick report design was reviewed, as a state machine: check -> approve -> choose Option A or B -> (confirm A) -> run.
// Every step needs its own explicit action of the consultant, and an action that does not fit the state changes nothing. That is what keeps
// "nothing runs before the consultant chose" true, whatever the buttons or retries do.

export type OptionId = "A" | "B";

export type Validation = {
  dictionary: { checked: number; unknownViews: number; unknownColumns: number };
  offline: string;
  // "not run" until the SQL has really been run on IFS and the result was checked
  realEnvironment: string;
};

// mode (Option A): "rehearsal" fills in the New Report dialog in IFS and cancels it, "create" saves the report
export type OptionAvailability = { available: boolean; missing: string[]; target?: string | null; mode?: "rehearsal" | "create"; testMode?: "rehearsal" | "execute" };

export type CheckInfo = {
  ready: boolean;
  blockers: string[];
  openQuestions: string[];
  designHash: string | null;
  validation: Validation;
  options: Record<OptionId, OptionAvailability>;
};

export type RunStep = { name: string; status: string; detail: string };

export type RunResult = {
  option: OptionId;
  // Option B: the export file, how to import it, and what to be careful about
  file?: { name: string; mimeType: string; content: string; bytes: number };
  instructions?: string[];
  warnings?: string[];
  // the id of the report in IFS: Option A reads it from the new report, Option B has put it in the file
  reportId?: string | number | null;
  ok: boolean;
  outcome: string;
  created: boolean;
  touchedIfs: string;
  steps: RunStep[];
  message: string;
  validation: Validation;
};

export type NextState =
  | { step: "checking" }
  | { step: "unavailable"; message: string }
  | { step: "blocked"; info: CheckInfo }
  | { step: "review"; info: CheckInfo }
  | { step: "options"; info: CheckInfo }
  | { step: "confirmA"; info: CheckInfo }
  | { step: "running"; info: CheckInfo; option: OptionId }
  | { step: "done"; info: CheckInfo; result: RunResult }
  | { step: "failed"; info: CheckInfo; option: OptionId; message: string };

export type NextAction =
  | { type: "checked"; info: CheckInfo }
  | { type: "checkFailed"; message: string }
  | { type: "recheck" }
  | { type: "approve" }
  | { type: "choose"; option: OptionId }
  | { type: "confirm" }
  | { type: "cancel" }
  | { type: "finished"; result: RunResult }
  | { type: "failed"; message: string }
  | { type: "back" };

export const initialNextState: NextState = { step: "checking" };

export function nextStepsReducer(state: NextState, action: NextAction): NextState {
  switch (action.type) {
    case "checked":
      if (state.step !== "checking") return state;
      return action.info.ready && action.info.designHash ? { step: "review", info: action.info } : { step: "blocked", info: action.info };
    case "checkFailed":
      return state.step === "checking" ? { step: "unavailable", message: action.message } : state;
    case "recheck":
      return state.step === "blocked" || state.step === "unavailable" ? { step: "checking" } : state;
    // the design is ready and the consultant approves it: only now are the options shown
    case "approve":
      return state.step === "review" ? { step: "options", info: state.info } : state;
    // the consultant picks an option. A can be picked only when it is available, and it still has to be confirmed; B starts at once.
    case "choose": {
      if (state.step !== "options") return state;
      if (!state.info.options[action.option]?.available) return state;
      return action.option === "A" ? { step: "confirmA", info: state.info } : { step: "running", info: state.info, option: "B" };
    }
    case "confirm":
      return state.step === "confirmA" ? { step: "running", info: state.info, option: "A" } : state;
    case "cancel":
      return state.step === "confirmA" ? { step: "options", info: state.info } : state;
    case "finished":
      return state.step === "running" ? { step: "done", info: state.info, result: action.result } : state;
    case "failed":
      return state.step === "running" ? { step: "failed", info: state.info, option: state.option, message: action.message } : state;
    // after a result or a failure the consultant is back at the options, and nothing runs until a new choice
    case "back":
      return state.step === "done" || state.step === "failed" ? { step: "options", info: state.info } : state;
    default:
      return state;
  }
}

// What to say when the answer of the backend to a run was lost (the connection broke, or the backend restarted): the run may still have happened
export function lostRunMessage(option: OptionId, texts: { nextRunLostA: string; nextRunLostB: string }): string {
  return option === "A" ? texts.nextRunLostA : texts.nextRunLostB;
}

// The body of the request that runs the chosen option. Only built from a state in which the consultant has chosen (and for A, confirmed).
export function runRequest(state: NextState, design: string): { design: string; designHash: string; option: OptionId; approved: true; confirmed?: true } | null {
  if (state.step !== "running" || !state.info.designHash) return null;
  return {
    design,
    designHash: state.info.designHash,
    option: state.option,
    approved: true,
    ...(state.option === "A" ? { confirmed: true as const } : {}),
  };
}
