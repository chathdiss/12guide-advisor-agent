import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, describe, it } from "node:test";
import { createPendingAnswers } from "../src/pending.js";
import { createApp } from "../src/server.js";

const KEY = "internal-secret";

describe("waiting list for answers that n8n delivers later", () => {
  it("hands a delivered answer to the one who waits, even when it arrives before the wait starts", async () => {
    const pending = createPendingAnswers();
    const slot = pending.expect("a");
    assert.equal(pending.deliver("a", { answer: "early" }), true);
    assert.deepEqual(await slot.wait(1000), { answer: "early" });
    assert.equal(pending.size, 0);
  });

  it("gives null after the time limit, and refuses a late delivery", async () => {
    const pending = createPendingAnswers();
    const slot = pending.expect("b");
    assert.equal(await slot.wait(30), null);
    assert.equal(pending.deliver("b", { answer: "late" }), false);
  });

  it("refuses an answer that nobody waits for, and forgets a cancelled wait", () => {
    const pending = createPendingAnswers();
    assert.equal(pending.deliver("nobody", {}), false);
    pending.expect("c").cancel();
    assert.equal(pending.size, 0);
  });
});

// n8n that answers "accepted" at once and posts the answer to the return address a moment later
function startLaterN8n(afterAccepted) {
  const seen = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const sent = JSON.parse(Buffer.concat(chunks).toString());
    seen.push(sent);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ accepted: true }));
    if (sent.callbackUrl) setTimeout(() => afterAccepted(sent), 40);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, seen, url: `http://127.0.0.1:${server.address().port}/x` })));
}

const post = (url, body, headers = {}) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

describe("an agent that delivers the answer later", () => {
  let n8n;
  let api;
  let base;
  let behaviour = () => {};
  before(async () => {
    n8n = await startLaterN8n((sent) => behaviour(sent));
    api = createApp({
      n8nChatUrl: n8n.url,
      internalKey: KEY,
      agentTimeoutMs: 800,
      publicUrl: "https://backend.example/",
    });
    await new Promise((r) => api.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${api.address().port}`;
  });
  after(() => Promise.all([api, n8n.server].map((s) => new Promise((r) => s.close(r)))));

  // the return address n8n gets points to the public address; the test posts to the local server with the same id
  const idOf = (sent) => sent.callbackUrl.split("/").pop();
  const deliver = (sent, body, headers = { "X-Internal-Key": KEY }) => post(`${base}/api/internal/answer/${idOf(sent)}`, body, headers);

  it("returns the answer that n8n posts to the return address, with the sources the backend adds", async () => {
    behaviour = (sent) => deliver(sent, { answer: "A long answer.", sources: [], tier: "full", followUps: ["Next?"] });
    const res = await post(`${base}/api/chat`, { question: "How does it work?" });
    assert.equal(res.status, 200);
    const value = await res.json();
    assert.equal(value.answer, "A long answer.");
    assert.equal(value.tier, "full");
    assert.deepEqual(value.followUps, ["Next?"]);
  });

  it("gives n8n a one-time return address on the public address, which the browser cannot choose", async () => {
    behaviour = (sent) => deliver(sent, { answer: "ok" });
    await post(`${base}/api/chat`, { question: "Another question", callbackUrl: "https://evil.example/steal" });
    const sent = n8n.seen.at(-1);
    assert.match(sent.callbackUrl, /^https:\/\/backend\.example\/api\/internal\/answer\/[0-9a-f-]{36}$/);
  });

  it("refuses an answer posted with the wrong key, and the waiting question times out", async () => {
    let status = 0;
    behaviour = async (sent) => (status = (await deliver(sent, { answer: "forged" }, { "X-Internal-Key": "wrong" })).status);
    const res = await post(`${base}/api/chat`, { question: "Forged answer?" });
    assert.equal(status, 401);
    assert.equal(res.status, 504);
    assert.equal((await res.json()).code, "too_slow");
  });

  it("reports a failed agent: an error posted to the return address becomes a clear error", async () => {
    behaviour = (sent) => deliver(sent, { error: "The agent failed" });
    const res = await post(`${base}/api/chat`, { question: "This fails?" });
    assert.equal(res.status, 502);
    assert.equal((await res.json()).code, "no_answer");
  });

  it("answers 404 to an answer that nobody waits for, and 405 to a wrong method", async () => {
    const stale = await post(`${base}/api/internal/answer/00000000-0000-4000-8000-000000000000`, { answer: "x" }, { "X-Internal-Key": KEY });
    assert.equal(stale.status, 404);
    assert.equal((await fetch(`${base}/api/internal/answer/x`)).status, 405);
  });
});

describe("an agent that answers at once, as before", () => {
  it("still works, with a return address that is simply not used", async () => {
    const n8n = createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ answer: "Immediate answer.", sources: [] }));
    });
    await new Promise((r) => n8n.listen(0, "127.0.0.1", r));
    const api = createApp({ n8nChatUrl: `http://127.0.0.1:${n8n.address().port}/x`, publicUrl: "https://backend.example" });
    await new Promise((r) => api.listen(0, "127.0.0.1", r));
    try {
      const res = await post(`http://127.0.0.1:${api.address().port}/api/chat`, { question: "Quick one?" });
      assert.equal((await res.json()).answer, "Immediate answer.");
    } finally {
      await Promise.all([api, n8n].map((s) => new Promise((r) => s.close(r))));
    }
  });

  it("sends no return address when the backend does not know its public address", async () => {
    let received = null;
    const n8n = createServer(async (req, res) => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      received = JSON.parse(Buffer.concat(chunks).toString());
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ answer: "Fine." }));
    });
    await new Promise((r) => n8n.listen(0, "127.0.0.1", r));
    const api = createApp({ n8nChatUrl: `http://127.0.0.1:${n8n.address().port}/x` });
    await new Promise((r) => api.listen(0, "127.0.0.1", r));
    try {
      await post(`http://127.0.0.1:${api.address().port}/api/chat`, { question: "No public address?" });
      assert.equal(received.callbackUrl, undefined);
    } finally {
      await Promise.all([api, n8n].map((s) => new Promise((r) => s.close(r))));
    }
  });
});
