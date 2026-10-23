// A follow-up in a Quick Reports chat: "Show Amount in accounting currency, and add the customer identity." With a scripted agent that does what a
// good one did in a live run: the real backend, tool and review page; the design of the first answer reaches the second turn whole, only the asked
// changes are in the second design, and the SQL status stays "not run".
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, describe, it } from "node:test";
import { createApp } from "../src/server.js";
import { createTools } from "../src/tools.js";
import { reviewDesign } from "../../../packages/quick-reports/src/review-design.js";

const KEY = "internal-secret";
const COLUMNS = { INVOICE_LEDGER_ITEM_CU_QRY: ["COMPANY", "IDENTITY", "NAME", "INVOICE_NO", "DUE_DATE", "OPEN_AMOUNT", "OPEN_DOM_AMOUNT", "INVOICE_AMOUNT", "CURRENCY"] };
const lookup = async (view) => (COLUMNS[view] ? new Set(COLUMNS[view]) : null);
const db = { query: async (sql, [view]) => ({ rows: (COLUMNS[view] ?? []).map((column_name) => ({ column_name })) }) };
const tools = createTools({ db, search: async () => [], searchAll: async () => [], loadFull: async () => new Map() });

const Q1 = "Create a quick report 'Open Customer Invoices' for one company, with the parameter Due Before and the columns Invoice No, Customer, Due Date and Amount.";
const Q2 = "Show Amount in accounting currency, and add the customer identity.";

const design1 = {
  designVersion: 1,
  spec: { title: "Open Customer Invoices", customer: "not given", ticket: "not given", specRevision: "not given", file: "not given" },
  type: "SQL quick report",
  report: { title: "Open Customer Invoices", category: "not given", permissionSets: "not given", purpose: "Lists the open customer invoices of one company that are due before a given date." },
  parameters: [
    { name: "Company", label: "Company", type: "string", mandatory: true, default: null, usedAs: "&Company" },
    { name: "DueBefore", label: "Due Before", type: "date", mandatory: true, default: null, usedAs: "&DueBefore" },
  ],
  dataSources: [
    {
      id: "DS1",
      status: "draft",
      purpose: "Open customer invoices of one company due before the entered date",
      entitiesUsed: [{ view: "INVOICE_LEDGER_ITEM_CU_QRY", role: "Customer invoice ledger items" }],
      assumptions: ["An invoice is open when OPEN_AMOUNT is not 0.", "Amount is the open amount in invoice currency (OPEN_AMOUNT)."],
      sql: "SELECT i.invoice_no AS \"Invoice No\", i.name AS \"Customer\", i.due_date AS \"Due Date\", i.open_amount AS \"Amount\" FROM INVOICE_LEDGER_ITEM_CU_QRY i WHERE i.company = '&Company' AND i.due_date < TO_DATE('&DueBefore', 'YYYY-MM-DD') AND i.open_amount <> 0 ORDER BY i.due_date, i.invoice_no",
    },
  ],
  columns: [
    { label: "Invoice No", specSource: "Invoice No", expression: "i.invoice_no" },
    { label: "Customer", specSource: "Customer", expression: "i.name" },
    { label: "Due Date", specSource: "Due Date", expression: "i.due_date" },
    { label: "Amount", specSource: "Amount", expression: "i.open_amount" },
  ],
  decisions: [{ id: "D1", title: "Amount", question: "Which amount?", options: [{ label: "OPEN_AMOUNT", consequence: "Invoice currency." }, { label: "OPEN_DOM_AMOUNT", consequence: "Accounting currency." }] }],
  validation: { status: "not run", toConfirmOnTheTestEnvironment: ["The view returns rows for a test company."] },
  openQuestions: ["Should cancelled invoices be excluded?"],
};

// the design after the follow-up: Amount in accounting currency, the identity as a new column, and the consequences of those two changes
const design2 = JSON.parse(JSON.stringify(design1));
design2.columns.splice(1, 0, { label: "Customer Identity", specSource: "Consultant request", expression: "i.identity" });
design2.columns.find((c) => c.label === "Amount").expression = "i.open_dom_amount";
design2.dataSources[0].sql = "SELECT i.invoice_no AS \"Invoice No\", i.identity AS \"Customer Identity\", i.name AS \"Customer\", i.due_date AS \"Due Date\", i.open_dom_amount AS \"Amount\" FROM INVOICE_LEDGER_ITEM_CU_QRY i WHERE i.company = '&Company' AND i.due_date < TO_DATE('&DueBefore', 'YYYY-MM-DD') AND i.open_amount <> 0 ORDER BY i.due_date, i.invoice_no";
design2.dataSources[0].assumptions = ["An invoice is open when OPEN_AMOUNT is not 0.", "Amount is the open amount in accounting currency (OPEN_DOM_AMOUNT)."];
design2.decisions = [];

const intro = (text) => `${text}\n\n[[REVIEW_PAGE]]\n\n[[DESIGN_JSON]]\n\nPlease approve the design or tell me what to change.`;
const ANSWER1 = intro("The design lists the open customer invoices due before a date. The open points are the meaning of Amount and of open.");
const ANSWER2 = intro("Amount now shows the open amount in accounting currency, and there is a new Customer Identity column. I changed nothing else.");

const post = (url, body, headers = {}) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

describe("a follow-up change in a Quick Reports chat", () => {
  let n8n;
  let api;
  let base;
  let script;
  const received = [];

  before(async () => {
    n8n = createServer(async (req, res) => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const sent = JSON.parse(Buffer.concat(chunks).toString());
      received.push(sent);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(await script(sent)));
    });
    await new Promise((r) => n8n.listen(0, "127.0.0.1", r));
    api = createApp({
      n8nChatUrl: `http://127.0.0.1:${n8n.address().port}/x`,
      internalKey: KEY,
      publicUrl: "https://backend.example",
      maxToolCalls: 6,
      tools,
      retrieve: async () => ({ status: "ok", passages: [] }),
    });
    await new Promise((r) => api.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${api.address().port}`;
  });
  after(() => Promise.all([api, n8n].map((s) => new Promise((r) => s.close(r)))));

  const review = (sent, design) => post(`${base}${new URL(sent.toolsUrl).pathname}/review_quick_report`, { design_json: JSON.stringify(design) }, { "X-Internal-Key": KEY }).then((r) => r.text());
  const chat = async (body) => (await post(`${base}/api/chat`, { language: "en", mode: "quickReport", ...body })).json();
  const designIn = (answer) => JSON.parse(answer.match(/```json\n([\s\S]*?)\n```/)[1]);

  it("changes only what was asked, keeps the parameters and the other columns, and keeps the status 'not run'", async () => {
    received.length = 0;
    script = async (sent) => {
      await review(sent, sent.history.length === 0 ? design1 : design2);
      return { answer: sent.history.length === 0 ? ANSWER1 : ANSWER2 };
    };
    const first = await chat({ question: Q1, history: [] });
    const second = await chat({ question: Q2, history: [{ role: "user", content: Q1 }, { role: "assistant", content: first.answer }] });

    // the second turn got the first design whole, as a json block that can be read again (the history is kept short without cutting the JSON)
    const handed = received[1].history.at(-1).content;
    assert.deepEqual(designIn(handed).columns, designIn(first.answer).columns);
    assert.ok(handed.length < first.answer.length, "shorter than the answer: the review page is not sent again");

    const before = designIn(first.answer);
    const after = designIn(second.answer);
    // what stayed
    assert.deepEqual(after.parameters, before.parameters);
    assert.deepEqual(after.spec, before.spec);
    assert.deepEqual(after.report, before.report);
    assert.deepEqual(after.dataSources[0].entitiesUsed.map((e) => e.view), ["INVOICE_LEDGER_ITEM_CU_QRY"]);
    assert.deepEqual(after.columns.filter((c) => ["Invoice No", "Customer", "Due Date"].includes(c.label)), before.columns.filter((c) => ["Invoice No", "Customer", "Due Date"].includes(c.label)));
    assert.deepEqual(after.openQuestions, before.openQuestions);
    // what changed: Amount, and one new column
    assert.deepEqual(after.columns.map((c) => c.label), ["Invoice No", "Customer Identity", "Customer", "Due Date", "Amount"]);
    assert.equal(after.columns.find((c) => c.label === "Amount").expression, "i.open_dom_amount");
    assert.equal(after.columns.find((c) => c.label === "Customer Identity").expression, "i.identity");
    assert.ok(after.dataSources[0].sql.includes('i.open_dom_amount AS "Amount"') && after.dataSources[0].sql.includes('i.identity AS "Customer Identity"'));
    assert.ok(after.dataSources[0].sql.includes("i.company = '&Company'") && after.dataSources[0].sql.includes("TO_DATE('&DueBefore'"), "the filters of the first design stay");
    // the status
    assert.equal(before.validation.status, "not run");
    assert.equal(after.validation.status, "not run");
    assert.match(second.answer, /Status: \*\*not run\*\*/);
    assert.ok(!/validated|tested|executed/i.test(second.answer.replace(/not validated|NOT validated|not run|not been run/gi, "")), "no claim that the SQL was run");
  });

  it("shows the review page of the second design exactly, with the new column and its own dictionary check", async () => {
    script = async (sent) => {
      await review(sent, design2);
      return { answer: ANSWER2 };
    };
    const second = await chat({ question: Q2, history: [{ role: "user", content: Q1 }, { role: "assistant", content: ANSWER1 }] });
    const expected = await reviewDesign(JSON.stringify(design2), lookup);
    const first = await reviewDesign(JSON.stringify(design1), lookup);
    assert.ok(second.answer.includes(expected.reviewPage), "the page is the one of the tool, exactly");
    assert.ok(!second.answer.includes("[["), "no placeholder is left");
    assert.match(expected.reviewPage, /\| 2 \| Customer Identity \|/);
    assert.ok(expected.dictionary.checked > first.dictionary.checked, "the new column was checked too");
    assert.equal(expected.dictionary.unknownColumns.length, 0);
    assert.equal(expected.ok, true);
  });

  it("shows the problem when a follow-up loses a column, instead of looking approved", async () => {
    const lost = JSON.parse(JSON.stringify(design2));
    lost.columns = lost.columns.filter((c) => c.label !== "Due Date");
    const r = await reviewDesign(JSON.stringify(lost), lookup);
    assert.equal(r.ok, false, "the SQL still has the column that the layout no longer has");
    assert.match(r.reviewPage, /^> \*\*The check found problems/);
  });
});
