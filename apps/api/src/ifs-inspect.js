// A read-only inspection of the IFS screens: a visible browser opens with the consultant's saved session, the CONSULTANT navigates, and each time they
// press Enter this records the structure of the page that is open: its path, its title, and the roles and labels of its controls.
//
// What this code never does: click, type, press a key, select, check, drag, run a script in the page, change a request, or write the session back.
// It only opens the configured address, and then reads the page name and the accessibility tree (Playwright's ariaSnapshot). A test checks that these
// calls are not in this file, and that a page that refuses every interaction can still be inspected.
//
// What it leaves out: customer data. Grid cells and everything inside them, text, paragraphs, input values, option values, link addresses, and the
// query and key parts of the page address are dropped, and long numbers and e-mail addresses in labels are masked. Screenshots are never taken.
// Labels of buttons and links can still contain a name now and then: read the file before you share it.
import { mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

// roles whose label is part of the structure of a screen: kept (the label only, never a value)
const KEEP = new Set([
  "button", "link", "tab", "tablist", "tabpanel", "menu", "menubar", "menuitem", "menuitemcheckbox", "menuitemradio", "toolbar", "heading",
  "textbox", "searchbox", "combobox", "checkbox", "radio", "switch", "spinbutton", "slider", "columnheader", "dialog", "alertdialog", "navigation",
  "banner", "main", "region", "form", "group", "grid", "table", "tree", "treeitem", "complementary", "contentinfo", "search", "listbox", "option",
]);
// at most this many items of lists are kept: the items of a list of data (customers, say) are not wanted
const OPTIONS_KEPT = 20;
// roles that hold data: they and everything below them are dropped
const DATA = new Set(["gridcell", "cell", "rowheader"]);

const LINE = /^(\s*)- ([A-Za-z]+)(?: "((?:[^"\\]|\\.)*)")?((?:\s*\[[^\]]*\])*)(?::(.*))?$/;

// a label without e-mail addresses and long numbers, and not longer than 80 characters
export function redactName(value) {
  const text = String(value ?? "")
    .replace(/\\"/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "<email>")
    .replace(/\d{4,}/g, "####");
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

// the path of a page address without the query, the hash, the key parts after a semicolon, and long numbers
export function cleanPath(address) {
  try {
    const u = new URL(address);
    return u.pathname
      .split("/")
      .map((segment) => segment.split(";")[0].replace(/\d{4,}/g, "####"))
      .join("/");
  } catch {
    return "";
  }
}

// The accessibility tree of a page (YAML text) reduced to what a screen is made of:
//   controls   [{ role, name, depth }]: the controls that are kept. Values (after the colon) are always dropped.
//   roleCounts how many elements of each role the page has (numbers only, no text), so that what is not recorded can be seen
//   dataCells  how many grid cells there are: they and what is inside them are left out
export function summarizeAriaSnapshot(yaml) {
  const controls = [];
  const roleCounts = {};
  let dataCells = 0;
  let options = 0;
  let dropBelow = -1;
  for (const raw of String(yaml ?? "").split(/\r?\n/)) {
    const m = LINE.exec(raw);
    if (!m) continue; // /url lines, continuation lines: never kept
    const indent = m[1].length;
    if (dropBelow >= 0) {
      if (indent > dropBelow) continue;
      dropBelow = -1;
    }
    const role = m[2];
    if (DATA.has(role)) {
      dataCells++;
      dropBelow = indent;
      continue;
    }
    roleCounts[role] = (roleCounts[role] ?? 0) + 1;
    if (!KEEP.has(role)) continue;
    if (role === "option" && ++options > OPTIONS_KEPT) continue;
    controls.push({ role, name: redactName(m[3]), depth: Math.floor(indent / 2) });
  }
  return { controls, roleCounts, dataCells };
}

export const filterAriaSnapshot = (yaml) => summarizeAriaSnapshot(yaml).controls;

// Controls that have no accessible name (icon buttons, for example) show as button "" in the outline. What can be read about them without touching
// them: their tooltip (title), a test id, a hint from the class name (icon fonts name their icons there), and where they are on the page.
// Controls inside a data row are skipped. Only these attributes are read, and nothing is clicked, focused or scrolled.
const UNNAMED_ROLES = ["button", "link", "menuitem", "tab", "checkbox", "textbox", "combobox"];
const UNNAMED_LIMIT = 30;
const ATTRIBUTES = ["title", "data-testid", "class"];
const IN_DATA_ROW = "xpath=ancestor::*[@role='gridcell' or @role='cell' or @role='rowheader' or self::td]";

export async function readUnnamed(frame) {
  const found = [];
  for (const role of UNNAMED_ROLES) {
    let items;
    let count;
    try {
      items = frame.getByRole(role, { name: /^\s*$/ });
      count = Math.min(await items.count(), UNNAMED_LIMIT);
    } catch {
      continue;
    }
    for (let i = 0; i < count; i++) {
      try {
        const el = items.nth(i);
        if ((await el.locator(IN_DATA_ROW).count()) > 0) continue;
        const entry = { role, nth: i + 1 };
        const title = await el.getAttribute(ATTRIBUTES[0], { timeout: 1000 });
        if (title) entry.title = redactName(title);
        const testId = await el.getAttribute(ATTRIBUTES[1], { timeout: 1000 });
        if (testId) entry.testId = redactName(testId);
        const cls = await el.getAttribute(ATTRIBUTES[2], { timeout: 1000 });
        if (cls) entry.class = redactName(cls);
        const box = await el.boundingBox({ timeout: 1000 });
        if (box) entry.box = { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height) };
        found.push(entry);
      } catch {
        // the element is gone: it is not recorded
      }
    }
  }
  return found;
}

// The output folder must be outside the repository: nothing recorded from IFS may end up in Git
export function assertOutsideRepo(dir, repoRoot) {
  const rel = relative(resolve(repoRoot), resolve(dir));
  // on another drive, relative() gives an absolute path: that is outside too
  const inside = rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  if (inside) throw new Error("The inspection folder is inside the repository. Choose a folder outside it.");
}

// Records the page that is open now. Only pages of the configured IFS host are recorded.
export async function recordPage(page, baseHost, n, now = new Date()) {
  let here;
  try {
    here = new URL(page.url());
  } catch {
    return { recorded: false, reason: "The page has no address yet." };
  }
  if (here.host !== baseHost) return { recorded: false, reason: `The page is not on ${baseHost}, so it was not recorded.` };

  const frames = [];
  let index = 0;
  for (const frame of page.frames()) {
    let frameHost = "";
    try {
      frameHost = new URL(frame.url()).host;
    } catch {
      continue;
    }
    if (frameHost !== baseHost) continue;
    try {
      const yaml = await frame.locator("body").ariaSnapshot({ timeout: 15_000 });
      const { controls, roleCounts, dataCells } = summarizeAriaSnapshot(yaml);
      frames.push({ index: index++, path: cleanPath(frame.url()), controls, roleCounts, dataCells, unnamed: await readUnnamed(frame) });
    } catch {
      frames.push({ index: index++, path: cleanPath(frame.url()), controls: [], note: "This frame could not be read." });
    }
  }
  return { recorded: true, snapshot: { n, time: now.toISOString(), path: cleanPath(page.url()), title: redactName(await page.title().catch(() => "")), frames } };
}

// An outline that is easy to read: one control per line, indented
export function outlineOf(snapshots) {
  const lines = [];
  for (const s of snapshots) {
    lines.push(`## ${s.n}. ${s.title || "(no title)"}  ${s.path}`);
    for (const f of s.frames) {
      if (s.frames.length > 1) lines.push(`  [frame ${f.index}] ${f.path}`);
      for (const c of f.controls) lines.push(`${"  ".repeat(c.depth + 1)}${c.role}${c.name ? ` "${c.name}"` : ""}`);
      if (f.roleCounts) {
        const counts = Object.entries(f.roleCounts).sort((a, b) => b[1] - a[1]).map(([role, n]) => `${role}:${n}`);
        lines.push(`  [roles on the page] ${counts.join(" ")}${f.dataCells ? ` | grid cells left out: ${f.dataCells}` : ""}`);
      }
      if (f.unnamed && f.unnamed.length > 0) {
        lines.push("  [controls without a name]");
        for (const u of f.unnamed) {
          const where = u.box ? ` at ${u.box.x},${u.box.y} (${u.box.w}x${u.box.h})` : "";
          lines.push(`    ${u.role} #${u.nth}${u.title ? ` title "${u.title}"` : ""}${u.testId ? ` testId "${u.testId}"` : ""}${u.class ? ` class "${u.class}"` : ""}${where}`);
        }
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}

const LOGIN_PATH = /(login|log-in|signin|sign-in|logon|openid|oauth|authorize|\/auth\b)/i;

export const INSTRUCTIONS = [
  "",
  "A browser window is open. Navigate to the Quick Reports screens yourself.",
  "This script never clicks, types or changes anything. Do not press New, Save, Delete or Run in IFS while you look around.",
  "Wait until the page has finished loading (fields and buttons are all visible) before you press Enter.",
  "  Enter   record the page that is open now (the page name and the labels of its controls, no data)",
  "  q       quit and close the browser",
  "",
].join("\n");

// deps: { playwright, baseUrl, storageState, outDir, lines (async iterable of the lines the consultant types), out, now }
export async function runInspection({ playwright, baseUrl, storageState, outDir, lines, out = console.log, now = () => new Date() }) {
  const baseHost = new URL(baseUrl).host;
  const snapshots = [];
  const stamp = now().toISOString().replace(/[:.]/g, "-");
  const file = join(outDir, `inspection-${stamp}.json`);
  const outline = join(outDir, `inspection-${stamp}.outline.txt`);
  mkdirSync(outDir, { recursive: true });

  const save = () => {
    writeFileSync(file, JSON.stringify({ host: baseHost, startedAt: stamp, screenshots: "never taken", snapshots }, null, 2));
    writeFileSync(outline, outlineOf(snapshots));
  };

  const browser = await playwright.chromium.launch({ headless: false });
  try {
    const context = await browser.newContext({ storageState });
    const page = await context.newPage();
    await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    const here = new URL(page.url());
    if (here.host !== baseHost || LOGIN_PATH.test(here.pathname)) {
      out("IFS asks for a sign-in: the saved session has expired. Save it again (see apps/api/README.md). Nothing was recorded.");
      return { file: null, snapshots: 0, outcome: "auth_required" };
    }
    out(INSTRUCTIONS);
    for await (const line of lines) {
      const command = String(line).trim().toLowerCase();
      if (command === "q" || command === "quit") break;
      if (command !== "") {
        out("Press Enter to record the page, or q to quit.");
        continue;
      }
      if (page.isClosed()) {
        out("The browser window was closed.");
        break;
      }
      const result = await recordPage(page, baseHost, snapshots.length + 1, now());
      if (!result.recorded) {
        out(result.reason);
        continue;
      }
      snapshots.push(result.snapshot);
      save();
      const count = result.snapshot.frames.reduce((sum, f) => sum + f.controls.length, 0);
      out(`Recorded page ${result.snapshot.n}: ${result.snapshot.title || result.snapshot.path} (${count} controls).`);
    }
  } finally {
    await browser.close().catch(() => {});
  }
  if (snapshots.length > 0) out(`Saved: ${file}\nOutline: ${outline}`);
  else out("Nothing was recorded.");
  return { file: snapshots.length > 0 ? file : null, snapshots: snapshots.length, outcome: "done" };
}

// What the inspection needs, checked before anything is opened. Nothing here touches the network or reads the session file.
// env: { IFS_BASE_URL, IFS_STORAGE_STATE, IFS_INSPECTION_DIR }; deps: { fileExists, playwrightInstalled, chromiumInstalled, repoRoot }
export function inspectionSetup(env, { fileExists, playwrightInstalled, chromiumInstalled, repoRoot }) {
  const problems = [];
  let baseUrl = "";
  try {
    const u = new URL(String(env.IFS_BASE_URL ?? "").trim());
    if (u.protocol === "https:") baseUrl = u.href;
  } catch {
    // reported below
  }
  if (!baseUrl) problems.push("IFS_BASE_URL is not set to the https address of the IFS environment.");

  const storageState = String(env.IFS_STORAGE_STATE ?? "").trim();
  if (!storageState) problems.push("IFS_STORAGE_STATE is not set.");
  else if (!fileExists(storageState)) problems.push("The session file in IFS_STORAGE_STATE does not exist.");

  const outDir = String(env.IFS_INSPECTION_DIR ?? "").trim();
  if (!outDir) problems.push("IFS_INSPECTION_DIR is not set. It is the folder for the recordings, outside the repository.");
  else {
    try {
      assertOutsideRepo(outDir, repoRoot);
    } catch (err) {
      problems.push(err.message);
    }
  }
  if (!playwrightInstalled()) problems.push("Playwright is not installed (npm install playwright, in apps/api).");
  else if (!chromiumInstalled()) problems.push("The Chromium browser is not installed (npx playwright install chromium, in apps/api).");
  return { ok: problems.length === 0, problems, config: { baseUrl, storageState, outDir } };
}
