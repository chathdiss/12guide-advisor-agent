import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { toCard } from "../src/projection-cards.js";
import { buildOperationCards, entityKeys, overviewOf } from "../src/projection-operations.js";

const P = "CustomerOrderHandling";
const op = (kind, name, bound_to, http_method, path, summary, parameters = "") => ({ projection_name: P, kind, name, bound_to, http_method, path, parameters, summary, ifs_version: "25.2.10.1" });

// rows as they are in operations.csv of the real export
const rows = [
  op("action", "CustomerOrderSet", "", "POST", "/CustomerOrderSet", "Add new entity to CustomerOrderSet", "select-fields"),
  op("function", "CustomerOrderSet", "", "GET", "/CustomerOrderSet", "Get entities from CustomerOrderSet"),
  op("function", "CustomerOrderSet", "", "GET", "/CustomerOrderSet(OrderNo='{OrderNo}')", "Get entity from CustomerOrderSet by key"),
  op("bound_action", "CustomerOrder_ReleaseOrder", "CustomerOrderSet", "POST", "/CustomerOrderSet(OrderNo='{OrderNo}')/IfsApp.CustomerOrderHandling.CustomerOrder_ReleaseOrder", "Invoke action ReleaseOrder"),
  op("bound_action", "CustomerOrder_ReleaseOrder", "CustomerOrderSet", "POST", "/CustomerOrderSet(OrderNo='{OrderNo}')/IfsApp.CustomerOrderHandling.CustomerOrder_ReleaseOrder", "Invoke action ReleaseOrder"),
  op("bound_function", "CustomerOrder_DefaultCopy", "CustomerOrderSet", "GET", "/CustomerOrderSet(OrderNo='{OrderNo}')/IfsApp.CustomerOrderHandling.CustomerOrder_DefaultCopy(CopyValues=@CopyValues)", "Invoke function DefaultCopy"),
  op("navigation", "OrderLinesArray", "CustomerOrderSet", "GET", "/CustomerOrderSet(OrderNo='{OrderNo}')/OrderLinesArray", ""),
  op("navigation", "OrderLinesArray", "CustomerOrderSet", "GET", "/CustomerOrderSet(OrderNo='{OrderNo}')/OrderLinesArray(LineNo='{LineNo}',RelNo='{RelNo}',OrderNo='{OrderNo}')", ""),
  op("navigation", "CurrencyTypeRef", "CustomerOrderSet", "GET", "/CustomerOrderSet(OrderNo='{OrderNo}')/CurrencyTypeRef", ""),
  op("action", "CustomerOrderLineSet", "", "POST", "/CustomerOrderLineSet", "Add new entity to CustomerOrderLineSet", "select-fields"),
  op("bound_action", "CustomerOrderLine_Cancel", "CustomerOrderLineSet", "POST", "/CustomerOrderLineSet(OrderNo='{OrderNo}',LineNo='{LineNo}',RelNo='{RelNo}',LineItemNo={LineItemNo})/IfsApp.CustomerOrderHandling.CustomerOrderLine_Cancel", "Invoke action Cancel"),
  op("action", "ReleaseSourceLine", "", "POST", "/ReleaseSourceLine", "Invoke action ReleaseSourceLine"),
  op("function", "CalculateTotals", "", "GET", "/CalculateTotals", "Invoke function CalculateTotals"),
  op("function", "Reference_OrderQuotationLov", "", "GET", "/Reference_OrderQuotationLov", "Get entities from Reference_OrderQuotationLov"),
  op("function", "Reference_OrderQuotationLov", "", "GET", "/Reference_OrderQuotationLov(QuotationNo='{QuotationNo}')", "Get entity from Reference_OrderQuotationLov by key"),
  { ...op("action", "Other", "", "POST", "/Other", "Invoke action Other"), projection_name: "NotInTheExport" },
];

const overview = toCard({
  chunk_id: `${P}|overview`,
  title: `${P} (overview)`,
  text: `PROJECTION: ${P}   (component ORDER, layer Core)\nPurpose: Use this API to enter, process, and view information on the customer order.\nService root: /main/ifsapplications/projection/v1/${P}.svc\nEntity sets: (none)`,
  source_url: "https://docs.example/api?projection=CustomerOrderHandling",
  ifs_version: "25.2.10.1",
  projection_name: P,
  component: "ORDER",
});
const overviews = new Map([[P, overviewOf(overview)]]);

describe("keys of an entity set", () => {
  it("reads the key names from the path of an operation", () => {
    assert.deepEqual(entityKeys("/CustomerOrderSet(OrderNo='{OrderNo}')/IfsApp.X.Y"), ["OrderNo"]);
    assert.deepEqual(entityKeys("/CustomerOrderLineSet(OrderNo='{OrderNo}',LineNo='{LineNo}',RelNo='{RelNo}',LineItemNo={LineItemNo})"), ["OrderNo", "LineNo", "RelNo", "LineItemNo"]);
    assert.deepEqual(entityKeys("/CustomerOrderSet"), []);
    assert.deepEqual(entityKeys(""), []);
  });

  it("takes the purpose and the service root from an overview card", () => {
    const o = overviewOf(overview);
    assert.match(o.purpose, /^Use this API to enter, process/);
    assert.equal(o.serviceRoot, "/main/ifsapplications/projection/v1/CustomerOrderHandling.svc");
    assert.deepEqual([o.component, o.url], ["ORDER", "https://docs.example/api?projection=CustomerOrderHandling"]);
  });
});

describe("entity set cards from the operations of the export", () => {
  const cards = buildOperationCards(rows, overviews);
  const set = (name) => cards.find((c) => c.entitySet === name);

  it("makes a card per entity set with the create and read calls, the key and the endpoint", () => {
    const c = set("CustomerOrderSet");
    assert.equal(c.chunkId, `${P}|set|CustomerOrderSet`);
    assert.equal(c.chunkType, "entity_set");
    assert.equal(c.title, `${P}: entity set CustomerOrderSet`);
    assert.match(c.text, /^ENTITY SET: CustomerOrderSet {3}\(projection CustomerOrderHandling, component ORDER, IFS 25.2.10.1\)/);
    assert.match(c.text, /Service root: \/main\/ifsapplications\/projection\/v1\/CustomerOrderHandling.svc/);
    assert.match(c.text, /Entity set endpoint: \/main\/ifsapplications\/projection\/v1\/CustomerOrderHandling.svc\/CustomerOrderSet\n/);
    assert.match(c.text, /Create: POST \/CustomerOrderSet {2}\(Add new entity to CustomerOrderSet\)/);
    assert.match(c.text, /Read all: GET \/CustomerOrderSet {2}\(Get entities from CustomerOrderSet\)/);
    assert.match(c.text, /Read one: GET \/CustomerOrderSet\(OrderNo='\{OrderNo\}'\) {2}\(Get entity from CustomerOrderSet by key\)/);
    assert.match(c.text, /^Key: OrderNo$/m);
  });

  it("lists the actions bound to the entity set with their full path, each once, and its functions and navigation properties", () => {
    const c = set("CustomerOrderSet");
    const release = c.text.match(/^Action \(POST\): CustomerOrder_ReleaseOrder: .*$/gm);
    assert.equal(release.length, 1, "a repeated row is written once");
    assert.match(release[0], /\/CustomerOrderSet\(OrderNo='\{OrderNo\}'\)\/IfsApp.CustomerOrderHandling.CustomerOrder_ReleaseOrder {2}\(Invoke action ReleaseOrder\)/);
    assert.match(c.text, /^Function \(GET\): CustomerOrder_DefaultCopy: /m);
    assert.match(c.text, /^Navigation properties \(related data, read with GET after the key\): OrderLinesArray, CurrencyTypeRef$/m);
  });

  it("says that the fields are not part of the export, so that nobody makes them up", () => {
    assert.match(set("CustomerOrderSet").text, /^Fields \(properties\): not part of this export\.$/m);
  });

  it("takes a composite key from the longest key that the paths show", () => {
    assert.match(set("CustomerOrderLineSet").text, /^Key: OrderNo, LineNo, RelNo, LineItemNo$/m);
  });

  it("makes cards for the actions and functions that are not bound to an entity set, and only counts the lookup functions", () => {
    const actions = cards.find((c) => c.chunkType === "projection_actions");
    assert.match(actions.text, /^PROJECTION ACTIONS, not bound to an entity set/);
    assert.match(actions.text, /Action \(POST\): ReleaseSourceLine: \/ReleaseSourceLine/);
    assert.ok(!/Add new entity/.test(actions.text), "the create calls belong to the entity sets");
    const functions = cards.find((c) => c.chunkType === "projection_functions");
    assert.match(functions.text, /Function \(GET\): CalculateTotals: \/CalculateTotals/);
    assert.match(functions.text, /Lookup functions Reference_<Name> \(lists of values\): 2 operations, not listed one by one\./);
    assert.ok(!/Reference_OrderQuotationLov:/.test(functions.text));
    assert.ok(!/CustomerOrderSet: \/CustomerOrderSet/.test(functions.text), "the read calls of an entity set are not projection functions");
  });

  it("gives every card the link of its projection, and skips a projection that is not in the export", () => {
    assert.ok(cards.every((c) => c.url === "https://docs.example/api?projection=CustomerOrderHandling"));
    assert.ok(cards.every((c) => c.projectionName === P && c.ifsVersion === "25.2.10.1" && c.sourceType === "ifs_projection_api"));
    assert.equal(cards.find((c) => /Other/.test(c.text) && c.text.includes("/Other")), undefined);
  });

  it("makes unique ids", () => {
    const ids = cards.map((c) => c.chunkId);
    assert.equal(new Set(ids).size, ids.length);
  });
});

describe("a projection with many operations", () => {
  const many = Array.from({ length: 90 }, (_, i) =>
    op("bound_action", `CustomerOrder_Action${i}`, "CustomerOrderSet", "POST", `/CustomerOrderSet(OrderNo='{OrderNo}')/IfsApp.CustomerOrderHandling.CustomerOrder_Action${i}`, `Invoke action Action${i}`),
  );
  const cards = buildOperationCards(many, overviews, { maxChars: 2000 }).filter((c) => c.entitySet === "CustomerOrderSet");

  it("splits an entity set over several cards that stay short, and each one repeats the heading", () => {
    assert.ok(cards.length > 3);
    assert.ok(cards.every((c) => c.text.length <= 2100), `longest ${Math.max(...cards.map((c) => c.text.length))}`);
    cards.forEach((c, i) => {
      assert.equal(c.chunkId, `${P}|set|CustomerOrderSet|part${i + 1}`);
      assert.equal(c.title, `${P}: entity set CustomerOrderSet (part ${i + 1} of ${cards.length})`);
      assert.match(c.text, /^ENTITY SET: CustomerOrderSet/);
      assert.match(c.text, /Service root: \/main\/ifsapplications/);
    });
  });

  it("keeps every action, once, in the right order", () => {
    const names = cards.flatMap((c) => [...c.text.matchAll(/CustomerOrder_Action(\d+): /g)].map((m) => Number(m[1])));
    assert.deepEqual(names, Array.from({ length: 90 }, (_, i) => i));
  });

  it("cuts a long list of navigation properties between names, not inside a name", () => {
    const navs = Array.from({ length: 200 }, (_, i) => op("navigation", `NavigationProperty${i}Ref`, "CustomerOrderSet", "GET", `/CustomerOrderSet(OrderNo='{OrderNo}')/NavigationProperty${i}Ref`, ""));
    const [first] = buildOperationCards(navs, overviews);
    const line = first.text.match(/^Navigation properties.*$/m)[0];
    assert.match(line, /, and \d+ more$/);
    assert.ok(!/NavigationProperty\d*(?:R|Re)?(?:,|$)/.test(line.replace(/NavigationProperty\d+Ref/g, "")), "no cut name");
  });
});
