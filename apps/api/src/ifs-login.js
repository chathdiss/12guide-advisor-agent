// Saves a signed-in IFS session for the scripts that open IFS with it (npm run ifs:login). A visible browser opens at IFS, the CONSULTANT signs in (user
// name, password and any second step) and presses Enter in the terminal; only then is the session written to the file of IFS_STORAGE_STATE.
//
// This code never types, clicks or reads what is on the page: it opens the address, waits for the consultant, checks that the page is not the sign-in
// page any more, and saves the cookies and local storage of the browser. The browser starts clean, so an old session cannot be mistaken for the new one.
// The content of the session is never printed. The file is replaced only when the new session has been written whole.
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { asksForSignIn } from "./ifs-signin.js";

export const LOGIN_INSTRUCTIONS = [
  "",
  "A browser window is open at IFS. Sign in there yourself, including any second step.",
  "When the IFS home page is open, come back here and press Enter. The session is saved then, and not before.",
  "  Enter   save the session you are signed in with",
  "  q       quit without saving",
  "",
].join("\n");

// deps: { playwright, baseUrl, storageState, lines (async iterable of what the consultant types), out }
export async function saveSession({ playwright, baseUrl, storageState, lines, out = console.log }) {
  const host = new URL(baseUrl).host;
  const browser = await playwright.chromium.launch({ headless: false });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    out(LOGIN_INSTRUCTIONS);
    for await (const line of lines) {
      const command = String(line).trim().toLowerCase();
      if (command === "q" || command === "quit") {
        out("Nothing was saved.");
        return { saved: false };
      }
      if (command !== "") {
        out("Press Enter when you are signed in, or q to quit.");
        continue;
      }
      if (page.isClosed()) {
        out("The browser window was closed. Nothing was saved.");
        return { saved: false };
      }
      if (await asksForSignIn(page, host)) {
        out("IFS still shows the sign-in page. Sign in, wait for the home page, and press Enter again.");
        continue;
      }
      let state;
      try {
        state = await context.storageState();
      } catch {
        out("The session could not be read from the browser. Nothing was saved.");
        return { saved: false };
      }
      if (!Array.isArray(state.cookies) || state.cookies.length === 0) {
        out("The browser has no session yet. Sign in first, then press Enter again.");
        continue;
      }
      mkdirSync(dirname(storageState), { recursive: true });
      const next = `${storageState}.new`;
      writeFileSync(next, JSON.stringify(state, null, 2));
      renameSync(next, storageState);
      out(`Saved the session to ${storageState} (${state.cookies.length} cookies; its content is not shown).`);
      out("It expires after some hours. When IFS asks for a sign-in again, run this command again.");
      return { saved: true, cookies: state.cookies.length };
    }
    out("Nothing was saved.");
    return { saved: false };
  } finally {
    await browser.close().catch(() => {});
  }
}
