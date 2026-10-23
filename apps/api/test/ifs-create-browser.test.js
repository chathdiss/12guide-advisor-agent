// Option A on a real browser against a MOCK of the IFS screens (a local page on 127.0.0.1, nothing else): headless Chromium runs createQuickReport with real
// Playwright locators, clicks and fills. The mock follows the recordings of the real screens: the New Report button, the dialog with its fields, the Type field
// that opens its list only through the arrow after it, the Query field that appears once SQL Statement is chosen, Save, Cancel and an alert. It cannot show
// that IFS behaves the same, but it shows that this code works with Playwright, including Save and the read-back, which no rehearsal can reach.
// Skipped when Chromium is not installed.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { after, before, describe, it } from "node:test";
import { createQuickReport } from "../src/ifs-create.js";

let playwright = null;
try {
  playwright = await import("playwright");
} catch {
  playwright = null;
}
const installed = playwright !== null && existsSync(playwright.chromium.executablePath());

// ?after=detail (default) | list | nowhere: where the mock is when the dialog has closed after Save
const PAGE = `<!doctype html><html><head><title>Quick Reports</title><style>[hidden]{display:none!important}.arrow{width:24px;height:24px}</style></head><body>
<h1>Quick Reports</h1>
<div id="actions"><button id="new">+ New Report</button><button>Import</button><button>Refresh All Quick Reports</button></div>
<div id="rows"><div role="row"><span role="gridcell">Users connected to All Roles</span></div></div>
<div id="detail" hidden><h1>Quick Report Detail</h1>
  <label for="dt">Report Title</label><input id="dt"><label for="dp">Projection Name</label><input id="dp" value="QuickReport123456"><label for="dq">Query *</label><textarea id="dq"></textarea></div>
<div role="dialog" id="dialog" hidden>
  <button id="close">Close</button>
  <h3>Basic Details</h3>
  <label for="title">Report Title</label><input id="title">
  <label for="type">Type</label><input id="type" readonly><button class="arrow" id="arrow"></button>
  <ul role="listbox" id="types" hidden>
    <li role="option">SQL Statement</li><li role="option">Crystal Reports</li><li role="option">Dashboard</li>
  </ul>
  <div id="queryBox" hidden><h3>Query Details</h3><label for="query">Query *</label><textarea id="query"></textarea></div>
  <h3>Comment Details</h3><label for="comments">Comments</label><textarea id="comments"></textarea>
  <div role="alert" id="alert" hidden></div>
  <button id="save">Save</button><button id="cancel">Cancel</button>
</div>
<script>
  const $ = (id) => document.getElementById(id);
  const after = new URLSearchParams(location.search).get("after") || "detail";
  window.saved = [];
  $("new").onclick = () => { $("dialog").hidden = false; };
  // clicking the Type field itself does nothing, as in IFS: only the arrow opens the list
  $("arrow").onclick = () => { $("types").hidden = !$("types").hidden; };
  for (const option of document.querySelectorAll("[role=option]")) option.onclick = () => {
    $("type").value = option.textContent; $("types").hidden = true; $("queryBox").hidden = option.textContent !== "SQL Statement";
  };
  $("cancel").onclick = () => { $("dialog").hidden = true; $("types").hidden = true; };
  $("close").onclick = $("cancel").onclick;
  $("save").onclick = () => {
    if ($("title").value === "DUPLICATE") { $("alert").textContent = " The report title must be unique. "; $("alert").hidden = false; return; }
    window.saved.push({ title: $("title").value, query: $("query").value, comments: $("comments").value, type: $("type").value });
    $("dialog").hidden = true;
    if (after === "detail") { $("detail").hidden = false; $("dt").value = $("title").value; $("dq").value = $("query").value; }
    if (after === "list") { const row = document.createElement("div"); row.setAttribute("role", "row"); row.innerHTML = '<span role="gridcell"></span>'; row.firstChild.textContent = $("title").value; $("rows").appendChild(row); }
  };
</script></body></html>`;

const design = (title = "ZZ TEST - DIALOG CHECK") => ({
  report: { title, purpose: "Lists customers." },
  dataSources: [{ id: "DS1", status: "ready", sql: "SELECT c.customer_id AS \"Customer Id\", c.name AS \"Name\"\nFROM IFSAPP.CUSTOMER_INFO c\nWHERE c.name LIKE '&NameStartsWith%'\nORDER BY c.name;" }],
});

describe("Option A on a real browser, against a mock of the IFS screens", { skip: installed ? false : "Chromium is not installed" }, () => {
  let server;
  let browser;
  let base;

  before(async () => {
    server = createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(PAGE);
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${server.address().port}/main/ifsapplications/web/page/QuickReport/List`;
    browser = await playwright.chromium.launch({ headless: true });
  });
  after(async () => {
    await browser?.close();
    await new Promise((r) => server?.close(r));
  });

  const run = async (after, options, d = design()) => {
    const page = await (await browser.newContext()).newPage();
    const result = await createQuickReport(page, d, { listUrl: `${base}?after=${after}`, timeoutMs: 4000, ...options });
    const saved = await page.evaluate(() => window.saved);
    const fields = await page.evaluate(() => ({ title: document.getElementById("title").value, query: document.getElementById("query").value, comments: document.getElementById("comments").value, type: document.getElementById("type").value }));
    return { result, saved, fields, page };
  };

  it("rehearsal: fills in the dialog through the arrow of the Type field, reads it back, cancels, and saves nothing", async () => {
    const { result, saved, fields, page } = await run("detail", { rehearsal: true });
    assert.equal(result.outcome, "rehearsed", JSON.stringify(result.steps));
    assert.equal(result.ok, true);
    assert.deepEqual(saved, [], "nothing was saved");
    assert.equal(await page.locator("#dialog").isHidden(), true, "the dialog is closed");
    assert.equal(fields.type, "SQL Statement");
    assert.equal(fields.title, "ZZ TEST - DIALOG CHECK");
    assert.ok(fields.query.includes("IFSAPP.CUSTOMER_INFO c") && !fields.query.endsWith(";"));
    assert.match(fields.comments, /it has not been run on IFS\.$/);
  });

  it("creating: saves once with what the design says, and reads the new report back from its detail page", async () => {
    const { result, saved } = await run("detail", { rehearsal: false });
    assert.equal(result.outcome, "created", JSON.stringify(result.steps));
    assert.equal(result.ok, true);
    assert.equal(saved.length, 1);
    assert.equal(saved[0].title, "ZZ TEST - DIALOG CHECK");
    assert.equal(saved[0].type, "SQL Statement");
    assert.equal(result.reportId, "123456", "the id of the new report is read from the name of its projection");
    assert.ok(saved[0].query.includes("LIKE '&NameStartsWith%'"));
    assert.match(result.steps.find((s) => s.name === "Check the new report").detail, /detail page of the new report shows the title and the SQL/);
  });

  it("creating: finds the report in the list when the detail page does not open", async () => {
    const { result, saved } = await run("list", { rehearsal: false });
    assert.equal(result.outcome, "created", JSON.stringify(result.steps));
    assert.equal(saved.length, 1);
    assert.match(result.steps.find((s) => s.name === "Check the new report").detail, /in the list/);
  });

  it("creating: does not claim success when the report cannot be found afterwards", async () => {
    const { result, saved } = await run("nowhere", { rehearsal: false });
    assert.equal(saved.length, 1);
    assert.equal(result.outcome, "created_unverified");
    assert.equal(result.ok, false);
    assert.match(result.message, /not created twice/);
  });

  it("creating: shows the message of IFS when it refuses the report, cancels the dialog, and does not say it was created", async () => {
    const { result, saved, page } = await run("detail", { rehearsal: false }, design("DUPLICATE"));
    assert.equal(result.outcome, "failed");
    assert.equal(result.created, false);
    assert.deepEqual(saved, []);
    assert.match(result.steps.find((s) => s.name === "Save").detail, /The report title must be unique\./);
    assert.equal(await page.locator("#dialog").isHidden(), true, "the dialog was cancelled");
  });

  it("stops at the dialog when the Type list has no SQL Statement, cancels, and says which step it was", async () => {
    const page = await (await browser.newContext()).newPage();
    await page.route("**/*", (route) => route.fulfill({ contentType: "text/html", body: PAGE.replace("<li role=\"option\">SQL Statement</li>", "") }));
    const result = await createQuickReport(page, design(), { listUrl: `${base}?after=detail`, rehearsal: false, timeoutMs: 1500 });
    assert.equal(result.outcome, "failed");
    assert.match(result.steps.at(-1).detail, /\(the option SQL Statement in the Type list\)/);
    assert.deepEqual(await page.evaluate(() => window.saved), []);
  });
});
