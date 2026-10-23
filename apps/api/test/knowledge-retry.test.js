// A search that fails because the database connection was lost is tried once more; a search that was cut off for taking too long is not.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRetriever } from "../src/knowledge.js";

const found = [{ title: "A", path: "a/A", origin: "IFS source code", url: null, component: "ACCRUL", version: "UPD29", startLine: 1, endLine: 5, content: "x" }];

// a search that fails with the given errors, one for each call, and then works
const searching = (...errors) => {
  const calls = { n: 0 };
  return { calls, search: async () => (calls.n++ < errors.length ? Promise.reject(new Error(errors[calls.n - 1])) : found) };
};
const quietly = async (fn) => {
  const original = console.error;
  const lines = [];
  console.error = (line) => lines.push(String(line));
  try {
    return { result: await fn(), lines };
  } finally {
    console.error = original;
  }
};

describe("the search of the knowledge base after a lost connection", () => {
  for (const message of ["Connection terminated unexpectedly", "read ECONNRESET", "timeout exceeded when trying to connect", "Connection refused", "server closed the connection unexpectedly"]) {
    it(`tries once more after: ${message}`, async () => {
      const s = searching(message);
      const { result, lines } = await quietly(() => createRetriever({ db: {}, search: s.search, retryDelayMs: 0 })("customer order fields", []));
      assert.equal(result.status, "ok");
      assert.equal(result.passages.length, 1);
      assert.equal(s.calls.n, 2);
      assert.deepEqual(lines, [], "a search that worked the second time is not an error");
    });
  }

  it("gives up after that one more try, says why in the log, and answers that the sources are unavailable", async () => {
    const s = searching("Connection terminated unexpectedly", "Connection terminated unexpectedly");
    const { result, lines } = await quietly(() => createRetriever({ db: {}, search: s.search, retryDelayMs: 0 })("customer order fields", []));
    assert.deepEqual(result, { status: "unavailable", passages: [] });
    assert.equal(s.calls.n, 2, "not a third time");
    assert.equal(lines.length, 1);
    assert.match(lines[0], /"knowledge":"unavailable".*Connection terminated unexpectedly/);
  });

  it("does not try again after a search that took too long, or any other error: that would only take as long again", async () => {
    for (const message of ["canceling statement due to statement timeout", "relation does not exist", "syntax error in tsquery"]) {
      const s = searching(message);
      const { result } = await quietly(() => createRetriever({ db: {}, search: s.search, retryDelayMs: 0 })("customer order fields", []));
      assert.equal(result.status, "unavailable", message);
      assert.equal(s.calls.n, 1, message);
    }
  });

  it("waits before it tries again, so that a new connection can be made", async () => {
    const s = searching("Connection terminated unexpectedly");
    const started = Date.now();
    await quietly(() => createRetriever({ db: {}, search: s.search, retryDelayMs: 80 })("customer order fields", []));
    assert.ok(Date.now() - started >= 70);
  });

  it("does nothing different when the search works at once", async () => {
    const s = searching();
    const { result } = await quietly(() => createRetriever({ db: {}, search: s.search })("customer order fields", []));
    assert.equal(result.status, "ok");
    assert.equal(s.calls.n, 1);
  });
});
