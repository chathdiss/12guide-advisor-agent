// Checks the SQL of a design against the IFS data dictionary in the Advisor's own knowledge database (no IFS environment needed):
//   npm run check:dictionary -- examples/weekly-cash-report.sample.design.json [--write]
// DATABASE_URL is the Advisor database (packages/db/.env), not an IFS environment. --write stores the result in the design.
import { readFileSync, writeFileSync } from "node:fs";
import { checkAgainstDictionary } from "../dictionary-check.js";

const file = process.argv[2];
if (!file || file.startsWith("--")) {
  console.error("Give the design file, for example examples/weekly-cash-report.sample.design.json");
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set. Run it with: node --env-file=../db/.env src/cli/check-dictionary.js <design>");
  process.exit(1);
}
const { default: pg } = await import("pg");
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
const design = JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, ""));

const version = (await pool.query("SELECT version FROM dictionary_load ORDER BY 1 DESC LIMIT 1").catch(() => ({ rows: [] }))).rows[0]?.version;
const lookup = async (view) => {
  const { rows } = await pool.query("SELECT DISTINCT column_name FROM dictionary_column WHERE view_name = $1", [view]);
  return rows.length > 0 ? new Set(rows.map((r) => r.column_name.toUpperCase())) : null;
};

let failed = false;
const total = { version: version ?? null, sources: [], checked: 0, skipped: 0, unknownViews: [], unknownColumns: [] };
for (const source of design.dataSources) {
  if (!source.sql) {
    console.log(`\n${source.id}: no SQL yet (${source.status ?? "no status"}), skipped`);
    continue;
  }
  const r = await checkAgainstDictionary(source.sql, lookup);
  console.log(`\n${source.id}: ${r.checked} column reference(s) checked, ${r.skipped} skipped (columns of a sub-select)`);
  r.unknownViews.forEach((v) => console.log(`  UNKNOWN VIEW    ${v}`));
  r.unknownColumns.forEach((c) => console.log(`  UNKNOWN COLUMN  ${c.alias}.${c.column} (view ${c.view})`));
  if (r.ok) console.log("  every view and column exists in the data dictionary");
  failed ||= !r.ok;
  total.sources.push(source.id);
  total.checked += r.checked;
  total.skipped += r.skipped;
  total.unknownViews.push(...r.unknownViews);
  total.unknownColumns.push(...r.unknownColumns.map((c) => ({ source: source.id, ...c })));
}
if (process.argv.includes("--write")) design.validation.offlineChecks = total;
if (process.argv.includes("--write")) {
  writeFileSync(file, JSON.stringify(design, null, 2) + "\n");
  console.log(`\nResult written to ${file}`);
}
await pool.end();
process.exit(failed ? 1 : 0);
