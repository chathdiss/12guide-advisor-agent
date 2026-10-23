// The test run as an action of the backend: what has to be there before it runs (approval, confirmation, an unchanged design, the id of the report, valid
// parameter values), what the runner does with it, and what is logged. Offline: fake runners, nothing is opened in IFS.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, describe, it } from "node:test";
import { reviewDesign } from "../../../packages/quick-reports/src/review-design.js";
import { createIfsRunner } from "../src/ifs-runner.js";
import { createQuickReportActions } from "../src/quickreport-actions.js";
import { createExporter } from "../src/qr-export.js";
import { createApp } from "../src/server.js";
import { createTools } from "../src/tools.js";

const COLUMNS = { CUSTOMER_INFO: ["CUSTOMER_ID", "NAME", "COUNTRY"] };
const lookup = async (view) => (COLUMNS[view] ? new Set(COLUMNS[view]) : null);
const design = {
  designVersion: 1,
  spec: { title: "ZZ TEST - DIALOG CHECK" },
  report: { title: "ZZ TEST - DIALOG CHECK", purpose: "Lists customers." },
  parameters: [
    { name: "NameStartsWith", label: "x", type: "string", mandatory: false, default: null, usedAs: "&NameStartsWith" },
    { name: "Country", label: "x", type: "string", mandatory: true, default: null, usedAs: "&Country" },
  ],
  dataSources: [{ id: "DS1", status: "ready", entitiesUsed: [{ view: "CUSTOMER_INFO" }], assumptions: [], sql: "SELECT c.customer_id AS \"Customer Id\", c.name AS \"Name\" FROM IFSAPP.CUSTOMER_INFO c WHERE c.name LIKE '&NameStartsWith%' AND c.country = '&Country'" }],
  columns: [{ label: "Customer Id", specSource: "x", expression: "c.customer_id" }, { label: "Name", specSource: "x", expression: "c.name" }],
  decisions: [],
  openQuestions: [],
};
const text = JSON.stringify(design);
const copy = (o) => JSON.parse(JSON.stringify(o));

const TESTED = {
  ok: true,
  outcome: "tested",
  touchedIfs: "ran the report (a read-only SELECT)",
  steps: [{ name: "Press Execute", status: "ok", detail: "d" }],
  message: "m",
  executed: "ran on env.build.ifs.cloud: 2 row(s) read in 1.2 s, columns match the design",
  result: { columns: ["Customer Id", "Name"], columnsMatch: true, rows: [["SECRET-ROW-VALUE", "Acme Industries"]], rowCount: 2, moreRows: false, seconds: 1.2 },
  screenshot: "data:image/png;base64,SECRETSCREENSHOT",
};

const setup = ({ result = TESTED, throws = false, available = true } = {}) => {
  const calls = [];
  const lines = [];
  const actions = createQuickReportActions({
    check: (d) => reviewDesign(d, lookup),
    runner: {
      availability: () => (available ? { available: true, missing: [], testMode: "execute" } : { available: false, missing: ["Automation is switched off."], testMode: "rehearsal" }),
      run: async () => ({ ok: true, outcome: "created", created: true, steps: [], message: "m" }),
      test: async (d, request) => {
        calls.push({ design: d, request });
        if (throws) throw new Error("page said secret-token-123");
        return result;
      },
    },
    exporter: createExporter(),
    log: (fields) => lines.push(fields),
  });
  return { actions, calls, lines };
};
const body = async (actions, patch = {}) => {
  const p = (await actions.prepare({ design: text })).body;
  return { design: text, designHash: p.designHash, approved: true, confirmed: true, reportId: "123456", params: { NameStartsWith: "A", Country: "Sweden" }, ...patch };
};

describe("what a test run needs before it runs", () => {
  it("runs nothing without the approval, the confirmation, or a numeric report id", async () => {
    const { actions, calls } = setup();
    const base = await body(actions);
    for (const [patch, status, code] of [
      [{ approved: false }, 409, "not_approved"],
      [{ approved: undefined }, 409, "not_approved"],
      [{ confirmed: false }, 409, "confirmation_required"],
      [{ confirmed: undefined }, 409, "confirmation_required"],
      [{ reportId: "75x" }, 400, "invalid_request"],
      [{ reportId: "" }, 400, "invalid_request"],
      [{ reportId: "../1" }, 400, "invalid_request"],
      [{ reportId: "1234567890123" }, 400, "invalid_request"],
    ]) {
      const r = await actions.test({ ...base, ...patch });
      assert.equal(r.status, status, JSON.stringify(patch));
      assert.equal(r.body.code, code, JSON.stringify(patch));
    }
    assert.equal(calls.length, 0);
  });

  it("runs nothing for a design that changed after the approval, or that is not ready", async () => {
    const { actions, calls } = setup();
    const base = await body(actions);
    const changed = copy(design);
    changed.report.purpose = "A purpose that was changed after the approval.";
    assert.equal((await actions.test({ ...base, design: JSON.stringify(changed) })).body.code, "design_changed");
    assert.equal((await actions.test({ ...base, designHash: undefined })).body.code, "design_changed");
    const open = copy(design);
    open.decisions = [{ id: "D1", title: "Meaning of Amount", question: "?", options: [] }];
    assert.equal((await actions.test({ ...base, design: JSON.stringify(open) })).body.code, "not_ready");
    assert.equal(calls.length, 0);
  });

  it("refuses values for a parameter that the design does not have, empty values for a mandatory one, long values, and values that could change the SQL", async () => {
    const { actions, calls } = setup();
    const base = await body(actions);
    const refusedBy = async (params) => (await actions.test({ ...base, params })).body;
    assert.match((await refusedBy({ Other: "x", Country: "S" })).error, /no parameter Other/);
    assert.match((await refusedBy({ NameStartsWith: "A" })).error, /Country is mandatory/);
    assert.match((await refusedBy({ NameStartsWith: "A", Country: "" })).error, /Country is mandatory/);
    assert.match((await refusedBy({ NameStartsWith: "x".repeat(101), Country: "S" })).error, /longer than 100/);
    for (const bad of ["a'b", "a;b", "a--b", "a&b"]) assert.match((await refusedBy({ NameStartsWith: bad, Country: "S" })).error, /may not contain quotes, semicolons, ampersands or comment marks/, bad);
    assert.equal(calls.length, 0);
  });

  it("allows an empty optional parameter, and hands the runner every declared parameter as text", async () => {
    const { actions, calls } = setup();
    const r = await actions.test(await body(actions, { params: { Country: "Sweden" } }));
    assert.equal(r.status, 200);
    assert.deepEqual(calls[0].request, { reportId: "123456", params: { NameStartsWith: "", Country: "Sweden" } });
    assert.equal(calls[0].design.report.title, "ZZ TEST - DIALOG CHECK");
  });

  it("says what is missing when the runner is not available, and runs nothing", async () => {
    const { actions, calls } = setup({ available: false });
    const r = await actions.test(await body(actions));
    assert.equal(r.status, 409);
    assert.equal(r.body.code, "unavailable");
    assert.match(r.body.missing.join(" "), /Automation is switched off/);
    assert.equal(calls.length, 0);
  });
});

describe("the result of a test run", () => {
  it("gives the rows and the screenshot to the consultant, and the run as the status of the real environment", async () => {
    const { actions } = setup();
    const r = await actions.test(await body(actions));
    assert.equal(r.status, 200);
    assert.equal(r.body.outcome, "tested");
    assert.equal(r.body.result.rows[0][0], "SECRET-ROW-VALUE");
    assert.ok(r.body.screenshot.startsWith("data:image/png;base64,"));
    assert.equal(r.body.validation.realEnvironment, TESTED.executed);
    assert.equal(r.body.validation.offline, "design checks passed");
  });

  it("keeps the status 'not run' for a rehearsal, an error of IFS and a timeout", async () => {
    for (const result of [
      { ok: true, outcome: "rehearsed", touchedIfs: "read-only visit", steps: [], message: "m" },
      { ok: false, outcome: "refused", touchedIfs: "ran the report (a read-only SELECT)", steps: [], message: "m" },
      { ok: false, outcome: "timeout", touchedIfs: "ran the report (a read-only SELECT)", steps: [], message: "m" },
    ]) {
      const { actions } = setup({ result });
      assert.equal((await actions.test(await body(actions))).body.validation.realEnvironment, "not run", result.outcome);
    }
  });

  it("does not start a second test run for the same design while one is running", async () => {
    let release;
    const gate = new Promise((r) => (release = r));
    const { actions } = setup();
    const slow = createQuickReportActions({
      check: (d) => reviewDesign(d, lookup),
      runner: { availability: () => ({ available: true, missing: [] }), run: async () => ({}), test: async () => (await gate, TESTED) },
      exporter: createExporter(),
    });
    const base = await body(actions);
    const first = slow.test(base);
    await new Promise((r) => setTimeout(r, 10));
    const second = await slow.test(base);
    assert.equal(second.body.code, "in_progress");
    release();
    assert.equal((await first).body.outcome, "tested");
    assert.equal((await slow.test(base)).status, 200, "allowed again after it ended");
  });

  it("answers a failure of the runner without its content", async () => {
    const { actions, lines } = setup({ throws: true });
    const r = await actions.test(await body(actions));
    assert.equal(r.body.outcome, "failed");
    assert.equal(r.body.validation.realEnvironment, "not run");
    assert.ok(!JSON.stringify(r.body).includes("secret-token-123") && !JSON.stringify(lines).includes("secret-token-123"));
  });
});

describe("the log of a test run", () => {
  it("has counts and timings only: never the rows, the values typed, the screenshot, or the SQL", async () => {
    const { actions, lines } = setup();
    await actions.test(await body(actions));
    assert.deepEqual(lines.map((l) => l.event), ["test_started", "test_done"]);
    assert.deepEqual({ ...lines[1], ms: typeof lines[1].ms }, { event: "test_done", outcome: "tested", ok: true, rows: 2, columnsMatch: true, ms: "number" });
    const logged = JSON.stringify(lines);
    for (const secret of ["SECRET-ROW-VALUE", "Acme Industries", "SECRETSCREENSHOT", "Sweden", "SELECT", "CUSTOMER_INFO"]) assert.ok(!logged.includes(secret), secret);
  });
});

describe("the test method of the IFS runner", () => {
  const config = { enabled: true, baseUrl: "https://env.build.ifs.cloud/landing-page/", storageState: "C:/x/session.json", fileExists: () => true, playwrightInstalled: () => true };
  const fakePlaywright = () => {
    const seen = { launch: [], closed: 0, storageState: null };
    const page = { tag: "page" };
    const browser = { newContext: async (o) => ((seen.storageState = o.storageState), { newPage: async () => page }), close: async () => void seen.closed++ };
    return { seen, page, loadPlaywright: async () => ({ chromium: { launch: async (o) => (seen.launch.push(o.headless), browser) } }) };
  };

  it("says in its availability whether a test run executes the SQL or only rehearses", () => {
    assert.equal(createIfsRunner({ ...config }).availability().testMode, "rehearsal");
    assert.equal(createIfsRunner({ ...config, executeTests: true }).availability().testMode, "execute");
  });

  it("opens the run page of the report with the saved session, passes the values on, and closes the browser", async () => {
    const f = fakePlaywright();
    const calls = [];
    const runner = createIfsRunner({ ...config, executeTests: true, loadPlaywright: f.loadPlaywright, testRun: async (page, d, o) => (calls.push({ page, d, o }), { ok: true, outcome: "tested", touchedIfs: "x", steps: [{ name: "Press Execute", status: "ok", detail: "d" }], message: "m" }) });
    const r = await runner.test({ report: { title: "T" } }, { reportId: "123456", params: { A: "1" } });
    assert.equal(calls[0].page, f.page);
    assert.deepEqual({ ...calls[0].o, timeoutMs: undefined }, { reportId: "123456", params: { A: "1" }, execute: true, runUrl: "https://env.build.ifs.cloud/main/ifsapplications/web/quickreport/123456", timeoutMs: undefined });
    assert.equal(f.seen.storageState, "C:/x/session.json");
    assert.equal(f.seen.closed, 1);
    assert.deepEqual(r.steps.map((s) => s.name), ["Configuration", "Press Execute"]);
  });

  it("is visible for a rehearsal, and without a window for a real run unless headed is on", async () => {
    const launches = [];
    for (const [executeTests, headed] of [[false, false], [true, false], [true, true], [false, true]]) {
      const f = fakePlaywright();
      await createIfsRunner({ ...config, executeTests, headed, loadPlaywright: f.loadPlaywright, testRun: async () => ({ ok: true, outcome: "rehearsed", steps: [], message: "m" }) }).test({}, { reportId: "1", params: {} });
      launches.push(...f.seen.launch);
    }
    assert.deepEqual(launches, [false, true, false, false]);
  });

  it("starts nothing when the configuration is not complete, and closes the browser when the test run throws", async () => {
    const f = fakePlaywright();
    const off = await createIfsRunner({ ...config, enabled: false, loadPlaywright: f.loadPlaywright }).test({}, { reportId: "1", params: {} });
    assert.equal(off.outcome, "unavailable");
    assert.equal(f.seen.launch.length, 0);
    const boom = await createIfsRunner({ ...config, loadPlaywright: f.loadPlaywright, testRun: async () => { throw new Error("page crashed"); } }).test({}, { reportId: "1", params: {} });
    assert.equal(boom.outcome, "failed");
    assert.equal(f.seen.closed, 1);
  });
});

describe("the route of the test run", () => {
  let api;
  let base;
  const post = (path, payload) => fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  before(async () => {
    const db = { query: async (sql, [view]) => ({ rows: (COLUMNS[view] ?? []).map((column_name) => ({ column_name })) }) };
    const tools = createTools({ db, search: async () => [], searchAll: async () => [], loadFull: async () => new Map() });
    api = createApp({ n8nChatUrl: "http://127.0.0.1:9/x", tools, quickReports: createQuickReportActions({ check: (d) => tools.checkQuickReport(d), runner: createIfsRunner({}), exporter: createExporter() }) });
    await new Promise((r) => api.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${api.address().port}`;
  });
  after(() => new Promise((r) => api.close(r)));

  it("uses POST, needs the confirmation, and says what is missing when automation is off, without opening anything", async () => {
    assert.equal((await fetch(`${base}/api/quick-report/test`)).status, 405);
    const check = await (await post("/api/quick-report/check", { design: text })).json();
    const payload = { design: text, designHash: check.designHash, approved: true, reportId: "123456", params: { Country: "Sweden" } };
    const without = await post("/api/quick-report/test", payload);
    assert.equal(without.status, 409);
    assert.equal((await without.json()).code, "confirmation_required");
    const res = await post("/api/quick-report/test", { ...payload, confirmed: true });
    const out = await res.json();
    assert.equal(res.status, 409);
    assert.equal(out.code, "unavailable");
    assert.match(out.missing.join(" "), /Automation is switched off/);
  });
});
