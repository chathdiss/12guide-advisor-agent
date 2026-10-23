// The test run of a report that exists in IFS (src/ifs-testrun.js). Offline: a fake page that behaves like the run page of a quick report. Nothing is opened in IFS.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { MAX_ROWS, RUN_UI, UNSAFE_VALUE, testRunReport } from "../src/ifs-testrun.js";

const RUN_URL = "https://env.build.ifs.cloud/main/ifsapplications/web/quickreport/123456";
const design = {
  report: { title: "ZZ TEST - DIALOG CHECK" },
  parameters: [{ name: "NameStartsWith", mandatory: false }],
  columns: [{ label: "Customer Id" }, { label: "Name" }],
};
const request = (patch = {}) => ({ reportId: "123456", params: { NameStartsWith: "A" }, execute: true, runUrl: RUN_URL, timeoutMs: 40, ...patch });

// The run page of a report. mode: "grid" (the result appears), "error" (IFS shows an alert), "timeout" (nothing appears), "unreadable" (the header shows, the grid cannot be read)
function fakeRunPage({ noData = false, loading = false, mode = "grid", titleShown = true, boxes = ["NameStartsWith"], columns = ["Customer Id", "Name"], rows = [["1", "Acme"], ["2", "Beta"]], alertText = "ORA-00942: table or view does not exist", url = RUN_URL, holdsValue = true } = {}) {
  const log = [];
  const st = { executed: false, values: {} };
  const fail = (what) => {
    throw new Error(`Timeout: ${what} not found`);
  };

  const header = {
    first: () => header,
    or: (other) => ({ waitFor: async () => { if (!st.executed || mode === "timeout") fail("the result"); if (mode === "grid" || mode === "unreadable") return; if (!other) fail("the alert"); } }),
    isVisible: async () => st.executed && (mode === "grid" || mode === "unreadable"),
  };
  const alert = { first: () => alert, innerText: async () => (mode === "error" ? ` ${alertText} ` : fail("an alert")) };
  const grid = {
    first: () => grid,
    getByRole: (role) => {
      // the rows come after the headers: a row or "No data" shows when the grid has loaded (not while it spins)
      if (role === "gridcell") return { first: () => ({ or: () => ({ waitFor: async () => { if (loading || !(rows.length > 0 || noData)) fail("the rows"); } }) }) };
      if (role === "columnheader") return { allInnerTexts: async () => (mode === "unreadable" ? fail("the grid") : [" ", ...columns]) };
      if (role === "row") {
        // every row of IFS starts with a cell for the check box column, whose header has no name
        const all = [{ cells: [] }, ...rows.map((cells) => ({ cells: ["", ...cells] }))];
        return { count: async () => all.length, nth: (i) => ({ getByRole: () => ({ allInnerTexts: async () => all[i].cells }) }) };
      }
      return fail(role);
    },
  };

  const page = {
    url: () => url,
    locator: () => ({ count: async () => 0 }),
    goto: async (u) => log.push(`goto ${u}`),
    getByText: (text) => ({ first: () => ({ waitFor: async () => { if (!titleShown || text !== RUN_UI.title("ZZ TEST - DIALOG CHECK")) fail(`the text ${text}`); } }) }),
    getByRole: (role, { name } = {}) => {
      if (role === "textbox") {
        const found = boxes.find((b) => name.test(b));
        return {
          first: () => ({
            waitFor: async () => !found && fail(`the box ${name}`),
            fill: async (value) => (log.push(`fill ${found}`), (st.values[found] = value)),
            inputValue: async () => (holdsValue ? st.values[found] : "something else"),
          }),
        };
      }
      if (role === "button") return { first: () => ({ click: async () => { if (!name.test("Execute")) fail("a button"); log.push("click Execute"); st.executed = true; } }) };
      if (role === "columnheader") return header;
      if (role === "alert") return alert;
      if (role === "grid") return { filter: () => grid };
      throw new Error(`forbidden: getByRole ${role}`);
    },
    screenshot: async () => Buffer.from("PNGDATA"),
  };
  return { page, log, st };
}

const names = (r) => r.steps.map((s) => `${s.name}:${s.status}`);

describe("the rehearsal of a test run: nothing is run", () => {
  it("opens the report, checks its title, finds the parameter and fills it in, and does not press Execute", async () => {
    const f = fakeRunPage();
    const r = await testRunReport(f.page, design, request({ execute: false }));
    assert.deepEqual(f.log, [`goto ${RUN_URL}`, "fill NameStartsWith"]);
    assert.equal(f.st.executed, false);
    assert.equal(r.outcome, "rehearsed");
    assert.equal(r.ok, true);
    assert.equal(r.touchedIfs, "read-only visit");
    assert.equal("executed" in r, false, "nothing was run: no status to report");
    assert.equal("screenshot" in r, false);
    assert.deepEqual(names(r), ["Open the report:ok", "Find the parameters:ok", "Fill in the parameters:ok", "Press Execute:not done"]);
    assert.match(r.steps.at(-1).detail, /the SQL was not run/);
  });

  it("is the default: without the option a run is a rehearsal", async () => {
    const f = fakeRunPage();
    const r = await testRunReport(f.page, design, { reportId: "123456", params: {}, runUrl: RUN_URL, timeoutMs: 40 });
    assert.equal(r.outcome, "rehearsed");
    assert.equal(f.st.executed, false);
  });
});

describe("a test run that runs the SQL", () => {
  it("presses Execute once, reads the columns and the rows, and compares the columns with the design", async () => {
    const f = fakeRunPage();
    const r = await testRunReport(f.page, design, request());
    assert.equal(f.log.filter((l) => l === "click Execute").length, 1);
    assert.equal(r.outcome, "tested");
    assert.equal(r.ok, true);
    assert.deepEqual(r.result.columns, ["Customer Id", "Name"]);
    assert.equal(r.result.columnsMatch, true);
    assert.deepEqual(r.result.rows, [["1", "Acme"], ["2", "Beta"]]);
    assert.equal(r.result.rowCount, 2);
    assert.equal(r.result.moreRows, false);
    assert.equal(typeof r.result.seconds, "number");
    assert.match(r.executed, /^ran on env\.build\.ifs\.cloud: 2 row\(s\) read in [\d.]+ s, columns match the design$/);
    assert.equal(r.touchedIfs, "ran the report (a read-only SELECT)");
    assert.deepEqual(names(r).slice(-4), ["Press Execute:ok", "Wait for the result:ok", "Read the result:ok", "Compare the columns:ok"]);
  });

  it("gives a screenshot of the result as a PNG data address", async () => {
    const r = await testRunReport(fakeRunPage().page, design, request());
    assert.equal(r.screenshot, `data:image/png;base64,${Buffer.from("PNGDATA").toString("base64")}`);
  });

  it("reads at most 20 rows and says that there are more, and clips long cell values", async () => {
    const many = Array.from({ length: 35 }, (_, i) => [String(i), "x".repeat(300)]);
    const r = await testRunReport(fakeRunPage({ rows: many }).page, design, request());
    assert.equal(r.result.rows.length, MAX_ROWS);
    assert.equal(r.result.moreRows, true);
    assert.equal(r.result.rows[0][1].length, 80);
    assert.match(r.executed, /20\+ row\(s\)/);
  });

  it("says when the columns are not those of the design: it ran, but it is not a success", async () => {
    const r = await testRunReport(fakeRunPage({ columns: ["Customer Id", "Name", "Extra"] }).page, design, request());
    assert.equal(r.outcome, "tested_mismatch");
    assert.equal(r.ok, false);
    assert.equal(r.result.columnsMatch, false);
    assert.match(r.steps.at(-1).detail, /Design: Customer Id, Name\. IFS: Customer Id, Name, Extra\./);
    assert.match(r.executed, /columns differ from the design/);
  });

  it("says when the report ran but its result could not be read, and still gives the screenshot", async () => {
    const r = await testRunReport(fakeRunPage({ mode: "unreadable" }).page, design, request());
    assert.equal(r.outcome, "ran_unreadable");
    assert.equal(r.ok, false);
    assert.match(r.executed, /the result could not be read/);
    assert.ok(r.screenshot.startsWith("data:image/png;base64,"));
  });

  it("shows the message of IFS when it gives an error instead of a result, and does not call the SQL run", async () => {
    const r = await testRunReport(fakeRunPage({ mode: "error" }).page, design, request());
    assert.equal(r.outcome, "refused");
    assert.equal(r.ok, false);
    assert.match(r.steps.at(-1).detail, /IFS showed an error instead of a result: ORA-00942: table or view does not exist\./);
    assert.equal("executed" in r, false, "an error is not a run");
  });

  it("says when no result came in time, that IFS may still be running it, and does not call it run", async () => {
    const r = await testRunReport(fakeRunPage({ mode: "timeout" }).page, design, request());
    assert.equal(r.outcome, "timeout");
    assert.match(r.steps.at(-1).detail, /IFS may still be running the SQL/);
    assert.equal("executed" in r, false);
  });
});

describe("when the screen is not as expected, Execute is not pressed", () => {
  it("does not press Execute on a page that is not the report of the approved design", async () => {
    const f = fakeRunPage({ titleShown: false });
    const r = await testRunReport(f.page, design, request());
    assert.equal(r.outcome, "failed");
    assert.equal(f.st.executed, false);
    assert.ok(!f.log.includes("click Execute") && !f.log.some((l) => l.startsWith("fill")));
    assert.match(r.steps[0].detail, /did not open with the title "ZZ TEST - DIALOG CHECK"/);
  });

  it("does not press Execute when a parameter box is missing", async () => {
    const f = fakeRunPage({ boxes: [] });
    const r = await testRunReport(f.page, design, request());
    assert.equal(r.outcome, "failed");
    assert.equal(f.st.executed, false);
  });

  it("does not press Execute when a box does not hold what was typed", async () => {
    const f = fakeRunPage({ holdsValue: false });
    const r = await testRunReport(f.page, design, request());
    assert.equal(r.outcome, "failed");
    assert.equal(f.st.executed, false);
    assert.match(r.steps.at(-1).detail, /does not hold what was typed/);
  });

  it("asks for a new session when IFS shows the sign-in page, and runs nothing", async () => {
    const f = fakeRunPage({ titleShown: false, url: "https://env.build.ifs.cloud/auth/realms/x/protocol/openid-connect/auth" });
    const r = await testRunReport(f.page, design, request());
    assert.equal(r.outcome, "auth_required");
    assert.match(r.steps[0].detail, /npm run ifs:login/);
    assert.equal(f.st.executed, false);
  });

  it("opens nothing for a report id that is not a number, or a design without columns or title", async () => {
    for (const bad of [request({ reportId: "75x" }), request({ reportId: "" }), request({ reportId: "../1" })]) {
      const f = fakeRunPage();
      const r = await testRunReport(f.page, design, bad);
      assert.equal(r.outcome, "failed");
      assert.deepEqual(f.log, []);
    }
    const f = fakeRunPage();
    assert.equal((await testRunReport(f.page, { ...design, columns: [] }, request())).outcome, "failed");
    assert.deepEqual(f.log, []);
  });

  it("fills in only the parameters that have a value, says which were left empty, and runs a report without parameters", async () => {
    const two = { ...design, parameters: [{ name: "NameStartsWith" }, { name: "Country" }] };
    const f = fakeRunPage({ boxes: ["NameStartsWith", "Country"] });
    const r = await testRunReport(f.page, two, request({ params: { NameStartsWith: "A" }, execute: false }));
    assert.deepEqual(f.log.filter((l) => l.startsWith("fill")), ["fill NameStartsWith"]);
    assert.match(r.steps.find((s) => s.name === "Fill in the parameters").detail, /Filled in: NameStartsWith\. Left empty: Country\./);
    const none = fakeRunPage({ boxes: [] });
    const r2 = await testRunReport(none.page, { ...design, parameters: [] }, request({ params: {} }));
    assert.equal(r2.outcome, "tested");
  });
});

describe("what a value may contain, and what this code is allowed to do", () => {
  it("refuses quotes, semicolons, ampersands and comment marks in a value, and allows ordinary text", () => {
    for (const bad of ["a'b", 'a"b', "a;b", "a&b", "a--b", "a/*b", "a*/b"]) assert.ok(UNSAFE_VALUE.test(bad), bad);
    for (const good of ["A", "Acme Industries", "100", "a-b", "Åsa"]) assert.ok(!UNSAFE_VALUE.test(good), good);
  });

  const source = readFileSync(new URL("../src/ifs-testrun.js", import.meta.url), "utf8").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");

  it("clicks only one thing, the Execute button, and never anything that changes a report", () => {
    assert.equal([...source.matchAll(/\.click\(/g)].length, 1);
    for (const word of ["Delete", "Edit", "Save", "Schedule", "Import", "Export", "Refresh"]) assert.ok(!new RegExp(`(getByRole|getByText)\\([^)]*${word}`).test(source), word);
    assert.ok(RUN_UI.execute.test("Execute") && !RUN_UI.execute.test("Execute and schedule"));
  });

  it("does not run a script in the page, change requests, press keys, or write the session", () => {
    assert.ok(!/\.(evaluate|evaluateHandle|route|addInitScript|exposeFunction|storageState|press|type|check|setInputFiles|dispatchEvent)\s*\(/.test(source));
    assert.ok(!/\b(keyboard|mouse)\b/.test(source));
    assert.ok(!/\bfetch\s*\(|console\./.test(source), "no network call of its own, and nothing is logged here");
  });
});

describe("the cells under the headers", () => {
  it("leaves out the check box column, so that every value is under its own header", async () => {
    const r = await testRunReport(fakeRunPage({ rows: [["BRCUST01", "BR CUSTOMER"], ["CZCUST01", "CZ CUSTOMER"]] }).page, design, request());
    assert.deepEqual(r.result.columns, ["Customer Id", "Name"]);
    assert.deepEqual(r.result.rows, [["BRCUST01", "BR CUSTOMER"], ["CZCUST01", "CZ CUSTOMER"]]);
    assert.ok(r.result.rows.every((row) => row.length === r.result.columns.length));
  });

  it("takes the last cells of a row that does not have a cell for each header", async () => {
    const f = fakeRunPage({ rows: [["BRCUST01", "BR CUSTOMER"]] });
    const original = f.page.getByRole;
    // a grid whose rows have one cell more than there are headers
    f.page.getByRole = (role, o) => {
      const loc = original(role, o);
      if (role !== "grid") return loc;
      return { filter: () => ({ first: () => ({ getByRole: (r) => (r === "columnheader" ? { allInnerTexts: async () => ["Customer Id", "Name"] } : r === "row" ? { count: async () => 2, nth: (i) => ({ getByRole: () => ({ allInnerTexts: async () => (i === 0 ? [] : ["", "X", "BRCUST01", "BR CUSTOMER"]) }) }) } : { first: () => ({ or: () => ({ waitFor: async () => {} }) }) }) }) }) };
    };
    const r = await testRunReport(f.page, design, request());
    assert.deepEqual(r.result.rows, [["BRCUST01", "BR CUSTOMER"]]);
  });
});

describe("a grid whose rows are still loading", () => {
  it("does not read zero rows too early: it waits, and says that the rows were still loading when they do not come", async () => {
    const r = await testRunReport(fakeRunPage({ loading: true }).page, design, request());
    assert.equal(r.outcome, "timeout");
    assert.equal(r.ok, false);
    assert.equal("result" in r, false, "no rows were read");
    assert.equal("executed" in r, false, "a result that never loaded is not a run to report");
    assert.match(r.steps.at(-1).detail, /The columns appeared, but the rows were still loading after [\d.]+ seconds\./);
    assert.ok(r.screenshot.startsWith("data:image/png;base64,"));
  });

  it("reads the rows only after the wait, and counts the wait in the time it took", async () => {
    const r = await testRunReport(fakeRunPage().page, design, request());
    assert.equal(r.outcome, "tested");
    assert.match(r.steps.find((s) => s.name === "Wait for the result").detail, /The result, with its rows or "No data", appeared after [\d.]+ seconds\./);
  });
});

describe("a run that returns no rows", () => {
  it("is a success for the columns, but says that the filter is not shown to work yet", async () => {
    const r = await testRunReport(fakeRunPage({ rows: [], noData: true }).page, design, request());
    assert.equal(r.outcome, "tested");
    assert.equal(r.ok, true);
    assert.equal(r.result.rowCount, 0);
    assert.match(r.message, /its columns match the design\. It returned no rows with these values/);
    assert.match(r.message, /an empty value returns all rows/);
    assert.match(r.executed, /: 0 row\(s\) read in [\d.]+ s, columns match the design$/);
  });

  it("does not add that to a run that returned rows", async () => {
    const r = await testRunReport(fakeRunPage().page, design, request());
    assert.ok(!/no rows/.test(r.message));
  });
});
