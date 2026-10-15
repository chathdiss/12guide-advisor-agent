// Creates the tables of the knowledge base by running the files in packages/db/schema, in order.
//   npm run db:init        (needs DATABASE_URL)
// Every file can be run again safely (IF NOT EXISTS).
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const schemaDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../db/schema");

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set. Copy packages/db/.env.example to .env first.");
  process.exit(1);
}

const { default: pg } = await import("pg");
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

try {
  const files = (await readdir(schemaDir)).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    process.stdout.write(`running ${file} ... `);
    await client.query(await readFile(path.join(schemaDir, file), "utf8"));
    console.log("ok");
  }
} finally {
  await client.end();
}
