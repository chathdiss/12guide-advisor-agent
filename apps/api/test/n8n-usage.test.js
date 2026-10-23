// The token counts of an answer, read afterwards from the stored n8n execution (n8n-usage.js) and logged by the server.
// Everything here is offline: a fake n8n answers with the structure that was found in a real execution of n8n 2.41.5.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, describe, it } from "node:test";
import { createApp } from "../src/server.js";
import { createUsageReader, tokenUsageOf } from "../src/n8n-usage.js";
import { cleanAgentResponse } from "../src/validate.js";

const API_KEY = "n8n-api-key-secret";
const QUESTION_TEXT = "a question with customer details";

// the structure of a real execution: one item per call of the model node, on the ai_languageModel connection
const call = (promptTokens, completionTokens) => ({
  startTime: 1,
  data: { ai_languageModel: [[{ json: { response: { generations: [[{ text: QUESTION_TEXT }]] }, tokenUsage: { completionTokens, promptTokens, totalTokens: promptTokens + completionTokens } } }]] },
});
const execution = (status = "success", calls = [call(15640, 119), call(16100, 80), call(17000, 450)]) => ({
  id: "3254",
  finished: status === "success",
  status,
  data: { resultData: { runData: { Claude: calls, "Advisor Agent": [{ data: { main: [[{ json: { output: QUESTION_TEXT } }]] } }] } } },
});

describe("the token counts of a stored execution", () => {
  it("adds up the tokenUsage of every call of the model node", () => {
    assert.deepEqual(tokenUsageOf(execution()), { inputTokens: 48740, outputTokens: 649, modelCalls: 3 });
  });

  it("gives null, and never a guess, when the execution has no counts", () => {
    assert.equal(tokenUsageOf(null), null);
    assert.equal(tokenUsageOf({}), null);
    assert.equal(tokenUsageOf({ data: "a flatted string from an older n8n" }), null);
    assert.equal(tokenUsageOf({ data: { resultData: { runData: {} } } }), null);
    assert.equal(tokenUsageOf(execution("success", [{ data: { ai_languageModel: [[{ json: { response: {} } }]] } }, { error: { message: "failed" } }])), null);
    assert.equal(tokenUsageOf(execution(), "Another model"), null);
  });

  it("counts only whole, non-negative numbers, and a call that has no count adds nothing", () => {
    const odd = execution("success", [call(-5, "x"), call(10, 2), { data: { ai_languageModel: [[{ json: {} }]] } }]);
    assert.deepEqual(tokenUsageOf(odd), { inputTokens: 10, outputTokens: 2, modelCalls: 2 });
  });
});

describe("the reader of the n8n execution API", () => {
  const response = (status, body, headers = {}) => ({ ok: status >= 200 && status < 300, status, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, json: async () => body });
  const fast = { attempts: 4, delayMs: 0, sleep: async () => {} };

  it("is off without the address and the API key, and for an address that is not http(s)", () => {
    assert.equal(createUsageReader({}), null);
    assert.equal(createUsageReader({ baseUrl: "http://localhost:5678" }), null);
    assert.equal(createUsageReader({ apiKey: API_KEY }), null);
    assert.equal(createUsageReader({ baseUrl: "file:///etc/passwd", apiKey: API_KEY }), null);
    assert.equal(createUsageReader({ baseUrl: "not a url", apiKey: API_KEY }), null);
  });

  it("asks for exactly one execution with the key in the header only, and returns the counts", async () => {
    const calls = [];
    const read = createUsageReader({ baseUrl: "http://localhost:5678/", apiKey: API_KEY, ...fast, fetchImpl: async (url, init) => (calls.push({ url, init }), response(200, execution())) });
    assert.deepEqual(await read("3254"), { inputTokens: 48740, outputTokens: 649, modelCalls: 3 });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "http://localhost:5678/api/v1/executions/3254?includeData=true");
    assert.equal(calls[0].init.headers["X-N8N-API-KEY"], API_KEY);
    assert.ok(!calls[0].url.includes(API_KEY), "the key is not in the address");
  });

  it("keeps a path in the address of n8n (a gateway) and drops the trailing slash", async () => {
    const urls = [];
    const read = createUsageReader({ baseUrl: "https://host.example/n8n/", apiKey: API_KEY, ...fast, fetchImpl: async (url) => (urls.push(url), response(200, execution())) });
    await read(12);
    assert.equal(urls[0], "https://host.example/n8n/api/v1/executions/12?includeData=true");
  });

  it("waits for an execution that has not been stored yet or is still running, and then reads it", async () => {
    const answers = [response(404, {}), response(200, execution("running", [])), response(502, {}), response(200, execution())];
    let n = 0;
    const read = createUsageReader({ baseUrl: "http://n8n.local", apiKey: API_KEY, ...fast, fetchImpl: async () => answers[n++] });
    assert.deepEqual(await read("1"), { inputTokens: 48740, outputTokens: 649, modelCalls: 3 });
    assert.equal(n, 4);
  });

  it("gives up with null after the attempts, and does not wait after the last one", async () => {
    let n = 0;
    let waits = 0;
    const read = createUsageReader({ baseUrl: "http://n8n.local", apiKey: API_KEY, attempts: 3, sleep: async () => void waits++, fetchImpl: async () => (n++, response(404, {})) });
    assert.equal(await read("1"), null);
    assert.equal(n, 3);
    assert.equal(waits, 2);
  });

  it("does not retry a refusal of the key, and never throws on network errors or broken answers", async () => {
    let n = 0;
    for (const status of [401, 403]) {
      n = 0;
      const refused = createUsageReader({ baseUrl: "http://n8n.local", apiKey: API_KEY, ...fast, fetchImpl: async () => (n++, response(status, { message: "no" })) });
      assert.equal(await refused("1"), null);
      assert.equal(n, 1, `status ${status}`);
    }
    const down = createUsageReader({ baseUrl: "http://n8n.local", apiKey: API_KEY, ...fast, fetchImpl: async () => { throw new Error(`connect ECONNREFUSED with ${API_KEY}`); } });
    assert.equal(await down("1"), null);
    const broken = createUsageReader({ baseUrl: "http://n8n.local", apiKey: API_KEY, ...fast, fetchImpl: async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => { throw new Error("bad json"); } }) });
    assert.equal(await broken("1"), null);
    const huge = createUsageReader({ baseUrl: "http://n8n.local", apiKey: API_KEY, ...fast, fetchImpl: async () => response(200, execution(), { "content-length": String(30 * 1024 * 1024) }) });
    assert.equal(await huge("1"), null);
  });

  it("accepts only digits as an execution id, so that an answer cannot steer the request to another address", async () => {
    let n = 0;
    const read = createUsageReader({ baseUrl: "http://n8n.local", apiKey: API_KEY, ...fast, fetchImpl: async () => (n++, response(200, execution())) });
    for (const bad of ["../workflows", "1/../../users", "1?x=2", "", null, undefined, "12345678901234567890", "abc"]) assert.equal(await read(bad), null, String(bad));
    assert.equal(n, 0, "nothing was requested");
  });
});

describe("the execution id that n8n passes on", () => {
  it("is kept only when it is a number, and the answer is cleaned as before", () => {
    assert.equal(cleanAgentResponse({ answer: "A", executionId: "3254" }).executionId, "3254");
    assert.equal(cleanAgentResponse({ answer: "A", executionId: 77 }).executionId, "77");
    for (const bad of ["../x", "1;2", "", {}, null]) assert.equal("executionId" in cleanAgentResponse({ answer: "A", executionId: bad }), false, JSON.stringify(bad));
    assert.equal("executionId" in cleanAgentResponse({ answer: "A" }), false);
  });
});

describe("the log of the token counts of an answer", () => {
  let n8n;
  let api;
  let base;
  let behaviour;
  const asked = [];
  let reader = async (id) => (asked.push(id), { inputTokens: 100, outputTokens: 20, modelCalls: 2 });

  before(async () => {
    n8n = createServer(async (req, res) => {
      for await (const c of req); // the question is not needed
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(behaviour()));
    });
    await new Promise((r) => n8n.listen(0, "127.0.0.1", r));
    api = createApp({
      n8nChatUrl: `http://127.0.0.1:${n8n.address().port}/x`,
      internalKey: "k",
      retrieve: async () => ({ status: "ok", passages: [] }),
      usageReader: (id) => reader(id),
    });
    await new Promise((r) => api.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${api.address().port}`;
  });
  after(() => Promise.all([api, n8n].map((s) => new Promise((r) => s.close(r)))));

  const chat = async () => {
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
      const res = await fetch(`${base}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: QUESTION_TEXT }) });
      const value = await res.json();
      await new Promise((r) => setTimeout(r, 30)); // the lookup runs after the answer
      return { value, logs, raw: JSON.stringify(logs) };
    } finally {
      console.log = original;
    }
  };

  it("logs the counts of the execution with the requestId of the answer, after it, and keeps the id and the counts out of the browser's answer", async () => {
    asked.length = 0;
    behaviour = () => ({ answer: "The answer.", executionId: "3254" });
    const { value, logs, raw } = await chat();
    assert.equal(value.answer, "The answer.");
    assert.equal("executionId" in value, false);
    assert.equal("usage" in value, false);
    assert.deepEqual(asked, ["3254"]);
    const main = logs.find((l) => l.status === 200);
    const later = logs.find((l) => l.event === "usage");
    assert.equal(main.usage, null, "the first log line is written when the answer is ready, before the counts exist");
    assert.ok(main.requestId);
    assert.equal(later.requestId, main.requestId);
    assert.deepEqual(later.usage, { inputTokens: 100, outputTokens: 20, modelCalls: 2 });
    for (const secret of [QUESTION_TEXT, "The answer."]) assert.ok(!raw.includes(secret), `the log does not contain: ${secret}`);
  });

  it("logs null when the counts cannot be read, and an error of the reader never reaches the answer", async () => {
    behaviour = () => ({ answer: "The answer.", executionId: "3254" });
    reader = async () => null;
    assert.equal((await chat()).logs.find((l) => l.event === "usage").usage, null);
    reader = async () => { throw new Error("boom"); };
    const { value, logs } = await chat();
    assert.equal(value.answer, "The answer.");
    assert.equal(logs.some((l) => l.event === "usage"), false);
  });

  it("does not read the execution when n8n already passed counts on, or passed no execution id", async () => {
    asked.length = 0;
    reader = async (id) => (asked.push(id), null);
    behaviour = () => ({ answer: "A.", executionId: "5", usage: { inputTokens: 1, outputTokens: 1, modelCalls: 1 } });
    const withUsage = await chat();
    assert.deepEqual(withUsage.logs.find((l) => l.status === 200).usage, { inputTokens: 1, outputTokens: 1, modelCalls: 1 });
    behaviour = () => ({ answer: "A." });
    await chat();
    behaviour = () => ({ answer: "A.", executionId: "../x" });
    await chat();
    assert.deepEqual(asked, []);
  });
});
