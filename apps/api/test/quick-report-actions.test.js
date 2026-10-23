// The next steps of a reviewed quick report design: readiness, the explicit choice of Option A or B, and what each option does. All offline: fake
// Playwright, no network, nothing opened or changed in IFS.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, describe, it } from "node:test";
import { designHash, readiness } from "../../../packages/quick-reports/src/next-steps.js";
import { reviewDesign } from "../../../packages/quick-reports/src/review-design.js";
import { createIfsRunner } from "../src/ifs-runner.js";
import { createQuickReportActions } from "../src/quickreport-actions.js";
import { checkExportXml } from "../../../packages/quick-reports/src/export-xml.js";
import { createExporter } from "../src/qr-export.js";
import { createApp } from "../src/server.js";
import { createTools } from "../src/tools.js";

const COLUMNS = { INVOICE_LEDGER_ITEM_CU_QRY: ["COMPANY", "IDENTITY", "NAME", "INVOICE_NO", "DUE_DATE", "OPEN_AMOUNT", "OPEN_DOM_AMOUNT", "INVOICE_AMOUNT", "CURRENCY"] };
const lookup = async (view) => (COLUMNS[view] ? new Set(COLUMNS[view]) : null);
const db = { query: async (sql, [view]) => ({ rows: (COLUMNS[view] ?? []).map((column_name) => ({ column_name })) }) };
const tools = createTools({ db, search: async () => [], searchAll: async () => [], loadFull: async () => new Map() });

const design = {
  designVersion: 1,
  spec: { title: "Open Customer Invoices", customer: "not given", ticket: "not given", specRevision: "not given", file: "not given" },
  type: "SQL quick report",
  report: { title: "Open Customer Invoices", category: "not given", permissionSets: "not given", purpose: "Lists the open customer invoices of one company." },
  parameters: [{ name: "Company", label: "Company", type: "string", mandatory: true, default: null, usedAs: "&Company" }],
  dataSources: [
    {
      id: "DS1",
      status: "draft",
      purpose: "Open customer invoices",
      entitiesUsed: [{ view: "INVOICE_LEDGER_ITEM_CU_QRY", role: "Customer invoice ledger items" }],
      assumptions: ["An invoice is open when OPEN_AMOUNT is not 0."],
      sql: "SELECT i.invoice_no AS \"Invoice No\", i.open_amount AS \"Amount\" FROM INVOICE_LEDGER_ITEM_CU_QRY i WHERE i.company = '&Company' AND i.open_amount <> 0 ORDER BY i.invoice_no",
    },
  ],
  columns: [
    { label: "Invoice No", specSource: "Invoice No", expression: "i.invoice_no" },
    { label: "Amount", specSource: "Amount", expression: "i.open_amount" },
  ],
  decisions: [],
  validation: { status: "not run", toConfirmOnTheTestEnvironment: ["The view returns rows for a test company."] },
  openQuestions: ["Which category and permission sets should the report get?"],
};
const text = (d = design) => JSON.stringify(d);
const copy = (o) => JSON.parse(JSON.stringify(o));

// a runner and an exporter that only count what they are asked to do
const spies = () => {
  const calls = { A: 0, B: 0 };
  return {
    calls,
    runner: { availability: () => ({ available: true, missing: [] }), run: async () => (calls.A++, { ok: true, outcome: "created", created: true, touchedIfs: "created", steps: [{ name: "Create", status: "ok", detail: "fake" }], message: "fake" }) },
    exporter: { availability: () => ({ available: true, missing: [] }), run: async () => (calls.B++, { ok: true, outcome: "exported", created: true, touchedIfs: "none", steps: [], message: "fake" }) },
  };
};
const actionsWith = (s) => createQuickReportActions({ check: (d) => reviewDesign(d, lookup), runner: s.runner, exporter: s.exporter });
const approvedBody = async (option, extra = {}) => {
  const p = (await actionsWith(spies()).prepare({ design: text() })).body;
  return { design: text(), designHash: p.designHash, option, approved: true, ...(option === "A" ? { confirmed: true } : {}), ...extra };
};

describe("when a design is ready for the next step", () => {
  const readyOf = async (d) => readiness(await reviewDesign(text(d), lookup));

  it("is ready when the checks pass, no decision is open, and the SQL was checked against the data dictionary", async () => {
    const r = await readyOf(design);
    assert.equal(r.ready, true);
    assert.deepEqual(r.blockers, []);
    assert.match(r.designHash, /^[0-9a-f]{64}$/);
  });

  it("is not ready while a decision is open, a check fails, a source is blocked, or nothing could be checked", async () => {
    const withDecision = copy(design);
    withDecision.decisions = [{ id: "D1", title: "Meaning of Amount", question: "?", options: [] }];
    assert.deepEqual((await readyOf(withDecision)).blockers, ["Decision not made yet: Meaning of Amount."]);

    const wrongColumn = copy(design);
    wrongColumn.dataSources[0].sql = wrongColumn.dataSources[0].sql.replace("i.open_amount AS", "i.no_such_column AS");
    const bad = await readyOf(wrongColumn);
    assert.equal(bad.ready, false);
    assert.ok(bad.blockers.some((b) => /NO_SUCH_COLUMN/i.test(b)));

    const blocked = copy(design);
    blocked.dataSources[0] = { id: "DS1", status: "blocked", purpose: "x", entitiesUsed: [], assumptions: [], blockedBy: "the spec gives no source" };
    assert.ok((await readyOf(blocked)).blockers.some((b) => /blocked: the spec gives no source/.test(b)));

    const unreadable = readiness(await reviewDesign("not json", lookup));
    assert.equal(unreadable.ready, false);
  });

  it("lists the open questions, but they do not block: approving is the consultant's decision", async () => {
    const r = await readyOf(design);
    assert.deepEqual(r.openQuestions, ["Which category and permission sets should the report get?"]);
    assert.equal(r.ready, true);
  });

  it("has a fingerprint that ignores key order and changes with every change of the design", () => {
    const reverse = (v) => (Array.isArray(v) ? v.map(reverse) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).reverse().map((k) => [k, reverse(v[k])])) : v);
    const reordered = reverse(design);
    assert.notEqual(JSON.stringify(reordered), JSON.stringify(design), "the keys really are in another order");
    assert.equal(designHash(reordered), designHash(design));
    const changed = copy(design);
    changed.columns[1].expression = "i.open_dom_amount";
    assert.notEqual(designHash(changed), designHash(design));
  });
});

describe("the check before anything is chosen", () => {
  it("shows what each option needs and runs nothing, however often it is asked", async () => {
    const s = spies();
    const actions = actionsWith(s);
    for (let i = 0; i < 3; i++) {
      const { status, body } = await actions.prepare({ design: text() });
      assert.equal(status, 200);
      assert.equal(body.ready, true);
      assert.deepEqual(Object.keys(body.options), ["A", "B"]);
    }
    assert.deepEqual(s.calls, { A: 0, B: 0 }, "no Playwright flow and no export before a choice");
  });

  it("separates what was checked from what was not: the SQL has not been run on IFS", async () => {
    const { body } = await actionsWith(spies()).prepare({ design: text() });
    assert.equal(body.validation.realEnvironment, "not run");
    assert.equal(body.validation.offline, "design checks passed");
    assert.equal(body.validation.dictionary.checked > 0, true);
    assert.equal(body.validation.dictionary.unknownColumns, 0);
  });

  it("refuses a missing, unreadable or oversized design", async () => {
    const actions = actionsWith(spies());
    assert.equal((await actions.prepare({})).status, 400);
    assert.equal((await actions.prepare({ design: "x".repeat(400_001) })).status, 413);
    const unreadable = await actions.prepare({ design: "not json" });
    assert.equal(unreadable.body.ready, false);
    const broken = createQuickReportActions({ check: async () => { throw new Error("dictionary down"); }, runner: spies().runner, exporter: spies().exporter });
    const r = await broken.prepare({ design: text() });
    assert.equal(r.status, 503);
    assert.ok(!JSON.stringify(r.body).includes("dictionary down"));
  });
});

describe("the explicit choice of an option", () => {
  it("runs nothing without a named option, an approval, and (for A) a confirmation", async () => {
    const s = spies();
    const actions = actionsWith(s);
    const base = await approvedBody("A");
    for (const [patch, status, code] of [
      [{ option: undefined }, 400, "option_required"],
      [{ option: "C" }, 400, "option_required"],
      [{ option: "a" }, 400, "option_required"],
      [{ approved: false }, 409, "not_approved"],
      [{ approved: undefined }, 409, "not_approved"],
      [{ confirmed: false }, 409, "confirmation_required"],
      [{ confirmed: undefined }, 409, "confirmation_required"],
    ]) {
      const r = await actions.run({ ...base, ...patch });
      assert.equal(r.status, status, JSON.stringify(patch));
      assert.equal(r.body.code, code, JSON.stringify(patch));
    }
    assert.deepEqual(s.calls, { A: 0, B: 0 });
  });

  it("does not run for a design that changed after the approval, or that is not ready", async () => {
    const s = spies();
    const actions = actionsWith(s);
    const body = await approvedBody("B");
    const changed = copy(design);
    changed.columns[1].expression = "i.open_dom_amount";
    changed.dataSources[0].sql = changed.dataSources[0].sql.replace("i.open_amount AS", "i.open_dom_amount AS");
    assert.equal((await actions.run({ ...body, design: text(changed) })).body.code, "design_changed");
    assert.equal((await actions.run({ ...body, designHash: "0".repeat(64) })).body.code, "design_changed");
    assert.equal((await actions.run({ ...body, designHash: undefined })).body.code, "design_changed");

    const open = copy(design);
    open.decisions = [{ id: "D1", title: "Meaning of Amount", question: "?", options: [] }];
    const r = await actions.run({ ...body, design: text(open) });
    assert.equal(r.body.code, "not_ready");
    assert.deepEqual(r.body.blockers, ["Decision not made yet: Meaning of Amount."]);
    assert.deepEqual(s.calls, { A: 0, B: 0 });
  });

  it("Option A runs only the Playwright flow, and reports its result and what was checked", async () => {
    const s = spies();
    const r = await actionsWith(s).run(await approvedBody("A"));
    assert.deepEqual(s.calls, { A: 1, B: 0 });
    assert.equal(r.status, 200);
    assert.equal(r.body.option, "A");
    assert.equal(r.body.outcome, "created");
    assert.equal(r.body.validation.realEnvironment, "not run", "creating a report is not running its SQL");
  });

  it("Option B runs only the export, never the Playwright flow", async () => {
    const s = spies();
    const r = await actionsWith(s).run(await approvedBody("B"));
    assert.deepEqual(s.calls, { A: 0, B: 1 });
    assert.equal(r.body.option, "B");
    assert.equal(r.body.touchedIfs, "none");
  });

  it("does not start a second run of the same option and design while one is running, and allows a retry after it ended", async () => {
    let release;
    const gate = new Promise((r) => (release = r));
    const s = spies();
    s.runner.run = async () => (s.calls.A++, await gate, { ok: false, outcome: "failed", created: false, touchedIfs: "none", steps: [], message: "failed" });
    const actions = actionsWith(s);
    const body = await approvedBody("A");
    const first = actions.run(body);
    await new Promise((r) => setTimeout(r, 10));
    const second = await actions.run(body);
    assert.equal(second.status, 409);
    assert.equal(second.body.code, "in_progress");
    release();
    assert.equal((await first).body.outcome, "failed");
    s.runner.run = async () => (s.calls.A++, { ok: true, outcome: "created", created: true, touchedIfs: "created", steps: [], message: "ok" });
    assert.equal((await actions.run(body)).body.outcome, "created");
    assert.equal(s.calls.A, 2);
  });

  it("answers a failure of the runner without its content, and can be retried", async () => {
    const s = spies();
    s.runner.run = async () => { throw new Error("page said: secret-token-123 at C:/private/session.json"); };
    const logged = [];
    const original = console.error;
    console.error = (line) => logged.push(line);
    let r;
    try {
      r = await actionsWith(s).run(await approvedBody("A"));
    } finally {
      console.error = original;
    }
    assert.equal(r.body.outcome, "failed");
    assert.ok(!JSON.stringify(r.body).includes("secret-token-123") && !logged.join("").includes("secret-token-123"));
    assert.equal(r.body.validation.realEnvironment, "not run");
  });
});

describe("Option A: the IFS runner", () => {
  const config = { enabled: true, baseUrl: "https://env.build.ifs.cloud/landing-page/", storageState: "C:/x/session.json", fileExists: () => true, playwrightInstalled: () => true };

  // a fake Playwright: the pages it opens, and whether the browser was closed
  const fakePlaywright = ({ finalUrl = "https://env.build.ifs.cloud/landing-page/", passwordFields = 0, failOpen = false } = {}) => {
    const seen = { launched: 0, closed: 0, urls: [], storageState: null };
    const page = {
      goto: async (url) => {
        seen.urls.push(url);
        if (failOpen) throw new Error("net::ERR_NAME_NOT_RESOLVED at https://env.build.ifs.cloud");
      },
      waitForLoadState: async () => {},
      waitForTimeout: async () => {},
      url: () => finalUrl,
      locator: () => ({ count: async () => passwordFields }),
    };
    const browser = { newContext: async (o) => ((seen.storageState = o.storageState), { newPage: async () => page }), close: async () => seen.closed++ };
    return { seen, loadPlaywright: async () => ({ chromium: { launch: async () => (seen.launched++, browser) } }) };
  };

  it("says what is missing and opens nothing: automation off, no address, no session file, no Playwright", async () => {
    const fake = fakePlaywright();
    for (const [patch, expected] of [
      [{ enabled: false }, /Automation is switched off/],
      [{ baseUrl: "" }, /IFS_BASE_URL is not set/],
      [{ baseUrl: "http://env.build.ifs.cloud" }, /IFS_BASE_URL is not set/],
      [{ storageState: "" }, /IFS_STORAGE_STATE is not set/],
      [{ fileExists: () => false }, /session file .* does not exist/],
      [{ playwrightInstalled: () => false }, /Playwright is not installed/],
    ]) {
      const runner = createIfsRunner({ ...config, ...patch, loadPlaywright: fake.loadPlaywright });
      const a = runner.availability();
      assert.equal(a.available, false);
      assert.match(a.missing.join(" "), expected);
      const r = await runner.run();
      assert.equal(r.outcome, "unavailable");
      assert.equal(r.created, false);
      assert.equal(r.touchedIfs, "none");
    }
    assert.equal(fake.seen.launched, 0, "no browser was started");
  });

  it("is available when everything is configured, without touching the network to find out", () => {
    const fake = fakePlaywright();
    const runner = createIfsRunner({ ...config, loadPlaywright: fake.loadPlaywright });
    assert.deepEqual(runner.availability(), { available: true, missing: [], target: "env.build.ifs.cloud", mode: "rehearsal", testMode: "rehearsal" });
    assert.equal(createIfsRunner({ ...config, rehearsal: false, loadPlaywright: fake.loadPlaywright }).availability().mode, "create");
    assert.equal(fake.seen.launched, 0);
  });

  // the steps in the Quick Reports screens are tested in ifs-create.test.js; here a fake that only records how it is called
  const fakeCreate = (result = {}) => {
    const calls = [];
    return { calls, create: async (page, design, options) => (calls.push({ page, design, options }), { ok: true, outcome: "rehearsed", created: false, touchedIfs: "opened the New Report dialog and cancelled it; nothing saved", steps: [{ name: "Fill in the dialog", status: "ok", detail: "fake" }], message: "fake", ...result }) };
  };

  it("opens the landing page with the saved session, and then does the steps of the Quick Reports screens with the approved design, in the same browser", async () => {
    const fake = fakePlaywright();
    const made = fakeCreate();
    const approved = { report: { title: "T" } };
    const r = await createIfsRunner({ ...config, loadPlaywright: fake.loadPlaywright, create: made.create }).run(approved);
    assert.deepEqual(fake.seen.urls, ["https://env.build.ifs.cloud/landing-page/"], "only the configured address is opened by the runner itself");
    assert.equal(fake.seen.storageState, "C:/x/session.json");
    assert.equal(made.calls.length, 1);
    assert.equal(made.calls[0].design, approved);
    assert.deepEqual(made.calls[0].options, { listUrl: "https://env.build.ifs.cloud/main/ifsapplications/web/page/QuickReport/List", rehearsal: true, timeoutMs: 30_000 });
    assert.equal(fake.seen.closed, 1, "the browser is closed afterwards");
    assert.deepEqual(r.steps.map((x) => [x.name, x.status]), [["Configuration", "ok"], ["Open IFS", "ok"], ["Fill in the dialog", "ok"]]);
    assert.equal(r.outcome, "rehearsed");
    assert.equal(r.created, false);
  });

  it("is a rehearsal in a visible browser unless the rehearsal is switched off, and then a run without a window", async () => {
    const launches = [];
    const playwrightWith = () => {
      const fake = fakePlaywright();
      return { fake, loadPlaywright: async () => ({ chromium: { launch: async (o) => (launches.push(o.headless), (await fake.loadPlaywright()).chromium.launch(o)) } }) };
    };
    for (const [rehearsal, headed] of [[true, false], [false, false], [false, true], [true, true]]) {
      const p = playwrightWith();
      const r = await createIfsRunner({ ...config, rehearsal, headed, loadPlaywright: p.loadPlaywright, create: fakeCreate().create }).run({});
      assert.equal(r.outcome, "rehearsed");
    }
    // headless: only a real run without IFS_HEADED
    assert.deepEqual(launches, [false, true, false, false]);
  });

  it("closes the browser, and reports a failure, when the steps in the screens throw", async () => {
    const fake = fakePlaywright();
    const r = await createIfsRunner({ ...config, loadPlaywright: fake.loadPlaywright, create: async () => { throw new Error("page crashed with secret-token-123"); } }).run({});
    assert.equal(r.outcome, "failed");
    assert.equal(fake.seen.closed, 1);
    assert.equal(r.created, false);
  });

  it("asks for a new session when IFS shows a sign-in, and does not try to get past it", async () => {
    for (const fake of [fakePlaywright({ finalUrl: "https://login.example.com/auth?x=1" }), fakePlaywright({ finalUrl: "https://env.build.ifs.cloud/auth/realms/x/protocol/openid-connect/auth" }), fakePlaywright({ passwordFields: 1 })]) {
      const r = await createIfsRunner({ ...config, loadPlaywright: fake.loadPlaywright }).run();
      assert.equal(r.outcome, "auth_required");
      assert.equal(r.created, false);
      assert.match(r.steps[1].detail, /nothing was bypassed/);
      assert.equal(fake.seen.closed, 1);
    }
  });

  it("reports a failure to open IFS, closes the browser, and keeps the error short", async () => {
    const fake = fakePlaywright({ failOpen: true });
    const r = await createIfsRunner({ ...config, loadPlaywright: fake.loadPlaywright }).run();
    assert.equal(r.outcome, "failed");
    assert.equal(fake.seen.closed, 1);
    assert.ok(r.steps[1].detail.length < 260);
    const broken = await createIfsRunner({ ...config, loadPlaywright: async () => { throw new Error("Cannot find package 'playwright'"); } }).run();
    assert.equal(broken.outcome, "failed");
  });
});

describe("Option B: the export file", () => {
  const normalized = async (d = design) => (await reviewDesign(JSON.stringify(d), lookup)).design;

  it("is available without any setup, and makes a file with the structure of a real IFS export", async () => {
    const exporter = createExporter();
    assert.deepEqual(exporter.availability(), { available: true, missing: [] });
    const r = await exporter.run(await normalized());
    assert.equal(r.ok, true);
    assert.equal(r.outcome, "exported");
    assert.equal(r.created, false, "nothing was created in IFS");
    assert.equal(r.touchedIfs, "none");
    assert.equal(r.file.name, "QuickReports_Open Customer Invoices.xml");
    assert.equal(r.file.mimeType, "application/xml");
    assert.deepEqual(checkExportXml(r.file.content), { ok: true, problems: [] });
    assert.ok(r.file.content.includes("'&amp;Company'"), "the parameter is written as an entity");
    assert.ok(r.file.content.includes("<QR_TYPE datatype=\"Enum\">SQL</QR_TYPE>"));
  });

  it("says how to import it, that IFS has not read it, and that the report id is a placeholder to test first", async () => {
    const r = await createExporter().run(await normalized());
    assert.match(r.instructions.join(" "), /Quick Reports\. Click Import|Click Import, then Browse XML/);
    assert.match(r.instructions.join(" "), /answer No/);
    assert.match(r.warnings.join(" "), /Import a harmless test report first/);
    assert.deepEqual(r.steps.map((x) => [x.name, x.status]), [["Export file", "ok"], ["Check the file", "ok"], ["Import it in IFS (you do this)", "not done"]]);
    assert.match(r.steps[1].detail, /IFS has not read it yet/);
    assert.match(r.message, /IFS was not opened or changed/);
  });

  it("makes no file for a design that has more than one SQL, or a title that is too long, and says why", async () => {
    const two = copy(design);
    two.dataSources.push({ id: "DS2", status: "ready", sql: "SELECT 1 FROM dual" });
    const r = await createExporter().run(await normalized(two));
    assert.equal(r.ok, false);
    assert.equal(r.outcome, "unsupported");
    assert.equal("file" in r, false);
    assert.match(r.steps[0].detail, /one SQL statement, and this design has 2/);
    const long = copy(design);
    long.report.title = "x".repeat(51);
    assert.match((await createExporter().run(await normalized(long))).steps[0].detail, /IFS allows at most 50/);
  });

  it("never opens IFS, and does not need the IFS settings: choosing Option B does not start the Playwright flow", async () => {
    let opened = 0;
    const runner = createIfsRunner({ enabled: false, loadPlaywright: async () => (opened++, {}) });
    const actions = createQuickReportActions({ check: (d) => reviewDesign(d, lookup), runner, exporter: createExporter() });
    const p = (await actions.prepare({ design: text() })).body;
    assert.equal(p.options.A.available, false);
    assert.equal(p.options.B.available, true);
    const r = await actions.run({ design: text(), designHash: p.designHash, option: "B", approved: true });
    assert.equal(r.status, 200);
    assert.equal(r.body.outcome, "exported");
    assert.equal(r.body.validation.realEnvironment, "not run", "an export is not a run of the SQL");
    assert.equal(opened, 0);
  });
});

describe("the routes", () => {
  let api;
  let base;
  const post = (path, body) => fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  before(async () => {
    api = createApp({
      n8nChatUrl: "http://127.0.0.1:9/x",
      tools,
      quickReports: createQuickReportActions({ check: (d) => tools.checkQuickReport(d), runner: createIfsRunner({}), exporter: createExporter() }),
    });
    await new Promise((r) => api.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${api.address().port}`;
  });
  after(() => new Promise((r) => api.close(r)));

  it("checks a design through the real review tool, and chooses nothing", async () => {
    const res = await post("/api/quick-report/check", { design: text() });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.ready, true);
    assert.equal(body.options.A.available, false, "automation is off by default");
    assert.match(body.options.A.missing.join(" "), /Automation is switched off/);
    assert.equal(body.options.B.available, true, "the export file needs nothing outside this program");
    assert.equal(body.validation.realEnvironment, "not run");
  });

  it("runs Option A only with the approval and the confirmation, and with automation off it opens nothing", async () => {
    const check = await (await post("/api/quick-report/check", { design: text() })).json();
    const without = await post("/api/quick-report/run", { design: text(), designHash: check.designHash, option: "A", approved: true });
    assert.equal(without.status, 409);
    assert.equal((await without.json()).code, "confirmation_required");
    const res = await post("/api/quick-report/run", { design: text(), designHash: check.designHash, option: "A", approved: true, confirmed: true });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.outcome, "unavailable");
    assert.equal(body.touchedIfs, "none");
    assert.equal(body.created, false);
  });

  it("uses POST only, and says when the actions are not configured on a server", async () => {
    assert.equal((await fetch(`${base}/api/quick-report/check`)).status, 405);
    const bare = createApp({ n8nChatUrl: "http://127.0.0.1:9/x" });
    await new Promise((r) => bare.listen(0, "127.0.0.1", r));
    try {
      const res = await fetch(`http://127.0.0.1:${bare.address().port}/api/quick-report/check`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ design: text() }) });
      assert.equal(res.status, 503);
      assert.equal((await res.json()).code, "not_configured");
    } finally {
      await new Promise((r) => bare.close(r));
    }
  });
});
