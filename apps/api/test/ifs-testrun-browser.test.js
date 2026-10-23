// The test run on a real browser against a MOCK of the run page of a quick report (a local page on 127.0.0.1, nothing else): real Playwright locators, fills,
// the click on Execute, the reading of the result grid, and a real screenshot. The mock follows what was seen of IFS: the title "Quick Report: <title>", one
// box for each parameter named after the variable, an Execute button, and a Notes grid that has column headers of its own (it must not be taken for the
// result). It cannot show that IFS lays its result out the same way; the rehearsal of a test run is for that. Skipped when Chromium is not installed.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { after, before, describe, it } from "node:test";
import { testRunReport } from "../src/ifs-testrun.js";

let playwright = null;
try {
  playwright = await import("playwright");
} catch {
  playwright = null;
}
const installed = playwright !== null && existsSync(playwright.chromium.executablePath());

// ?mode=grid (default) | error | none | other: what happens after Execute; ?title=: the title of the report that the page shows; ?cols=: the result columns
const PAGE = `<!doctype html><html><head><title>Quick Report</title></head><body>
<div id="title"></div>
<div><label for="p1">NameStartsWith</label><input id="p1"></div>
<button id="exec">Execute</button>
<div role="grid" aria-label="Notes"><div role="row"><div role="columnheader">Key</div><div role="columnheader">Value</div></div></div>
<div id="out"></div>
<script>
  const q = new URLSearchParams(location.search);
  document.getElementById("title").textContent = "Quick Report: " + (q.get("title") || "ZZ TEST - DIALOG CHECK");
  window.executed = 0;
  window.typed = null;
  document.getElementById("exec").onclick = () => {
    window.executed++;
    window.typed = document.getElementById("p1").value;
    const mode = q.get("mode") || "grid";
    setTimeout(() => {
      const out = document.getElementById("out");
      if (mode === "error") { out.innerHTML = '<div role="alert">ORA-00942: table or view does not exist</div>'; return; }
      if (mode === "none") return;
      const cols = (q.get("cols") || "Customer Id,Name").split(",");
      // the headers show at once; the rows come after a delay (rows=slow), or "No data" (rows=none), or never (rows=never: a spinner)
      const rowsMode = q.get("rows") || "now";
      // like IFS: a first column with a check box, whose header has no name
      const head = '<div role="row"><div role="columnheader"></div>' + cols.map((c) => '<div role="columnheader">' + c + '</div>').join("") + '</div>';
      const body = () => { let h = ""; for (let i = 1; i <= 3; i++) h += '<div role="row"><div role="gridcell"><input type="checkbox"></div>' + cols.map((c) => '<div role="gridcell">' + c + ' ' + i + '</div>').join("") + '</div>'; return h; };
      out.innerHTML = '<div role="grid" aria-label="Result">' + head + (rowsMode === "now" ? body() : rowsMode === "none" ? '<div>(No data)</div>' : '<div class="spinner">loading</div>') + '</div>';
      if (rowsMode === "slow") setTimeout(() => { out.querySelector(".spinner").outerHTML = body(); }, 900);
    }, 300);
  };
</script></body></html>`;

const design = {
  report: { title: "ZZ TEST - DIALOG CHECK" },
  parameters: [{ name: "NameStartsWith", mandatory: false }],
  columns: [{ label: "Customer Id" }, { label: "Name" }],
};

describe("the test run on a real browser, against a mock of the run page", { skip: installed ? false : "Chromium is not installed" }, () => {
  let server;
  let browser;
  let base;

  before(async () => {
    server = createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(PAGE);
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${server.address().port}/main/ifsapplications/web/quickreport/123456`;
    browser = await playwright.chromium.launch({ headless: true });
  });
  after(async () => {
    await browser?.close();
    await new Promise((r) => server?.close(r));
  });

  const run = async (query, options = {}) => {
    const page = await (await browser.newContext()).newPage();
    const request = { reportId: "123456", params: { NameStartsWith: "A" }, execute: true, runUrl: `${base}${query}`, timeoutMs: 3000, ...options };
    const result = await testRunReport(page, design, request);
    const state = await page.evaluate(() => ({ executed: window.executed, typed: window.typed })).catch(() => ({ executed: -1, typed: null }));
    return { result, state };
  };

  it("rehearsal: opens the report, fills in the parameter, and does not press Execute", async () => {
    const { result, state } = await run("", { execute: false });
    assert.equal(result.outcome, "rehearsed", JSON.stringify(result.steps));
    assert.equal(state.executed, 0, "Execute was not pressed");
  });

  it("runs it: types the value, presses Execute once, reads the result grid (not the Notes grid), and takes a real screenshot", async () => {
    const { result, state } = await run("");
    assert.equal(result.outcome, "tested", JSON.stringify(result.steps));
    assert.deepEqual(state, { executed: 1, typed: "A" });
    assert.deepEqual(result.result.columns, ["Customer Id", "Name"]);
    assert.equal(result.result.columnsMatch, true);
    assert.deepEqual(result.result.rows, [["Customer Id 1", "Name 1"], ["Customer Id 2", "Name 2"], ["Customer Id 3", "Name 3"]]);
    assert.ok(result.screenshot.startsWith("data:image/png;base64,") && result.screenshot.length > 2000, "a real PNG");
    assert.match(result.executed, /^ran on 127\.0\.0\.1:\d+: 3 row\(s\) read in [\d.]+ s, columns match the design$/);
  });

  it("waits for the rows that come after the headers, and does not read zero rows too early", async () => {
    const { result } = await run("?rows=slow");
    assert.equal(result.outcome, "tested", JSON.stringify(result.steps));
    assert.equal(result.result.rowCount, 3, "the rows that loaded after the headers were read");
    assert.deepEqual(result.result.rows[0], ["Customer Id 1", "Name 1"]);
  });

  it("reads a result that has no rows when IFS shows No data", async () => {
    const { result } = await run("?rows=none");
    assert.equal(result.outcome, "tested");
    assert.equal(result.result.rowCount, 0);
    assert.match(result.message, /It returned no rows with these values/);
  });

  it("says that the rows were still loading when they never come, and reads no rows", async () => {
    const { result } = await run("?rows=never", { timeoutMs: 300 });
    assert.equal(result.outcome, "timeout");
    assert.match(result.steps.at(-1).detail, /the rows were still loading/);
    assert.equal("result" in result, false);
    assert.ok(result.screenshot.startsWith("data:image/png;base64,"));
  });

  it("says when the columns of the result are not those of the design", async () => {
    const { result } = await run("?cols=Customer%20Id,Name,Extra");
    assert.equal(result.outcome, "tested_mismatch");
    assert.equal(result.ok, false);
    assert.deepEqual(result.result.columns, ["Customer Id", "Name", "Extra"]);
  });

  it("shows the error that IFS gives, and does not call it a run", async () => {
    const { result, state } = await run("?mode=error");
    assert.equal(state.executed, 1);
    assert.equal(result.outcome, "refused");
    assert.match(result.steps.at(-1).detail, /ORA-00942/);
    assert.equal("executed" in result, false);
  });

  it("says when no result comes in time, with a screenshot, without calling it a run", async () => {
    const { result } = await run("?mode=none", { timeoutMs: 400 });
    assert.equal(result.outcome, "timeout");
    assert.ok(result.screenshot.startsWith("data:image/png;base64,"));
    assert.equal("executed" in result, false);
  });

  it("does not press Execute on a report with another title", async () => {
    const { result, state } = await run("?title=Users%20connected%20to%20All%20Roles", { timeoutMs: 600 });
    assert.equal(result.outcome, "failed");
    assert.equal(state.executed, 0);
    assert.match(result.steps[0].detail, /did not open with the title "ZZ TEST - DIALOG CHECK"/);
  });
});
