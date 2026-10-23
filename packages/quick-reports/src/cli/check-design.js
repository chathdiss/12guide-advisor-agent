// Checks a quick report design file:   npm run check -- examples/weekly-cash-report.sample.design.json
import { readFileSync } from "node:fs";
import { checkDesign } from "../check-design.js";

const file = process.argv[2];
if (!file) {
  console.error("Give the design file, for example examples/weekly-cash-report.sample.design.json");
  process.exit(1);
}
const design = JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, ""));
const { ok, errors, warnings } = checkDesign(design);
errors.forEach((e) => console.log(`ERROR    ${e}`));
warnings.forEach((w) => console.log(`WARNING  ${w}`));
console.log(ok ? `\nOK: ${design.report?.title ?? file} passes the checks.` : `\nFAILED: ${errors.length} error(s).`);
process.exit(ok ? 0 : 1);
