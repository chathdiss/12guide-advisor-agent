// Writes the review page of a design as a Markdown file:   npm run review -- examples/weekly-cash-report.sample.design.json
import { readFileSync, writeFileSync } from "node:fs";
import { reviewMarkdown } from "../review.js";

const file = process.argv[2];
if (!file) {
  console.error("Give the design file, for example examples/weekly-cash-report.sample.design.json");
  process.exit(1);
}
const design = JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, ""));
const out = file.replace(/\.design\.json$/, ".review.md");
writeFileSync(out, reviewMarkdown(design) + "\n");
console.log(`Review page written to ${out}`);
