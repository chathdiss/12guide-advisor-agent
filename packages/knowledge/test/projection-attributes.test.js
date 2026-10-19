import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { csvObjects } from "../src/csv.js";
import { buildAttributeCards } from "../src/projection-attributes.js";
import { toCard } from "../src/projection-cards.js";

const P = "CustomerOrderHandling";
const card = toCard({
  chunk_id: `${P}|CustomerOrderSet`,
  chunk_type: "entity_set",
  projection_name: P,
  entity_set: "CustomerOrderSet",
  component: "ORDER",
  ifs_version: "25.2.10.1",
  source_url: "https://docs.example/x",
  title: `${P} / CustomerOrderSet`,
  text: [
    `PROJECTION: ${P}   (component ORDER)`,
    "ENTITY SET: CustomerOrderSet   (entity type: CustomerOrder)",
    `REST endpoint: /main/ifsapplications/projection/v1/${P}.svc/CustomerOrderSet`,
    "Keys: OrderNo",
    "Attributes: OrderNo (string, max 12, key); CustomerNo (string, max 20); (+2 more attributes)",
    "Child data (collections): OrderLinesArray -> CustomerOrderLine",
    "Lookups (field -> referenced entity): CustomerNoRef -> CustOrdCust6; (+1 more)",
  ].join("\n"),
});
const whole = toCard({ chunk_id: "P2|Whole", chunk_type: "entity_set", projection_name: "P2", entity_set: "Whole", text: "ENTITY SET: Whole\nAttributes: A (string); B (number)" });

const header = '"projection_name","entity_set","property","type","format","max_length","is_key","is_navigation","enum_values","description","ifs_version"';
const rows = [
  `"${P}","CustomerOrderSet","luname","string",,"80","False","False",,,"v"`,
  `"${P}","CustomerOrderSet","OrderNo","string",,"12","True","False",,,"v"`,
  `"${P}","CustomerOrderSet","CustomerNo","string",,"20","False","False",,,"v"`,
  `"${P}","CustomerOrderSet","ShipmentType","string",,"4000","False","False",,"Note: The maxLength may be lesser than 4000 depending on the character set","v"`,
  `"${P}","CustomerOrderSet","Objstate","enum:CustomerOrderState",,,"False","False","Planned|Released|Cancelled",,"v"`,
  `"P2","Whole","A","string",,,"False","False",,,"v"`,
  `"Other","Set","X","string",,,"False","False",,,"v"`,
].join("\r\n");
const properties = `﻿${header}\r\n${rows}\r\n`;
const entitySets = csvObjects(
  `"projection_name","entity_set","navigations"\r\n"${P}","CustomerOrderSet","OrderLinesArray -> CustomerOrderLine; CustomerNoRef -> CustOrdCust6; ShipmentTypeRef -> ShipmentType"\r\n`,
);

describe("cards for what the entity set cards of the export leave out", () => {
  const cards = buildAttributeCards([card, whole], properties, entitySets);

  it("makes a card with the attributes that the main card does not show, with type, length and allowed values", () => {
    assert.equal(cards.length, 1);
    const [c] = cards;
    assert.equal(c.chunkId, `${P}|CustomerOrderSet|more`);
    assert.equal(c.chunkType, "entity_set_more");
    assert.equal(c.entitySet, "CustomerOrderSet");
    assert.equal(c.title, `${P} / CustomerOrderSet (more fields)`);
    assert.match(c.text, /^ENTITY SET: CustomerOrderSet {3}\(projection CustomerOrderHandling, component ORDER, IFS 25.2.10.1\) {3}\[more fields\]/);
    assert.match(c.text, /REST endpoint: \/main\/ifsapplications\/projection\/v1\/CustomerOrderHandling.svc\/CustomerOrderSet/);
    assert.match(c.text, /^Keys: OrderNo$/m);
    assert.match(c.text, /Fields \(attributes\), continued: ShipmentType \(string, max 4000\); Objstate \(enum:CustomerOrderState\) values: Planned, Released, Cancelled/);
  });

  it("leaves out the attributes that the main card already shows, the system columns and the note about the maximum length", () => {
    const [c] = cards;
    assert.ok(!/OrderNo \(/.test(c.text.split("Fields (attributes), continued:")[1]));
    assert.ok(!/CustomerNo \(/.test(c.text));
    assert.ok(!/luname/.test(c.text));
    assert.ok(!/Note:/.test(c.text));
  });

  it("adds the lookups that the main card does not show, and no child collection twice", () => {
    const [c] = cards;
    assert.match(c.text, /Lookups \(field -> referenced entity\), continued: ShipmentTypeRef -> ShipmentType/);
    assert.ok(!/OrderLinesArray/.test(c.text));
    assert.ok(!/CustomerNoRef/.test(c.text));
  });

  it("gives the card the link, version and component of the main card, and nothing for a card that was not cut", () => {
    const [c] = cards;
    assert.deepEqual([c.url, c.ifsVersion, c.component, c.projectionName], ["https://docs.example/x", "25.2.10.1", "ORDER", P]);
    assert.ok(!cards.some((x) => x.entitySet === "Whole"));
  });

  it("splits a long list over cards that stay short, each with the heading, and keeps every attribute once", () => {
    const many = Array.from({ length: 200 }, (_, i) => `"${P}","CustomerOrderSet","Field${i}","string",,"20","False","False",,,"v"`).join("\r\n");
    const parts = buildAttributeCards([card], `${header}\r\n${many}\r\n`, [], { maxChars: 1500 });
    assert.ok(parts.length > 2);
    assert.ok(parts.every((p, i) => p.text.length <= 1600 && p.chunkId === `${P}|CustomerOrderSet|more|part${i + 1}` && p.text.startsWith("ENTITY SET: CustomerOrderSet")));
    const names = parts.flatMap((p) => [...p.text.matchAll(/Field(\d+) \(/g)].map((m) => Number(m[1])));
    assert.deepEqual(names, Array.from({ length: 200 }, (_, i) => i));
  });

  it("makes nothing when no card was cut", () => {
    assert.deepEqual(buildAttributeCards([whole], properties, entitySets), []);
  });
});
