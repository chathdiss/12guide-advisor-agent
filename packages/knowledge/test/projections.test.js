import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { csvObjects, parseCsv } from "../src/csv.js";
import { cardToDocument, ORIGIN, readCards, SOURCE_ID, toCard, versionLabel } from "../src/projection-cards.js";
import { sourceWeight } from "../src/search.js";
import { storeCardsBulk } from "../src/store.js";

describe("reading CSV", () => {
  it("reads quoted cells with commas, quotes and line breaks, and a Windows line end", () => {
    const csv = 'chunk_id,title,text\r\nc1,"Customer Order, header","Line one\nLine ""two""\nLine three"\r\nc2,Plain,short\r\n';
    assert.deepEqual(parseCsv(csv), [
      ["chunk_id", "title", "text"],
      ["c1", "Customer Order, header", 'Line one\nLine "two"\nLine three'],
      ["c2", "Plain", "short"],
    ]);
  });

  it("ignores the byte order mark that PowerShell writes, empty lines, and finds a semicolon as separator", () => {
    assert.deepEqual(parseCsv("﻿a;b\n\n1;2\n"), [["a", "b"], ["1", "2"]]);
    assert.deepEqual(parseCsv(""), []);
    assert.deepEqual(parseCsv("a,b\n1,"), [["a", "b"], ["1", ""]]);
  });

  it("returns objects with the header names in lower case", () => {
    assert.deepEqual(csvObjects("Chunk_ID,Title\nc1,T1\nc2,T2\n"), [{ chunk_id: "c1", title: "T1" }, { chunk_id: "c2", title: "T2" }]);
  });
});

describe("projection cards", () => {
  const row = (extra = {}) => ({
    chunk_id: "CustomerOrderHandling/CustomerOrderSet/1",
    title: "CustomerOrderHandling: CustomerOrderSet",
    text: "Endpoint: GET /CustomerOrderHandling.svc/CustomerOrderSet\nKeys: OrderNo",
    source_url: "https://docs.ifs.com/ifsapiexplorer/?projection=CustomerOrderHandling",
    ifs_version: "25.2.10.20260909204054.0",
    source_type: "ifs_projection_api",
    projection_name: "CustomerOrderHandling",
    entity_set: "CustomerOrderSet",
    component: "ORDER",
    ...extra,
  });

  it("turns the first two numbers of the build into the release", () => {
    assert.equal(versionLabel("25.2.10.20260909204054.0"), "IFS Cloud 25R2");
    assert.equal(versionLabel("24.1.3"), "IFS Cloud 24R1");
    assert.equal(versionLabel(""), "IFS Cloud");
    assert.equal(versionLabel("garbage"), "IFS Cloud");
  });

  it("maps a row to a card, takes the field names in any case, and refuses a row without text or id", () => {
    const card = toCard({ CHUNK_ID: " c1 ", Title: "T", TEXT: "body", Source_Url: "https://x" });
    assert.deepEqual([card.chunkId, card.title, card.text, card.url, card.sourceType], ["c1", "T", "body", "https://x", "ifs_projection_api"]);
    assert.equal(toCard({ chunk_id: "c1", text: "" }), null);
    assert.equal(toCard({ text: "body" }), null);
    assert.equal(toCard({ chunk_id: "c1", text: "First line\nsecond" }).title, "First line", "a card without title is named after its first line");
  });

  it("reads chunks.jsonl, skips bad lines and repeated ids (the last one wins)", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cards-"));
    const lines = [JSON.stringify(row()), "not json", JSON.stringify(row({ title: "newer" })), JSON.stringify({ chunk_id: "x" }), JSON.stringify(row({ chunk_id: "c2" }))];
    await writeFile(path.join(dir, "chunks.jsonl"), lines.join("\n"));
    const { cards, skipped, from } = readCards(dir);
    assert.equal(from, "chunks.jsonl");
    assert.equal(cards.length, 2);
    assert.equal(skipped, 3);
    assert.equal(cards.find((c) => c.chunkId.endsWith("/1")).title, "newer");
  });

  it("reads a chunks.jsonl that starts with a byte order mark, as PowerShell writes it, without losing the first card", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cards-"));
    await writeFile(path.join(dir, "chunks.jsonl"), "\uFEFF" + [JSON.stringify(row({ chunk_id: "first" })), JSON.stringify(row({ chunk_id: "second" }))].join("\r\n"));
    const { cards, skipped } = readCards(dir);
    assert.deepEqual(cards.map((c) => c.chunkId), ["first", "second"]);
    assert.equal(skipped, 0);
  });

  it("falls back to chunks.csv, and says so when the folder has neither", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cards-"));
    await writeFile(path.join(dir, "chunks.csv"), 'chunk_id,title,text,source_url\r\nc1,"A, b","Line 1\nLine 2",https://docs.ifs.com/x\r\n');
    const { cards, from } = readCards(dir);
    assert.equal(from, "chunks.csv");
    assert.deepEqual([cards[0].title, cards[0].text, cards[0].url], ["A, b", "Line 1\nLine 2", "https://docs.ifs.com/x"]);
    assert.throws(() => readCards(path.join(dir, "nothing")), /Neither chunks.jsonl nor chunks.csv/);
    const empty = await mkdtemp(path.join(os.tmpdir(), "cards-"));
    await writeFile(path.join(empty, "chunks.csv"), "chunk_id,title\nc1,T\n");
    assert.throws(() => readCards(empty), /no usable cards/);
  });

  it("makes a document of a card: one passage with its own link, the release, and the facts kept for filtering", () => {
    const doc = cardToDocument(toCard(row()));
    assert.equal(doc.source, SOURCE_ID);
    assert.equal(doc.origin, ORIGIN);
    assert.equal(doc.docKey, "ifs-projection-api/CustomerOrderHandling/CustomerOrderSet/1");
    assert.equal(doc.url, "https://docs.ifs.com/ifsapiexplorer/?projection=CustomerOrderHandling");
    assert.equal(doc.version, "IFS Cloud 25R2");
    assert.equal(doc.content, "Endpoint: GET /CustomerOrderHandling.svc/CustomerOrderSet\nKeys: OrderNo");
    assert.match(doc.searchText, /customer order handling/, "the words inside the names are searchable");
    assert.deepEqual([doc.meta.source_type, doc.meta.ifs_version, doc.meta.projection_name, doc.meta.entity_set], ["ifs_projection_api", "25.2.10.20260909204054.0", "CustomerOrderHandling", "CustomerOrderSet"]);
    assert.equal(doc.lines, 2);
    assert.equal(cardToDocument(toCard(row({ source_url: "" }))).url, null);
    assert.equal(cardToDocument(toCard(row()), { label: "IFS Cloud 25R2 SU10" }).version, "IFS Cloud 25R2 SU10");
  });

  it("changes the hash when the text, the title or the link changes, so a repeat run only writes what changed", () => {
    const a = cardToDocument(toCard(row())).meta.hash;
    assert.equal(cardToDocument(toCard(row())).meta.hash, a);
    for (const change of [{ text: "other" }, { title: "other" }, { source_url: "https://other" }]) assert.notEqual(cardToDocument(toCard(row(change))).meta.hash, a);
  });

  it("keeps a card within one passage", () => {
    const doc = cardToDocument(toCard(row({ text: "x\n".repeat(20_000) })));
    assert.ok(doc.content.length <= 16_000);
  });

  it("counts the API cards as neutral, so that they do not fill the results of a question that is not about REST", () => {
    assert.equal(sourceWeight({ origin: ORIGIN }), 0);
    assert.ok(sourceWeight({ origin: "IFS documentation" }) > sourceWeight({ origin: ORIGIN }));
  });
});

describe("storing cards in bulk", () => {
  it("writes the documents and their chunks with three queries, however many cards", async () => {
    const docs = ["a", "b", "c"].map((id) => cardToDocument(toCard({ chunk_id: id, title: `T ${id}`, text: `text of ${id}\nsecond line`, source_url: `https://x/${id}` })));
    const calls = [];
    const client = {
      query: async (sql, params) => {
        calls.push({ sql, params });
        if (sql.includes("INSERT INTO knowledge_documents")) return { rows: params[2].map((doc_key, i) => ({ id: 100 + i, doc_key })) };
        return { rows: [] };
      },
    };
    assert.equal(await storeCardsBulk(client, docs), 3);
    assert.equal(calls.length, 3);
    // the documents
    assert.equal(calls[0].params[0], SOURCE_ID);
    assert.equal(calls[0].params[1], ORIGIN);
    assert.deepEqual(calls[0].params[2], docs.map((d) => d.docKey));
    assert.deepEqual(calls[0].params[4], ["https://x/a", "https://x/b", "https://x/c"]);
    assert.equal(JSON.parse(calls[0].params[7][1]).chunk_id, "b");
    // the old chunks go, then the new ones come in under the ids that were returned
    assert.match(calls[1].sql, /DELETE FROM knowledge_chunks/);
    assert.deepEqual(calls[1].params[0], [100, 101, 102]);
    assert.deepEqual(calls[2].params[0], [100, 101, 102]);
    assert.deepEqual(calls[2].params[1], [0, 0, 0], "chunk index 0");
    assert.deepEqual(calls[2].params[4], docs.map((d) => d.content));
    assert.deepEqual(calls[2].params[3], [2, 2, 2], "the number of lines");
  });

  it("does nothing for an empty list", async () => {
    let asked = 0;
    assert.equal(await storeCardsBulk({ query: async () => (asked++, { rows: [] }) }, []), 0);
    assert.equal(asked, 0);
  });
});

describe("the false 'Entity sets: (none)' line of the export", () => {
  it("is dropped from an overview card, because it is not true and matches the words 'entity set' on every projection", () => {
    const card = toCard({
      chunk_id: "X|overview",
      text: "PROJECTION: X   (component INVENT)\nPurpose: A purpose.\nService root: /main/x.svc\nEntity sets: (none)\nProjection-level actions/functions: A [action, POST]",
    });
    assert.ok(!/Entity sets/.test(card.text));
    assert.match(card.text, /Purpose: A purpose\.\nService root: \/main\/x\.svc\nProjection-level actions\/functions: A/);
  });
});

describe("a long card", () => {
  it("is stored whole, as one chunk, and not cut near 3,000 characters", () => {
    const text = "ENTITY SET: X\n" + "Attributes: " + "Attribute (string, max 5); ".repeat(400) + "\nActions on a record: CustomerOrder_ReleaseOrder";
    const doc = cardToDocument(toCard({ chunk_id: "P|X", title: "P / X", text }));
    assert.ok(text.length > 9000);
    assert.equal(doc.content, text);
    assert.match(doc.searchText, /CustomerOrder_ReleaseOrder/);
  });
});
