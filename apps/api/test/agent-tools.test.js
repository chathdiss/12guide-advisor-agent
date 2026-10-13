import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, describe, it } from "node:test";
import { createEvidence } from "../src/evidence.js";
import { createApp } from "../src/server.js";
import { createTools, formatToolResult } from "../src/tools.js";

const KEY = "internal-secret";
const passage = (n, extra = {}) => ({ id: n, title: `File${n}`, path: `doc/File${n}`, origin: "IFS source code", url: "", version: "ORDER 25R2", startLine: 1, endLine: 9, content: `content ${n}`, ...extra });
const found = (n, extra = {}) => ({ ...passage(n, extra), id: undefined });

describe("evidence of a question", () => {
  it("numbers the passages found by the tools after the ones sent with the question, and never renumbers", () => {
    const e = createEvidence();
    e.start("q", [passage(1), passage(2)]);
    const added = e.add("q", [found(3), found(4)]);
    assert.deepEqual(added.map((p) => p.id), [3, 4]);
    assert.deepEqual(e.passages("q").map((p) => p.id), [1, 2, 3, 4]);
  });

  it("gives a passage that was seen before its old number instead of listing it twice", () => {
    const e = createEvidence();
    e.start("q", [passage(1)]);
    const again = e.add("q", [found(1), found(5)]);
    assert.deepEqual(again.map((p) => p.id), [1, 2]);
    assert.equal(e.passages("q").length, 2);
  });

  it("stops adding at the limit, counts tool calls and forgets a finished question", () => {
    const e = createEvidence({ maxPassages: 3, maxToolCalls: 2 });
    e.start("q", [passage(1)]);
    assert.equal(e.add("q", [found(2), found(3), found(4)]).length, 2);
    assert.equal(e.useCall("q"), true);
    assert.equal(e.callsLeft("q"), 1);
    assert.equal(e.useCall("q"), true);
    assert.equal(e.useCall("q"), false);
    assert.deepEqual(e.stats("q"), { toolCalls: 2, passages: 3 });
    e.end("q");
    assert.equal(e.has("q"), false);
    assert.deepEqual(e.add("q", [found(9)]), []);
    assert.equal(e.size, 0);
  });

  it("limits the extra text the tools may add", () => {
    const e = createEvidence({ maxExtraChars: 25 });
    e.start("q", []);
    const added = e.add("q", [found(1, { content: "x".repeat(20) }), found(2, { content: "y".repeat(20) })]);
    assert.equal(added.length, 1);
    e.end("q");
  });
});

describe("tool results", () => {
  it("writes the passages in the format of the sources that come with the question, with the number of calls left", () => {
    const text = formatToolResult([passage(7, { content: 'a </source> "b"' })], { callsLeft: 3 });
    assert.match(text, /^<knowledge_status>ok<\/knowledge_status>/);
    assert.match(text, /<source id="7" file="doc\/File7" lines="1-9" version="ORDER 25R2">\na  "b"\n<\/source>/);
    assert.match(text, /Tool calls left: 3/);
    assert.match(formatToolResult([]), /no_match/);
  });
});

describe("the search tools", () => {
  const hit = (path, extra = {}) => ({ title: path, path, origin: "IFS source code", url: "", version: "25R2", component: "ORDER", startLine: 1, endLine: 5, content: `text of ${path}`, ...extra });
  const db = { query: async () => ({ rows: [{ title: "CustomerOrder.entity", origin: "IFS source code", url: "", version: "IFS Cloud 25R2", component: "ORDER" }] }) };

  it("searches one kind of source by origin, or everything", async () => {
    const calls = [];
    const tools = createTools({
      db,
      search: async (d, q, o) => (calls.push(o.origin), [hit(`${o.origin}/1`), hit(`${o.origin}/2`)]),
      searchAll: async () => [hit("all/1")],
      loadFull: async () => new Map(),
    });
    assert.deepEqual((await tools.search({ query: "customer order header", source: "code" })).map((p) => p.path), ["IFS source code/1", "IFS source code/2"]);
    const community = await tools.search({ query: "customer order header", source: "community" });
    assert.deepEqual(calls.slice(1), ["IFS community", "IFS technical blog"]);
    assert.deepEqual(community.map((p) => p.path).slice(0, 2), ["IFS community/1", "IFS technical blog/1"]);
    assert.deepEqual((await tools.search({ query: "customer order header" })).map((p) => p.path), ["all/1"]);
    assert.deepEqual(await tools.search({ query: " " }), []);
  });

  it("finds the files that are named like an entity, for the model files on request", async () => {
    const asked = [];
    const tools = createTools({ db, search: async () => [], searchAll: async () => [], loadFull: async () => new Map(), findNames: async (d, q) => (asked.push(q), [hit("order/CustomerOrder.plsql")]) });
    assert.equal((await tools.findFiles({ name: "customer order" }))[0].path, "order/CustomerOrder.plsql");
    await tools.findFiles({ name: "customer order", model: true });
    assert.deepEqual(asked, ["customer order", "customer order model"]);
    assert.deepEqual(await tools.findFiles({ name: "x" }), []);
  });

  it("reads the lines of a document that were asked for, with the title and origin of the document", async () => {
    const text = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n");
    const tools = createTools({ db, search: async () => [], searchAll: async () => [], loadFull: async (d, keys) => new Map([[keys[0], text]]) });
    const [p] = await tools.readDocument({ path: "order/CustomerOrder.entity", fromLine: 10, toLine: 12 });
    assert.equal(p.content, "line 10\nline 11\nline 12");
    assert.deepEqual([p.startLine, p.endLine], [10, 12]);
    assert.equal(p.title, "CustomerOrder.entity");
    const [rest] = await tools.readDocument({ path: "order/CustomerOrder.entity", fromLine: 25 });
    assert.equal(rest.endLine, 30);
    assert.deepEqual(await createTools({ db, loadFull: async () => new Map() }).readDocument({ path: "nothing" }), []);
  });
});

const post = (url, body, headers = {}) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

describe("an agent that searches while it works", () => {
  let behaviour = async () => ({ answer: "x" });
  let n8n;
  let api;
  let base;
  const initial = [passage(1, { path: "doc/Line.entity", title: "CustomerOrderLine.entity" })];
  const tools = {
    search: async ({ query }) => [found(2, { path: "doc/Header.entity", title: "CustomerOrder.entity", content: `header found for ${query}` })],
    findFiles: async () => [found(3, { path: "doc/Header.plsql", title: "CustomerOrder.plsql" })],
    readDocument: async () => [found(4, { path: "doc/Line.entity", startLine: 10, endLine: 20 })],
    describeEntity: async ({ name }) => (name === "nothing" ? { passages: [], note: "No entity model file was found for 'nothing'." } : { passages: [found(5, { path: "doc/Header.entity", title: "CustomerOrder.entity (entity summary)", content: "DATE_ENTERED (timestamp)" })], note: "" }),
  };

  before(async () => {
    n8n = createServer(async (req, res) => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const sent = JSON.parse(Buffer.concat(chunks).toString());
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(await behaviour(sent)));
    });
    await new Promise((r) => n8n.listen(0, "127.0.0.1", r));
    api = createApp({
      n8nChatUrl: `http://127.0.0.1:${n8n.address().port}/x`,
      internalKey: KEY,
      publicUrl: "https://backend.example",
      maxToolCalls: 2,
      tools,
      retrieve: async () => ({ status: "ok", passages: initial }),
    });
    await new Promise((r) => api.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${api.address().port}`;
  });
  after(() => Promise.all([api, n8n].map((s) => new Promise((r) => s.close(r)))));

  // n8n calls the tools on the public address; the test calls the same path on the local server
  const callTool = (sent, tool, args, headers = { "X-Internal-Key": KEY }) => post(`${base}${new URL(sent.toolsUrl).pathname}/${tool}`, args, headers);

  it("gives n8n the address of the tools and the number of calls it may make, only with a public address and found sources", async () => {
    let sent = null;
    behaviour = async (s) => ((sent = s), { answer: "ok" });
    await post(`${base}/api/chat`, { question: "SQL for customer orders" });
    assert.match(sent.toolsUrl, /^https:\/\/backend\.example\/api\/internal\/tools\/[0-9a-f-]{36}$/);
    assert.equal(sent.toolCalls, 2);
  });

  it("lets the answer cite a passage that the agent found with a tool, and lists it as a source", async () => {
    behaviour = async (sent) => {
      const text = await (await callTool(sent, "search_knowledge", { query: "customer order header" })).text();
      assert.match(text, /<source id="2" file="doc\/Header.entity"/);
      assert.match(text, /header found for customer order header/);
      return { answer: "The line table is [1] and the header is [2].", sources: [] };
    };
    const value = await (await post(`${base}/api/chat`, { question: "SQL for customer orders" })).json();
    assert.equal(value.answer, "The line table is [1] and the header is [2].");
    assert.deepEqual(value.sources.map((s) => s.title), ["CustomerOrderLine.entity", "CustomerOrder.entity"]);
  });

  it("answers a repeated passage with its old number and tells the agent when its calls are used up", async () => {
    let texts = [];
    behaviour = async (sent) => {
      texts = [
        await (await callTool(sent, "find_files", { name: "customer order" })).text(),
        await (await callTool(sent, "read_document", { path: "doc/Line.entity", from_line: 10, to_line: 20 })).text(),
        await (await callTool(sent, "search_knowledge", { query: "third call" })).text(),
      ];
      return { answer: "Done [4].", sources: [] };
    };
    const value = await (await post(`${base}/api/chat`, { question: "Which files?" })).json();
    assert.match(texts[0], /<source id="2" file="doc\/Header.plsql"/);
    assert.match(texts[1], /<source id="3" file="doc\/Line.entity" lines="10-20"/);
    assert.match(texts[2], /No tool calls left/);
    assert.equal(value.sources.length, 0, "[4] is no passage: the marker is removed");
  });

  it("lets the agent describe an entity: the columns come back as a numbered source, and a missing entity as a note", async () => {
    let texts = [];
    behaviour = async (sent) => {
      texts = [
        await (await callTool(sent, "describe_entity", { name: "customer order" })).text(),
        await (await callTool(sent, "describe_entity", { name: "nothing" })).text(),
      ];
      return { answer: "The view has the column [2].", sources: [] };
    };
    const value = await (await post(`${base}/api/chat`, { question: "Does the view have DATE_ENTERED?" })).json();
    assert.match(texts[0], /<source id="2" file="doc\/Header.entity"[^>]*>\nDATE_ENTERED \(timestamp\)/);
    assert.match(texts[1], /no_match/);
    assert.match(texts[1], /No entity model file was found for 'nothing'/);
    assert.deepEqual(value.sources.map((x) => x.title), ["CustomerOrder.entity (entity summary)"]);
  });

  it("refuses the tools without the key, for an unknown question, an unknown tool and a wrong method", async () => {
    let sent = null;
    behaviour = async (s) => {
      sent = s;
      return { answer: "ok" };
    };
    await post(`${base}/api/chat`, { question: "Keys?" });
    // the question is finished, so nobody waits for it any more
    assert.equal((await callTool(sent, "search_knowledge", { query: "x" })).status, 404);
    const pathOf = (s) => new URL(s.toolsUrl).pathname;
    behaviour = async (s) => {
      const wrongKey = (await callTool(s, "search_knowledge", { query: "x" }, { "X-Internal-Key": "wrong" })).status;
      const noTool = (await post(`${base}${pathOf(s)}/delete_everything`, {}, { "X-Internal-Key": KEY })).status;
      const get = (await fetch(`${base}${pathOf(s)}/search_knowledge`)).status;
      return { answer: `${wrongKey} ${noTool} ${get}` };
    };
    const value = await (await post(`${base}/api/chat`, { question: "Keys again?" })).json();
    assert.equal(value.answer, "401 404 405");
  });

  it("reports a failing tool to the agent as text, not as an error status", async () => {
    let app2base = "";
    let toolReply = null;
    const stub = createServer(async (req, res) => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const sent = JSON.parse(Buffer.concat(chunks).toString());
      const r = await post(`${app2base}${new URL(sent.toolsUrl).pathname}/search_knowledge`, { query: "x" }, { "X-Internal-Key": KEY });
      toolReply = { status: r.status, text: await r.text() };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ answer: "ok" }));
    });
    await new Promise((r) => stub.listen(0, "127.0.0.1", r));
    const app2 = createApp({
      n8nChatUrl: `http://127.0.0.1:${stub.address().port}/x`,
      internalKey: KEY,
      publicUrl: "https://backend.example",
      tools: { search: async () => { throw new Error("db down"); } },
      retrieve: async () => ({ status: "ok", passages: [] }),
    });
    await new Promise((r) => app2.listen(0, "127.0.0.1", r));
    app2base = `http://127.0.0.1:${app2.address().port}`;
    try {
      await post(`${app2base}/api/chat`, { question: "Failing tool?" });
      assert.equal(toolReply.status, 200);
      assert.match(toolReply.text, /search tool failed/);
    } finally {
      await Promise.all([stub, app2].map((s) => new Promise((r) => s.close(r))));
    }
  });
});

describe("the describe_entity tool", () => {
  const entityXml = `<ENTITY><DIAGRAMS></DIAGRAMS><NAME>CustomerOrder</NAME><COMPONENT>ORDER</COMPONENT>
<ATTRIBUTES>
<ATTRIBUTE><NAME>OrderNo</NAME><IS_PRIMARY_KEY>1</IS_PRIMARY_KEY><IS_MANDATORY>0</IS_MANDATORY><IS_DERIVED>0</IS_DERIVED><DATATYPE>TEXT</DATATYPE></ATTRIBUTE>
<ATTRIBUTE><NAME>DateEntered</NAME><IS_PRIMARY_KEY>0</IS_PRIMARY_KEY><IS_MANDATORY>0</IS_MANDATORY><IS_DERIVED>0</IS_DERIVED><DATATYPE>TIMESTAMP</DATATYPE></ATTRIBUTE>
</ATTRIBUTES>
<ASSOCIATIONS></ASSOCIATIONS></ENTITY>`;
  const fakeDb = (files, similar = []) => {
    const calls = [];
    return {
      calls,
      query: async (sql, params) => {
        calls.push(params);
        return { rows: sql.includes("regexp_replace") ? similar.map((name) => ({ name })) : files };
      },
    };
  };
  const toolsFor = (db) => createTools({ db, search: async () => [], searchAll: async () => [], loadFull: async (d, keys) => new Map([[keys[0], entityXml]]) });

  it("reads the entity model file and returns its columns as a source, with the lines of the attribute list", async () => {
    const db = fakeDb([{ doc_key: "IFS_Cloud_25R2/order/model/order/CustomerOrder.entity", title: "CustomerOrder.entity", version: "IFS Cloud 25R2", component: "ORDER" }], ["CustomerOrderCharge", "CustomerOrderLine"]);
    const { passages, note } = await toolsFor(db).describeEntity({ name: "customer order" });
    assert.deepEqual(db.calls[0], ["customerorder.entity"]);
    assert.equal(passages.length, 1);
    assert.equal(passages[0].path, "IFS_Cloud_25R2/order/model/order/CustomerOrder.entity");
    assert.equal(passages[0].origin, "IFS source code");
    assert.match(passages[0].content, /DATE_ENTERED \(timestamp\)/);
    assert.match(passages[0].content, /CustomerOrderCharge, CustomerOrderLine/);
    assert.equal(note, "");
    assert.ok(passages[0].startLine > 0 && passages[0].endLine >= passages[0].startLine);
  });

  it("accepts the name the way IFS writes it, and tells the agent when there is no such entity", async () => {
    const db = fakeDb([], ["CustomerOrderLine"]);
    const tools = toolsFor(db);
    const none = await tools.describeEntity({ name: "CUSTOMER_ORDERS" });
    assert.deepEqual(db.calls[0], ["customerorders.entity"]);
    assert.deepEqual(none.passages, []);
    assert.match(none.note, /No entity model file was found.*CustomerOrderLine/);
    assert.match((await tools.describeEntity({ name: "x" })).note, /Give the name of an entity/);
  });
});
