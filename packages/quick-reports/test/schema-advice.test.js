// The schema owner in front of a view: IFS documents that the database objects of a SQL quick report are written as IFSAPP.CUSTOMER_INFO, because it is
// how IFS grants the permissions of the report. The data dictionary has the view without the owner.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { checkAgainstDictionary, tableReferences } from "../src/dictionary-check.js";
import { normalizeDesign, reviewDesign } from "../src/review-design.js";

const weekly = JSON.parse(readFileSync(new URL("../examples/weekly-cash-report.sample.design.json", import.meta.url), "utf8"));
const copy = (o) => JSON.parse(JSON.stringify(o));
const COLUMNS = {
  IDENTITY_INVOICE_INFO: ["COMPANY", "IDENTITY", "PAY_TERM_ID", "PARTY_TYPE_DB"],
  CUSTOMER_INFO: ["CUSTOMER_ID", "NAME"],
  LEDGER_TRANSACTION_CU_QRY: ["COMPANY", "IDENTITY", "LEDGER_COMPANY", "LEDGER_ITEM_SERIES_ID", "LEDGER_ITEM_ID", "LEDGER_ITEM_VERSION", "PAY_DATE", "PAYMENT_ID", "TRANS_ID", "PAYMENT_TYPE_CODE"],
  INVOICE_LEDGER_ITEM_CU_QRY: ["COMPANY", "IDENTITY", "SERIES_ID", "INVOICE_NO", "LEDGER_ITEM_VERSION", "LEDGER_STATUS_TYPE", "INVOICE_AMOUNT", "INVOICE_DATE", "DUE_DATE", "CURRENCY"],
};
const lookup = async (view) => (COLUMNS[view] ? new Set(COLUMNS[view]) : null);

// the same SQL with the owner in front of every view of FROM and JOIN
const prefixed = (sql) => sql.replace(/\b(FROM|JOIN)\s+(?=[a-z_])/gi, "$1 IFSAPP.");

describe("reading a view with the owner in front of it", () => {
  it("takes the owner apart from the view and the alias", () => {
    assert.deepEqual(tableReferences("SELECT c.name FROM IFSAPP.CUSTOMER_INFO c JOIN IFSAPP.IDENTITY_INVOICE_INFO AS ii ON ii.identity = c.customer_id"), [
      { view: "CUSTOMER_INFO", alias: "C", owner: "IFSAPP" },
      { view: "IDENTITY_INVOICE_INFO", alias: "II", owner: "IFSAPP" },
    ]);
    assert.deepEqual(tableReferences("SELECT name FROM customer_info"), [{ view: "CUSTOMER_INFO", alias: "CUSTOMER_INFO", owner: null }]);
    assert.deepEqual(tableReferences("select 1 from ifsapp . customer_info"), [{ view: "CUSTOMER_INFO", alias: "CUSTOMER_INFO", owner: "IFSAPP" }]);
  });

  it("checks the columns the same way with and without the owner, and does not take the owner for a view", async () => {
    const sql = "SELECT c.customer_id, c.name FROM CUSTOMER_INFO c WHERE c.customer_id = '&Id'";
    const plain = await checkAgainstDictionary(sql, lookup);
    const owned = await checkAgainstDictionary(prefixed(sql), lookup);
    assert.deepEqual(owned.views, ["CUSTOMER_INFO"]);
    assert.deepEqual(owned.unknownViews, []);
    assert.equal(owned.checked, plain.checked);
    assert.equal(owned.skipped, plain.skipped);
    assert.equal(owned.ok, true);
  });

  it("still finds a column that does not exist, and a view that does not exist, behind the owner", async () => {
    const bad = await checkAgainstDictionary("SELECT c.no_such FROM IFSAPP.CUSTOMER_INFO c", lookup);
    assert.deepEqual(bad.unknownColumns.map((c) => c.column), ["NO_SUCH"]);
    const noView = await checkAgainstDictionary("SELECT x.a FROM IFSAPP.NO_SUCH_VIEW x", lookup);
    assert.deepEqual(noView.unknownViews, ["NO_SUCH_VIEW"]);
  });

  it("does not take a call of an API behind the owner for a column", async () => {
    const r = await checkAgainstDictionary("SELECT IFSAPP.Customer_Info_API.Get_Name(c.customer_id) AS n FROM IFSAPP.CUSTOMER_INFO c", lookup);
    assert.deepEqual(r.unknownColumns, []);
    assert.equal(r.ok, true);
  });

  it("says which views have no owner", async () => {
    assert.deepEqual((await checkAgainstDictionary("SELECT c.name FROM CUSTOMER_INFO c", lookup)).unprefixed, ["CUSTOMER_INFO"]);
    assert.deepEqual((await checkAgainstDictionary("SELECT c.name FROM IFSAPP.CUSTOMER_INFO c", lookup)).unprefixed, []);
  });
});

describe("the review of a design and the owner", () => {
  const withSql = (sql) => {
    const d = copy(weekly);
    d.dataSources[0].sql = sql(d.dataSources[0].sql);
    return d;
  };

  it("warns about a view without the owner, with what IFS documents, and still passes the design", async () => {
    const r = await reviewDesign(JSON.stringify(weekly), lookup);
    assert.equal(r.ok, true);
    assert.match(r.text, /WARNING Data source latest-paid-invoice-per-customer: write .*IDENTITY_INVOICE_INFO.* with the schema owner in front, as IFS documents for SQL quick reports \(IFSAPP\./);
  });

  it("gives no such warning when every view has the owner, and checks as many columns as before", async () => {
    const plain = await reviewDesign(JSON.stringify(weekly), lookup);
    const owned = await reviewDesign(JSON.stringify(withSql(prefixed)), lookup);
    assert.ok(!/schema owner in front/.test(owned.text));
    assert.equal(owned.dictionary.checked, plain.dictionary.checked);
    assert.equal(owned.dictionary.unknownViews.length, 0);
    assert.equal(owned.dictionary.unknownColumns.length, 0);
    assert.equal(owned.ok, true);
    assert.match(owned.reviewPage, /Status: \*\*not run\*\*/);
  });

  it("keeps an assumption that mentions the owner: it is not removed any more", () => {
    const design = copy(weekly);
    design.dataSources[0].assumptions.push("The views are written with the schema owner IFSAPP in front of them.");
    const { design: out, notes } = normalizeDesign(design);
    assert.ok(out.dataSources[0].assumptions.includes("The views are written with the schema owner IFSAPP in front of them."));
    assert.deepEqual(notes, []);
  });
});
