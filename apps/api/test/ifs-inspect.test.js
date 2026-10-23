// The read-only inspection of the IFS screens (src/ifs-inspect.js, src/cli/ifs-inspect.js). All offline: a fake browser, no network, no IFS.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { assertOutsideRepo, cleanPath, filterAriaSnapshot, inspectionSetup, outlineOf, readUnnamed, recordPage, redactName, runInspection, summarizeAriaSnapshot } from "../src/ifs-inspect.js";

const BASE = "https://env.build.ifs.cloud/landing-page/";
const HOST = "env.build.ifs.cloud";

// the data that must never be in a recording
const SECRETS = ["Acme Industries", "john.smith@acme.com", "1234567890", "secret note text", "CUSTOMER-ABC", "hello value", "/customers/5678", "Row action for Acme"];

// what Playwright's ariaSnapshot returns for a Quick Reports like screen, with data in it
const SNAPSHOT = `
- banner:
  - heading "Quick Reports" [level=1]
  - button "New"
  - button "Save" [disabled]
  - textbox "Search": hello value
- navigation "Navigator":
  - treeitem "Finance"
  - link "Customers":
    - /url: /customers/5678
- main:
  - tablist:
    - tab "Details" [selected]
    - tab "Parameters"
  - combobox "Company": CUSTOMER-ABC
  - grid "Reports":
    - row "Name Description":
      - columnheader "Name"
      - columnheader "Description"
    - row "Acme Industries secret note text":
      - gridcell "Acme Industries":
        - button "Row action for Acme"
      - gridcell "secret note text"
      - cell "1234567890"
  - paragraph: john.smith@acme.com wrote secret note text
  - text: Acme Industries
  - listitem: Acme Industries
  - img "Logo of Acme Industries"
  - button "Export 1234567890 rows to john.smith@acme.com"
`;

describe("masking labels and addresses", () => {
  it("masks e-mail addresses and long numbers, shortens long labels, and keeps ordinary labels", () => {
    assert.equal(redactName("Save"), "Save");
    assert.equal(redactName("  Quick   Reports "), "Quick Reports");
    assert.equal(redactName("Mail john.smith@acme.com now"), "Mail <email> now");
    assert.equal(redactName("Order 1234567 of 99"), "Order #### of 99");
    assert.equal(redactName("x".repeat(100)).length, 81);
    assert.equal(redactName(null), "");
  });

  it("keeps only the path of a page address: no query, no hash, no key parts, no long numbers", () => {
    assert.equal(cleanPath("https://env.build.ifs.cloud/main/ifsapplications/web/page/QuickReports/Form;$filter=Id%20eq%20'A1';key=1234567?x=1#top"), "/main/ifsapplications/web/page/QuickReports/Form");
    assert.equal(cleanPath("https://env.build.ifs.cloud/a/1234567/b"), "/a/####/b");
    assert.equal(cleanPath("not a url"), "");
  });
});

describe("reducing a page to its controls", () => {
  const controls = filterAriaSnapshot(SNAPSHOT);
  const text = JSON.stringify(controls);

  it("keeps the labels and roles of the screen: headings, buttons, tabs, fields, column headers, the navigator", () => {
    assert.deepEqual(controls.map((c) => `${c.role}:${c.name}`), [
      "banner:",
      "heading:Quick Reports",
      "button:New",
      "button:Save",
      "textbox:Search",
      "navigation:Navigator",
      "treeitem:Finance",
      "link:Customers",
      "main:",
      "tablist:",
      "tab:Details",
      "tab:Parameters",
      "combobox:Company",
      "grid:Reports",
      "columnheader:Name",
      "columnheader:Description",
      "button:Export #### rows to <email>",
    ]);
  });

  it("keeps the nesting as a depth", () => {
    assert.equal(controls.find((c) => c.name === "Quick Reports").depth, 1);
    assert.equal(controls.find((c) => c.name === "Navigator").depth, 0);
    assert.equal(controls.find((c) => c.name === "Name").depth, 3);
  });

  it("leaves out all data: values of fields, grid cells and what is inside them, text, paragraphs, link addresses, images", () => {
    for (const secret of SECRETS) assert.ok(!text.includes(secret), `the result contains: ${secret}`);
    assert.ok(!controls.some((c) => ["gridcell", "cell", "row", "text", "paragraph", "listitem", "img"].includes(c.role)));
  });

  it("gives nothing for an empty or unreadable snapshot", () => {
    assert.deepEqual(filterAriaSnapshot(""), []);
    assert.deepEqual(filterAriaSnapshot(null), []);
    assert.deepEqual(filterAriaSnapshot("this is not yaml\n  - - -\n"), []);
  });
});

// a browser that allows only reading: any other property is an interaction, and throws
const strict = (name, allowed) =>
  new Proxy(allowed, {
    get(target, prop) {
      if (prop === "then" || typeof prop === "symbol") return undefined;
      if (!(prop in target)) throw new Error(`forbidden interaction: ${name}.${String(prop)}`);
      return target[prop];
    },
  });

const fakeElement = ({ attributes = {}, box = null, inDataRow = false, fails = false }) =>
  strict("element", {
    locator: () => strict("locator", { count: async () => (inDataRow ? 1 : 0) }),
    getAttribute: async (name) => {
      if (fails) throw new Error("element detached");
      return attributes[name] ?? null;
    },
    boundingBox: async () => box,
  });

const fakeFrame = (url, yaml, fails = false, items = {}) =>
  strict("frame", {
    url: () => url,
    locator: () => strict("locator", { ariaSnapshot: async () => { if (fails) throw new Error("detached"); return yaml; } }),
    getByRole: (role) => strict("roleLocator", { count: async () => (items[role] ?? []).length, nth: (i) => fakeElement(items[role][i]) }),
  });

const fakeBrowser = ({ url = `${BASE}`, title = "Quick Reports", frames, closed = false, gotoFails = false, items = {} } = {}) => {
  const seen = { launch: null, context: null, goto: [], closed: 0 };
  const main = fakeFrame(url, SNAPSHOT, false, items);
  const page = strict("page", {
    goto: async (address, options) => {
      seen.goto.push([address, options.waitUntil]);
      if (gotoFails) throw new Error("net::ERR_FAILED");
    },
    url: () => url,
    title: async () => title,
    frames: () => frames ?? [main],
    isClosed: () => closed,
  });
  const browser = strict("browser", {
    newContext: async (options) => ((seen.context = options), strict("context", { newPage: async () => page })),
    close: async () => void seen.closed++,
  });
  const playwright = { chromium: { launch: async (options) => ((seen.launch = options), browser) } };
  return { playwright, seen, page };
};

const lines = (...items) => (async function* () { yield* items; })();

describe("recording a page", () => {
  it("records the page structure of the configured host only", async () => {
    const { page } = fakeBrowser();
    const r = await recordPage(page, HOST, 1, new Date("2026-10-22T10:00:00Z"));
    assert.equal(r.recorded, true);
    assert.equal(r.snapshot.path, "/landing-page/");
    assert.equal(r.snapshot.title, "Quick Reports");
    assert.equal(r.snapshot.frames[0].controls.length, 17);
    for (const secret of SECRETS) assert.ok(!JSON.stringify(r).includes(secret), secret);
  });

  it("does not record a page of another host, and does not even read it", async () => {
    const other = strict("page", { url: () => "https://other.example.com/x", title: async () => { throw new Error("must not be read"); }, frames: () => { throw new Error("must not be read"); } });
    const r = await recordPage(other, HOST, 1);
    assert.equal(r.recorded, false);
    assert.match(r.reason, /not on env\.build\.ifs\.cloud/);
  });

  it("skips frames of other hosts, and says when a frame cannot be read", async () => {
    const { page } = fakeBrowser({ frames: [fakeFrame(BASE, SNAPSHOT), fakeFrame("https://ads.example.com/f", SNAPSHOT), fakeFrame(`${BASE}inner`, "", true), fakeFrame("about:blank", "")] });
    const r = await recordPage(page, HOST, 1);
    assert.equal(r.snapshot.frames.length, 2);
    assert.equal(r.snapshot.frames[1].note, "This frame could not be read.");
  });

  it("makes a readable outline", async () => {
    const { page } = fakeBrowser();
    const { snapshot } = await recordPage(page, HOST, 1);
    const outline = outlineOf([snapshot]);
    assert.match(outline, /^## 1\. Quick Reports {2}\/landing-page\//);
    assert.match(outline, /\n {4}heading "Quick Reports"/);
    assert.match(outline, /button "Save"/);
  });
});

describe("the inspection session", () => {
  const dirs = [];
  const tmp = () => (dirs.push(mkdtempSync(join(tmpdir(), "ifs-inspect-"))), dirs.at(-1));
  after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
  const run = (browser, input, outDir) => {
    const out = [];
    return runInspection({ playwright: browser.playwright, baseUrl: BASE, storageState: "C:/sessions/ifs-session.json", outDir, lines: input, out: (m) => out.push(m), now: () => new Date("2026-10-22T10:00:00Z") }).then((r) => ({ ...r, out: out.join("\n") }));
  };

  it("opens a visible browser with the saved session, opens only the configured address, records on Enter, and quits on q", async () => {
    const browser = fakeBrowser();
    const outDir = tmp();
    const r = await run(browser, lines("", "oops", "", "q", ""), outDir);
    assert.deepEqual(browser.seen.launch, { headless: false });
    assert.deepEqual(browser.seen.context, { storageState: "C:/sessions/ifs-session.json" });
    assert.deepEqual(browser.seen.goto, [[BASE, "domcontentloaded"]]);
    assert.equal(browser.seen.closed, 1);
    assert.equal(r.snapshots, 2, "two Enters, two recordings; the third line quit");
    assert.match(r.out, /Press Enter to record the page, or q to quit\./);
    assert.match(r.out, /Recorded page 2: Quick Reports \(17 controls\)\./);
    assert.match(r.out, /never clicks, types or changes anything/);
  });

  it("writes a recording without any data, without screenshots, in the folder that was given", async () => {
    const outDir = tmp();
    const r = await run(fakeBrowser(), lines("", "q"), outDir);
    const files = readdirSync(outDir);
    assert.deepEqual(files.sort(), ["inspection-2026-10-22T10-00-00-000Z.json", "inspection-2026-10-22T10-00-00-000Z.outline.txt"]);
    assert.equal(r.file, join(outDir, files.find((f) => f.endsWith(".json"))));
    const json = readFileSync(r.file, "utf8");
    const outline = readFileSync(join(outDir, files.find((f) => f.endsWith(".txt"))), "utf8");
    for (const secret of SECRETS) assert.ok(!json.includes(secret) && !outline.includes(secret), secret);
    const data = JSON.parse(json);
    assert.equal(data.screenshots, "never taken");
    assert.equal(data.host, HOST);
    assert.ok(!files.some((f) => /\.(png|jpe?g|webp)$/.test(f)));
  });

  it("writes nothing when nothing was recorded, and closes the browser", async () => {
    const outDir = tmp();
    const browser = fakeBrowser();
    const r = await run(browser, lines("q"), outDir);
    assert.equal(r.file, null);
    assert.deepEqual(readdirSync(outDir), []);
    assert.match(r.out, /Nothing was recorded\./);
    assert.equal(browser.seen.closed, 1);
  });

  it("says so when the browser window was closed, and records nothing", async () => {
    const closed = await run(fakeBrowser({ closed: true }), lines("", "q"), tmp());
    assert.match(closed.out, /The browser window was closed\./);
    assert.equal(closed.snapshots, 0);
  });

  it("asks for a new session when IFS shows a sign-in, records nothing, and does not go any further", async () => {
    const outDir = tmp();
    for (const url of ["https://login.example.com/auth", "https://env.build.ifs.cloud/auth/realms/x/protocol/openid-connect/auth"]) {
      const browser = fakeBrowser({ url });
      const r = await run(browser, lines("", "q"), outDir);
      assert.equal(r.outcome, "auth_required");
      assert.match(r.out, /session has expired/);
      assert.equal(browser.seen.closed, 1);
    }
    assert.deepEqual(readdirSync(outDir), []);
  });

  it("closes the browser when IFS cannot be opened", async () => {
    const browser = fakeBrowser({ gotoFails: true });
    await assert.rejects(() => run(browser, lines("", "q"), tmp()), /ERR_FAILED/);
    assert.equal(browser.seen.closed, 1);
  });
});

describe("what the page is made of, and what cannot be seen in the outline", () => {
  it("counts the elements of every role, and the grid cells that are left out, without any text", () => {
    const s = summarizeAriaSnapshot(SNAPSHOT);
    assert.equal(s.dataCells, 3);
    assert.equal(s.roleCounts.button, 3, "the button inside a grid cell is not counted");
    assert.equal(s.roleCounts.row, 2);
    assert.equal(s.roleCounts.paragraph, 1);
    assert.equal(s.roleCounts.text, 1);
    assert.equal(s.roleCounts.columnheader, 2);
    assert.equal(s.roleCounts.gridcell, undefined);
    assert.equal(summarizeAriaSnapshot(SNAPSHOT).controls.length, filterAriaSnapshot(SNAPSHOT).length);
    for (const secret of SECRETS) assert.ok(!JSON.stringify(s).includes(secret), secret);
    assert.ok(Object.values(s.roleCounts).every((n) => Number.isInteger(n)));
  });

  it("reads the tooltip, test id, class hint and place of controls without a name, and leaves out those inside a data row", async () => {
    const frame = fakeFrame(BASE, "", false, {
      button: [
        { attributes: { title: "New", class: "aurena-icon icon-add", "data-testid": "new-button" }, box: { x: 1180.4, y: 120.6, width: 40, height: 40 } },
        { attributes: { title: "Delete 1234567 of john.smith@acme.com" }, box: null },
        { attributes: { title: "Row action" }, inDataRow: true },
        { attributes: { title: "Gone" }, fails: true },
      ],
      link: [{ attributes: {} }],
    });
    const found = await readUnnamed(frame);
    assert.deepEqual(found, [
      { role: "button", nth: 1, title: "New", testId: "new-button", class: "aurena-icon icon-add", box: { x: 1180, y: 121, w: 40, h: 40 } },
      { role: "button", nth: 2, title: "Delete #### of <email>" },
      { role: "link", nth: 1 },
    ]);
  });

  it("reads at most 30 controls of a role, and nothing at all when the frame cannot be asked", async () => {
    const many = Array.from({ length: 80 }, () => ({ attributes: { title: "x" } }));
    assert.equal((await readUnnamed(fakeFrame(BASE, "", false, { button: many }))).length, 30);
    const broken = strict("frame", { getByRole: () => { throw new Error("no"); } });
    assert.deepEqual(await readUnnamed(broken), []);
  });

  it("puts all of it in the recording and in the outline", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "ifs-inspect-"));
    try {
      const browser = fakeBrowser({ items: { button: [{ attributes: { title: "New", class: "icon-add" }, box: { x: 10, y: 20, width: 30, height: 40 } }] } });
      const out = [];
      const r = await runInspection({ playwright: browser.playwright, baseUrl: BASE, storageState: "s.json", outDir, lines: lines("", "q"), out: (m) => out.push(m), now: () => new Date("2026-10-22T10:00:00Z") });
      const data = JSON.parse(readFileSync(r.file, "utf8"));
      const frame = data.snapshots[0].frames[0];
      assert.deepEqual(frame.unnamed, [{ role: "button", nth: 1, title: "New", class: "icon-add", box: { x: 10, y: 20, w: 30, h: 40 } }]);
      assert.equal(frame.dataCells, 3);
      assert.equal(frame.roleCounts.grid, 1);
      const outline = readFileSync(r.file.replace(".json", ".outline.txt"), "utf8");
      assert.match(outline, /\[roles on the page\] .*button:3/);
      assert.match(outline, /grid cells left out: 3/);
      assert.match(outline, /\[controls without a name\]\n {4}button #1 title "New" class "icon-add" at 10,20 \(30x40\)/);
      assert.match(out.join("\n"), /Wait until the page has finished loading/);
      for (const secret of SECRETS) assert.ok(!JSON.stringify(data).includes(secret) && !outline.includes(secret), secret);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it("reads only the tooltip, the test id and the class of a control: no other attribute, no text", () => {
    const source = readFileSync(new URL("../src/ifs-inspect.js", import.meta.url), "utf8");
    assert.match(source, /const ATTRIBUTES = \["title", "data-testid", "class"\];/);
    assert.ok(!/\.(innerText|textContent|innerHTML|inputValue|allInnerTexts|allTextContents)\s*\(/.test(source), "no text of the page is read");
    assert.equal((source.match(/getAttribute\(/g) ?? []).length, 3);
  });
});

describe("the items of a list", () => {
  const items = (n) => Array.from({ length: n }, (_, i) => `      - option "Item ${i + 1}"`).join("\n");

  it("keeps the list and its first 20 items, and counts all of them", () => {
    const yaml = `- dialog:\n  - textbox "Type"\n  - listbox "Type list":\n${items(30)}\n  - button "Cancel"`;
    const s = summarizeAriaSnapshot(yaml);
    const options = s.controls.filter((c) => c.role === "option");
    assert.equal(options.length, 20);
    assert.equal(options[0].name, "Item 1");
    assert.equal(options.at(-1).name, "Item 20");
    assert.equal(s.roleCounts.option, 30, "all of them are counted");
    assert.ok(s.controls.some((c) => c.role === "listbox" && c.name === "Type list"));
    assert.ok(s.controls.some((c) => c.role === "button" && c.name === "Cancel"), "what follows the list is still there");
  });

  it("masks e-mail addresses and long numbers in the items", () => {
    const s = summarizeAriaSnapshot('- listbox "L":\n  - option "john.smith@acme.com"\n  - option "Order 1234567"');
    assert.deepEqual(s.controls.filter((c) => c.role === "option").map((c) => c.name), ["<email>", "Order ####"]);
  });
});

describe("what this code is allowed to do", () => {
  const sources = ["../src/ifs-inspect.js", "../src/cli/ifs-inspect.js"].map((p) => [p, readFileSync(new URL(p, import.meta.url), "utf8")]);
  // comments say what it does not do, so they are left out of the scan
  const code = (text) => text.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");

  it("never calls an interaction, a script in the page, a change of requests, or a write of the session", () => {
    const forbidden = /\.(click|dblclick|tap|fill|type|press|pressSequentially|check|uncheck|setChecked|selectOption|setInputFiles|dispatchEvent|hover|dragTo|focus|blur|evaluate|evaluateHandle|evaluateAll|addInitScript|addScriptTag|exposeFunction|exposeBinding|route|unroute|setContent|setExtraHTTPHeaders|screenshot|storageState)\s*\(/;
    for (const [name, text] of sources) {
      assert.ok(!forbidden.test(code(text)), `${name} calls something that interacts`);
      assert.ok(!/\b(keyboard|mouse|touchscreen)\b/.test(code(text)), `${name} uses the keyboard or the mouse`);
    }
  });

  it("has no network call of its own, and no write besides the two recording files", () => {
    for (const [name, text] of sources) {
      assert.ok(!/\bfetch\s*\(|node:https?|XMLHttpRequest/.test(code(text)), name);
    }
    const lib = code(sources[0][1]);
    assert.equal((lib.match(/writeFileSync\(/g) ?? []).length, 2);
    assert.ok(!/unlinkSync|rmSync|renameSync|appendFileSync/.test(lib));
  });

  it("is not the Option A runner: it does not import it, and it does not need IFS_AUTOMATION", () => {
    for (const [name, text] of sources) {
      assert.ok(!/ifs-runner|quickreport-actions/.test(code(text)), name);
      assert.ok(!/IFS_AUTOMATION/.test(code(text)), name);
    }
  });
});

describe("the output folder", () => {
  const repo = "D:/Gotli/12guide-ai-agents";
  it("must be outside the repository", () => {
    assert.throws(() => assertOutsideRepo(repo, repo), /inside the repository/);
    assert.throws(() => assertOutsideRepo(`${repo}/apps/api/inspection`, repo), /inside the repository/);
    assert.throws(() => assertOutsideRepo(`${repo}/../12guide-ai-agents/x`, repo), /inside the repository/);
    assert.doesNotThrow(() => assertOutsideRepo("D:/IFS-Sessions/inspection", repo));
    assert.doesNotThrow(() => assertOutsideRepo("D:/Gotli/12guide-ai-agents-notes", repo));
  });
});

describe("the setup check", () => {
  const ok = { fileExists: () => true, playwrightInstalled: () => true, chromiumInstalled: () => true, repoRoot: "D:/Gotli/12guide-ai-agents" };
  const env = { IFS_BASE_URL: BASE, IFS_STORAGE_STATE: "D:/IFS-Sessions/ifs-session.json", IFS_INSPECTION_DIR: "D:/IFS-Sessions/inspection" };

  it("is fine when everything is there, and does not need the automation switch", () => {
    const r = inspectionSetup(env, ok);
    assert.equal(r.ok, true);
    assert.deepEqual(r.config, { baseUrl: BASE, storageState: "D:/IFS-Sessions/ifs-session.json", outDir: "D:/IFS-Sessions/inspection" });
    assert.equal(inspectionSetup({ ...env, IFS_AUTOMATION: "off" }, ok).ok, true);
  });

  it("says what is missing", () => {
    const problems = (patch, deps = ok) => inspectionSetup({ ...env, ...patch }, deps).problems.join(" ");
    assert.match(problems({ IFS_BASE_URL: "http://env.build.ifs.cloud" }), /IFS_BASE_URL/);
    assert.match(problems({ IFS_BASE_URL: "" }), /IFS_BASE_URL/);
    assert.match(problems({ IFS_STORAGE_STATE: "" }), /IFS_STORAGE_STATE is not set/);
    assert.match(problems({}, { ...ok, fileExists: () => false }), /session file .* does not exist/);
    assert.match(problems({ IFS_INSPECTION_DIR: "" }), /IFS_INSPECTION_DIR is not set/);
    assert.match(problems({ IFS_INSPECTION_DIR: "D:/Gotli/12guide-ai-agents/recordings" }), /inside the repository/);
    assert.match(problems({}, { ...ok, playwrightInstalled: () => false }), /Playwright is not installed/);
    assert.match(problems({}, { ...ok, chromiumInstalled: () => false }), /Chromium browser is not installed/);
  });

  it("never reads the session file: it only asks whether it exists", () => {
    const asked = [];
    inspectionSetup(env, { ...ok, fileExists: (p) => (asked.push(p), true) });
    assert.deepEqual(asked, ["D:/IFS-Sessions/ifs-session.json"]);
  });
});
