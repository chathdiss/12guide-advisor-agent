// The next steps of a reviewed quick report design: is it ready, and what the consultant chose to do with it (Option A: create it in IFS with
// Playwright, Option B: an export file). Nothing happens without an explicit request that names the option, for exactly the design that was
// approved, and the options are never chosen for the consultant. The SQL status stays "not run": only a verified run on IFS could change it.
import { designHash, readiness, validationLevels } from "../../../packages/quick-reports/src/next-steps.js";
import { UNSAFE_VALUE } from "./ifs-testrun.js";

const MAX_DESIGN_CHARS = 400_000;
const OPTIONS = ["A", "B"];
const MAX_VALUE_CHARS = 100;

const refuse = (status, code, error) => ({ status, body: { ok: false, code, error } });

// check(designJson) -> the result of reviewDesign; runner / exporter: { availability(), run(design) }; log(fields): a line for the log of the server
export function createQuickReportActions({ check, runner, exporter, log = () => {} }) {
  // runs that have started and not ended: a double click or a retry while one is running does not start a second one
  const running = new Set();

  const options = () => ({ A: runner.availability(), B: exporter.availability() });

  async function reviewed(designJson) {
    if (typeof designJson !== "string" || !designJson.trim()) return { error: refuse(400, "invalid_request", "The design is missing.") };
    if (designJson.length > MAX_DESIGN_CHARS) return { error: refuse(413, "invalid_request", "The design is too large.") };
    let review;
    try {
      review = await check(designJson);
    } catch (err) {
      log({ event: "check_failed", error: `${err?.name ?? "Error"}: ${String(err?.message ?? "").slice(0, 150)}` });
      return { error: refuse(503, "check_unavailable", "The design could not be checked right now.") };
    }
    return { review };
  }

  return {
    // Is the design ready for the consultant to approve? Read-only: never touches IFS.
    async prepare(body) {
      const { review, error } = await reviewed(body?.design);
      if (error) return error;
      const state = readiness(review);
      return {
        status: 200,
        body: {
          ok: true,
          ready: state.ready,
          blockers: state.blockers,
          openQuestions: state.openQuestions,
          designHash: state.designHash,
          validation: validationLevels(review),
          // what each option needs; nothing is chosen, and nothing is run
          options: options(),
        },
      };
    },

    // The consultant chose an option. body: { design, designHash, option: "A" | "B", approved: true, confirmed?: true }
    async run(body) {
      const option = body?.option;
      if (!OPTIONS.includes(option)) return refuse(400, "option_required", 'Choose Option "A" or Option "B". Nothing is chosen for you.');
      if (body?.approved !== true) return refuse(409, "not_approved", "The design has not been approved.");
      if (option === "A" && body?.confirmed !== true) return refuse(409, "confirmation_required", "Option A changes the IFS environment: confirm it first.");

      const { review, error } = await reviewed(body?.design);
      if (error) return error;
      const state = readiness(review);
      if (!state.ready) return { status: 409, body: { ok: false, code: "not_ready", error: "The design is not ready for the next step.", blockers: state.blockers } };
      if (typeof body.designHash !== "string" || body.designHash !== state.designHash) {
        return refuse(409, "design_changed", "The design is not the one that was approved. Approve it again.");
      }

      const key = `${state.designHash}:${option}`;
      if (running.has(key)) return refuse(409, "in_progress", "This option is already running for this design.");
      running.add(key);
      const started = Date.now();
      log({ event: "run_started", option });
      try {
        const chosen = option === "A" ? runner : exporter;
        let result;
        try {
          result = await chosen.run(review.design);
        } catch (err) {
          // never the content of an error: it may hold paths or page content
          result = { ok: false, outcome: "failed", created: false, touchedIfs: "unknown", steps: [], message: "The action failed unexpectedly. Check the backend log." };
          log({ event: "run_failed", option, error: String(err?.name ?? "Error") });
        }
        log({ event: "run_done", option, outcome: result.outcome, ok: result.ok, created: result.created, ms: Date.now() - started });
        return {
          status: 200,
          body: {
            option,
            ...result,
            // what was checked, and how: the SQL has not been run on IFS unless a real run says so
            validation: validationLevels(review, result.executed ?? null),
          },
        };
      } finally {
        running.delete(key);
      }
    },

    // The test run of a report that exists in IFS: its SQL is run by IFS, with the parameter values that the consultant typed. It needs the approval, a
    // confirmation, the id of the report, and it runs only the report that has the title of the approved design (ifs-testrun.js). Without the setting
    // IFS_TEST_EXECUTE it is a rehearsal that does not press Execute. body: { design, designHash, approved: true, confirmed: true, reportId, params }
    async test(body) {
      if (body?.approved !== true) return refuse(409, "not_approved", "The design has not been approved.");
      if (body?.confirmed !== true) return refuse(409, "confirmation_required", "A test run runs the SQL of the report in IFS: confirm it first.");
      const reportId = String(body?.reportId ?? "").trim();
      if (!/^\d{1,12}$/.test(reportId)) return refuse(400, "invalid_request", "The id of the report must be a number.");
      const params = body?.params && typeof body.params === "object" && !Array.isArray(body.params) ? body.params : {};

      const { review, error } = await reviewed(body?.design);
      if (error) return error;
      const state = readiness(review);
      if (!state.ready) return { status: 409, body: { ok: false, code: "not_ready", error: "The design is not ready for the next step.", blockers: state.blockers } };
      if (typeof body.designHash !== "string" || body.designHash !== state.designHash) {
        return refuse(409, "design_changed", "The design is not the one that was approved. Approve it again.");
      }

      // the values: only declared parameters, short, without what could change the SQL around them, and a value for each mandatory one
      const declared = (review.design.parameters ?? []).map((p) => ({ name: String(p.name), mandatory: p.mandatory === true }));
      for (const key of Object.keys(params)) {
        if (!declared.some((p) => p.name === key)) return refuse(400, "invalid_request", `The design has no parameter ${key}.`);
      }
      for (const p of declared) {
        const value = params[p.name] === undefined || params[p.name] === null ? "" : String(params[p.name]);
        if (value.length > MAX_VALUE_CHARS) return refuse(400, "invalid_request", `The value of ${p.name} is longer than ${MAX_VALUE_CHARS} characters.`);
        if (UNSAFE_VALUE.test(value)) return refuse(400, "invalid_request", `The value of ${p.name} may not contain quotes, semicolons, ampersands or comment marks.`);
        if (p.mandatory && value === "") return refuse(400, "invalid_request", `The parameter ${p.name} is mandatory: it needs a value.`);
        params[p.name] = value;
      }

      const availability = runner.availability();
      if (!availability.available) return { status: 409, body: { ok: false, code: "unavailable", error: "The test run cannot start yet.", missing: availability.missing } };

      const key = `${state.designHash}:test`;
      if (running.has(key)) return refuse(409, "in_progress", "A test run is already running for this design.");
      running.add(key);
      const started = Date.now();
      log({ event: "test_started", mode: availability.testMode });
      try {
        let result;
        try {
          result = await runner.test(review.design, { reportId, params });
        } catch (err) {
          result = { ok: false, outcome: "failed", touchedIfs: "unknown", steps: [], message: "The test run failed unexpectedly. Check the backend log." };
          log({ event: "test_failed", error: String(err?.name ?? "Error") });
        }
        // counts and timings only: the rows, the values and the screenshot go to the consultant and nowhere else
        log({ event: "test_done", outcome: result.outcome, ok: result.ok, rows: result.result?.rowCount ?? null, columnsMatch: result.result?.columnsMatch ?? null, ms: Date.now() - started });
        return { status: 200, body: { ...result, validation: validationLevels(review, result.executed ?? null) } };
      } finally {
        running.delete(key);
      }
    },
  };
}
