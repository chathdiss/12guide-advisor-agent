// Stores the saved IFS Community topics (from crawl-community) in the knowledge base.
//
//   npm run ingest:community -- --dir D:\Gotli\advisor-knowledge\ifs-community-full
//   npm run ingest:community:dry -- --dir ...       (counts only, no database)
//
// Safe to run again: unchanged topics are skipped.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { chunkDocument, hashText } from "../prepare.js";
import { ORIGIN, SOURCE_ID, topicToDocument } from "../sources/community-source.js";
import { inTransaction, refreshTermStats, storeDocument } from "../store.js";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const dir = args[args.indexOf("--dir") + 1];
if (!dir || dir.startsWith("--")) {
  console.error("Give the folder with --dir <path>.");
  process.exit(1);
}

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

const stats = { topics: 0, chunks: 0, chars: 0, added: 0, changed: 0, unchanged: 0, solved: 0, replies: 0 };
const started = Date.now();
const shards = readdirSync(dir).filter((f) => /^topics-\d+\.jsonl$/.test(f)).sort();

for (const shard of shards) {
  // split on the newline character only: readline would also cut at U+2028, which can appear inside a post
  const lines = readFileSync(path.join(dir, shard), "utf8").split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;
    const rec = JSON.parse(line);
    const doc = topicToDocument(rec);
    const chunks = chunkDocument(doc.text, doc);
    const hash = hashText(doc.text);
    stats.topics++;
    stats.chunks += chunks.length;
    stats.chars += doc.text.length;
    stats.replies += rec.replies.length;
    if (rec.solved) stats.solved++;
    if (pool) {
      if (known.get(doc.docKey) === hash) {
        stats.unchanged++;
      } else {
        known.has(doc.docKey) ? stats.changed++ : stats.added++;
        await inTransaction(pool, (client) =>
          storeDocument(client, { source: SOURCE_ID, origin: ORIGIN, ...doc, meta: { ...doc.meta, hash } }, chunks),
        );
      }
    }
    if (stats.topics % 2000 === 0) console.log(`  ${stats.topics} topics ...`);
  }
}
if (pool && stats.added + stats.changed > 0) await refreshTermStats(pool); // the search weighs words by how rare they are
if (pool) await pool.end();

console.log(`\n${dryRun ? "DRY RUN (nothing stored)" : "Stored in the database"}`);
console.log(`topics: ${stats.topics} (${stats.solved} solved)   replies: ${stats.replies}   chunks: ${stats.chunks}   text: ${(stats.chars / 1e6).toFixed(1)} M characters   time: ${((Date.now() - started) / 1000).toFixed(0)}s`);
if (!dryRun) console.log(`new: ${stats.added}   changed: ${stats.changed}   unchanged: ${stats.unchanged}`);
