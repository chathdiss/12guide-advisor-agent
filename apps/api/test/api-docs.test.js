import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { API_ORIGIN, asksAboutApi } from "../src/api-docs.js";
import { searchBoth } from "../src/knowledge.js";
import { createTools } from "../src/tools.js";

describe("questions about the IFS REST API", () => {
  it("recognises the questions of the projection export, and leaves other questions alone", () => {
    assert.ok(asksAboutApi("How do I create a customer order through REST?"));
    assert.ok(asksAboutApi("Which action releases a customer order?"));
    assert.ok(asksAboutApi("What fields does the customer order entity set have?"));
    assert.ok(asksAboutApi("Which OData endpoint returns the customer orders?"));
    assert.ok(asksAboutApi("What does the request body of the POST look like in JSON?"));
    assert.ok(asksAboutApi("Use $filter and $expand on the projection"));
    assert.ok(!asksAboutApi("How do I configure a project budget in IFS Cloud?"));
    assert.ok(!asksAboutApi("What does the error ORA-20110 mean?"));
    assert.ok(!asksAboutApi("Give me a SQL query for the Lobby with all customer orders of this week"));
    assert.ok(!asksAboutApi(""));
    assert.ok(!asksAboutApi(undefined));
  });

  const r = (ref) => ({ ref, path: ref, startLine: 1, content: ref });
  const search = async (db, q, o) => (o.origin === API_ORIGIN ? [r("api1"), r("api2")] : [r("e1"), r("e2"), r("e3")]);

  it("searches the API cards alone for such a question and puts them first, before the general results", async () => {
    const calls = [];
    const spy = async (db, q, o) => (calls.push(o.origin ?? "all"), search(db, q, o));
    const out = await searchBoth(spy, {}, "How do I create a customer order through REST?", 12, null);
    assert.ok(calls.includes(API_ORIGIN));
    assert.deepEqual(out.map((x) => x.ref).slice(0, 4), ["api1", "e1", "api2", "e2"], "the API cards lead, the general results follow in turn");
    assert.ok(out.some((x) => x.ref === "e3"));
  });

  it("does not search the API cards for a question that is not about the API", async () => {
    const calls = [];
    const spy = async (db, q, o) => (calls.push(o.origin ?? "all"), search(db, q, o));
    const out = await searchBoth(spy, {}, "How do I configure a project budget in IFS Cloud?", 12, null);
    assert.ok(!calls.includes(API_ORIGIN));
    assert.ok(!out.some((x) => x.ref.startsWith("api")));
  });
});

describe("the agent's search tool and the API cards", () => {
  it("searches the API cards alone with source=api", async () => {
    const origins = [];
    const tools = createTools({
      db: {},
      search: async (db, q, o) => (origins.push(o.origin), [{ title: "CustomerOrderHandling", path: "ifs-projection-api/1", origin: API_ORIGIN, url: "", version: "IFS Cloud 25R2", component: "ORDER", startLine: 1, endLine: 3, content: "Endpoint: GET /CustomerOrderSet" }]),
      searchAll: async () => [],
      loadFull: async () => new Map(),
    });
    const passages = await tools.search({ query: "customer order entity set fields", source: "api" });
    assert.deepEqual(origins, [API_ORIGIN]);
    assert.equal(passages.length, 1);
    assert.match(passages[0].content, /CustomerOrderSet/);
  });

  it("gives a card its own link as the source", async () => {
    const card = { title: "CustomerOrderHandling: CustomerOrderSet", path: "ifs-projection-api/c1", origin: API_ORIGIN, url: "https://docs.ifs.com/ifsapiexplorer/x", version: "IFS Cloud 25R2", component: "ORDER", startLine: 1, endLine: 2, content: "Endpoint: GET /CustomerOrderSet" };
    const tools = createTools({ db: {}, search: async () => [card], searchAll: async () => [], loadFull: async (db, keys) => new Map(keys.map((k) => [k, "Endpoint: GET /CustomerOrderSet\nKeys: OrderNo"])) });
    const [p] = await tools.search({ query: "customer order", source: "api" });
    assert.equal(p.url, "https://docs.ifs.com/ifsapiexplorer/x");
    assert.equal(p.origin, API_ORIGIN);
    assert.match(p.content, /Keys: OrderNo/);
  });
});
