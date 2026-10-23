import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { checkDesign, parametersUsed } from "../src/check-design.js";
import { reviewMarkdown } from "../src/review.js";

const design = JSON.parse(readFileSync(new URL("../examples/shop-order-report.sample.design.json", import.meta.url), "utf8"));
const copy = (o) => JSON.parse(JSON.stringify(o));
const source = (id) => design.dataSources.find((s) => s.id === id);

describe("the Shop Order Report design", () => {
  const r = checkDesign(design);

  it("passes the checks, and says what is still missing instead of failing", () => {
    assert.deepEqual(r.errors, []);
    assert.ok(r.ok);
    assert.ok(r.warnings.some((w) => /gl-labour-postings is blocked/.test(w)));
    assert.ok(r.warnings.some((w) => /routing-standard-cost is blocked/.test(w)));
    assert.ok(r.warnings.some((w) => /standard-part-cost is a draft/.test(w)));
  });

  it("has the three parameters of the specification, the company with a default", () => {
    assert.deepEqual(design.parameters.map((p) => p.name), ["Company", "FromDate", "ToDate"]);
    assert.equal(design.parameters[0].default, "100");
    assert.ok(design.parameters.every((p) => p.mandatory));
  });

  it("has the seven columns of the layout, two of them repeated per work centre", () => {
    assert.equal(design.columns.length, 7);
    assert.deepEqual(design.columns.filter((c) => c.dynamic).map((c) => c.dynamic.per), ["work centre", "work centre"]);
  });

  it("does not write SQL for what is unknown: a blocked source has no SQL and says by what it is blocked", () => {
    for (const id of ["gl-labour-postings", "routing-standard-cost"]) {
      assert.equal(source(id).status, "blocked");
      assert.equal(source(id).sql, undefined);
      assert.ok(source(id).blockedBy.length >= 2);
    }
  });

  it("selects by the company through its sites, and only the closed shop orders", () => {
    assert.match(source("closed-shop-orders").sql, /FROM shop_ord so\s+JOIN company_site cs/);
    assert.match(source("closed-shop-orders").sql, /so\.state = 'Closed'/);
    assert.match(source("work-centres").sql, /cs\.company = '&Company'/);
    assert.deepEqual(parametersUsed(source("work-centres").sql), ["Company"]);
  });

  it("sums only the labour setup and labour overhead buckets of cost set 1, as the specification says", () => {
    const sql = source("standard-part-cost").sql;
    assert.match(sql, /pcb\.cost_set = 1/);
    assert.match(sql, /cost_bucket_id IN \('201', '221'\)/);
    assert.ok(!sql.includes("'200'"), "the labour runtime bucket is a question for the consultant, not part of the SQL");
  });

  it("states both equations of the specification and the rule of the general ledger", () => {
    const names = design.formulas.map((f) => f.name);
    assert.equal(design.formulas.length, 4);
    assert.ok(names.some((n) => /per routing operation/.test(n)));
    assert.ok(names.some((n) => /per work centre/.test(n)));
    assert.match(design.formulas.find((f) => /general ledger/.test(f.name)).text, /x -1/);
  });

  it("keeps the questions the specification leaves open as decisions and questions, and does not decide them", () => {
    assert.deepEqual(design.decisions.map((d) => d.id), ["work-centre-columns", "shop-order-selection"]);
    assert.ok(design.decisions.every((d) => d.options.length === 3 && !("chosen" in d)));
    const q = design.openQuestions.join("\n");
    for (const needle of [/shop order/i, /transaction code/i, /Std Lot Size/, /Labor Runtime|bucket 200/, /division by zero/, /started but not closed/]) assert.match(q, needle);
  });
});

describe("the checks on the parts of a design that has blocked sources", () => {
  it("rejects a blocked source that has SQL or does not say by what it is blocked", () => {
    const a = copy(design);
    a.dataSources.find((s) => s.id === "gl-labour-postings").sql = "SELECT 1 FROM dual";
    assert.ok(checkDesign(a).errors.some((e) => /blocked and must not have SQL/.test(e)));
    const b = copy(design);
    b.dataSources.find((s) => s.id === "gl-labour-postings").blockedBy = [];
    assert.ok(checkDesign(b).errors.some((e) => /say by what/.test(e)));
  });

  it("rejects a repeated column that does not say what it is repeated per, and an unknown status", () => {
    const a = copy(design);
    delete a.columns.find((c) => c.dynamic).dynamic.per;
    assert.ok(checkDesign(a).errors.some((e) => /repeated per/.test(e)));
    const b = copy(design);
    b.dataSources[0].status = "finished";
    assert.ok(checkDesign(b).errors.some((e) => /unknown status/.test(e)));
  });

  it("still rejects a SQL that changes data in a source that is written", () => {
    const a = copy(design);
    a.dataSources.find((s) => s.id === "closed-shop-orders").sql = "DELETE FROM shop_ord";
    assert.ok(checkDesign(a).errors.some((e) => /not read-only|must start with SELECT/.test(e)));
  });
});

describe("the dictionary check and the review page of the Shop Order Report", () => {
  it("has a stored dictionary check without unknown views or columns, for the three sources with SQL", () => {
    const o = design.validation.offlineChecks;
    assert.ok(o, "run: npm run check:dictionary -- examples/shop-order-report.sample.design.json --write");
    assert.deepEqual([o.unknownViews, o.unknownColumns], [[], []]);
    assert.deepEqual(o.sources, ["work-centres", "closed-shop-orders", "standard-part-cost"]);
  });

  it("shows the formulas, what blocks each source, the decisions and every question", () => {
    const md = reviewMarkdown(design);
    assert.match(md, /^# Sample Shop Order Report per week/);
    assert.match(md, /Labour cost per work centre \(one per work centre\)/);
    assert.match(md, /Setup Labour rate x Setup Crew Size/);
    assert.match(md, /Worked example from the screenshots/);
    assert.match(md, /## Data source: gl-labour-postings \(blocked\)/);
    assert.match(md, /\*\*No SQL yet\.\*\* Blocked by:/);
    assert.match(md, /### How the work centre columns are made/);
    design.openQuestions.forEach((q, i) => assert.ok(md.includes(`${i + 1}. ${q}`)));
  });
});
