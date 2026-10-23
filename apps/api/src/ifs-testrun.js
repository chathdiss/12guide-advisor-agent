// The test run of a quick report that exists in IFS: open its run page, fill in the parameters the consultant typed, press Execute, and read what IFS shows:
// the columns (do they match the design?), the first rows, how long it took, an error if there is one, and a screenshot of the result.
//
// This is the only place where the SQL of a design is run, and it is run by IFS (a quick report is a SELECT that IFS runs with the rights of the signed-in
// user), never by this program. It runs only the report whose run page has the title of the approved design, so it cannot run another report. Without
// `execute` it is a REHEARSAL: it opens the report, finds the parameters and fills them in, and does not press Execute: nothing is run.
//
// What is known from the screens: the run page of a report has the title "Quick Report: <title>", one text box for each parameter, named after the
// variable in the SQL (&NameStartsWith: NameStartsWith), and an Execute button. What is NOT known until it has been tried: how the result is laid out. The
// result is looked for as a grid whose column headers are the labels of the design (the quoted aliases of the SQL); when it cannot be read, the screenshot
// still shows what IFS displays. Rows, cell values and the screenshot go to the page of the consultant only: they are not logged and not stored.
import { SIGN_IN_AGAIN, asksForSignIn } from "./ifs-signin.js";

export const RUN_UI = {
  runPath: (id) => `/main/ifsapplications/web/quickreport/${id}`,
  title: (name) => `Quick Report: ${name}`,
  execute: /^Execute$/i,
};
export const MAX_ROWS = 20;
// what IFS shows in a grid that has no rows
export const NO_DATA = /^\(?No data\)?$/i;
const MAX_CELL = 80;
const MAX_SCREENSHOT_BYTES = 1_500_000;
// what may not be in a value that is typed into a parameter: it is put into the SQL as text
export const UNSAFE_VALUE = /['";&]|--|\/\*|\*\//;

const short = (error) => String(error?.message ?? error).split("\n")[0].slice(0, 200);
const escapeRe = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const clip = (text) => String(text ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_CELL);
const same = (a, b) => a.length === b.length && a.every((x, i) => x.toLowerCase() === b[i].toLowerCase());

// design: the normalized design. request: { reportId, params, execute, runUrl, timeoutMs }.
// Returns { ok, outcome, touchedIfs, steps, message, executed?, result?, screenshot? }.
export async function testRunReport(page, design, { reportId, params = {}, execute = false, runUrl, timeoutMs = 30_000 } = {}) {
  const steps = [];
  const add = (name, status, detail) => steps.push({ name, status, detail });
  const end = (ok, outcome, touchedIfs, message, extra = {}) => ({ ok, outcome, touchedIfs, steps, message, ...extra });

  const title = String(design?.report?.title || design?.spec?.title || "").trim();
  const declared = (Array.isArray(design?.parameters) ? design.parameters : []).map((p) => String(p.name));
  const labels = (Array.isArray(design?.columns) ? design.columns : []).map((c) => String(c.label));
  if (!title || labels.length === 0 || !/^\d{1,12}$/.test(String(reportId ?? ""))) {
    add("Prepare", "failed", "The design has no title or no columns, or the report id is not a number.");
    return end(false, "failed", "none", "Nothing was opened in IFS.");
  }
  const host = new URL(runUrl).host;

  // 1. the run page of the report, and a check that it is the report of the approved design
  try {
    await page.goto(runUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await page.getByText(RUN_UI.title(title), { exact: true }).first().waitFor({ state: "visible", timeout: timeoutMs });
    add("Open the report", "ok", "The run page of the report opened, and its title is the title of the approved design. This was a read-only visit.");
  } catch (err) {
    if (await asksForSignIn(page, host)) {
      add("Open the report", "failed", SIGN_IN_AGAIN);
      return end(false, "auth_required", "read-only visit", "IFS needs a new signed-in session. Nothing was run.");
    }
    add("Open the report", "failed", `The run page of the report with id ${reportId} did not open with the title "${title}": ${short(err)}`);
    return end(false, "failed", "read-only visit", "Nothing was run. Check that the report exists in IFS, with this id and this title.");
  }

  // 2. the parameter boxes: one for each declared parameter, named after the variable
  const boxes = new Map();
  try {
    for (const name of declared) {
      const box = page.getByRole("textbox", { name: new RegExp(`^${escapeRe(name)}\\s*$`, "i") }).first();
      await box.waitFor({ state: "visible", timeout: 10_000 });
      boxes.set(name, box);
    }
    add("Find the parameters", "ok", declared.length > 0 ? `Found the boxes of: ${declared.join(", ")}.` : "The report has no parameters.");
  } catch (err) {
    add("Find the parameters", "failed", `A parameter box was not found: ${short(err)}`);
    return end(false, "failed", "read-only visit", "Nothing was run.");
  }

  // 3. the values of the consultant
  const filled = [];
  const left = [];
  try {
    for (const name of declared) {
      const value = String(params[name] ?? "");
      if (value === "") {
        left.push(name);
        continue;
      }
      await boxes.get(name).fill(value, { timeout: 10_000 });
      if ((await boxes.get(name).inputValue({ timeout: 10_000 })) !== value) throw new Error(`The box ${name} does not hold what was typed.`);
      filled.push(name);
    }
    add("Fill in the parameters", "ok", `Filled in: ${filled.join(", ") || "none"}.${left.length > 0 ? ` Left empty: ${left.join(", ")}.` : ""}`);
  } catch (err) {
    add("Fill in the parameters", "failed", `A parameter was not filled in: ${short(err)}`);
    return end(false, "failed", "read-only visit", "Nothing was run.");
  }

  // 4. a rehearsal stops here
  if (!execute) {
    add("Press Execute", "not done", "This was a rehearsal: Execute was not pressed, so the SQL was not run. Switch it on (IFS_TEST_EXECUTE=on) to run it.");
    return end(true, "rehearsed", "read-only visit", "Rehearsal done: the report was opened and its parameters were filled in. The SQL was not run.");
  }

  // 5. run it
  const started = Date.now();
  try {
    await page.getByRole("button", { name: RUN_UI.execute }).first().click({ timeout: timeoutMs });
    add("Press Execute", "ok", "Execute was pressed: IFS runs the SQL of the report now.");
  } catch (err) {
    add("Press Execute", "failed", `The Execute button was not found or not pressed: ${short(err)}`);
    return end(false, "failed", "read-only visit", "Nothing was run.");
  }
  const ran = "ran the report (a read-only SELECT)";

  const screenshot = async () => {
    try {
      const png = await page.screenshot({ type: "png" });
      return png.length <= MAX_SCREENSHOT_BYTES ? `data:image/png;base64,${Buffer.from(png).toString("base64")}` : null;
    } catch {
      return null;
    }
  };

  // the result is a grid with the column labels of the design as its headers; an error of IFS shows as an alert
  const firstHeader = page.getByRole("columnheader", { name: new RegExp(`^${escapeRe(labels[0])}$`, "i") }).first();
  const alert = page.getByRole("alert").first();
  try {
    await firstHeader.or(alert).waitFor({ state: "visible", timeout: timeoutMs * 2 });
  } catch {
    const seconds = Math.round((Date.now() - started) / 100) / 10;
    add("Wait for the result", "failed", `No result within ${seconds} seconds. IFS may still be running the SQL.`);
    return end(false, "timeout", ran, "The SQL was started, but no result appeared in time. Look at the report in IFS.", { screenshot: await screenshot() });
  }
  if (!(await firstHeader.isVisible().catch(() => false))) {
    let message = "";
    try {
      message = clip(await alert.innerText({ timeout: 3000 }));
    } catch {
      // no text to read
    }
    add("Wait for the result", "failed", `IFS showed an error instead of a result${message ? `: ${message}` : ""}.`);
    return end(false, "refused", ran, "IFS did not give a result for this SQL.", { screenshot: await screenshot() });
  }

  // The column headers show at once, and the rows come after (IFS shows a spinner meanwhile): wait until there is a row or "No data", or the rows would be
  // read too early and a report that has rows would look empty.
  const grid = page.getByRole("grid").filter({ has: firstHeader }).first();
  try {
    await grid.getByRole("gridcell").first().or(page.getByText(NO_DATA).first()).waitFor({ state: "visible", timeout: timeoutMs * 2 });
  } catch {
    const waited = Math.round((Date.now() - started) / 100) / 10;
    add("Wait for the result", "failed", `The columns appeared, but the rows were still loading after ${waited} seconds.`);
    return end(false, "timeout", ran, "The SQL was started, but IFS had not finished loading the rows in time. Look at the report in IFS.", { screenshot: await screenshot() });
  }
  const seconds = Math.round((Date.now() - started) / 100) / 10;
  add("Wait for the result", "ok", `The result, with its rows or "No data", appeared after ${seconds} seconds.`);

  // 6. read the columns and the first rows of the result
  let columns = [];
  const rows = [];
  let moreRows = false;
  try {
    // IFS puts a column with a check box (and sometimes a menu) before the data: its header has no name, and the cells of that column are not data.
    // The cells that are kept are those under a header that has a name.
    const headers = (await grid.getByRole("columnheader").allInnerTexts()).map(clip);
    const named = headers.map((h, i) => (h ? i : -1)).filter((i) => i >= 0);
    columns = named.map((i) => headers[i]);
    const all = grid.getByRole("row");
    const count = await all.count();
    for (let i = 0; i < count; i++) {
      const cells = (await all.nth(i).getByRole("gridcell").allInnerTexts()).map(clip);
      if (cells.length === 0) continue; // the header row
      if (rows.length >= MAX_ROWS) {
        moreRows = true;
        break;
      }
      // a row that has a cell for each header: the cells under the named headers; otherwise the last cells, which are the data
      rows.push(cells.length === headers.length ? named.map((n) => cells[n]) : cells.slice(Math.max(0, cells.length - columns.length)));
    }
  } catch {
    columns = [];
  }

  const where = `ran on ${host}`;
  if (columns.length === 0) {
    add("Read the result", "failed", "The result grid could not be read. See the screenshot.");
    return end(false, "ran_unreadable", ran, "The report ran, but its result could not be read. See the screenshot.", { executed: `${where}: the result could not be read`, screenshot: await screenshot() });
  }
  const columnsMatch = same(columns, labels);
  add("Read the result", "ok", `${columns.length} column(s), ${rows.length}${moreRows ? "+" : ""} row(s) read (at most ${MAX_ROWS}).`);
  add("Compare the columns", columnsMatch ? "ok" : "failed", columnsMatch ? "The columns are those of the design, in the same order." : `The columns differ from the design. Design: ${labels.join(", ")}. IFS: ${columns.join(", ")}.`);

  const result = { columns, expectedColumns: labels, columnsMatch, rows, rowCount: rows.length, moreRows, seconds };
  const slow = seconds > 30 ? " It was slow (over 30 seconds): check the SQL before it is used." : "";
  return end(
    columnsMatch,
    columnsMatch ? "tested" : "tested_mismatch",
    ran,
    columnsMatch
      ? `The report ran in ${seconds} seconds and its columns match the design.${rows.length === 0 ? " It returned no rows with these values: that can be right, but the filter is not shown to work yet. Try other values (an empty value returns all rows) before you rely on it." : ""}${slow}`
      : "The report ran, but its columns are not those of the design.",
    { executed: `${where}: ${rows.length}${moreRows ? "+" : ""} row(s) read in ${seconds} s, columns ${columnsMatch ? "match the design" : "differ from the design"}`, result, screenshot: await screenshot() },
  );
}
