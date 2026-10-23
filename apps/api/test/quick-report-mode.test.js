// The two tabs of the web app ask for their own workflow: Quick Reports always gets the quick report workflow, Advisor Chat never does, and a
// request without a tab (an older client) is still decided by the request itself.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, describe, it } from "node:test";
import { createApp } from "../src/server.js";
import { validateChatRequest } from "../src/validate.js";

const SPEC = "Please create a quick report. Title: Open Orders. Parameter: Company. Columns: Order No, Customer, Amount.";
const GENERAL = "How do I post a voucher in IFS Cloud?";
const post = (url, body) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

describe("the mode of a chat request", () => {
  it("is kept when it names a tab, and empty otherwise", () => {
    const mode = (m) => validateChatRequest({ question: "q", ...(m === undefined ? {} : { mode: m }) }).value.mode;
    assert.equal(mode("quickReport"), "quickReport");
    assert.equal(mode("advisor"), "advisor");
    for (const other of [undefined, "", "Quick", "lobby", 1, null, {}]) assert.equal(mode(other), "", String(other));
  });
});

describe("the workflow that a tab gets", () => {
  let n8n;
  let api;
  let base;
  const received = [];
  const retrieveArgs = [];
  const cacheLookups = [];

  before(async () => {
    n8n = createServer(async (req, res) => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      received.push(JSON.parse(Buffer.concat(chunks).toString()));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ answer: "Done." }));
    });
    await new Promise((r) => n8n.listen(0, "127.0.0.1", r));
    api = createApp({
      n8nChatUrl: `http://127.0.0.1:${n8n.address().port}/x`,
      internalKey: "k",
      publicUrl: "https://backend.example",
      tools: { reviewQuickReport: async () => ({ text: "x" }) },
      memory: {
        findCachedAnswer: async (q) => (cacheLookups.push(q.question), { id: 1, answer: "A saved answer.", sources: [], match: "exact" }),
        findLessons: async () => [],
        recordCacheEvent: () => {},
        usedAnswer: () => {},
      },
      retrieve: async (...args) => (retrieveArgs.push(args), { status: "ok", passages: [] }),
    });
    await new Promise((r) => api.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${api.address().port}`;
  });
  after(() => Promise.all([api, n8n].map((s) => new Promise((r) => s.close(r)))));

  const ask = async (body) => {
    received.length = 0;
    retrieveArgs.length = 0;
    cacheLookups.length = 0;
    const value = await (await post(`${base}/api/chat`, body)).json();
    return { value, sent: received[0], retrieve: retrieveArgs[0] };
  };

  it("Quick Reports: the quick report workflow, even for a question that does not look like one", async () => {
    const { sent, retrieve } = await ask({ question: GENERAL, mode: "quickReport", fresh: true });
    assert.equal(sent.quickReport, true);
    assert.deepEqual(retrieve.slice(2), [{ limit: 4 }]);
  });

  it("Quick Reports: never a saved answer of the other tab", async () => {
    const { value, sent } = await ask({ question: "What is the difference between a customer order and a sales quotation", mode: "quickReport" });
    assert.deepEqual(cacheLookups, []);
    assert.equal(value.answer, "Done.");
    assert.equal(sent.quickReport, true);
  });

  it("Advisor Chat: not the quick report workflow, even for a specification of a quick report", async () => {
    const { sent, retrieve } = await ask({ question: SPEC, mode: "advisor", fresh: true });
    assert.equal("quickReport" in sent, false);
    assert.equal(retrieve.length, 2, "the usual number of passages");
  });

  it("Advisor Chat: saved answers still work", async () => {
    const { value } = await ask({ question: "What is the difference between a customer order and a sales quotation", mode: "advisor" });
    assert.equal(value.answer, "A saved answer.");
    assert.equal(cacheLookups.length, 1);
  });

  it("without a mode the request decides, as before", async () => {
    assert.equal((await ask({ question: SPEC, fresh: true })).sent.quickReport, true);
    assert.equal("quickReport" in (await ask({ question: GENERAL, fresh: true })).sent, false);
  });

  it("a quick report conversation stays in its tab: the design of its last answer does not turn a question of Advisor Chat into a change", async () => {
    const design = '```json\n{"designVersion":1,"dataSources":[]}\n```';
    const history = [{ role: "user", content: SPEC }, { role: "assistant", content: `Here it is.\n\n${design}` }];
    assert.equal((await ask({ question: "Add a Currency column", history, fresh: true })).sent.quickReport, true, "no mode: the history decides");
    assert.equal("quickReport" in (await ask({ question: "Add a Currency column", history, mode: "advisor", fresh: true })).sent, false);
    assert.equal((await ask({ question: "Add a Currency column", history, mode: "quickReport", fresh: true })).sent.quickReport, true);
  });
});
