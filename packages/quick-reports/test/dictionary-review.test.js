import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { checkAgainstDictionary, tableReferences } from "../src/dictionary-check.js";
import { reviewMarkdown } from "../src/review.js";

const real = JSON.parse(readFileSync(new URL("../examples/weekly-cash-report.sample.design.json", import.meta.url), "utf8"));

// a small dictionary: view -> columns
const DICTIONARY = {
  CUSTOMER_INFO: ["CUSTOMER_ID", "NAME"],
  IDENTITY_INVOICE_INFO: ["COMPANY", "IDENTITY", "PAY_TERM_ID", "PARTY_TYPE_DB"],
};
const lookup = async (view) => (DICTIONARY[view] ? new Set(DICTIONARY[view]) : null);

describe("the views and aliases of a SQL", () => {
  it("reads FROM and JOIN with and without AS, and ignores a keyword that follows a view", () => {
    assert.deepEqual(tableReferences("SELECT 1 FROM customer_info c JOIN identity_invoice_info AS i ON i.identity = c.customer_id LEFT JOIN other_view WHERE 1 = 1"), [
      { view: "CUSTOMER_INFO", alias: "C", owner: null },
      { view: "IDENTITY_INVOICE_INFO", alias: "I", owner: null },
      { view: "OTHER_VIEW", alias: "OTHER_VIEW", owner: null },
    ]);
  });
});

describe("checking a SQL against the data dictionary", () => {
  it("accepts views and columns that exist, in any letter case", async () => {
    const r = await checkAgainstDictionary("SELECT c.customer_id, i.Pay_Term_Id FROM customer_info c JOIN identity_invoice_info i ON i.identity = c.customer_id", lookup);
    assert.ok(r.ok);
    assert.equal(r.checked, 3);
  });

  it("reports a column that the view does not have, and a view that the dictionary does not know", async () => {
    const r = await checkAgainstDictionary("SELECT c.customer_id, c.full_curr_amount, x.a FROM customer_info c JOIN no_such_view x ON x.a = c.customer_id", lookup);
    assert.ok(!r.ok);
    assert.deepEqual(r.unknownColumns, [{ alias: "C", view: "CUSTOMER_INFO", column: "FULL_CURR_AMOUNT" }]);
    assert.deepEqual(r.unknownViews, ["NO_SUCH_VIEW"]);
  });

  it("skips the columns of a sub-select and does not read text in quotes or comments", async () => {
    const sql = "SELECT lt.anything FROM (SELECT t.customer_id FROM customer_info t WHERE t.name = 'x.y' /* z.w */) lt -- q.r\n";
    const r = await checkAgainstDictionary(sql, lookup);
    assert.ok(r.ok);
    assert.equal(r.skipped, 1);
    assert.equal(r.checked, 2);
  });

  it("holds for the Weekly Cash Report: the stored result of the check has no unknown view or column", () => {
    const o = real.validation.offlineChecks;
    assert.ok(o, "run: npm run check:dictionary -- examples/weekly-cash-report.sample.design.json --write");
    assert.deepEqual([o.unknownViews, o.unknownColumns], [[], []]);
    assert.ok(o.checked >= 20);
  });
});

describe("the review page of a design", () => {
  const md = reviewMarkdown(real);

  it("shows the parameters, all eleven columns, the SQL and the status", () => {
    assert.match(md, /^# Sample Weekly Cash Report \(SQL quick report\)/);
    assert.match(md, /\| Company ID \| string \| yes \| none \| `'&Company'` \|/);
    for (const c of real.columns) assert.ok(md.includes(`| ${c.label} |`), c.label);
    assert.match(md, /```sql\nSELECT cust\.customer_id/);
    assert.match(md, /Status: \*\*not run\*\*/);
    assert.match(md, /0 unknown, 0 unknown view\(s\)/);
  });

  it("numbers the questions for the consultant and ends by asking for approval", () => {
    real.openQuestions.forEach((q, i) => assert.ok(md.includes(`${i + 1}. ${q}`)));
    assert.match(md, /Approve the design, or tell me what to change\.$/);
  });
});
