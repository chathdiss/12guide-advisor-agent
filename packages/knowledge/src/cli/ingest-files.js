// Stores documents that are files (PDF, PowerPoint, Word) in the knowledge base.
//
//   The files and a manifest.json (list of { title, url, file, group }) are in one folder outside the repository.
//   npm run ingest:files -- --dir D:\Gotli\advisor-knowledge\ifs-docs-files
//   npm run ingest:files:dry -- --dir ...        (reads the files and counts, no database)
//
// Every page or slide is marked in the text ("[Page 12]"), and the document is stored with the link of the
// file it came from. Safe to run again: unchanged documents are skipped.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { extractFile } from "../extract-file.js";
import { chunkDocument, hashText } from "../prepare.js";
import { inTransaction, refreshTermStats, storeDocument } from "../store.js";

const SOURCE_ID = "ifs-docs-files";
const ORIGIN = "IFS documentation";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const dir = args[args.indexOf("--dir") + 1];
if (!dir || dir.startsWith("--")) {
  console.error("Give the folder with --dir <path>.");
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8"));

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
let failed = 0;
let chunkTotal = 0;
for (const item of manifest) {
  const file = path.join(dir, item.file);
  if (!existsSync(file)) {
    console.warn(`  missing   ${item.file}`);
    failed++;
    continue;
  }
  try {
    const { kind, unit, pages } = await extractFile(item.file, readFileSync(file));
    const body = pages.map((text, i) => (text.trim() ? `[${unit} ${i + 1}]\n${text}` : "")).filter(Boolean).join("\n\n");
    if (body.trim().length < 200) throw new Error("no text found (a scanned document?)");
    const doc = {
      docKey: item.url,
      url: item.url,
      title: item.title,
      version: kind,
      component: item.group ?? "",
      text: `# ${item.title}\n\nDocument type: ${kind}${item.group ? `, ${item.group}` : ""}\n\n${body}`,
      meta: { group: item.group, kind, units: pages.length, file: item.file },
    };
    const chunks = chunkDocument(doc.text, doc);
    const hash = hashText(doc.text);
    chunkTotal += chunks.length;
    console.log(`  ${kind.padEnd(10)} ${String(pages.length).padStart(5)} ${unit.toLowerCase()}s ${String(chunks.length).padStart(5)} chunks  ${item.title}`);
    if (!pool) continue;
    if (known.get(doc.docKey) === hash) {
      unchanged++;
      continue;
    }
    known.has(doc.docKey) ? changed++ : added++;
    await inTransaction(pool, (client) =>
      storeDocument(client, { source: SOURCE_ID, origin: ORIGIN, ...doc, meta: { ...doc.meta, hash } }, chunks),
    );
  } catch (err) {
    failed++;
    console.warn(`  skipped   ${item.file}: ${err.message}`);
  }
}
if (pool && added + changed > 0) await refreshTermStats(pool);
if (pool) await pool.end();

console.log(`\n${dryRun ? "DRY RUN (nothing stored)" : "Stored in the database"}`);
console.log(`documents: ${manifest.length - failed}   chunks: ${chunkTotal}   skipped: ${failed}${dryRun ? "" : `   new: ${added}   changed: ${changed}   unchanged: ${unchanged}`}`);
