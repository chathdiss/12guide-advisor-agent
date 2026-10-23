// The quick report conversation, end to end, without any model: a scripted fake agent plays the part of n8n. It receives the request exactly as n8n
// does, calls the tools over HTTP like the tool nodes do, and answers. Everything else is the real server, the real tools and the real review.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { after, before, describe, it } from "node:test";
import { reviewDesign } from "../../../packages/quick-reports/src/review-design.js";
import { createApp } from "../src/server.js";
import { createTools } from "../src/tools.js";

const KEY = "internal-secret";
const sample = JSON.parse(readFileSync(new URL("../../../packages/quick-reports/examples/weekly-cash-report.sample.design.json", import.meta.url), "utf8"));
const COLUMNS = {
  IDENTITY_INVOICE_INFO: ["COMPANY", "IDENTITY", "PAY_TERM_ID", "PARTY_TYPE_DB"],
  CUSTOMER_INFO: ["CUSTOMER_ID", "NAME"],
  LEDGER_TRANSACTION_CU_QRY: ["COMPANY", "IDENTITY", "LEDGER_COMPANY", "LEDGER_ITEM_SERIES_ID", "LEDGER_ITEM_ID", "LEDGER_ITEM_VERSION", "PAY_DATE", "PAYMENT_ID", "TRANS_ID", "PAYMENT_TYPE_CODE"],
  INVOICE_LEDGER_ITEM_CU_QRY: ["COMPANY", "IDENTITY", "SERIES_ID", "INVOICE_NO", "LEDGER_ITEM_VERSION", "LEDGER_STATUS_TYPE", "INVOICE_AMOUNT", "INVOICE_DATE", "DUE_DATE", "CURRENCY"],
};
const lookup = async (view) => (COLUMNS[view] ? new Set(COLUMNS[view]) : null);
const db = { query: async (sql, [view]) => ({ rows: (COLUMNS[view] ?? []).map((column_name) => ({ column_name })) }) };
const tools = createTools({ db, search: async () => [], searchAll: async () => [], loadFull: async () => new Map() });

const SPEC = "Please create a quick report. Title: Weekly Cash Report. Parameter: Company. Columns: Customer ID, Name, Invoice Series, Invoice No, Status, Invoice Amount, Invoice Date, Payment Terms, Next/Last Due Date, Currency Code, Payment Date. The most recent paid invoice of each customer.";
const ANSWER = "I designed the report.\n\n[[REVIEW_PAGE]]\n\n[[DESIGN_JSON]]\n\nPlease approve the design or tell me what to change.";

const post = (url, body, headers = {}) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

describe("a quick report conversation with a scripted agent", () => {
  let n8n;
  let api;
  let base;
  let script = async () => ({ answer: "x" });
  const retrieveCalls = [];
  let retrieveUsage = null;
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
      retrieve: async (...args) => {
        retrieveCalls.push(args);
        return { status: "ok", passages: [{ id: 1, title: "File", path: "doc/File", origin: "IFS source code", url: "", version: "INVOICE 25R2", startLine: 1, endLine: 2, content: "c" }], ...(retrieveUsage ? { usage: retrieveUsage } : {}) };
      },
    });
    await new Promise((r) => api.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${api.address().port}`;
  });
  after(() => Promise.all([api, n8n].map((s) => new Promise((r) => s.close(r)))));

  // what the agent does: it calls a tool of the request, like the tool nodes of n8n
  const tool = (sent, name, args) => post(`${base}${new URL(sent.toolsUrl).pathname}/${name}`, args, { "X-Internal-Key": KEY }).then((r) => r.text());

  // the answer of a request, and the log lines that the server wrote for it
  const chat = async (body) => {
    const logs = [];
    const original = console.log;
    console.log = (line) => {
      try {
        const parsed = JSON.parse(line);
        if (parsed.route === "/api/chat") logs.push(parsed);
        else original(line);
      } catch {
        original(line);
      }
    };
    try {
      const value = await (await post(`${base}/api/chat`, body)).json();
      return { value, log: logs.at(-1), raw: JSON.stringify(logs) };
    } finally {
      console.log = original;
    }
  };

  const expectedPage = async (design) => (await reviewDesign(design, lookup)).reviewPage;
  const expectedJson = async (design) => (await reviewDesign(design, lookup)).designJson;

  it("flags the request, sends few passages, and puts the exact review page and design into the answer without the agent retyping them", async () => {
    retrieveCalls.length = 0;
    received.length = 0;
    script = async (sent) => {
      await tool(sent, "describe_entity", { name: "INVOICE_LEDGER_ITEM_CU_QRY" });
      await tool(sent, "find_columns", { query: "payment date" });
      const review = await tool(sent, "review_quick_report", { design_json: JSON.stringify(sample) });
      assert.match(review, /<design_checks ok="true">/);
      assert.ok(!review.includes("# Sample Weekly Cash Report"), "the agent is not sent the page");
      return { answer: ANSWER, usage: { inputTokens: 52_000, outputTokens: 3_400, cacheReadTokens: 0, modelCalls: 4, prompt: "the question text", token: "secret" } };
    };
    const { value, log, raw } = await chat({ question: SPEC });

    assert.equal(received[0].quickReport, true);
    assert.equal(received[0].toolCalls, 6);
    assert.deepEqual(retrieveCalls[0].slice(2), [{ limit: 4 }], "four passages instead of the usual number");

    const page = await expectedPage(sample);
    const json = await expectedJson(sample);
    assert.ok(value.answer.includes(page), "the review page is in the answer exactly as the tool made it");
    assert.ok(value.answer.includes(`\`\`\`json\n${json}\n\`\`\``), "so is the design");
    assert.ok(!value.answer.includes("[["), "no placeholder is left");
    assert.match(value.answer, /^I designed the report\./);
    assert.match(value.answer, /Please approve the design or tell me what to change\.$/);
    assert.match(value.answer, /Status: \*\*not run\*\*/);
    assert.equal("usage" in value, false, "the counts are for the log, not for the browser");
    assert.deepEqual(value.sources, []);

    // the log: what the provider counted, numbers only; never the question, the answer, or a secret
    assert.deepEqual(log.usage, { inputTokens: 52_000, outputTokens: 3_400, cacheReadTokens: 0, modelCalls: 4 });
    assert.equal(log.quickReport, true);
    assert.equal(log.reviews, 1);
    assert.equal(log.toolCalls, 3);
    for (const secret of ["the question text", "secret", "Weekly Cash Report", "designVersion", KEY]) assert.ok(!raw.includes(secret), `the log does not contain: ${secret}`);
  });

  it("keeps the last calls for the review: only four lookups, then the review, and a changed design can be reviewed again", async () => {
    received.length = 0;
    const replies = [];
    script = async (sent) => {
      for (let i = 0; i < 6; i++) replies.push(await tool(sent, "search_knowledge", { query: `lookup ${i}` }));
      replies.push(await tool(sent, "review_quick_report", { design_json: JSON.stringify(sample) }));
      const changed = JSON.parse(JSON.stringify(sample));
      changed.columns.splice(9, 0, { label: "Payment Term", specSource: "asked later", expression: "x" });
      changed.dataSources[0].sql = changed.dataSources[0].sql.replace('li.due_date AS "Next/Last Due Date"', 'li.due_date AS "Next/Last Due Date",\n       iii.pay_term_id AS "Payment Term"');
      replies.push(await tool(sent, "review_quick_report", { design_json: JSON.stringify(changed) }));
      replies.push(await tool(sent, "review_quick_report", { design_json: JSON.stringify(changed) }));
      return { answer: ANSWER };
    };
    await chat({ question: SPEC });
    assert.equal(replies.slice(0, 4).filter((r) => /kept for review_quick_report/.test(r)).length, 0, "four lookups are allowed");
    assert.ok(replies.slice(4, 6).every((r) => /The calls that are left are kept for review_quick_report/.test(r)), "the fifth and sixth are refused, and not counted");
    assert.match(replies[6], /<design_checks ok="true">/);
    assert.match(replies[6], /Tool calls left: 1\./);
    assert.match(replies[7], /<design_checks ok="true">/, "the second review is allowed");
    assert.match(replies[7], /Tool calls left: 0\./);
    assert.match(replies[8], /No tool calls left/);
  });

  it("shows the page of the last review when the design was changed and reviewed again", async () => {
    script = async (sent) => {
      await tool(sent, "review_quick_report", { design_json: JSON.stringify(sample) });
      const changed = JSON.parse(JSON.stringify(sample));
      changed.report.purpose = "A changed purpose that only the second design has.";
      await tool(sent, "review_quick_report", { design_json: JSON.stringify(changed) });
      return { answer: ANSWER };
    };
    const { value } = await chat({ question: SPEC });
    assert.match(value.answer, /A changed purpose that only the second design has\./);
    assert.equal(value.answer.split("# Sample Weekly Cash Report").length - 1, 1, "one page, the last one");
  });

  it("continues a change request in the next turn from the compact design of the last answer, and reviews the changed design", async () => {
    retrieveCalls.length = 0;
    received.length = 0;
    script = async (sent) => {
      await tool(sent, "review_quick_report", { design_json: JSON.stringify(sample) });
      return { answer: ANSWER };
    };
    const first = (await chat({ question: SPEC })).value.answer;

    const changed = JSON.parse(JSON.stringify(sample));
    changed.parameters.push({ name: "DueBefore", label: "Due Before", type: "date", mandatory: false, default: null, usedAs: "'&DueBefore'" });
    changed.dataSources[0].sql += "\n-- &DueBefore";
    script = async (sent) => {
      await tool(sent, "review_quick_report", { design_json: JSON.stringify(changed) });
      return { answer: ANSWER };
    };
    const turn2 = await chat({ question: "Add an optional parameter Due Before and keep everything else.", history: [{ role: "user", content: SPEC }, { role: "assistant", content: first }] });

    const sent = received.at(-1);
    assert.equal(sent.quickReport, true, "the question does not say quick report, the last answer holds a design");
    assert.deepEqual(retrieveCalls.at(-1).slice(2), [{ limit: 4 }]);
    const kept = sent.history[1].content;
    assert.deepEqual(JSON.parse(kept.match(/```json\n([\s\S]*?)\n```/)[1]), JSON.parse(await expectedJson(sample)), "the design is whole and valid JSON");
    assert.ok(!kept.includes("# Sample Weekly Cash Report"), "the review page is not sent again");
    assert.ok(kept.length < first.length);
    assert.ok(turn2.value.answer.includes("Due Before"), "the new page has the new parameter");
    assert.ok(turn2.value.answer.includes(await expectedPage(changed)));
  });

  it("leaves a question that is not a quick report request as it was: no flag, the usual search, all calls free, nothing replaced", async () => {
    retrieveCalls.length = 0;
    received.length = 0;
    const replies = [];
    script = async (sent) => {
      for (let i = 0; i < 6; i++) replies.push(await tool(sent, "search_knowledge", { query: `lookup ${i}` }));
      return { answer: "The fields are listed here: [[REVIEW_PAGE]] is only text." };
    };
    const { value } = await chat({ question: "Which fields does the customer order entity set have?" });
    assert.equal("quickReport" in received[0], false);
    assert.equal(retrieveCalls[0].length, 2, "the retriever is called as before");
    assert.ok(replies.every((r) => !/kept for review_quick_report/.test(r)));
    assert.equal(value.answer, "The fields are listed here: [[REVIEW_PAGE]] is only text.");
    for (const question of ["How do I create a quick report in IFS Cloud?", "Create a lobby for customer orders"]) {
      received.length = 0;
      script = async () => ({ answer: "ok" });
      await chat({ question });
      assert.equal("quickReport" in received[0], false, question);
    }
  });

  it("does not look as if a design was reviewed when the agent never called the review tool", async () => {
    script = async () => ({ answer: ANSWER });
    const { value } = await chat({ question: SPEC });
    assert.match(value.answer, /\(No review page: the design was not checked with the review tool\.\)/);
    assert.match(value.answer, /\(No design: the design was not checked with the review tool\.\)/);
    assert.ok(!value.answer.includes("# Sample Weekly Cash Report"));
  });

  it("shows the problems of a design that is still wrong at the end, so that nothing looks approved that is not", async () => {
    script = async (sent) => {
      const bad = { ...sample, dataSources: [{ ...sample.dataSources[0], sql: sample.dataSources[0].sql.replace("li.invoice_amount", "li.full_curr_amount") }] };
      const review = await tool(sent, "review_quick_report", { design_json: JSON.stringify(bad) });
      assert.match(review, /<view_columns view="INVOICE_LEDGER_ITEM_CU_QRY"/);
      return { answer: ANSWER };
    };
    const { value } = await chat({ question: SPEC });
    assert.match(value.answer, /> \*\*The check found problems that are not solved yet:\*\*\n> - The column FULL_CURR_AMOUNT does not exist/);
  });

  it("logs the counts of the keyword rewrite and of the agent, null when n8n passed none, and never the text of the question", async () => {
    retrieveUsage = { inputTokens: 410, outputTokens: 60, calls: 1 };
    script = async () => ({ answer: "A normal answer." });
    const a = await chat({ question: "How do I post a voucher in IFS Cloud?" });
    assert.deepEqual(a.log.rewriteUsage, { inputTokens: 410, outputTokens: 60, calls: 1 });
    assert.equal(a.log.usage, null, "n8n passed none: nothing is estimated");
    assert.ok(!a.raw.includes("voucher"));
    retrieveUsage = null;
    const b = await chat({ question: "How do I post a voucher in IFS Cloud?" });
    assert.equal("rewriteUsage" in b.log, false);
    assert.equal("quickReport" in b.log, false);
  });

  it("cuts a long introduction to three sentences before the exact page, and leaves the answer of any other request alone", async () => {
    const long = "I designed the report. It has one parameter. It lists the invoices. It is not run yet.\n\nThree points matter:\n\n- First point.\n- Second point.\n\n[[REVIEW_PAGE]]\n\n[[DESIGN_JSON]]\n\nPlease approve the design or tell me what to change.";
    script = async (sent) => {
      await tool(sent, "review_quick_report", { design_json: JSON.stringify(sample) });
      return { answer: long };
    };
    const { value } = await chat({ question: SPEC });
    assert.match(value.answer, /^I designed the report. It has one parameter. It lists the invoices.\n\n/);
    assert.ok(!value.answer.includes("It is not run yet") && !value.answer.includes("Three points") && !value.answer.includes("First point"));
    assert.ok(value.answer.includes(await expectedPage(sample)), "the page is still exact");
    assert.match(value.answer, /Please approve the design or tell me what to change.$/);

    script = async () => ({ answer: "One. Two. Three. Four. Five." });
    assert.equal((await chat({ question: "How do I post a voucher in IFS Cloud?" })).value.answer, "One. Two. Three. Four. Five.");
  });
});
