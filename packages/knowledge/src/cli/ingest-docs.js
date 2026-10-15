// Stores the IFS Cloud Technical Documentation in the knowledge base.
//
//   Save https://docs.ifs.com/techdocs/<release>/search.json in a folder outside the repository, then:
//   npm run ingest:docs -- --file D:\Gotli\advisor-knowledge\ifs-techdocs-25r2\search.json --release 25R2
//   npm run ingest:docs:dry -- --file ... --release 25R2        (counts only, no database)
//
// Safe to run again: unchanged pages are skipped.
import { readFileSync } from "node:fs";
import { chunkDocument, hashText } from "../prepare.js";
import { groupPages, ORIGIN, pageToDocument, sourceId } from "../sources/ifs-docs-source.js";
import { inTransaction, refreshTermStats, storeDocument } from "../store.js";

const args = process.argv.slice(2);
const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const dryRun = args.includes("--dry-run");
const file = opt("--file");
const release = opt("--release");
if (!file || !release) {
  console.error("Give the index with --file <path to search.json> and the release with --release <for example 25R2>.");
  process.exit(1);
}
// Other sets of the site (IFS.ai, Lifecycle Experience) say where their pages are and how to label them:
//   --source ifs-aidocs --base-url https://docs.ifs.com/aidocs/ --version "IFS.ai documentation"
const SOURCE_ID = opt("--source") ?? sourceId(release);
const baseUrl = opt("--base-url");
const pageOptions = baseUrl ? { baseUrl, version: opt("--version") ?? release } : release;

const pages = groupPages(JSON.parse(readFileSync(file, "utf8")));
console.log(`${pages.length} pages with text in the ${release} index\n`);

let pool = null;
const known = new Map();
if (!dryRun) {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set. Copy packages/db/.env.example to .env, or use --dry-run.");
    process.exit(1);
  }
  const { default: pg } = await import("pg");
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const { rows } = await pool.query("SELECT doc_key, meta->>'hash' AS hash FROM knowledge_documents WHERE source = $1", [SOURCE_ID]);
  rows.forEach((r) => known.set(r.doc_key, r.hash));
}

let added = 0;
let changed = 0;
let unchanged = 0;
let chunkTotal = 0;
let chars = 0;
const started = Date.now();
for (const page of pages) {
  const doc = pageToDocument(page, pageOptions);
  const chunks = chunkDocument(doc.text, doc);
  const hash = hashText(doc.text);
  chunkTotal += chunks.length;
  chars += doc.text.length;
  if (!pool) continue;
  if (known.get(doc.docKey) === hash) {
    unchanged++;
    continue;
  }
  known.has(doc.docKey) ? changed++ : added++;
  await inTransaction(pool, (client) =>
    storeDocument(client, { source: SOURCE_ID, origin: ORIGIN, ...doc, meta: { ...doc.meta, hash } }, chunks),
  );
}
if (pool && added + changed > 0) await refreshTermStats(pool);
if (pool) await pool.end();

console.log(dryRun ? "DRY RUN (nothing stored)" : "Stored in the database");
console.log(`pages: ${pages.length}   chunks: ${chunkTotal}   text: ${(chars / 1e6).toFixed(1)} M characters   time: ${((Date.now() - started) / 1000).toFixed(0)}s`);
if (!dryRun) console.log(`new: ${added}   changed: ${changed}   unchanged: ${unchanged}`);
