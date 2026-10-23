// IFS shows a parameter to the consultant under the name that follows the & in the SQL: a name that is a code or has an underscore or a space is a warning.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { checkDesign } from "../src/check-design.js";

const real = JSON.parse(readFileSync(new URL("../examples/weekly-cash-report.sample.design.json", import.meta.url), "utf8"));
const copy = (o) => JSON.parse(JSON.stringify(o));

// the sample design with its one parameter (Company) named otherwise, in the declaration and in the SQL
const named = (name) => {
  const d = copy(real);
  d.parameters[0] = { ...d.parameters[0], name, usedAs: `&${name}` };
  d.dataSources[0].sql = d.dataSources[0].sql.replaceAll("&Company", `&${name}`);
  return d;
};
const nameWarnings = (name) => checkDesign(named(name)).warnings.filter((w) => /is shown to the consultant in IFS as it is written/.test(w));

describe("the names of the parameters", () => {
  it("accepts a short readable name in CamelCase", () => {
    for (const name of ["Company", "NameStartsWith", "DueBefore", "CustomerId", "ID", "Id", "WorkCenter"]) assert.deepEqual(nameWarnings(name), [], name);
  });

  it("warns about a code, a single letter, an underscore and a space, and says what a good name looks like", () => {
    for (const name of ["P1", "p", "x2", "param1", "Parameter_2", "PARAM_1", "Due_Before", "Name Starts"]) {
      const w = nameWarnings(name);
      assert.equal(w.length, 1, name);
      assert.match(w[0], new RegExp(`The parameter name ${name.replace(/[()]/g, "\\$&")} is shown`));
      assert.match(w[0], /such as NameStartsWith/);
    }
  });

  it("is only a warning: the design still passes the checks", () => {
    const r = checkDesign(named("Due_Before"));
    assert.deepEqual(r.errors, []);
    assert.equal(r.ok, true);
  });

  it("does not warn about a name twice, and leaves the other checks as they were", () => {
    const r = checkDesign(named("P1"));
    assert.equal(r.warnings.filter((w) => /P1/.test(w) && /shown to the consultant/.test(w)).length, 1);
    assert.ok(r.warnings.some((w) => /not validated/.test(w)));
  });
});
