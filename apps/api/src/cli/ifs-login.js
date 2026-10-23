// Saves a signed-in IFS session: `npm run ifs:login` in apps/api (see the README). You sign in yourself in the browser that opens; this never types a
// user name or a password, and never shows the session.
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { assertOutsideRepo } from "../ifs-inspect.js";
import { saveSession } from "../ifs-login.js";

const require = createRequire(import.meta.url);
const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));

let playwright = null;
try {
  require.resolve("playwright");
  playwright = await import("playwright");
} catch {
  playwright = null;
}

const problems = [];
let baseUrl = "";
try {
  const u = new URL(String(process.env.IFS_BASE_URL ?? "").trim());
  if (u.protocol === "https:") baseUrl = u.href;
} catch {
  // reported below
}
if (!baseUrl) problems.push("IFS_BASE_URL is not set to the https address of the IFS environment.");
const storageState = String(process.env.IFS_STORAGE_STATE ?? "").trim();
if (!storageState) problems.push("IFS_STORAGE_STATE is not set. It is the file where the session is saved, outside the repository.");
else {
  try {
    assertOutsideRepo(storageState, repoRoot);
  } catch {
    problems.push("IFS_STORAGE_STATE is inside the repository. A session must never be in Git: choose a folder outside it.");
  }
}
if (!playwright) problems.push("Playwright is not installed (npm install playwright, in apps/api).");
else if (!existsSync(playwright.chromium.executablePath())) problems.push("The Chromium browser is not installed (npx playwright install chromium, in apps/api).");
if (problems.length > 0) {
  console.error("This cannot start:\n" + problems.map((p) => `  - ${p}`).join("\n"));
  process.exit(1);
}

console.log(
  [
    "",
    "Save a signed-in IFS session",
    `  Environment : ${new URL(baseUrl).host}`,
    `  Saved to    : ${storageState}  ${existsSync(storageState) ? "(this replaces the session that is there)" : ""}`,
    "  A browser opens at IFS. You sign in yourself; nothing is typed for you, and the session is never shown.",
    "",
  ].join("\n"),
);

const rl = createInterface({ input: process.stdin, output: process.stdout });
const lines = rl[Symbol.asyncIterator]();
process.stdout.write("Type yes to open the IFS sign-in, anything else to cancel: ");
const answer = await lines.next();
if (answer.done || String(answer.value).trim().toLowerCase() !== "yes") {
  console.log("Cancelled. IFS was not opened.");
  rl.close();
  process.exit(0);
}
try {
  await saveSession({ playwright, baseUrl, storageState, lines: { [Symbol.asyncIterator]: () => lines } });
} catch (err) {
  console.error(`It stopped: ${String(err?.message ?? err).split("\n")[0].slice(0, 200)}`);
  process.exitCode = 1;
} finally {
  rl.close();
}
