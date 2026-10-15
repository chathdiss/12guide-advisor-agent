// Stores single web pages of docs.ifs.com (saved from a browser, see sources/ifs-pages-source.js).
//
//   npm run ingest:pages -- --dir D:\Gotli\advisor-knowledge\ifs-docs-pages
//   npm run ingest:pages:dry -- --dir ...        (checks the checksums, no database)
//
// Safe to run again: unchanged pages are skipped.
import { chunkDocument, hashText } from "../prepare.js";
import { pageToDocument, readRecords, SOURCE_ID } from "../sources/ifs-pages-source.js";
import { inTransaction, refreshTermStats, storeDocument } from "../store.js";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const dir = args[args.indexOf("--dir") + 1];
if (!dir || dir.startsWith("--")) {
  console.error("Give the folder with --dir <path>.");
  process.exit(1);
}

const { records, rejected } = readRecords(dir);
console.log(`${records.length} valid pages, ${rejected} rejected (bad line or checksum mismatch)\n`);

let pool = null;
const known = new Map();
if (!dryRun) {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set. Copy packages/db/.env.example to .env, or use --dry-run.");
    process.exit(1);
  }
  const { default: pg } = await import("pg");
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const sources = [...new Set([SOURCE_ID, ...records.map((r) => r.source ?? SOURCE_ID)])];
  const { rows } = await pool.query("SELECT source, doc_key, meta->>'hash' AS hash FROM knowledge_documents WHERE source = ANY($1)", [sources]);
  rows.forEach((r) => known.set(`${r.source}|${r.doc_key}`, r.hash));
}

let added = 0;
let changed = 0;
let unchanged = 0;
let chunkTotal = 0;
for (const rec of records) {
  const doc = pageToDocument(rec);
  const chunks = chunkDocument(doc.text, doc);
  const hash = hashText(doc.text);
  chunkTotal += chunks.length;
  console.log(`  ${String(chunks.length).padStart(3)} chunks  ${rec.title}`);
  if (!pool) continue;
  const key = `${doc.source}|${doc.docKey}`;
  if (known.get(key) === hash) {
    unchanged++;
    continue;
  }
  known.has(key) ? changed++ : added++;
  await inTransaction(pool, (client) =>
    storeDocument(client, { ...doc, meta: { ...doc.meta, hash } }, chunks),
  );
}
if (pool && added + changed > 0) await refreshTermStats(pool);
if (pool) await pool.end();

console.log(`\n${dryRun ? "DRY RUN (nothing stored)" : "Stored in the database"}`);
console.log(`pages: ${records.length}   chunks: ${chunkTotal}${dryRun ? "" : `   new: ${added}   changed: ${changed}   unchanged: ${unchanged}`}`);
