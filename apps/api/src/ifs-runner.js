// Option A of the quick report flow: create the report in the IFS environment through its web UI with Playwright.
//
// It opens the landing page with a session that the consultant saved earlier (a Playwright storage state file; this code never types a user name or a
// password and never reads the file's content), and then does the steps in the Quick Reports screens (ifs-create.js): open the New Report dialog, fill it
// in with the approved design, and save it. Until the consultant has seen that it finds the fields, it is a REHEARSAL (IFS_REHEARSAL, on by default):
// everything up to Save, then Cancel, so nothing is saved. Testing the report (View Report) is not implemented: the SQL is never run, and its status stays
// 'not run'. Without the switch IFS_AUTOMATION=on nothing here runs at all.
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { UI, createQuickReport } from "./ifs-create.js";
import { SIGN_IN_AGAIN, asksForSignIn } from "./ifs-signin.js";
import { RUN_UI, testRunReport } from "./ifs-testrun.js";

const require = createRequire(import.meta.url);
const playwrightInstalledHere = () => {
  try {
    require.resolve("playwright");
    return true;
  } catch {
    return false;
  }
};

// https address of the environment, or "" for anything else
function cleanHttps(value) {
  try {
    const u = new URL(String(value ?? "").trim());
    return u.protocol === "https:" ? u.href : "";
  } catch {
    return "";
  }
}

// config: { enabled, rehearsal, headed, executeTests, testRun, baseUrl, storageState, fileExists, playwrightInstalled, loadPlaywright, create, timeoutMs }
export function createIfsRunner({
  enabled = false,
  rehearsal = true,
  // headed: also a real run is done in a visible browser (a rehearsal always is), so that the first one can be watched
  headed = false,
  // executeTests: a test run of a report presses Execute, and so runs its SQL in IFS. Without it a test run is a rehearsal that does not.
  executeTests = false,
  baseUrl = "",
  storageState = "",
  fileExists = existsSync,
  playwrightInstalled = playwrightInstalledHere,
  loadPlaywright = () => import("playwright"),
  create = createQuickReport,
  testRun = testRunReport,
  timeoutMs = 30_000,
} = {}) {
  const url = cleanHttps(baseUrl);

  // what is missing before this option can run. Nothing here touches the network.
  function missing() {
    const gaps = [];
    if (!enabled) gaps.push("Automation is switched off. Set IFS_AUTOMATION=on in the backend (only on the computer that runs the automation, never on the hosted backend).");
    if (!url) gaps.push("IFS_BASE_URL is not set to the https address of the IFS environment.");
    if (!storageState) gaps.push("IFS_STORAGE_STATE is not set. It is the file with the signed-in session that you save yourself (see apps/api/README.md).");
    else if (!fileExists(storageState)) gaps.push("The session file in IFS_STORAGE_STATE does not exist. Sign in to IFS yourself and save the session again.");
    if (!playwrightInstalled()) gaps.push("Playwright is not installed (npm install playwright, then npx playwright install chromium, in apps/api).");
    return gaps;
  }

  const answer = (outcome, steps, message, touched = "none") => ({ ok: false, outcome, created: false, touchedIfs: touched, steps, message });

  return {
    availability() {
      const gaps = missing();
      // mode: what choosing the option does. A rehearsal fills in the New Report dialog and cancels it; creating saves the report.
      // testMode: what a test run does. "rehearsal" opens the report and fills in the parameters; "execute" also runs the SQL in IFS.
      return { available: gaps.length === 0, missing: gaps, target: url ? new URL(url).host : null, mode: rehearsal ? "rehearsal" : "create", testMode: executeTests ? "execute" : "rehearsal" };
    },

    // The test run of a report that exists in IFS (ifs-testrun.js), after the consultant asked for it and confirmed it. request: { reportId, params }.
    // A rehearsal is visible; a real run is, when headed is on.
    async test(design, { reportId, params }) {
      const steps = [];
      const gaps = missing();
      if (gaps.length > 0) {
        steps.push({ name: "Configuration", status: "failed", detail: gaps.join(" ") });
        return answer("unavailable", steps, "The test run cannot start yet. Nothing was opened or run in IFS.");
      }
      steps.push({ name: "Configuration", status: "ok", detail: `IFS environment ${new URL(url).host}; saved session found; Playwright installed.` });
      let browser;
      try {
        const { chromium } = await loadPlaywright();
        browser = await chromium.launch({ headless: executeTests && !headed });
        const context = await browser.newContext({ storageState });
        const page = await context.newPage();
        const made = await testRun(page, design, { reportId, params, execute: executeTests, runUrl: new URL(RUN_UI.runPath(reportId), url).href, timeoutMs });
        return { ...made, steps: [...steps, ...made.steps] };
      } catch (err) {
        steps.push({ name: "Open IFS", status: "failed", detail: `Could not open IFS: ${String(err?.message ?? err).split("\n")[0].slice(0, 200)}` });
        return answer("failed", steps, "IFS could not be reached or opened. Nothing was run.");
      } finally {
        await browser?.close().catch(() => {});
      }
    },

    // Runs only after the consultant chose Option A and confirmed it. `design` is the approved design.
    async run(design) {
      const steps = [];
      const add = (name, status, detail) => steps.push({ name, status, detail });
      const gaps = missing();
      if (gaps.length > 0) {
        add("Configuration", "failed", gaps.join(" "));
        return answer("unavailable", steps, "Option A cannot run yet. Nothing was opened or changed in IFS.");
      }
      add("Configuration", "ok", `IFS environment ${new URL(url).host}; saved session found; Playwright installed.`);

      let browser;
      try {
        const { chromium } = await loadPlaywright();
        // a rehearsal is visible, so that the consultant can watch the dialog being filled in and cancelled; a real run is, when headed is on
        browser = await chromium.launch({ headless: !rehearsal && !headed });
        const context = await browser.newContext({ storageState });
        const page = await context.newPage();
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
        await page.waitForLoadState("networkidle", { timeout: timeoutMs }).catch(() => {});
        // an expired session is sent to the sign-in page by the page itself, a moment after it opened
        await page.waitForTimeout(2000);
        if (await asksForSignIn(page, new URL(url).host)) {
          add("Open IFS", "failed", SIGN_IN_AGAIN);
          return answer("auth_required", steps, "IFS needs a new signed-in session. Nothing was created.", "read-only visit");
        }
        add("Open IFS", "ok", "The landing page opened with the saved session. This was a read-only visit.");
        // the steps in the Quick Reports screens, in the same browser
        const made = await create(page, design, { listUrl: new URL(UI.listPath, url).href, rehearsal, timeoutMs });
        return { ...made, steps: [...steps, ...made.steps] };
      } catch (err) {
        add("Open IFS", "failed", `Could not open IFS: ${String(err?.message ?? err).split("\n")[0].slice(0, 200)}`);
        return answer("failed", steps, "IFS could not be reached or opened. Nothing was created.");
      } finally {
        await browser?.close().catch(() => {});
      }
    },
  };
}
