// The inspection on a real browser: headless Chromium opens a small page from a local server (127.0.0.1), nothing else. It checks that the real output of
// Playwright's ariaSnapshot is reduced the way the fixtures of ifs-inspect.test.js assume. No IFS, no network, no session. Skipped when Chromium is not installed.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { after, before, describe, it } from "node:test";
import { recordPage } from "../src/ifs-inspect.js";

let playwright = null;
try {
  playwright = await import("playwright");
} catch {
  playwright = null;
}
const installed = playwright !== null && existsSync(playwright.chromium.executablePath());

const PAGE = `<!doctype html><html><head><title>Quick Reports - Test</title></head><body>
<nav aria-label="Navigator"><a href="/customers/5678">Home</a></nav>
<h1>Quick Reports</h1>
<button>Import</button>
<button class="icon icon-add" data-testid="new-button"></button>
<button class="icon icon-trash"></button>
<label for="title">Report Title</label><input id="title" value="secret field value">
<div role="grid" aria-label="Quick Report List">
  <div role="row"><div role="columnheader">Report Title</div><div role="columnheader">Category</div></div>
  <div role="row"><div role="gridcell">Acme Industries <button class="row-action"></button> john.smith@acme.com</div><div role="gridcell">secret category 1234567890</div></div>
</div>
<p>secret paragraph text</p>
</body></html>`;

describe("the inspection on a real browser", { skip: installed ? false : "Chromium is not installed" }, () => {
  let server;
  let browser;
  let page;
  let host;

  before(async () => {
    server = createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(PAGE);
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    host = `127.0.0.1:${server.address().port}`;
    browser = await playwright.chromium.launch({ headless: true });
    page = await (await browser.newContext()).newPage();
    await page.goto(`http://${host}/main/ifsapplications/web/page/QuickReport/List;key=1234567?x=secret#top`);
  });
  after(async () => {
    await browser?.close();
    await new Promise((r) => server?.close(r));
  });

  it("records the page name, the controls and the column headers, and nothing of the data", async () => {
    const r = await recordPage(page, host, 1);
    assert.equal(r.recorded, true);
    const { snapshot } = r;
    assert.equal(snapshot.title, "Quick Reports - Test");
    assert.equal(snapshot.path, "/main/ifsapplications/web/page/QuickReport/List");
    const names = snapshot.frames[0].controls.map((c) => `${c.role}:${c.name}`);
    for (const expected of ["heading:Quick Reports", "button:Import", "textbox:Report Title", "columnheader:Report Title", "columnheader:Category", "link:Home", "grid:Quick Report List"]) {
      assert.ok(names.includes(expected), `missing ${expected}; got ${names.join(" | ")}`);
    }
    const text = JSON.stringify(snapshot);
    for (const secret of ["secret field value", "Acme Industries", "john.smith@acme.com", "secret category", "1234567890", "secret paragraph text", "/customers/5678", "key=1234567", "x=secret", "row-action"]) {
      assert.ok(!text.includes(secret), `the recording contains: ${secret}`);
    }
    assert.equal(snapshot.frames[0].dataCells, 2);
  });

  it("finds the buttons without a name, with their class hint and place, and not the one inside a data row", async () => {
    const { snapshot } = await recordPage(page, host, 1);
    const unnamed = snapshot.frames[0].unnamed.filter((u) => u.role === "button");
    assert.deepEqual(unnamed.map((u) => u.class), ["icon icon-add", "icon icon-trash"]);
    assert.equal(unnamed[0].testId, "new-button");
    assert.ok(unnamed.every((u) => u.box && u.box.w > 0 && u.box.h > 0), "they have a place on the page");
  });
});
