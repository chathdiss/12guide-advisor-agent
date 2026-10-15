// Stores the IFS posts of the dsj23.me blog in the knowledge base.
//
//   npm run ingest:dsj23:dry     (lists the posts, no database)
//   npm run ingest:dsj23         (needs DATABASE_URL; safe to run again, unchanged posts are skipped)
import { chunkDocument, hashText } from "../prepare.js";
import { fetchPosts, isIfsPost, ORIGIN, postToDocument, SOURCE_ID } from "../sources/dsj23-source.js";
import { inTransaction, refreshTermStats, storeDocument } from "../store.js";

const dryRun = process.argv.includes("--dry-run");

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

const all = await fetchPosts();
const posts = all.filter(isIfsPost);
console.log(`${all.length} posts on the blog, ${posts.length} about IFS\n`);

let added = 0;
let changed = 0;
let unchanged = 0;
let chunkTotal = 0;
for (const post of posts) {
  const doc = postToDocument(post);
  const chunks = chunkDocument(doc.text, doc);
  const hash = hashText(doc.text);
  chunkTotal += chunks.length;
  console.log(`  ${String(post.date).slice(0, 10)}  ${doc.title}  (${chunks.length} chunks)`);
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

console.log(`\n${dryRun ? "DRY RUN (nothing stored)" : "Stored in the database"}`);
console.log(`posts: ${posts.length}   chunks: ${chunkTotal}${dryRun ? "" : `   new: ${added}   changed: ${changed}   unchanged: ${unchanged}`}`);
