// Loads the IFS projection (REST/OData API) cards into the knowledge base, from the export of Export-IfsProjectionDocs.ps1.
//
//   npm run ingest:projections -- --dir D:\Gotli\advisor-knowledge\ifs-projection-export-pojid9a-dev1
//   npm run ingest:projections:dry -- --dir ...        (reads the cards and counts, no database)
//
// --dir is the export folder (it holds chunks.jsonl or chunks.csv). --version-label sets the release shown with the answers;
// by default it comes from the cards (25.2.10.... is IFS Cloud 25R2). --prune removes the stored cards that are no longer in the
// export. Safe to run again: a card that did not change is skipped, a changed one is replaced, a new one is added.
// The export folder and the script that makes it stay outside the repository: the script holds a client secret.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { csvObjects } from "../csv.js";
import { cardToDocument, ORIGIN, readCards, SOURCE_ID, versionLabel } from "../projection-cards.js";
import { buildAttributeCards } from "../projection-attributes.js";
import { buildOperationCards, overviewOf } from "../projection-operations.js";
import { refreshTermStats, storeCardsBulk } from "../store.js";

const args = process.argv.slice(2);
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const dryRun = args.includes("--dry-run");
const dir = flag("--dir");
if (!dir || dir.startsWith("--")) {
  console.error("Give the export folder with --dir <path>.");
  process.exit(1);
}

const { cards: overviews, skipped, from } = readCards(dir);
const cards = [...overviews];

// An older export has only an overview card per projection: it does not name the entity sets, keys and bound actions, but
// operations.csv does, and cards are made from it (projection-operations.js). A newer export has a card per entity set (with its
// fields, endpoint, child data and actions), and then these cards would only repeat it, so they are made only when the export
// has no entity set cards, or with --with-operations. --no-operations never makes them.
const hasEntitySetCards = overviews.some((c) => c.chunkType === "entity_set");
const operationsFile = path.join(dir, "operations.csv");
if (!args.includes("--no-operations") && (!hasEntitySetCards || args.includes("--with-operations")) && existsSync(operationsFile)) {
  const rows = csvObjects(readFileSync(operationsFile, "utf8"));
  const byName = new Map(overviews.filter((c) => c.projectionName).map((c) => [c.projectionName, overviewOf(c)]));
  const ids = new Set(cards.map((c) => c.chunkId));
  const built = buildOperationCards(rows, byName).filter((c) => !ids.has(c.chunkId));
  cards.push(...built);
  const count = (type) => built.filter((c) => c.chunkType === type).length;
  console.log(`operations.csv: ${rows.length} operations -> ${built.length} cards (entity sets: ${count("entity_set")}, projection actions: ${count("projection_actions")}, projection functions: ${count("projection_functions")})`);
}
// The entity set cards of the export stop after 100 attributes and 25 lookups ("(+98 more attributes)"): the whole lists are in
// properties.csv and entity_sets.csv, and cards are made with what is missing (projection-attributes.js). --no-attributes skips this.
const propertiesFile = path.join(dir, "properties.csv");
const entitySetsFile = path.join(dir, "entity_sets.csv");
if (!args.includes("--no-attributes") && existsSync(propertiesFile)) {
  const more = buildAttributeCards(
    cards,
    readFileSync(propertiesFile, "utf8"),
    existsSync(entitySetsFile) ? csvObjects(readFileSync(entitySetsFile, "utf8")) : [],
  );
  cards.push(...more);
  console.log(`properties.csv: ${more.length} cards with the attributes and lookups that the entity set cards leave out`);
}
const label = flag("--version-label") ?? versionLabel(cards.find((c) => c.ifsVersion)?.ifsVersion);
const versions = [...new Set(cards.map((c) => c.ifsVersion).filter(Boolean))];
console.log(`${overviews.length} overview cards read from ${from} (${skipped} rows skipped: no text or id, or a repeated id); ${cards.length} cards in total`);
console.log(`projections: ${new Set(cards.map((c) => c.projectionName).filter(Boolean)).size}   with a link: ${cards.filter((c) => c.url).length}   version: ${label}${versions.length > 0 ? ` (${versions.join(", ")})` : ""}`);

const docs = cards.map((c) => cardToDocument(c, { label }));
const longest = Math.max(...docs.map((d) => d.content.length));
console.log(`the longest card is ${longest} characters`);

if (dryRun) {
  console.log("\nSample cards:");
  for (const d of docs.slice(0, 3)) console.log(`- ${d.title}\n  ${d.url ?? "(no link)"}\n  ${d.content.slice(0, 160).replace(/\s+/g, " ")}...`);
  console.log(`\nDRY RUN (nothing stored): ${docs.length} cards`);
  process.exit(0);
}

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set. Copy packages/db/.env.example to .env, or use --dry-run.");
  process.exit(1);
}
const { default: pg } = await import("pg");
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });

const known = new Map();
(await pool.query("SELECT doc_key, meta->>'hash' AS hash FROM knowledge_documents WHERE source = $1", [SOURCE_ID])).rows.forEach((r) => known.set(r.doc_key, r.hash));

const todo = docs.filter((d) => known.get(d.docKey) !== d.meta.hash);
const added = todo.filter((d) => !known.has(d.docKey)).length;
console.log(`new: ${added}   changed: ${todo.length - added}   unchanged: ${docs.length - todo.length}`);

const BATCH = 300;
let stored = 0;
for (let i = 0; i < todo.length; i += BATCH) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    stored += await storeCardsBulk(client, todo.slice(i, i + BATCH));
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  process.stdout.write(`\rstored ${stored} of ${todo.length}`);
}
if (todo.length > 0) console.log("");

if (args.includes("--prune")) {
  const keep = new Set(docs.map((d) => d.docKey));
  const gone = [...known.keys()].filter((k) => !keep.has(k));
  if (gone.length > 0) await pool.query("DELETE FROM knowledge_documents WHERE source = $1 AND doc_key = ANY($2)", [SOURCE_ID, gone]);
  console.log(`removed ${gone.length} cards that are no longer in the export`);
}
if (todo.length > 0 || args.includes("--prune")) {
  console.log("rebuilding the word statistics ...");
  await refreshTermStats(pool);
  // after thousands of cards were added or removed the planner must see the new sizes, or the searches get slow (27 s instead of 9 s)
  console.log("updating the table statistics ...");
  await pool.query("VACUUM (ANALYZE) knowledge_documents");
  await pool.query("VACUUM (ANALYZE) knowledge_chunks");
}
await pool.end();
console.log(`\nStored in the database (${ORIGIN}): ${docs.length} cards in total, ${todo.length} written this time`);
