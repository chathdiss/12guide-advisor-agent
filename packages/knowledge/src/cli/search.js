// Try the search from the command line:
//   npm run search -- "currency amount"
import { queryTerms, searchKnowledge } from "../search.js";

const query = process.argv.slice(2).join(" ").trim();
if (!query) {
  console.error('Give a question, for example: npm run search -- "currency amount"');
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set (packages/db/.env).");
  process.exit(1);
}

const { default: pg } = await import("pg");
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });

try {
  const counts = await pool.query(
    "SELECT (SELECT count(*) FROM knowledge_documents) AS documents, (SELECT count(*) FROM knowledge_chunks) AS chunks",
  );
  console.log(`knowledge base: ${counts.rows[0].documents} documents, ${counts.rows[0].chunks} chunks`);
  console.log(`question: ${query}`);
  console.log(`search terms: ${queryTerms(query).join(", ") || "(none)"}\n`);

  const started = Date.now();
  const results = await searchKnowledge(pool, query);
  console.log(`${results.length} results in ${Date.now() - started} ms\n`);

  results.forEach((r, i) => {
    console.log(`${i + 1}. [${r.ref}] ${r.path}  lines ${r.startLine}-${r.endLine}   (${r.component} ${r.version}, coverage ${r.coverage}, score ${r.score})`);
    const snippet = r.content.split("\n").filter((l) => l.trim()).slice(0, 3).map((l) => "     " + l.trim().slice(0, 110));
    console.log(snippet.join("\n") + "\n");
  });
} finally {
  await pool.end();
}
