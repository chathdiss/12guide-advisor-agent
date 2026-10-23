// Read-only inspection of the IFS Quick Reports screens: `npm run ifs:inspect` in apps/api (see the README). It opens a visible browser with your saved
// session; you navigate, and Enter records the page structure (names and control labels, no data). It never clicks, types or changes anything.
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { inspectionSetup, runInspection } from "../ifs-inspect.js";

const require = createRequire(import.meta.url);
const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));

let playwright = null;
try {
  require.resolve("playwright");
  playwright = await import("playwright");
} catch {
  playwright = null;
}

const setup = inspectionSetup(process.env, {
  fileExists: existsSync,
  playwrightInstalled: () => playwright !== null,
  chromiumInstalled: () => existsSync(playwright.chromium.executablePath()),
  repoRoot,
});
if (!setup.ok) {
  console.error("The inspection cannot start:\n" + setup.problems.map((p) => `  - ${p}`).join("\n"));
  process.exit(1);
}

const { baseUrl, storageState, outDir } = setup.config;
console.log(
  [
    "",
    "Read-only inspection of IFS",
    `  Environment : ${new URL(baseUrl).host}`,
    `  Session     : the saved session file (its content is never shown or changed)`,
    `  Recordings  : ${outDir}`,
    "  It opens a visible browser. It will not click, type or change anything, and takes no screenshots.",
    "  You navigate yourself and press Enter here to record the page that is open.",
    "",
  ].join("\n"),
);

const rl = createInterface({ input: process.stdin, output: process.stdout });
const lines = rl[Symbol.asyncIterator]();
process.stdout.write("Type yes to open IFS, anything else to cancel: ");
const answer = await lines.next();
if (answer.done || String(answer.value).trim().toLowerCase() !== "yes") {
  console.log("Cancelled. IFS was not opened.");
  rl.close();
  process.exit(0);
}

try {
  await runInspection({ playwright, baseUrl, storageState, outDir, lines: { [Symbol.asyncIterator]: () => lines } });
} catch (err) {
  console.error(`The inspection stopped: ${String(err?.message ?? err).split("\n")[0].slice(0, 200)}`);
  process.exitCode = 1;
} finally {
  rl.close();
}
