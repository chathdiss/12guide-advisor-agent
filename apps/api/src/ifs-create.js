// Option A of the quick report flow, the part in the IFS screens: open the Quick Reports page, open the New Report dialog, fill it in with the approved
// design, and (unless this is a rehearsal) save it. IFS gives the report its own id, and grants its permissions, as it does for any new report.
//
// What is known from recordings of the screens (ifs-inspect.js): the dialog has Report Title, Type, Category, Domain, Query (only for the type SQL
// Statement), Comments, and Save and Cancel. The Type field is a text field that does NOT open its list when it is clicked: the list (SQL Statement,
// Crystal Reports, MS Report, Dashboard, Web Report, Query Builder, Query Designer) opens with the arrow button right after the field. What is NOT known
// until it has been tried: how the New Report button is found by Playwright, and where IFS goes after Save. That is why a REHEARSAL fills in the dialog
// and then cancels it: nothing is saved, and it shows whether the fields are found and filled. The rehearsal is the default (IFS_REHEARSAL); real
// creation is switched on by the consultant.
//
// Nothing here runs SQL. "View Report" would run it on IFS, and its screens have not been recorded, so the report is created and read back, not tested.
import { commentsFor } from "../../../packages/quick-reports/src/export-xml.js";
import { SIGN_IN_AGAIN, asksForSignIn } from "./ifs-signin.js";

// how the screens are found: all in one place, to adjust after a rehearsal
export const UI = {
  listPath: "/main/ifsapplications/web/page/QuickReport/List",
  heading: "Quick Reports",
  newReport: /New Report/i,
  title: /^Report Title/i,
  type: /^Type/i,
  // the arrow button that opens the Type list: the first button after the Type field
  typeArrow: "xpath=following::button[1]",
  typeOption: /SQL Statement/i,
  query: /^Query/i,
  comments: /^Comments/i,
  // the detail page of a report shows the projection that IFS made for it: QuickReport<id>
  projection: /^Projection Name/i,
  save: /^Save$/i,
  cancel: /^Cancel$/i,
};

const short = (error) => String(error?.message ?? error).split("\n")[0].slice(0, 200);
const sameText = (a, b) => String(a ?? "").replace(/\r\n/g, "\n").trim() === String(b ?? "").replace(/\r\n/g, "\n").trim();

// design: the normalized design. options: { listUrl, rehearsal, timeoutMs }. Returns the result of the run: { ok, outcome, created, touchedIfs, steps, message }.
export async function createQuickReport(page, design, { listUrl, rehearsal = true, timeoutMs = 30_000 } = {}) {
  const steps = [];
  const add = (name, status, detail) => steps.push({ name, status, detail });
  const end = (ok, outcome, created, touchedIfs, message, extra = {}) => ({ ok, outcome, created, touchedIfs, steps, message, ...extra });

  const title = String(design?.report?.title || design?.spec?.title || "").trim();
  const source = (Array.isArray(design?.dataSources) ? design.dataSources : []).find((s) => s && s.sql);
  const sql = source ? source.sql.replace(/\r\n/g, "\n").trim().replace(/;\s*$/, "") : "";
  if (!title || !sql) {
    add("Prepare", "failed", "The design has no title or no SQL.");
    return end(false, "failed", false, "none", "Nothing was opened or changed in IFS.");
  }

  // 1. the Quick Reports page
  try {
    await page.goto(listUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await page.getByRole("heading", { name: UI.heading }).first().waitFor({ state: "visible", timeout: timeoutMs });
    add("Open the Quick Reports page", "ok", "The page opened with the saved session. This was a read-only visit.");
  } catch (err) {
    // an expired session is sent to the sign-in page: that is what the page that did not show up was
    if (await asksForSignIn(page, new URL(listUrl).host)) {
      add("Open the Quick Reports page", "failed", SIGN_IN_AGAIN);
      return end(false, "auth_required", false, "read-only visit", "IFS needs a new signed-in session. Nothing was created.");
    }
    add("Open the Quick Reports page", "failed", `The Quick Reports page did not open: ${short(err)}`);
    return end(false, "failed", false, "read-only visit", "The Quick Reports page could not be opened. Nothing was created.");
  }

  // 2. the New Report dialog
  const dialog = page.getByRole("dialog").first();
  try {
    await page.getByRole("button", { name: UI.newReport }).or(page.getByText(UI.newReport)).first().click({ timeout: timeoutMs });
    await dialog.waitFor({ state: "visible", timeout: timeoutMs });
    add("Open the New Report dialog", "ok", "The dialog is open. Nothing is saved until Save is pressed.");
  } catch (err) {
    add("Open the New Report dialog", "failed", `The New Report button or its dialog was not found: ${short(err)}`);
    return end(false, "failed", false, "read-only visit", "The New Report dialog could not be opened. Nothing was created.");
  }

  const cancel = async () => {
    try {
      await dialog.getByRole("button", { name: UI.cancel }).first().click({ timeout: 10_000 });
      await dialog.waitFor({ state: "hidden", timeout: 10_000 });
      return true;
    } catch {
      return false;
    }
  };

  // 3. fill it in, and read back what the fields hold. `doing` is what it was working on when something went wrong.
  let doing = "the dialog";
  try {
    doing = "the Report Title field";
    const titleField = dialog.getByRole("textbox", { name: UI.title }).first();
    await titleField.fill(title, { timeout: timeoutMs });
    doing = "the arrow of the Type field";
    await dialog.getByRole("textbox", { name: UI.type }).first().locator(UI.typeArrow).click({ timeout: timeoutMs });
    doing = "the option SQL Statement in the Type list";
    await page.getByRole("option", { name: UI.typeOption }).first().click({ timeout: timeoutMs });
    doing = "the Query field";
    const queryField = dialog.getByRole("textbox", { name: UI.query }).first();
    await queryField.fill(sql, { timeout: timeoutMs });
    doing = "the Comments field";
    await dialog.getByRole("textbox", { name: UI.comments }).first().fill(commentsFor(design), { timeout: timeoutMs });
    doing = "reading the fields back";
    const [heldTitle, heldQuery] = [await titleField.inputValue({ timeout: 10_000 }), await queryField.inputValue({ timeout: 10_000 })];
    if (!sameText(heldTitle, title) || !sameText(heldQuery, sql)) throw new Error("The fields do not hold what was typed.");
    add("Fill in the dialog", "ok", "Title, type SQL Statement, query and comments are filled in, and the title and the query were read back.");
  } catch (err) {
    const closed = await cancel();
    add("Fill in the dialog", "failed", `A field was not found or not filled (${doing}): ${short(err)}`);
    return end(false, "failed", false, closed ? "opened the New Report dialog and cancelled it; nothing saved" : "the New Report dialog may still be open; nothing saved", "The dialog could not be filled in. Nothing was created.");
  }

  // 4. a rehearsal stops here
  if (rehearsal) {
    const closed = await cancel();
    add("Save", "not done", "This was a rehearsal: Cancel was pressed, nothing was saved. Switch the rehearsal off (IFS_REHEARSAL=off) to create the report.");
    add("Test the quick report", "not done", "The SQL has not been run on IFS. Its status stays 'not run'.");
    return end(closed, "rehearsed", false, "opened the New Report dialog and cancelled it; nothing saved", closed ? "Rehearsal done: the dialog was filled in and cancelled. Nothing was saved." : "Rehearsal done, but the dialog could not be closed. Close it yourself; nothing was saved.");
  }

  // 5. save, and see whether IFS took it
  try {
    await dialog.getByRole("button", { name: UI.save }).first().click({ timeout: timeoutMs });
    await dialog.waitFor({ state: "hidden", timeout: timeoutMs });
    add("Save", "ok", "Save was pressed and the dialog closed.");
  } catch (err) {
    let reason = short(err);
    try {
      const alert = await page.getByRole("alert").first().innerText({ timeout: 3000 });
      if (alert.trim()) reason = alert.trim().replace(/\s+/g, " ").slice(0, 200);
    } catch {
      // no message to read
    }
    const closed = await cancel();
    add("Save", "failed", `IFS did not take the report: ${reason}`);
    return end(false, "failed", false, closed ? "opened the New Report dialog and cancelled it; nothing saved" : "the New Report dialog may still be open; nothing saved", "IFS did not create the report. Nothing was created.");
  }

  // 6. read it back: IFS shows the new report in its detail page, or in the list
  try {
    const titleBox = page.getByRole("textbox", { name: UI.title }).first();
    await titleBox.waitFor({ state: "visible", timeout: 10_000 });
    const heldTitle = await titleBox.inputValue({ timeout: 10_000 });
    const heldQuery = await page.getByRole("textbox", { name: UI.query }).first().inputValue({ timeout: 10_000 });
    if (sameText(heldTitle, title) && sameText(heldQuery, sql)) {
      // the id that IFS gave the report: it is in the name of its projection, and the test run needs it
      let reportId = null;
      try {
        const projection = await page.getByRole("textbox", { name: UI.projection }).first().inputValue({ timeout: 5000 });
        reportId = (/QuickReport(\d{1,12})$/i.exec(String(projection).trim()) ?? [])[1] ?? null;
      } catch {
        // the id is not read: the consultant can type it for the test run
      }
      add("Check the new report", "ok", `The detail page of the new report shows the title and the SQL that were saved.${reportId ? ` Its id is ${reportId}.` : ""}`);
      add("Test the quick report", "not done", "The SQL has not been run on IFS. Its status stays 'not run'. Use the test run for that.");
      return end(true, "created", true, "quick report created", "The quick report was created and read back. Its SQL has not been run.", { reportId });
    }
  } catch {
    // not on the detail page: look in the list
  }
  try {
    await page.getByText(title, { exact: true }).first().waitFor({ state: "visible", timeout: 10_000 });
    add("Check the new report", "ok", "A report with this title is in the list. Its SQL was not read back.");
    add("Test the quick report", "not done", "The SQL has not been run on IFS. Its status stays 'not run'.");
    return end(true, "created", true, "quick report created", "The quick report was created (found in the list by its title). Its SQL has not been run.", { reportId: null });
  } catch {
    add("Check the new report", "failed", "The dialog closed, but the new report could not be found afterwards.");
    add("Test the quick report", "not done", "The SQL has not been run on IFS. Its status stays 'not run'.");
    return end(false, "created_unverified", true, "quick report possibly created", "Save was accepted, but the report could not be found afterwards. Check the Quick Reports page in IFS before you try again, so that it is not created twice.");
  }
}
