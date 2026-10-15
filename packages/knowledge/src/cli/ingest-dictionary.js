// Loads the IFS data dictionary: the logical units and the view columns, from the two Excel exports.
//
//   npm run ingest:dictionary -- --dir D:\Gotli\advisor-knowledge\ifs-dictionary --version "IFS Cloud 25R2"
//   npm run ingest:dictionary:dry -- --dir ...        (reads the files and counts, no database)
//
// The folder holds DICTIONARY_SYS_LU_ACTIVE.xlsx and DICTIONARY_SYS_VIEW_COLUMN_ACT.xlsx (or files that start with those
// names). The tables come from packages/db/schema/004_dictionary.sql (npm run db:init). --version is the release the
// export was made from; the default is IFS Cloud 25R2. Safe to run again: a file that did not change is skipped, and a
// changed one replaces what was stored for that version.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { DEFAULT_VERSION, fileHash, loadedHashes, parseColumnRows, parseLuRows, replaceColumns, replaceLogicalUnits } from "../dictionary.js";
import { readXlsxRows } from "../xlsx.js";

const args = process.argv.slice(2);
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const dryRun = args.includes("--dry-run");
const dir = flag("--dir");
const version = (flag("--version") ?? DEFAULT_VERSION).trim();
if (!dir || dir.startsWith("--")) {
  console.error('Give the folder with --dir <path>, and the release with --version "IFS Cloud 25R2".');
  process.exit(1);
}

const find = (prefix) => {
  const found = readdirSync(dir).filter((f) => f.toUpperCase().startsWith(prefix) && f.toLowerCase().endsWith(".xlsx"));
  if (found.length === 0) {
    console.error(`No file that starts with ${prefix} and ends with .xlsx in ${dir}.`);
    process.exit(1);
  }
  return path.join(dir, found.sort()[0]);
};
const luFile = find("DICTIONARY_SYS_LU");
const columnFile = find("DICTIONARY_SYS_VIEW_COLUMN");

let pool = null;
let known = new Map();
if (!dryRun) {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set. Copy packages/db/.env.example to .env, or use --dry-run.");
    process.exit(1);
  }
  const { default: pg } = await import("pg");
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  known = await loadedHashes(pool, version).catch((err) => {
    console.error(`Could not read the dictionary tables (${err.message}). Run npm run db:init first.`);
    process.exit(1);
  });
}

console.log(`Version: ${version}${dryRun ? "   (dry run: nothing is stored)" : ""}`);

const buffer = readFileSync(luFile);
const luHash = fileHash(buffer);
let luCount = 0;
if (known.get("lu") === luHash) {
  console.log(`logical units: ${path.basename(luFile)} did not change, skipped`);
} else {
  const lus = parseLuRows(readXlsxRows(buffer));
  luCount = lus.length;
  console.log(`logical units: ${lus.length} read from ${path.basename(luFile)}`);
  if (pool) {
    await replaceLogicalUnits(pool, version, lus, luHash);
    console.log("logical units: stored");
  }
}

const columnBuffer = readFileSync(columnFile);
const columnHash = fileHash(columnBuffer);
let columnCount = 0;
if (known.get("column") === columnHash) {
  console.log(`view columns: ${path.basename(columnFile)} did not change, skipped`);
} else {
  console.log(`view columns: reading ${path.basename(columnFile)} (${Math.round(columnBuffer.length / 1048576)} MB) ...`);
  const columns = parseColumnRows(readXlsxRows(columnBuffer));
  columnCount = columns.length;
  console.log(`view columns: ${columns.length} read, ${new Set(columns.map((c) => c.viewName)).size} views, ${new Set(columns.map((c) => c.luName)).size} logical units`);
  if (pool) {
    await replaceColumns(pool, version, columns, columnHash, (n) => process.stdout.write(`\rview columns: stored ${n} of ${columns.length}`));
    console.log("\nview columns: stored");
  }
}
if (pool) await pool.end();
console.log(`\n${dryRun ? "DRY RUN (nothing stored)" : "Done"}   logical units: ${luCount}   view columns: ${columnCount}`);
