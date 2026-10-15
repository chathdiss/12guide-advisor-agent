// Reads the IFS source files and stores them in the knowledge base.
//
//   npm run ingest:ifs:dry -- --dir D:\Gotli\advisor-knowledge\ifs-apps10-upd29     (only counts, no database)
//   npm run ingest:ifs     -- --dir D:\Gotli\advisor-knowledge\ifs-apps10-upd29     (needs DATABASE_URL)
//   add --prune to also remove documents whose file is no longer in the folder
//
// Safe to run again: files that did not change are skipped, so only new and changed files cost time.
//
// The documents stay outside the repository; only this code is committed.
import { prepareDocument } from "../prepare.js";
import { ORIGIN, walkIfsSource } from "../sources/ifs-source.js";
import { refreshTermStats } from "../store.js";

function parseArgs(argv) {
  const args = { dir: process.env.IFS_SOURCE_DIR, dryRun: false, prune: false, limit: Infinity };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dir") args.dir = argv[++i];
    else if (argv[i] === "--dry-run") args.dryRun = true;
    else if (argv[i] === "--prune") args.prune = true;
    else if (argv[i] === "--limit") args.limit = Number(argv[++i]);
  }
  return args;
}

const BATCH = 100; // chunks per INSERT

async function storeDocument(client, file, chunks, hash) {
  const meta = { kind: file.kind, layer: file.layer, path: file.docKey, hash };
  const { rows } = await client.query(
    `INSERT INTO knowledge_documents (source, doc_key, title, origin, url, version, component, meta, indexed_at)
     VALUES ($1, $2, $3, $4, NULL, $5, $6, $7, now())
     ON CONFLICT (source, doc_key) DO UPDATE
       SET title = EXCLUDED.title, origin = EXCLUDED.origin, version = EXCLUDED.version,
           component = EXCLUDED.component, meta = EXCLUDED.meta, indexed_at = now()
     RETURNING id`,
    [file.source, file.docKey, file.title, ORIGIN, file.version, file.component, meta],
  );
  const documentId = rows[0].id;

  // re-running replaces what was stored for this file, so there are never duplicates
  await client.query("DELETE FROM knowledge_chunks WHERE document_id = $1", [documentId]);

  for (let i = 0; i < chunks.length; i += BATCH) {
    const part = chunks.slice(i, i + BATCH);
    const values = [];
    const params = [];
    part.forEach((c, n) => {
      const o = n * 6;
      values.push(`($${o + 1}, $${o + 2}, $${o + 3}, $${o + 4}, $${o + 5}, $${o + 6})`);
      params.push(documentId, c.chunkIndex, c.startLine, c.endLine, c.content, c.searchText);
    });
    await client.query(
      `INSERT INTO knowledge_chunks (document_id, chunk_index, start_line, end_line, content, search_text)
       VALUES ${values.join(", ")}`,
      params,
    );
  }
}

async function main() {
  const { dir, dryRun, prune, limit } = parseArgs(process.argv.slice(2));
  if (!dir) {
    console.error("Give the folder with --dir <path> (or set IFS_SOURCE_DIR).");
    process.exit(1);
  }

  let pool = null;
  if (!dryRun) {
    if (!process.env.DATABASE_URL) {
      console.error("DATABASE_URL is not set. Copy packages/db/.env.example to .env, or use --dry-run.");
      process.exit(1);
    }
    const { default: pg } = await import("pg");
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  }

  // what is stored already: doc_key -> hash of the file it was made from, and the source it belongs to.
  // The doc_key starts with the version folder, so it is unique across the code versions.
  const known = new Map();
  if (pool) {
    const { rows } = await pool.query("SELECT doc_key, source, meta->>'hash' AS hash FROM knowledge_documents WHERE origin = $1", [ORIGIN]);
    rows.forEach((r) => known.set(r.doc_key, { hash: r.hash, source: r.source }));
  }
  const sourcesInFolder = new Set(); // --prune only looks at the versions that are in the folder
  const seen = new Set();
  let added = 0;
  let changed = 0;
  let unchanged = 0;

  const stats = new Map(); // kind -> { files, chunks, chars }
  let files = 0;
  let chunkTotal = 0;
  let charTotal = 0;
  let failed = 0;
  const started = Date.now();

  for await (const file of walkIfsSource(dir)) {
    if (files >= limit) break;
    try {
      const { chunks, characters, hash } = await prepareDocument(file);
      if (chunks.length === 0) continue;
      seen.add(file.docKey);
      sourcesInFolder.add(file.source);

      if (pool && known.get(file.docKey)?.hash === hash) {
        unchanged++;
        continue;
      }
      if (pool) known.has(file.docKey) ? changed++ : added++;

      if (pool) {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await storeDocument(client, file, chunks, hash);
          await client.query("COMMIT");
        } catch (err) {
          await client.query("ROLLBACK");
          throw err;
        } finally {
          client.release();
        }
      }

      files++;
      chunkTotal += chunks.length;
      charTotal += characters;
      const s = stats.get(file.kind) ?? { files: 0, chunks: 0, chars: 0 };
      s.files++;
      s.chunks += chunks.length;
      s.chars += characters;
      stats.set(file.kind, s);

      if (files % 200 === 0) console.log(`  ... ${files} files, ${chunkTotal} chunks`);
    } catch (err) {
      failed++;
      console.warn(`  skipped ${file.docKey}: ${err.message}`);
    }
  }

  let removed = 0;
  if (pool && prune && limit === Infinity) {
    const gone = [...known.entries()].filter(([key, v]) => sourcesInFolder.has(v.source) && !seen.has(key)).map(([key]) => key);
    if (gone.length > 0) {
      await pool.query("DELETE FROM knowledge_documents WHERE origin = $1 AND doc_key = ANY($2)", [ORIGIN, gone]);
    }
    removed = gone.length;
  }

  if (pool && added + changed > 0) await refreshTermStats(pool); // the search weighs words by how rare they are
  if (pool) await pool.end();

  console.log(`\n${dryRun ? "DRY RUN (nothing stored)" : "Stored in the database"}`);
  console.log(`files: ${files}   chunks: ${chunkTotal}   characters: ${(charTotal / 1e6).toFixed(1)} M   skipped: ${failed}   time: ${((Date.now() - started) / 1000).toFixed(1)}s`);
  if (!dryRun) {
    console.log(`new: ${added}   changed: ${changed}   unchanged (skipped): ${unchanged}   removed: ${prune ? removed : "not requested (--prune)"}`);
  }
  console.log(`about ${Math.round(charTotal / 3.5 / 1000)}k tokens of text (for the cost of vectors later)\n`);
  console.log("by kind:");
  [...stats.entries()]
    .sort((a, b) => b[1].chunks - a[1].chunks)
    .forEach(([kind, s]) =>
      console.log(`  ${kind.padEnd(24)} ${String(s.files).padStart(5)} files  ${String(s.chunks).padStart(6)} chunks  ${(s.chars / 1e6).toFixed(2)} M chars`),
    );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
