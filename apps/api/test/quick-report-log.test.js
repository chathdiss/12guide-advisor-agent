// What the backend writes to its log about the next steps of a quick report: metadata only, never the design, the SQL, a title, or the content of a page.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { reviewDesign } from "../../../packages/quick-reports/src/review-design.js";
import { createQuickReportActions } from "../src/quickreport-actions.js";

const COLUMNS = { CUSTOMER_INFO: ["CUSTOMER_ID", "NAME"] };
const lookup = async (view) => (COLUMNS[view] ? new Set(COLUMNS[view]) : null);
const design = {
  designVersion: 1,
  spec: { title: "Secret Report Title" },
  report: { title: "Secret Report Title", purpose: "Lists customers." },
  dataSources: [{ id: "DS1", status: "ready", entitiesUsed: [{ view: "CUSTOMER_INFO" }], assumptions: [], sql: "SELECT c.customer_id AS \"Customer Id\" FROM IFSAPP.CUSTOMER_INFO c WHERE c.name = 'SecretValue'" }],
  columns: [{ label: "Customer Id", specSource: "x", expression: "c.customer_id" }],
  decisions: [],
  openQuestions: [],
};
const text = JSON.stringify(design);

const setup = ({ runnerResult, runnerThrows, checkThrows } = {}) => {
  const lines = [];
  const actions = createQuickReportActions({
    check: async (d) => {
      if (checkThrows) throw new Error(checkThrows);
      return reviewDesign(d, lookup);
    },
    runner: { availability: () => ({ available: true, missing: [] }), run: async () => { if (runnerThrows) throw new Error(runnerThrows); return runnerResult ?? { ok: true, outcome: "rehearsed", created: false, touchedIfs: "none", steps: [], message: "m" }; } },
    exporter: { availability: () => ({ available: true, missing: [] }), run: async () => ({ ok: true, outcome: "exported", created: false, touchedIfs: "none", steps: [], message: "m" }) },
    log: (fields) => lines.push(fields),
  });
  return { actions, lines };
};
const approved = async (actions, option) => {
  const p = (await actions.prepare({ design: text })).body;
  return { design: text, designHash: p.designHash, option, approved: true, ...(option === "A" ? { confirmed: true } : {}) };
};

describe("the log of a run", () => {
  it("has a line when it starts and one when it ends, with the option, the outcome and how long it took", async () => {
    const { actions, lines } = setup({ runnerResult: { ok: true, outcome: "created", created: true, touchedIfs: "quick report created", steps: [], message: "m" } });
    await actions.run(await approved(actions, "A"));
    assert.deepEqual(lines.map((l) => l.event), ["run_started", "run_done"]);
    assert.equal(lines[0].option, "A");
    assert.deepEqual({ ...lines[1], ms: typeof lines[1].ms }, { event: "run_done", option: "A", outcome: "created", ok: true, created: true, ms: "number" });
  });

  it("names the failure of a runner by its type only, never by its message, and still answers", async () => {
    const { actions, lines } = setup({ runnerThrows: "page said: secret-token-123 for SecretValue" });
    const r = await actions.run(await approved(actions, "A"));
    assert.equal(r.status, 200);
    assert.equal(r.body.outcome, "failed");
    const failed = lines.find((l) => l.event === "run_failed");
    assert.deepEqual(failed, { event: "run_failed", option: "A", error: "Error" });
    assert.ok(!JSON.stringify(lines).includes("secret-token-123"));
  });

  it("never has the design, its SQL, its title or a page in a line", async () => {
    const { actions, lines } = setup();
    await actions.run(await approved(actions, "B"));
    await actions.run(await approved(actions, "A"));
    const logged = JSON.stringify(lines);
    for (const secret of ["Secret Report Title", "SecretValue", "SELECT", "CUSTOMER_INFO", "IFSAPP"]) assert.ok(!logged.includes(secret), secret);
  });

  it("has a line when the design cannot be checked, with a short reason, and the answer is a 503", async () => {
    const { actions, lines } = setup({ checkThrows: "Connection terminated unexpectedly" });
    const r = await actions.prepare({ design: text });
    assert.equal(r.status, 503);
    assert.deepEqual(lines, [{ event: "check_failed", error: "Error: Connection terminated unexpectedly" }]);
    const long = setup({ checkThrows: "x".repeat(500) });
    await long.actions.prepare({ design: text });
    assert.ok(long.lines[0].error.length < 170);
  });

  it("does not write anything when no log is given", async () => {
    const actions = createQuickReportActions({
      check: (d) => reviewDesign(d, lookup),
      runner: { availability: () => ({ available: true, missing: [] }), run: async () => ({ ok: true, outcome: "rehearsed", created: false, touchedIfs: "none", steps: [], message: "m" }) },
      exporter: { availability: () => ({ available: true, missing: [] }), run: async () => ({ ok: true, outcome: "exported", created: false, touchedIfs: "none", steps: [], message: "m" }) },
    });
    const r = await actions.run(await approved(actions, "B"));
    assert.equal(r.body.outcome, "exported");
  });
});
