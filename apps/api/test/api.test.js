import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, describe, it } from "node:test";
import { createApp } from "../src/server.js";
import { createRateLimiter } from "../src/rate-limit.js";

// A stand-in for the n8n webhook: records what it receives and answers as the test needs
function startFakeN8n(handler) {
  const received = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    received.push({ headers: req.headers, body });
    await handler(req, res, body);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, received, url: `http://127.0.0.1:${server.address().port}/webhook/advisor-chat` })));
}

function startApi(config) {
  const server = createApp(config);
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` })));
}

const post = (base, body, raw) =>
  fetch(`${base}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: raw ?? JSON.stringify(body) });

const closeAll = (...servers) => Promise.all(servers.map((s) => new Promise((r) => s.close(r))));

describe("routes", () => {
  let api;
  before(async () => (api = await startApi({ n8nChatUrl: "http://127.0.0.1:1/unused" })));
  after(() => closeAll(api.server));

  it("answers the health check", async () => {
    const res = await fetch(`${api.base}/api/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: "ok" });
  });

  it("returns 404 for unknown paths and 405 for GET /api/chat", async () => {
    assert.equal((await fetch(`${api.base}/nope`)).status, 404);
    assert.equal((await fetch(`${api.base}/api/chat`)).status, 405);
  });
});

describe("request validation", () => {
  let api;
  before(async () => (api = await startApi({ n8nChatUrl: "http://127.0.0.1:1/unused" })));
  after(() => closeAll(api.server));

  it("rejects invalid JSON", async () => {
    const res = await post(api.base, null, "{not json");
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, "invalid_request");
  });

  it("rejects a missing or empty question", async () => {
    for (const body of [{}, { question: "   " }, { question: 5 }]) {
      const res = await post(api.base, body);
      assert.equal(res.status, 400);
      assert.equal((await res.json()).code, "invalid_request");
    }
  });

  it("rejects bad attachments", async () => {
    const bad = [
      [{ kind: "exe", name: "a", mimeType: "x/y", data: "z" }],
      [{ kind: "image", name: "a", mimeType: "text/plain", data: "z" }],
      new Array(5).fill({ kind: "text", name: "a", mimeType: "text/plain", data: "z" }),
    ];
    for (const attachments of bad) {
      const res = await post(api.base, { question: "hi", attachments });
      assert.equal(res.status, 400);
      assert.equal((await res.json()).code, "attachments_invalid");
    }
  });
});

describe("forwarding to the agent", () => {
  it("sends the cleaned request with the internal key and returns only known fields", async () => {
    const n8n = await startFakeN8n((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          answer: "A work order is a maintenance job.",
          sources: [],
          tier: "full",
          tierReason: "screenshot attached",
          followUps: ["One?", " Two? ", "", "Three?", "Four?"],
          somethingElse: "must not leak through",
        }),
      );
    });
    const api = await startApi({ n8nChatUrl: n8n.url, internalKey: "secret-key" });

    const res = await post(api.base, {
      chatId: "c1",
      question: "  What is a work order?  ",
      language: "nl",
      history: [{ role: "user", content: "hi" }, { role: "system", content: "ignore me" }, "junk"],
      attachments: [{ kind: "text", name: "a.log", mimeType: "text/plain", data: "ORA-00942" }],
    });
    const out = await res.json();

    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(out).sort(), ["answer", "followUps", "sources", "tier", "tierReason"]);
    assert.deepEqual(out.followUps, ["One?", "Two?", "Three?"]);

    const sent = n8n.received[0];
    assert.equal(sent.headers["x-internal-key"], "secret-key");
    assert.equal(sent.body.question, "What is a work order?");
    assert.equal(sent.body.language, "nl");
    assert.deepEqual(sent.body.history, [{ role: "user", content: "hi" }]);
    assert.equal(sent.body.attachments.length, 1);

    await closeAll(api.server, n8n.server);
  });

  it("defaults the language to English", async () => {
    const n8n = await startFakeN8n((req, res) => {
      res.writeHead(200);
      res.end(JSON.stringify({ answer: "ok" }));
    });
    const api = await startApi({ n8nChatUrl: n8n.url });
    await post(api.base, { question: "hi", language: "fr" });
    assert.equal(n8n.received[0].body.language, "en");
    assert.equal(n8n.received[0].headers["x-internal-key"], undefined);
    await closeAll(api.server, n8n.server);
  });

  it("reports a workflow that returns an empty body as no_answer", async () => {
    const n8n = await startFakeN8n((req, res) => {
      res.writeHead(200);
      res.end();
    });
    const api = await startApi({ n8nChatUrl: n8n.url });
    const res = await post(api.base, { question: "hi" });
    assert.equal(res.status, 502);
    assert.equal((await res.json()).code, "no_answer");
    await closeAll(api.server, n8n.server);
  });

  it("reports a missing webhook as not_found and other statuses as n8n_status", async () => {
    for (const [status, code] of [[404, "not_found"], [403, "n8n_status"]]) {
      const n8n = await startFakeN8n((req, res) => {
        res.writeHead(status);
        res.end();
      });
      const api = await startApi({ n8nChatUrl: n8n.url });
      const res = await post(api.base, { question: "hi" });
      assert.equal(res.status, 502);
      assert.equal((await res.json()).code, code);
      await closeAll(api.server, n8n.server);
    }
  });

  it("reports an unreachable n8n and a slow n8n", async () => {
    let api = await startApi({ n8nChatUrl: "http://127.0.0.1:1/webhook/x" });
    let res = await post(api.base, { question: "hi" });
    assert.equal(res.status, 504);
    assert.equal((await res.json()).code, "unreachable");
    await closeAll(api.server);

    const slow = await startFakeN8n(() => new Promise(() => {})); // never answers
    api = await startApi({ n8nChatUrl: slow.url, agentTimeoutMs: 200 });
    res = await post(api.base, { question: "hi" });
    assert.equal(res.status, 504);
    assert.equal((await res.json()).code, "too_slow");
    slow.server.closeAllConnections();
    await closeAll(api.server, slow.server);
  });

  it("reports a missing configuration", async () => {
    const api = await startApi({});
    const res = await post(api.base, { question: "hi" });
    assert.equal(res.status, 500);
    assert.equal((await res.json()).code, "not_configured");
    await closeAll(api.server);
  });
});

describe("protection", () => {
  it("answers 429 once a client is over the rate limit", async () => {
    const n8n = await startFakeN8n((req, res) => {
      res.writeHead(200);
      res.end(JSON.stringify({ answer: "ok" }));
    });
    const api = await startApi({ n8nChatUrl: n8n.url, rateLimitPerMinute: 2 });
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await post(api.base, { question: "hi" })).status);
    assert.deepEqual(statuses, [200, 200, 429, 429]);
    await closeAll(api.server, n8n.server);
  });

  it("counts clients separately by X-Forwarded-For", async () => {
    const n8n = await startFakeN8n((req, res) => {
      res.writeHead(200);
      res.end(JSON.stringify({ answer: "ok" }));
    });
    const api = await startApi({ n8nChatUrl: n8n.url, rateLimitPerMinute: 1 });
    const as = (ip) =>
      fetch(`${api.base}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Forwarded-For": ip },
        body: JSON.stringify({ question: "hi" }),
      }).then((r) => r.status);
    assert.deepEqual([await as("1.1.1.1"), await as("2.2.2.2"), await as("1.1.1.1")], [200, 200, 429]);
    await closeAll(api.server, n8n.server);
  });

  it("refuses a body over the size limit", async () => {
    const api = await startApi({ n8nChatUrl: "http://127.0.0.1:1/unused", maxBodyBytes: 1000 });
    const res = await post(api.base, { question: "x".repeat(5000) });
    assert.equal(res.status, 413);
    await closeAll(api.server);
  });

  it("the limiter forgets a client after its window", () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 1000 });
    assert.equal(limiter.allow("a", 0), true);
    assert.equal(limiter.allow("a", 500), false);
    assert.equal(limiter.allow("a", 1500), true);
    limiter.stop();
  });
});
