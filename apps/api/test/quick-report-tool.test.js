// The quick report review tool of the advisor agent, its route, and the two workflow files. The agent flow (fake agent, history, budget) is in
// quick-report-flow.test.js; the helpers are in quick-report-unit.test.js.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { after, before, describe, it } from "node:test";
import { createApp } from "../src/server.js";
import { createTools } from "../src/tools.js";

const KEY = "internal-secret";
const sample = JSON.parse(readFileSync(new URL("../../../packages/quick-reports/examples/weekly-cash-report.sample.design.json", import.meta.url), "utf8"));
const designText = JSON.stringify(sample);

// a data dictionary that has the views of the Weekly Cash Report sample
const COLUMNS = {
  IDENTITY_INVOICE_INFO: ["COMPANY", "IDENTITY", "PAY_TERM_ID", "PARTY_TYPE_DB"],
  CUSTOMER_INFO: ["CUSTOMER_ID", "NAME"],
  LEDGER_TRANSACTION_CU_QRY: ["COMPANY", "IDENTITY", "LEDGER_COMPANY", "LEDGER_ITEM_SERIES_ID", "LEDGER_ITEM_ID", "LEDGER_ITEM_VERSION", "PAY_DATE", "PAYMENT_ID", "TRANS_ID", "PAYMENT_TYPE_CODE"],
  INVOICE_LEDGER_ITEM_CU_QRY: ["COMPANY", "IDENTITY", "SERIES_ID", "INVOICE_NO", "LEDGER_ITEM_VERSION", "LEDGER_STATUS_TYPE", "INVOICE_AMOUNT", "INVOICE_DATE", "DUE_DATE", "CURRENCY"],
};
const db = { query: async (sql, [view]) => ({ rows: (COLUMNS[view] ?? []).map((column_name) => ({ column_name })) }) };
const brokenDb = { query: async () => { throw new Error("relation dictionary_column does not exist"); } };
const toolsOf = (database) => createTools({ db: database, search: async () => [], searchAll: async () => [], loadFull: async () => new Map() });

describe("the quick report review tool", () => {
  it("checks the design against the data dictionary without running any SQL, and keeps the review page for the backend", async () => {
    const { text, artifacts } = await toolsOf(db).reviewQuickReport({ designJson: designText });
    assert.match(text, /<design_checks ok="true">/);
    assert.match(text, /every view and column that could be checked exists in the data dictionary/);
    assert.match(text, /NOT validated: the SQL has not been run on any IFS environment, and there are no sample results/);
    assert.ok(!text.includes("# Sample Weekly Cash Report"), "the page is not sent back to the agent: it would be paid for again at every step");
    assert.match(artifacts.reviewPage, /^# Sample Weekly Cash Report/);
    assert.equal(JSON.parse(artifacts.designJson).validation.status, "not run");
    assert.equal(artifacts.ok, true);
  });

  it("sends the agent back to the design with the real columns of the view when a column does not exist", async () => {
    const bad = JSON.stringify({ ...sample, dataSources: [{ ...sample.dataSources[0], sql: sample.dataSources[0].sql.replace("li.invoice_amount", "li.full_curr_amount") }] });
    const { text, artifacts } = await toolsOf(db).reviewQuickReport({ designJson: bad });
    assert.match(text, /<design_checks ok="false">/);
    assert.match(text, /ERROR The column FULL_CURR_AMOUNT does not exist in the view INVOICE_LEDGER_ITEM_CU_QRY/);
    assert.match(text, /<view_columns view="INVOICE_LEDGER_ITEM_CU_QRY" count="10">[^<]*INVOICE_AMOUNT/);
    assert.match(text, /do not search again for them/);
    assert.equal(artifacts.ok, false);
    assert.match(artifacts.reviewPage, /^> \*\*The check found problems/);
  });

  it("does not let a design say that its SQL was validated", async () => {
    const claimed = JSON.stringify({ ...sample, validation: { ...sample.validation, status: "validated" } });
    const { text, artifacts } = await toolsOf(db).reviewQuickReport({ designJson: claimed });
    assert.match(text, /WARNING The design said that the SQL was "validated"\. That was reset/);
    assert.match(artifacts.reviewPage, /Status: \*\*not run\*\*/);
    assert.ok(!/Status: \*\*validated/i.test(artifacts.reviewPage));
  });

  it("still reviews the design, and says so, when the data dictionary is not loaded", async () => {
    const { text, artifacts } = await toolsOf(brokenDb).reviewQuickReport({ designJson: designText });
    assert.match(text, /<dictionary_check available="false"\/>/);
    assert.match(text, /data dictionary is not available, so the views and columns were not checked/);
    assert.ok(artifacts.reviewPage);
  });

  it("answers text that is not a design with a message the agent can act on, and no page", async () => {
    const r = await toolsOf(db).reviewQuickReport({ designJson: "a quick report for open orders" });
    assert.match(r.text, /The design could not be read/);
    assert.equal(r.artifacts, undefined);
    assert.match((await toolsOf(db).reviewQuickReport({})).text, /The design is empty/);
  });
});

const post = (url, body, headers = {}) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

describe("the route of the review tool", () => {
  let n8n;
  let api;
  let base;
  let behaviour = async () => ({ answer: "x" });

  before(async () => {
    n8n = createServer(async (req, res) => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(await behaviour(JSON.parse(Buffer.concat(chunks).toString()))));
    });
    await new Promise((r) => n8n.listen(0, "127.0.0.1", r));
    api = createApp({
      n8nChatUrl: `http://127.0.0.1:${n8n.address().port}/x`,
      internalKey: KEY,
      publicUrl: "https://backend.example",
      maxToolCalls: 1,
      tools: toolsOf(db),
      retrieve: async () => ({ status: "ok", passages: [{ id: 1, title: "File", path: "doc/File", origin: "IFS source code", url: "", version: "INVOICE 25R2", startLine: 1, endLine: 2, content: "c" }] }),
    });
    await new Promise((r) => api.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${api.address().port}`;
  });
  after(() => Promise.all([api, n8n].map((s) => new Promise((r) => s.close(r)))));

  it("passes design_json to the tool, returns its text as it is, and counts the call", async () => {
    let first = "";
    let second = "";
    behaviour = async (sent) => {
      const path = new URL(sent.toolsUrl).pathname;
      const call = (design) => post(`${base}${path}/review_quick_report`, { design_json: design }, { "X-Internal-Key": KEY }).then((r) => r.text());
      first = await call(designText);
      second = await call(designText);
      return { answer: "Here is the review." };
    };
    const value = await (await post(`${base}/api/chat`, { question: "Create a quick report for the weekly cash flow" })).json();
    assert.equal(value.answer, "Here is the review.");
    assert.match(first, /^<quick_report_review>/);
    assert.match(first, /<design_checks ok="true">/);
    assert.match(first, /Tool calls left: 0\./);
    assert.match(second, /No tool calls left/);
  });

  it("does not make sources of the review: nothing in it can be cited", async () => {
    behaviour = async (sent) => {
      await post(`${base}${new URL(sent.toolsUrl).pathname}/review_quick_report`, { design_json: designText }, { "X-Internal-Key": KEY });
      return { answer: "Reviewed [2].", sources: [] };
    };
    const value = await (await post(`${base}/api/chat`, { question: "Create a quick report for the weekly cash flow" })).json();
    assert.ok(!value.answer.includes("[2]"), "a marker for a source that does not exist is removed");
    assert.equal(value.sources.length, 0);
  });

  it("needs the internal key like every tool", async () => {
    let status = 0;
    behaviour = async (sent) => {
      status = (await post(`${base}${new URL(sent.toolsUrl).pathname}/review_quick_report`, { design_json: designText })).status;
      return { answer: "x" };
    };
    await post(`${base}/api/chat`, { question: "Create a quick report" });
    assert.ok([401, 403].includes(status), `status ${status}`);
  });
});

describe("the two workflow files of the agent", () => {
  const files = ["n8n-agent-workflow.json", "n8n-agent-workflow-2.34.6.json"];
  const load = (f) => JSON.parse(readFileSync(new URL(`../../../agents/advisor/${f}`, import.meta.url), "utf8"));
  const node = (w, name) => w.nodes.find((n) => n.name === name);

  it("have the review_quick_report tool, connected to the agent, with the parameter design_json", () => {
    for (const f of files) {
      const w = load(f);
      const tool = node(w, "review_quick_report");
      assert.ok(tool, f);
      assert.equal(tool.type, "n8n-nodes-base.httpRequestTool");
      assert.match(tool.parameters.url, /\/review_quick_report$/);
      assert.equal(tool.parameters.bodyParameters.parameters[0].name, "design_json");
      assert.match(tool.parameters.toolDescription, /does NOT run any SQL/);
      assert.deepEqual(w.connections.review_quick_report.ai_tool[0][0], { node: "Advisor Agent", type: "ai_tool", index: 0 });
      assert.equal(new Set(w.nodes.map((n) => n.id)).size, w.nodes.length, "node ids are unique");
      assert.match(node(w, "describe_entity").parameters.toolDescription, /not the base view of an entity/);
    }
  });

  it("keep the quick report instructions out of the static prompt that every question pays for, and in the Build prompt node for the flagged requests", () => {
    for (const f of files) {
      const w = load(f);
      const system = node(w, "Advisor Agent").parameters.options.systemMessage;
      assert.ok(!system.includes("Quick report design"), `${f}: the static prompt has no quick report section`);
      assert.ok(system.includes("## Using your own IFS knowledge") && system.includes("Strict rules for the tables"), `${f}: the other rules are kept`);
      const build = node(w, "Build prompt").parameters.jsCode;
      assert.match(build, /const quickReportBlock = body\.quickReport === true \? /);
      assert.match(build, /toolsBlock,\n {2}quickReportBlock,\n {2}languageLine,/);
      for (const needle of [/review_quick_report/, /A Lobby is not supported yet/, /Never write a view, a column or a parameter that no tool result showed/, /never say or imply that the SQL was validated, run or tested/, /there are no sample results yet/, /never claim that anything was created, exported or tested/, /Word equations and pictures are not part of an attached file/, /write every column as alias\.column/, /Your last two tool calls are kept for it/, /exact text \[\[REVIEW_PAGE\]\] and then \[\[DESIGN_JSON\]\]/, /default \(null when there is none\)/]) {
        assert.match(build, needle, `${f}: ${needle}`);
      }
    }
  });

  it("carry the same prompts and the same tools, so that the two n8n versions do not drift apart", () => {
    const [a, b] = files.map(load);
    const prompt = (w) => node(w, "Advisor Agent").parameters.options.systemMessage;
    assert.equal(prompt(a), prompt(b));
    assert.equal(node(a, "Build prompt").parameters.jsCode, node(b, "Build prompt").parameters.jsCode);
    assert.equal(node(a, "Format response").parameters.jsCode, node(b, "Format response").parameters.jsCode);
    const tools = (w) => w.nodes.filter((n) => n.type === "n8n-nodes-base.httpRequestTool").map((n) => `${n.name} ${n.parameters.url}`).sort();
    assert.deepEqual(tools(a), tools(b));
  });
});
