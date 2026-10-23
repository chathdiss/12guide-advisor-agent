import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { normalizeDesign, parseDesign, reviewDesign } from "../src/review-design.js";

const sample = (name) => JSON.parse(readFileSync(new URL(`../examples/${name}.sample.design.json`, import.meta.url), "utf8"));
const weekly = sample("weekly-cash-report");
const shop = sample("shop-order-report");
const copy = (o) => JSON.parse(JSON.stringify(o));

// a data dictionary that has what the Weekly Cash Report uses
const COLUMNS = {
  IDENTITY_INVOICE_INFO: ["COMPANY", "IDENTITY", "PAY_TERM_ID", "PARTY_TYPE_DB"],
  CUSTOMER_INFO: ["CUSTOMER_ID", "NAME"],
  LEDGER_TRANSACTION_CU_QRY: ["COMPANY", "IDENTITY", "LEDGER_COMPANY", "LEDGER_ITEM_SERIES_ID", "LEDGER_ITEM_ID", "LEDGER_ITEM_VERSION", "PAY_DATE", "PAYMENT_ID", "TRANS_ID", "PAYMENT_TYPE_CODE"],
  INVOICE_LEDGER_ITEM_CU_QRY: ["COMPANY", "IDENTITY", "SERIES_ID", "INVOICE_NO", "LEDGER_ITEM_VERSION", "LEDGER_STATUS_TYPE", "INVOICE_AMOUNT", "INVOICE_DATE", "DUE_DATE", "CURRENCY"],
};
const lookup = async (view) => (COLUMNS[view] ? new Set(COLUMNS[view]) : null);

describe("reading the design that the agent wrote", () => {
  it("reads JSON text, also in a code fence, and an object", () => {
    assert.deepEqual(parseDesign('{"a":1}').design, { a: 1 });
    assert.deepEqual(parseDesign('```json\n{"a":1}\n```').design, { a: 1 });
    assert.deepEqual(parseDesign({ a: 1 }).design, { a: 1 });
  });

  it("says what is wrong when it is empty, not JSON, or not an object", () => {
    assert.match(parseDesign("").error, /empty/);
    assert.match(parseDesign("{ not json").error, /not valid JSON/);
    assert.match(parseDesign("[1,2]").error, /one JSON object/);
  });
});

describe("filling in a design", () => {
  it("adds what the agent may leave out, and keeps what it wrote", () => {
    const { design } = normalizeDesign({ report: { title: "Open orders" }, parameters: [{ name: "Company" }], dataSources: [{ id: "a", sql: "SELECT 1 AS \"X\" FROM dual" }, { id: "b" }] });
    assert.equal(design.designVersion, 1);
    assert.equal(design.spec.title, "Open orders");
    assert.equal(design.spec.customer, "not given");
    assert.deepEqual(design.parameters[0], { name: "Company", label: "Company", type: "string", mandatory: false, default: null, usedAs: "'&Company'" });
    assert.deepEqual(design.dataSources.map((s) => s.status), ["ready", "blocked"]);
    assert.deepEqual(design.validation, { toConfirmOnTheTestEnvironment: [], status: "not run" });
  });

  it("never accepts that the SQL was validated: the status is reset, and a stored dictionary check is dropped", () => {
    const d = copy(weekly);
    d.validation.status = "validated";
    d.validation.offlineChecks = { checked: 999 };
    const { design, notes } = normalizeDesign(d);
    assert.equal(design.validation.status, "not run");
    assert.equal(design.validation.offlineChecks, undefined);
    assert.match(notes[0], /reset/);
  });
});

describe("reviewing a design", () => {
  it("passes the Weekly Cash Report sample, with the review page and the dictionary result", async () => {
    const r = await reviewDesign(weekly, lookup);
    assert.deepEqual(r.errors, []);
    assert.ok(r.ok);
    assert.equal(r.dictionary.unknownColumns.length, 0);
    assert.ok(r.dictionary.checked >= 20);
    assert.match(r.text, /<design_checks ok="true">/);
    assert.match(r.text, /NOT validated: the SQL has not been run on any IFS environment/);
    assert.match(r.reviewPage, /^# Sample Weekly Cash Report/);
    assert.ok(!r.text.includes("# Sample Weekly Cash Report"), "the page is not sent back to the agent");
    assert.match(r.text, /exact text \[\[REVIEW_PAGE\]\] and then \[\[DESIGN_JSON\]\]/);
    assert.match(r.text, /introduction of at most three concise sentences/);
    assert.equal(JSON.parse(r.designJson).validation.status, "not run");
    assert.match(r.review, /Status: \*\*not run\*\*/);
  });

  it("passes the Shop Order Report sample with its blocked sources, and says that they are blocked", async () => {
    // a dictionary that has the views of the shop order sample
    const views = { SHOP_ORD: ["ORDER_NO", "RELEASE_NO", "SEQUENCE_NO", "PART_NO", "CONTRACT", "STATE", "QTY_COMPLETE", "ROUTING_REVISION", "CLOSE_DATE"], WORK_CENTER: ["CONTRACT", "WORK_CENTER_NO", "DESCRIPTION"], COMPANY_SITE: ["CONTRACT", "COMPANY"], PART_COST_BUCKET: ["CONTRACT", "PART_NO", "COST_SET", "COST_BUCKET_ID", "BUCKET_LEVEL_COST"] };
    const r = await reviewDesign(JSON.stringify(shop), async (view) => (views[view] ? new Set(views[view]) : null));
    assert.deepEqual(r.errors, []);
    assert.ok(r.ok);
    assert.ok(r.warnings.some((w) => /gl-labour-postings is blocked/.test(w)));
    assert.match(r.reviewPage, /Blocked by:/);

    // and one that knows none of them: the views are reported as unknown
    const none = await reviewDesign(JSON.stringify(shop), async () => null);
    assert.ok(!none.ok);
    assert.ok(none.errors.some((e) => /The view SHOP_ORD is not in the IFS data dictionary/.test(e)));
  });

  it("reports a column that the dictionary does not have, and asks for a corrected design", async () => {
    const d = copy(weekly);
    d.dataSources[0].sql = d.dataSources[0].sql.replace("li.invoice_amount", "li.full_curr_amount");
    const r = await reviewDesign(d, lookup);
    assert.ok(!r.ok);
    assert.ok(r.errors.some((e) => /column FULL_CURR_AMOUNT does not exist in the view INVOICE_LEDGER_ITEM_CU_QRY/.test(e)));
    assert.match(r.text, /<design_checks ok="false">/);
    assert.match(r.text, /There are errors\. Correct the design/);
  });

  it("rejects a SQL that changes data, and an undeclared parameter", async () => {
    const d = copy(weekly);
    d.dataSources[0].sql = "DELETE FROM customer_info WHERE company = '&Other'";
    const r = await reviewDesign(d, lookup);
    assert.ok(!r.ok);
    assert.ok(r.errors.some((e) => /not read-only|must start with SELECT/.test(e)));
    assert.ok(r.errors.some((e) => /&Other/.test(e)));
  });

  it("says that the views were not checked when the dictionary is not available, and does not fail because of it", async () => {
    const r = await reviewDesign(weekly, async () => {
      throw new Error("relation dictionary_column does not exist");
    });
    assert.ok(r.ok);
    assert.ok(r.warnings.some((w) => /data dictionary is not available/.test(w)));
    assert.match(r.text, /<dictionary_check available="false"\/>/);
    assert.equal(r.design.validation.offlineChecks, undefined);
  });

  it("answers a design that is not JSON with a message the agent can act on, without a review page", async () => {
    const r = await reviewDesign("here is my design: ...", lookup);
    assert.ok(!r.ok);
    assert.match(r.text, /The design could not be read/);
    assert.ok(!r.text.includes("<review_page>"));
  });

  it("checks columns that are written without a table alias, and does not say that nothing was checked is fine", async () => {
    const d = copy(weekly);
    d.dataSources = [{ id: "plain", status: "draft", sql: 'SELECT identity AS "Customer ID", name AS "Customer Name" FROM invoice_ledger_item_cu_qry WHERE company = \'&Company\'' }];
    d.columns = [{ label: "Customer ID" }, { label: "Customer Name" }];
    const r = await reviewDesign(d, async (view) => (view === "INVOICE_LEDGER_ITEM_CU_QRY" ? new Set(COLUMNS.INVOICE_LEDGER_ITEM_CU_QRY.concat(["NAME"])) : null));
    assert.ok(r.dictionary.checked >= 3, "identity, name and company are checked");
    assert.match(r.text, /unknown_columns="0"/);
  });

  it("reports an invented column in a query without table aliases, and sends back the real columns of the view", async () => {
    const d = copy(weekly);
    d.dataSources = [{ id: "plain", status: "draft", sql: 'SELECT identity AS "Customer ID", series_idx AS "Series" FROM invoice_ledger_item_cu_qry WHERE company = \'&Company\'' }];
    d.columns = [{ label: "Customer ID" }, { label: "Series" }];
    const r = await reviewDesign(d, lookup);
    assert.ok(!r.ok);
    assert.ok(r.errors.some((e) => /column SERIES_IDX does not exist in the view INVOICE_LEDGER_ITEM_CU_QRY .*without a table alias/.test(e)));
    assert.match(r.text, /<view_columns view="INVOICE_LEDGER_ITEM_CU_QRY" count="\d+">[^<]*INVOICE_AMOUNT[^<]*<\/view_columns>/);
    assert.match(r.text, /do not search again for them/);
    assert.match(r.reviewPage, /^> \*\*The check found problems/);
  });

  it("asks for alias.column when a column without a table alias could belong to more than one view", async () => {
    const d = copy(weekly);
    d.dataSources = [{ id: "two", status: "draft", sql: 'SELECT identity AS "Customer ID" FROM customer_info c JOIN identity_invoice_info i ON i.identity = c.customer_id WHERE company = \'&Company\'' }];
    d.columns = [{ label: "Customer ID" }];
    const r = await reviewDesign(d, lookup);
    assert.ok(r.errors.some((e) => /The column IDENTITY has no table alias and is in more than one view|The column COMPANY has no table alias/.test(e) || /write alias\.column/.test(e)));
  });

  it("warns when nothing at all could be checked, instead of saying that every column exists", async () => {
    const d = copy(weekly);
    d.dataSources = [{ id: "sub", status: "draft", sql: 'SELECT x.a AS "A" FROM (SELECT 1 AS a FROM dual) x' }];
    d.columns = [{ label: "A" }];
    const r = await reviewDesign(d, async () => null);
    assert.ok(r.warnings.some((w) => /No column of the SQL could be checked/.test(w)) || r.errors.length > 0);
    assert.ok(!/every view and column that could be checked exists/.test(r.text));
  });

  it("turns a default that says none or empty into null, and keeps a real default", () => {
    const { design } = normalizeDesign({ parameters: [{ name: "A", default: "none" }, { name: "B", default: "Empty" }, { name: "C", default: "N/A" }, { name: "D", default: "" }, { name: "E", default: "100" }, { name: "F" }] });
    assert.deepEqual(design.parameters.map((p) => p.default), [null, null, null, null, "100", null]);
  });

  it("is a review of the design only: the sample results are never claimed", async () => {
    const r = await reviewDesign(weekly, lookup);
    const status = r.text.match(/<status>([\s\S]*?)<\/status>/)[1];
    assert.match(status, /NOT validated/);
    assert.match(status, /no sample results/);
    assert.match(r.review, /Status: \*\*not run\*\*/);
    assert.ok(!/Status: \*\*validated/i.test(r.review));
  });
});
