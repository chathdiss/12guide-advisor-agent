import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { checkDesign, outputColumns, parametersUsed } from "../src/check-design.js";

const real = JSON.parse(readFileSync(new URL("../examples/weekly-cash-report.sample.design.json", import.meta.url), "utf8"));
const copy = (o) => JSON.parse(JSON.stringify(o));
const withSql = (sql) => {
  const d = copy(real);
  d.dataSources[0].sql = sql;
  return d;
};

describe("reading the SQL of a quick report", () => {
  it("finds the parameters, also with query flags, and leaves the application owner alone", () => {
    assert.deepEqual(parametersUsed("WHERE a = '&Company' AND b = '&Company' AND c = '&[MC--L]SupplierID' AND &AO.Report_sys.Parse_parameter(x, '&Name') = 'TRUE'"), ["Company", "SupplierID", "Name"]);
    assert.deepEqual(parametersUsed("SELECT 1 FROM dual -- &Hidden\nWHERE 1 = 1"), [], "a parameter in a comment is not used");
  });

  it("finds the output columns from the quoted aliases of the select list", () => {
    assert.deepEqual(outputColumns('SELECT a AS "Customer ID", b AS "Name" FROM (SELECT 1 AS rn FROM dual)'), ["Customer ID", "Name"]);
  });
});

describe("the checks of a quick report design", () => {
  it("passes the Weekly Cash Report design, with warnings for what is still open", () => {
    const r = checkDesign(real);
    assert.deepEqual(r.errors, []);
    assert.ok(r.ok);
    assert.ok(r.warnings.some((w) => /not validated/.test(w)));
    assert.ok(r.warnings.some((w) => /open question/.test(w)));
  });

  it("has a column for each column of the layout, in the order of the specification", () => {
    assert.deepEqual(outputColumns(real.dataSources[0].sql), real.columns.map((c) => c.label));
    assert.equal(real.columns.length, 11);
  });

  it("asks for the company only once, as a mandatory parameter", () => {
    assert.deepEqual(parametersUsed(real.dataSources[0].sql), ["Company"]);
    assert.equal(real.parameters[0].mandatory, true);
  });

  it("rejects a SQL that changes data", () => {
    for (const sql of ["DELETE FROM customer_info", "SELECT 1 AS \"Customer ID\" FROM dual; DROP TABLE x", "WITH a AS (SELECT 1 FROM dual) UPDATE t SET x = 1"]) {
      assert.ok(!checkDesign(withSql(sql)).ok, sql);
    }
  });

  it("does not take a column named like a keyword for a statement", () => {
    const d = withSql(real.dataSources[0].sql.replace("lt.pay_date AS \"Payment Date\"", "lt.pay_date AS \"Payment Date\", 1 AS update_flag"));
    assert.ok(!checkDesign(d).errors.some((e) => /read-only/.test(e)));
  });

  it("rejects a parameter that is used but not declared, and warns about one that is declared but not used", () => {
    const missing = checkDesign(withSql(real.dataSources[0].sql.replaceAll("'&Company'", "'&Firm'")));
    assert.ok(missing.errors.some((e) => /&Firm/.test(e)));
    assert.ok(missing.warnings.some((w) => /Company is declared but not used/.test(w)));
  });

  it("rejects output columns that differ from the layout", () => {
    const d = copy(real);
    d.columns.pop();
    assert.ok(checkDesign(d).errors.some((e) => /differ from the report layout/.test(e)));
  });

  it("rejects a design with a missing part", () => {
    const d = copy(real);
    delete d.parameters;
    assert.ok(checkDesign(d).errors.some((e) => /Missing "parameters"/.test(e)));
    assert.ok(!checkDesign(null).ok);
  });
});
