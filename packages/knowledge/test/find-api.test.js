import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findApiCards } from "../src/find-api.js";

// a fake database: the first query finds the cards by name, the second ranks their chunks
function fakeDb({ docs = [], chunks = [] } = {}) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      return { rows: sql.includes("FROM knowledge_documents d\n") || sql.includes("lower(d.meta->>'entity_set') AS entity_set") ? docs : chunks };
    },
  };
}
const doc = (id, entity_set, projection) => ({ id, entity_set: entity_set.toLowerCase(), projection: projection.toLowerCase() });
const chunk = (id, title, rank = 1) => ({ id, content: `text of ${title}`, start_line: 1, end_line: 3, title, doc_key: `ifs-projection-api/${title}`, origin: "IFS API documentation", url: `https://x/${title}`, version: "IFS Cloud 25R2", component: "ORDER", rank });

describe("finding the API cards that are named like the question", () => {
  it("looks for the entity set and the projection that the words of the question name", async () => {
    const db = fakeDb({ docs: [doc(1, "CustomerOrderSet", "CustomerOrderHandling")], chunks: [chunk(10, "CustomerOrderSet part 1")] });
    await findApiCards(db, "How do I create a customer order through REST?");
    const [byName] = db.calls;
    assert.ok(byName.params[1].includes("customerorderset"), "customer order -> CustomerOrderSet");
    assert.ok(byName.params[2].includes("customerorderhandling"), "customer order -> CustomerOrderHandling");
    assert.equal(byName.params[0], "IFS API documentation");
  });

  it("uses the entity set that has the name of the question instead of every card of its projection", async () => {
    const db = fakeDb({
      docs: [doc(1, "CustomerOrderSet", "CustomerOrderHandling"), doc(2, "", "CustomerOrderHandling"), doc(3, "CustomerOrderLineSet", "CustomerOrderHandling")],
      chunks: [chunk(10, "CustomerOrderSet part 1")],
    });
    await findApiCards(db, "Which action releases a customer order?");
    assert.deepEqual(db.calls[1].params[0], [1], "only the cards of CustomerOrderSet are ranked");
    assert.match(db.calls[1].params[1], /release/, "the other words choose between the parts of the entity set");
  });

  it("falls back to the cards of the projection when no entity set has the name", async () => {
    const db = fakeDb({ docs: [doc(2, "", "CustomerOrderHandling"), doc(5, "", "CustomerOrderHandling")], chunks: [chunk(20, "CustomerOrderHandling actions")] });
    await findApiCards(db, "customer order release");
    assert.deepEqual(db.calls[1].params[0], [2, 5]);
  });

  it("takes the most specific name: 'customer order line' wins over 'customer order'", async () => {
    const db = fakeDb({ docs: [doc(1, "CustomerOrderSet", "CustomerOrderHandling"), doc(3, "CustomerOrderLineSet", "CustomerOrderHandling")], chunks: [chunk(30, "CustomerOrderLineSet part 1")] });
    await findApiCards(db, "How do I get a customer order line through the REST API?");
    assert.deepEqual(db.calls[1].params[0], [3]);
  });

  it("returns the cards in the shape of the search, best first and no more than the limit", async () => {
    const db = fakeDb({ docs: [doc(1, "CustomerOrderSet", "CustomerOrderHandling")], chunks: [1, 2, 3, 4, 5].map((n) => chunk(n, `part ${n}`, 6 - n)) });
    const out = await findApiCards(db, "customer order actions", { limit: 3 });
    assert.equal(out.length, 3);
    assert.deepEqual(out.map((c) => c.title), ["part 1", "part 2", "part 3"]);
    assert.deepEqual([out[0].origin, out[0].url, out[0].version, out[0].startLine, out[0].coverage], ["IFS API documentation", "https://x/part 1", "IFS Cloud 25R2", 1, 1]);
    assert.ok(out[0].score > 50 && out[0].ref.length === 8);
  });

  it("returns nothing, and asks no second question, when no card has the name", async () => {
    const db = fakeDb({ docs: [], chunks: [chunk(1, "never")] });
    assert.deepEqual(await findApiCards(db, "How do I make coffee through REST?"), []);
    assert.equal(db.calls.length, 1);
    const none = fakeDb();
    assert.deepEqual(await findApiCards(none, "ok"), []);
    assert.equal(none.calls.length, 0, "no name, no query");
  });
});

describe("a question about the fields", () => {
  const main = { ...chunk(10, "CustomerOrderHandling / CustomerOrderSet"), chunk_type: "entity_set", projection: "CustomerOrderHandling", entity_set: "CustomerOrderSet" };
  const more = (n) => ({ ...chunk(100 + n, `CustomerOrderHandling / CustomerOrderSet (more fields, part ${n} of 2)`, 0), chunk_type: "entity_set_more" });
  const db = (asked) => ({
    query: async (sql, params) => {
      if (sql.includes("entity_set_more")) return asked.push(params), { rows: [more(1), more(2)] };
      if (sql.includes("lower(d.meta->>'entity_set') AS entity_set")) return { rows: [doc(1, "CustomerOrderSet", "CustomerOrderHandling")] };
      return { rows: [main, chunk(11, "Other / CustomerOrderSet"), chunk(12, "Third / CustomerOrderSet")] };
    },
  });

  it("adds the cards with the rest of the fields after the entity set card", async () => {
    const asked = [];
    const out = await findApiCards(db(asked), "What fields does the customer order entity set have?");
    assert.deepEqual(asked, [["IFS API documentation", "CustomerOrderHandling", "CustomerOrderSet"]]);
    assert.deepEqual(out.map((c) => c.title).slice(0, 3), ["CustomerOrderHandling / CustomerOrderSet", "CustomerOrderHandling / CustomerOrderSet (more fields, part 1 of 2)", "CustomerOrderHandling / CustomerOrderSet (more fields, part 2 of 2)"]);
    assert.equal(out.length, 4, "the limit, or the entity set card and all its more-fields cards if that is more");
  });

  it("does not look for them when the question is not about the fields", async () => {
    const asked = [];
    const out = await findApiCards(db(asked), "How do I create a customer order through REST?");
    assert.deepEqual(asked, []);
    assert.equal(out.length, 3);
  });
});
