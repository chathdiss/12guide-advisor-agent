import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { createMemory, isClientId } from "../src/memory.js";
import { createApp } from "../src/server.js";

const CLIENT = "11111111-2222-4333-8444-555555555555";
const OTHER = "99999999-2222-4333-8444-555555555555";
const KEY = "review-secret";

// ---- the HTTP side, with a stand-in for the memory ---------------------------------------------------------

function startApi(config) {
  const server = createApp(config);
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` })));
}
const closeAll = (...servers) => Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
const call = (base, method, path, { body, headers } = {}) =>
  fetch(`${base}${path}`, { method, headers: { "Content-Type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });

// a stand-in for n8n that counts the questions it receives (every one of them would cost AI tokens)
async function startAgent(answer = "A complete answer about the question.") {
  const received = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    received.push(JSON.parse(Buffer.concat(chunks).toString()));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ answer, sources: [], tier: "lite" }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, received, url: `http://127.0.0.1:${server.address().port}/x` };
}

describe("memory routes", () => {
  const seen = [];
  const memory = {
    listChats: async (id) => (seen.push(["listChats", id]), [{ id: "c1", title: "t", messages: [] }]),
    saveChat: async (id, chatId, chat) => (seen.push(["saveChat", id, chatId, chat.title]), { ok: true }),
    deleteChat: async (id, chatId) => (seen.push(["deleteChat", id, chatId]), true),
    saveFeedback: async (input) => (seen.push(["feedback", input.clientId, input.rating]), input.rating === "down" && String(input.comment ?? "").length < 8 ? { ok: false, error: "short" } : { ok: true, saved: input.rating === "up", id: 7 }),
    listLessons: async ({ status }) => (seen.push(["list", status]), []),
    reviewLesson: async (id, input) => (seen.push(["review", id, input.status]), id === "404" ? { ok: false, error: "Lesson not found." } : { ok: true, lesson: { id: Number(id), status: input.status } }),
    findLessons: async () => [{ id: 3, question: "q", correction: "Use the other screen." }],
    findReports: async () => [{ id: 9, question: "q", correction: "The table name seems wrong." }],
    cacheStats: async () => ({ hits: 2, misses: 3 }),
  };
  let api;
  let agent;
  before(async () => {
    agent = await startAgent("ok");
    api = await startApi({ n8nChatUrl: agent.url, memory, reviewKey: KEY, customers: ["Acme"], versions: ["IFS Cloud 25R2"] });
  });
  after(() => closeAll(api.server, agent.server));

  it("offers the choices of the two dropdowns", async () => {
    const res = await call(api.base, "GET", "/api/memory/scopes");
    assert.deepEqual(await res.json(), { customers: ["Acme"], versions: ["IFS Cloud 25R2"] });
  });

  it("lists, saves and deletes the chats of the client id in the header", async () => {
    const headers = { "x-client-id": CLIENT };
    assert.equal((await (await call(api.base, "GET", "/api/memory/chats", { headers })).json()).chats.length, 1);
    assert.equal((await call(api.base, "PUT", "/api/memory/chats/chat-12345678", { headers, body: { title: "T", messages: [] } })).status, 200);
    assert.equal((await call(api.base, "DELETE", "/api/memory/chats/chat-12345678", { headers })).status, 200);
    assert.deepEqual(seen.filter((s) => s[0] !== "list").slice(-3).map((s) => s.slice(0, 3)), [
      ["listChats", CLIENT],
      ["saveChat", CLIENT, "chat-12345678"],
      ["deleteChat", CLIENT, "chat-12345678"],
    ]);
  });

  it("takes a thumbs up from anybody without a review key, and a thumbs down only with an explanation", async () => {
    const headers = { "x-client-id": CLIENT };
    const up = await call(api.base, "POST", "/api/memory/feedback", { headers, body: { rating: "up", question: "q", answer: "a" } });
    assert.equal(up.status, 201);
    assert.equal((await up.json()).saved, true);
    assert.equal((await call(api.base, "POST", "/api/memory/feedback", { headers, body: { rating: "down", question: "q", answer: "a", comment: "no" } })).status, 400);
    assert.equal((await call(api.base, "POST", "/api/memory/feedback", { headers, body: { rating: "down", question: "q", answer: "a", comment: "The table is wrong." } })).status, 201);
  });

  it("keeps the reviewer's queue and the statistics behind the review key", async () => {
    assert.equal((await call(api.base, "GET", "/api/memory/lessons")).status, 401);
    assert.equal((await call(api.base, "GET", "/api/memory/stats")).status, 401);
    assert.equal((await call(api.base, "GET", "/api/memory/lessons", { headers: { "x-review-key": "wrong" } })).status, 401);
    assert.equal((await call(api.base, "GET", "/api/memory/lessons", { headers: { "x-review-key": KEY } })).status, 200);
    assert.equal(seen.at(-1)[1], "unverified", "the queue shows the unverified notes by default");
    assert.deepEqual(await (await call(api.base, "GET", "/api/memory/stats", { headers: { "x-review-key": KEY } })).json(), { hits: 2, misses: 3 });
    const headers = { "x-review-key": KEY };
    const done = await call(api.base, "POST", "/api/memory/lessons/5/review", { headers, body: { status: "approved" } });
    assert.equal((await done.json()).lesson.status, "approved");
    assert.equal((await call(api.base, "POST", "/api/memory/lessons/404/review", { headers, body: { status: "approved" } })).status, 404);
  });

  it("no longer takes feedback through the lesson route: that is for the reviewer only", async () => {
    assert.equal((await call(api.base, "POST", "/api/memory/lessons", { headers: { "x-client-id": CLIENT }, body: { rating: "up", question: "q" } })).status, 401);
  });

  it("switches the review off when no key is configured", async () => {
    const open = await startApi({ n8nChatUrl: "http://127.0.0.1:1/x", memory });
    try {
      assert.equal((await call(open.base, "GET", "/api/memory/lessons")).status, 503);
    } finally {
      await closeAll(open.server);
    }
  });

  it("sends confirmed lessons and, separately, unverified reports to the agent", async () => {
    const res = await call(api.base, "POST", "/api/chat", { body: { question: "How do I post this?", customer: "Acme", ifsVersion: "IFS Cloud 25R2" } });
    const value = await res.json();
    assert.deepEqual(value.lessons, [{ id: 3, correction: "Use the other screen." }]);
    const sent = agent.received.at(-1);
    assert.equal(sent.customer, "Acme");
    assert.equal(sent.lessons[0].id, 3);
    assert.equal(sent.reports[0].id, 9);
    assert.equal(sent.reports[0].correction, "The table name seems wrong.");
  });

  it("answers 503 for memory when there is no database", async () => {
    const none = await startApi({ n8nChatUrl: "http://127.0.0.1:1/x" });
    try {
      assert.equal((await call(none.base, "GET", "/api/memory/chats", { headers: { "x-client-id": CLIENT } })).status, 503);
    } finally {
      await closeAll(none.server);
    }
  });
});

// ---- the database side: only when a database is available ----------------------------------------------------

describe("memory in the database", { skip: !process.env.DATABASE_URL && "DATABASE_URL is not set" }, () => {
  const tag = `test-${Date.now()}`;
  const customer = `${tag}-customer`;
  const version = "IFS Cloud 25R2";
  const Q = `How do I reopen a closed accounting period for ${tag}?`;
  const LONGQ = `How do I reopen a closed accounting period for company ${tag} in the accrul component of IFS`;
  const A = "Open the Accounting Periods page and use the Reopen command on the closed period.";
  let db;
  let memory;
  before(() => {
    db = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
    memory = createMemory(db);
  });
  after(async () => {
    await db.query("DELETE FROM memory_lessons WHERE customer LIKE $1 OR suggested_by IN ($2, $3)", [`${tag}%`, CLIENT, OTHER]);
    await db.query("DELETE FROM memory_answers WHERE customer LIKE $1", [`${tag}%`]);
    await db.query("DELETE FROM memory_chats WHERE client_id IN ($1, $2)", [CLIENT, OTHER]);
    await db.end();
  });

  const up = (extra = {}) => memory.saveFeedback({ clientId: CLIENT, rating: "up", customer, ifsVersion: version, language: "en", question: Q, answer: A, sources: [{ title: "Doc", url: "https://x" }], tier: "full", followUps: ["Next?"], standalone: true, ...extra });
  const ask = (extra = {}) => memory.findCachedAnswer({ customer, ifsVersion: version, language: "en", question: Q, ...extra });

  it("recognises a client id", () => {
    assert.ok(isClientId(CLIENT));
    assert.ok(!isClientId("short"));
    assert.ok(!isClientId(undefined));
  });

  it("saves a thumbs-up answer at once, with no review, and finds it again", async () => {
    assert.equal(await ask(), null, "nothing saved yet");
    const saved = await up();
    assert.ok(saved.ok && saved.saved);
    const found = await ask();
    assert.equal(found.answer, A);
    assert.equal(found.match, "exact");
    assert.deepEqual(found.sources, [{ title: "Doc", url: "https://x" }]);
    assert.equal(found.tier, "full");
    assert.deepEqual(found.followUps, ["Next?"]);
  });

  it("finds it for the same question in other words", async () => {
    const reworded = await ask({ question: `how can I reopen the closed accounting period for ${tag}` });
    assert.equal(reworded.answer, A);
    assert.equal(reworded.match, "exact");
  });

  it("finds a long question for a long question that differs by one word, but not a short one", async () => {
    assert.ok((await up({ question: LONGQ })).saved);
    assert.equal((await ask({ question: `${LONGQ} again` })).match, "similar");
    assert.equal(await ask({ question: `${LONGQ} again for another company` }), null);
    assert.equal(await ask({ question: `How do I reopen an accounting period for ${tag}?` }), null, "a short question needs the same words");
  });

  it("does not find it for another customer, version, language or question", async () => {
    assert.equal(await ask({ customer: `${customer}-other` }), null);
    assert.equal(await ask({ customer: "" }), null, "an empty choice only matches an empty choice");
    assert.equal(await ask({ ifsVersion: "IFS Apps 10" }), null);
    assert.equal(await ask({ language: "nl" }), null);
    assert.equal(await ask({ question: `How do I close an accounting period for ${tag}?` }), null);
    assert.equal(await ask({ question: `How do I NOT reopen a closed accounting period for ${tag}?` }), null);
  });

  it("does not save a follow-up, an empty answer or a question without a topic", async () => {
    assert.deepEqual(await up({ standalone: false, question: `follow up ${tag} something` }), { ok: true, saved: false, reason: "follow_up" });
    assert.equal((await up({ answer: "short" })).saved, false);
    assert.equal((await up({ question: "how do i" })).saved, false);
  });

  it("counts a second thumbs up on the same question without making a second copy", async () => {
    await up();
    const { rows } = await db.query("SELECT count(*)::int AS n, max(likes) AS likes FROM memory_answers WHERE customer = $1 AND question = $2", [customer, Q]);
    assert.equal(rows[0].n, 1);
    assert.ok(rows[0].likes >= 2);
  });

  it("stops reusing an answer after a thumbs down, stores the note as unverified, and needs an explanation", async () => {
    assert.equal((await memory.saveFeedback({ clientId: CLIENT, rating: "down", customer, ifsVersion: version, language: "en", question: Q, answer: A, comment: "short" })).ok, false);
    const down = await memory.saveFeedback({
      clientId: CLIENT,
      rating: "down",
      customer,
      ifsVersion: version,
      language: "en",
      question: Q,
      answer: A,
      comment: "The page is called Accounting Period Control in 25R2, and the answer does not say who may reopen.",
    });
    assert.ok(down.ok);
    assert.equal(down.switchedOff, true);
    assert.equal(await ask(), null, "the answer with a thumbs down is not returned again");
    const { rows } = await db.query("SELECT status, rating, question, answer FROM memory_lessons WHERE id = $1", [down.id]);
    assert.deepEqual([rows[0].status, rows[0].rating, rows[0].question, rows[0].answer], ["unverified", "down", Q, A], "tied to the question and the answer, not verified");
  });

  it("gives the unverified note to the agent as a report, never as a confirmed lesson, until a reviewer confirms it", async () => {
    const q = { customer, ifsVersion: version, question: "reopen closed accounting period" };
    assert.deepEqual(await memory.findLessons(q), [], "an unverified note is not a confirmed lesson");
    const reports = await memory.findReports(q);
    assert.equal(reports.length, 1);
    assert.match(reports[0].correction, /Accounting Period Control/);
    assert.deepEqual(await memory.findReports({ ...q, customer: `${customer}-other` }), [], "another customer does not get it");
    assert.deepEqual(await memory.findReports({ ...q, question: "customer order delivery address" }), [], "an unrelated question does not get it");

    const [{ id }] = await memory.listLessons({ status: "unverified" }).then((l) => l.filter((x) => x.customer === customer));
    assert.ok((await memory.reviewLesson(id, { status: "approved", note: "checked" })).ok);
    assert.equal((await memory.findLessons(q)).length, 1, "once a reviewer confirms it, it is a lesson");
    assert.deepEqual(await memory.findReports(q), [], "and no longer only a report");
    await memory.reviewLesson(id, { status: "rejected" });
    assert.deepEqual(await memory.findLessons(q), [], "a dismissed note is not used");
  });

  it("replaces a switched-off answer by a new thumbs-up answer", async () => {
    const better = "Use the Reopen command on the Accounting Periods page; it needs the Period Administrator role.";
    assert.ok((await up({ answer: better })).saved);
    assert.equal((await ask()).answer, better);
  });

  it("forgets answers older than the time limit", async () => {
    await db.query("UPDATE memory_answers SET updated_at = now() - interval '90 days' WHERE customer = $1", [customer]);
    assert.equal(await ask({ ttlDays: 60 }), null);
    assert.ok(await ask({ ttlDays: 120 }));
  });

  it("refuses feedback without a rating or a client id", async () => {
    assert.equal((await memory.saveFeedback({ clientId: CLIENT, rating: "maybe", question: "q" })).ok, false);
    assert.equal((await memory.saveFeedback({ clientId: "x", rating: "up", question: "q" })).ok, false);
  });

  it("keeps the chats of each client apart, and the newest version of a chat", async () => {
    const chat = (title, updatedAt) => ({ title, messages: [{ id: "m1", role: "user", content: "hi" }], createdAt: 1000, updatedAt });
    assert.ok((await memory.saveChat(CLIENT, "chat-aaaaaaaa", chat("first", 2000))).ok);
    assert.ok((await memory.saveChat(OTHER, "chat-bbbbbbbb", chat("other", 2000))).ok);
    await memory.saveChat(CLIENT, "chat-aaaaaaaa", chat("older copy", 1500)); // an older copy must not win
    const mine = await memory.listChats(CLIENT);
    assert.deepEqual(mine.map((c) => [c.id, c.title]), [["chat-aaaaaaaa", "first"]]);
    assert.equal((await memory.saveChat("bad", "chat-aaaaaaaa", chat("x", 1))).ok, false);
    assert.equal(await memory.deleteChat(CLIENT, "chat-aaaaaaaa"), true);
    assert.deepEqual(await memory.listChats(CLIENT), []);
    assert.equal((await memory.listChats(OTHER)).length, 1);
  });
});

// ---- both flows end to end, with the real database and counters on everything that costs tokens --------------

describe("saved answers save tokens (end to end)", { skip: !process.env.DATABASE_URL && "DATABASE_URL is not set" }, () => {
  const tag = `e2e-${Date.now()}`;
  const customer = `${tag}-customer`;
  const version = "IFS Cloud 25R2";
  const Q = `How do I reopen a closed accounting period for ${tag}?`;
  const ANSWER = "Open the Accounting Periods page and use the Reopen command on the closed period. This is the full answer.";
  let db;
  let api;
  let agent;
  let retrieveCalls = 0; // retrieve() is where the keyword rewrite (a Haiku call) happens
  const headers = { "x-client-id": CLIENT };
  const chat = (body) => call(api.base, "POST", "/api/chat", { body: { customer, ifsVersion: version, language: "en", history: [], ...body } }).then((r) => r.json());
  const feedback = (body) => call(api.base, "POST", "/api/memory/feedback", { headers, body: { customer, ifsVersion: version, language: "en", question: Q, answer: ANSWER, tier: "lite", standalone: true, ...body } });

  before(async () => {
    db = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
    agent = await startAgent(ANSWER);
    api = await startApi({
      n8nChatUrl: agent.url,
      memory: createMemory(db),
      reviewKey: KEY,
      retrieve: async () => (retrieveCalls++, { status: "ok", passages: [] }),
    });
  });
  after(async () => {
    await db.query("DELETE FROM memory_lessons WHERE customer LIKE $1", [`${tag}%`]);
    await db.query("DELETE FROM memory_answers WHERE customer LIKE $1", [`${tag}%`]);
    await db.end();
    await closeAll(api.server, agent.server);
  });

  it("thumbs up: the second consultant gets the saved answer with zero AI calls", async () => {
    const first = await chat({ question: Q });
    assert.equal(first.answer, ANSWER);
    assert.equal(first.cached, undefined, "the first time, the agent answers");
    assert.deepEqual([agent.received.length, retrieveCalls], [1, 1]);

    assert.equal((await feedback({ rating: "up" })).status, 201);

    const eventsBefore = (await db.query("SELECT count(*)::int AS n FROM memory_cache_events WHERE outcome = 'hit'")).rows[0].n;
    const again = await chat({ question: Q });
    assert.equal(again.answer, ANSWER);
    assert.equal(again.cached.match, "exact");
    assert.equal(again.tier, "lite");
    assert.deepEqual([agent.received.length, retrieveCalls], [1, 1], "no agent call and no keyword rewrite for the saved answer");

    const reworded = await chat({ question: `how can i reopen the closed accounting period for ${tag}` });
    assert.equal(reworded.answer, ANSWER);
    assert.deepEqual([agent.received.length, retrieveCalls], [1, 1], "a reworded question is answered from memory too");

    const stats = await (await call(api.base, "GET", "/api/memory/stats?days=1", { headers: { "x-review-key": KEY } })).json();
    assert.ok(stats.hits >= 2 && stats.estimatedTokensSaved >= 2 * 6000, JSON.stringify(stats));
    // the backend writes the log row without waiting for it, so give the database a moment
    let hits = 0;
    for (let i = 0; i < 50 && hits < eventsBefore + 2; i++) {
      hits = (await db.query("SELECT count(*)::int AS n FROM memory_cache_events WHERE outcome = 'hit'")).rows[0].n;
      if (hits < eventsBefore + 2) await new Promise((r) => setTimeout(r, 40));
    }
    assert.ok(hits >= eventsBefore + 2, `hits logged: ${hits}, expected at least ${eventsBefore + 2}`);
  });

  it("calls the agent when the saved answer must not be used", async () => {
    const calls = () => agent.received.length;
    let before = calls();
    await chat({ question: Q, customer: `${customer}-other` });
    assert.equal(calls(), before + 1, "another customer");
    before = calls();
    await chat({ question: Q, ifsVersion: "IFS Apps 10" });
    assert.equal(calls(), before + 1, "another IFS version");
    before = calls();
    await chat({ question: Q, language: "nl" });
    assert.equal(calls(), before + 1, "another language");
    before = calls();
    await chat({ question: Q, history: [{ role: "user", content: "earlier" }, { role: "assistant", content: "reply" }] });
    assert.equal(calls(), before + 1, "a follow-up");
    before = calls();
    await chat({ question: Q, attachments: [{ name: "a.txt", kind: "text", mimeType: "text/plain", data: "x" }] });
    assert.equal(calls(), before + 1, "a question with an attachment");
    before = calls();
    await chat({ question: Q, fresh: true });
    assert.equal(calls(), before + 1, "a consultant asking for a new answer");
    before = calls();
    await chat({ question: `How do I NOT reopen a closed accounting period for ${tag}?` });
    assert.equal(calls(), before + 1, "a question that says the opposite");
  });

  it("thumbs down: stops the saved answer, keeps the note unverified, and tells the agent only as a report", async () => {
    assert.equal((await feedback({ rating: "down", comment: "no" })).status, 400);
    const down = await feedback({ rating: "down", comment: "The Reopen command needs the Period Administrator role, which this answer leaves out." });
    assert.equal(down.status, 201);
    assert.equal((await down.json()).switchedOff, true);

    const before = agent.received.length;
    const next = await chat({ question: Q });
    assert.equal(next.cached, undefined, "the saved answer is not returned after a thumbs down");
    assert.equal(agent.received.length, before + 1);
    const sent = agent.received.at(-1);
    assert.deepEqual(sent.lessons, [], "an unverified note is not a confirmed lesson");
    assert.equal(sent.reports.length, 1);
    assert.match(sent.reports[0].correction, /Period Administrator/);
  });
});
