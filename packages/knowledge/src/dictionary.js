// The IFS data dictionary (see packages/db/schema/004_dictionary.sql): reads the two exports and stores them.
//
//   DICTIONARY_SYS_LU_ACTIVE      MODULE, LU_NAME, LU_PROMPT, BASE_TABLE, BASE_VIEW, BASE_PACKAGE, ENABLED_ROWKEY, LOGICAL_UNIT_TYPE
//   DICTIONARY_SYS_VIEW_COLUMN_ACT LU_NAME, VIEW_NAME, COLUMN_NAME, COLUMN_DATATYPE, COLUMN_PROMPT, TYPE_FLAG, REQUIRED_FLAG,
//                                  INSERT_FLAG, UPDATE_FLAG, LOV_FLAG, COLUMN_INDEX, COLUMN_REFERENCE, ENUMERATION, ROW_LEVEL_SECURITY
//
// The columns are found by the names in the header row, so a different column order does not matter, and a missing
// column is reported by name instead of loading nonsense.
import { createHash } from "node:crypto";
import { inTransaction } from "./store.js";

export const DEFAULT_VERSION = "IFS Cloud 25R2";

const LU_HEADERS = ["MODULE", "LU_NAME", "LU_PROMPT", "BASE_TABLE", "BASE_VIEW", "BASE_PACKAGE", "ENABLED_ROWKEY", "LOGICAL_UNIT_TYPE"];
const COLUMN_HEADERS = [
  "LU_NAME", "VIEW_NAME", "COLUMN_NAME", "COLUMN_DATATYPE", "COLUMN_PROMPT", "TYPE_FLAG", "REQUIRED_FLAG", "INSERT_FLAG",
  "UPDATE_FLAG", "LOV_FLAG", "COLUMN_INDEX", "COLUMN_REFERENCE", "ENUMERATION", "ROW_LEVEL_SECURITY",
];

export const fileHash = (buffer) => createHash("sha1").update(buffer).digest("hex");

// rows (the first one is the header) -> objects with the header names as keys
function toObjects(rows, wanted, label) {
  if (rows.length === 0) throw new Error(`${label}: the file has no rows.`);
  const header = rows[0].map((h) => String(h).trim().toUpperCase());
  const missing = wanted.filter((h) => !header.includes(h));
  if (missing.length > 0) throw new Error(`${label}: these columns are missing in the header row: ${missing.join(", ")}.`);
  const at = Object.fromEntries(wanted.map((h) => [h, header.indexOf(h)]));
  const out = [];
  for (const row of rows.slice(1)) {
    const obj = Object.fromEntries(wanted.map((h) => [h, String(row[at[h]] ?? "").trim()]));
    if (obj.LU_NAME) out.push(obj);
  }
  return out;
}

export function parseLuRows(rows) {
  return toObjects(rows, LU_HEADERS, "Logical units").map((r) => ({
    module: r.MODULE,
    luName: r.LU_NAME,
    luPrompt: r.LU_PROMPT,
    baseTable: r.BASE_TABLE,
    baseView: r.BASE_VIEW,
    basePackage: r.BASE_PACKAGE,
    enabledRowkey: r.ENABLED_ROWKEY.toUpperCase() === "TRUE",
    luType: r.LOGICAL_UNIT_TYPE,
  }));
}

export function parseColumnRows(rows) {
  return toObjects(rows, COLUMN_HEADERS, "View columns")
    .filter((r) => r.VIEW_NAME && r.COLUMN_NAME)
    .map((r) => ({
      luName: r.LU_NAME,
      viewName: r.VIEW_NAME,
      columnName: r.COLUMN_NAME,
      datatype: r.COLUMN_DATATYPE,
      prompt: r.COLUMN_PROMPT,
      typeFlag: r.TYPE_FLAG,
      requiredFlag: r.REQUIRED_FLAG,
      insertFlag: r.INSERT_FLAG,
      updateFlag: r.UPDATE_FLAG,
      lovFlag: r.LOV_FLAG,
      columnIndex: Number.parseInt(r.COLUMN_INDEX, 10) || 0,
      columnReference: r.COLUMN_REFERENCE,
      enumeration: r.ENUMERATION,
      rowLevelSecurity: r.ROW_LEVEL_SECURITY,
    }));
}

const BATCH = 5000;

// What was loaded for a version: Map(kind -> file hash)
export async function loadedHashes(pool, version) {
  const { rows } = await pool.query("SELECT kind, file_hash FROM dictionary_load WHERE version = $1", [version]);
  return new Map(rows.map((r) => [r.kind, r.file_hash]));
}

// Replaces what is stored for `version` with the given logical units or columns, in one transaction: a failed load leaves
// the old data as it was.
export async function replaceLogicalUnits(pool, version, lus, hash) {
  await inTransaction(pool, async (client) => {
    await client.query("DELETE FROM dictionary_lu WHERE version = $1", [version]);
    for (let i = 0; i < lus.length; i += BATCH) {
      const part = lus.slice(i, i + BATCH);
      await client.query(
        `INSERT INTO dictionary_lu (version, lu_name, module, lu_prompt, base_table, base_view, base_package, enabled_rowkey, lu_type)
         SELECT $1, * FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::boolean[], $9::text[])
         ON CONFLICT DO NOTHING`,
        [version, part.map((r) => r.luName), part.map((r) => r.module), part.map((r) => r.luPrompt), part.map((r) => r.baseTable), part.map((r) => r.baseView), part.map((r) => r.basePackage), part.map((r) => r.enabledRowkey), part.map((r) => r.luType)],
      );
    }
    await client.query(
      `INSERT INTO dictionary_load (version, kind, file_hash, row_count, loaded_at) VALUES ($1, 'lu', $2, $3, now())
       ON CONFLICT (version, kind) DO UPDATE SET file_hash = EXCLUDED.file_hash, row_count = EXCLUDED.row_count, loaded_at = now()`,
      [version, hash, lus.length],
    );
  });
}

export async function replaceColumns(pool, version, columns, hash, onProgress = () => {}) {
  await inTransaction(pool, async (client) => {
    await client.query("DELETE FROM dictionary_column WHERE version = $1", [version]);
    for (let i = 0; i < columns.length; i += BATCH) {
      const part = columns.slice(i, i + BATCH);
      const col = (key) => part.map((r) => r[key]);
      await client.query(
        `INSERT INTO dictionary_column (version, lu_name, view_name, column_name, datatype, prompt, type_flag, required_flag, insert_flag,
                                        update_flag, lov_flag, column_index, column_reference, enumeration, row_level_security)
         SELECT $1, * FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[],
                                  $10::text[], $11::text[], $12::int[], $13::text[], $14::text[], $15::text[])
         ON CONFLICT DO NOTHING`,
        [version, col("luName"), col("viewName"), col("columnName"), col("datatype"), col("prompt"), col("typeFlag"), col("requiredFlag"), col("insertFlag"), col("updateFlag"), col("lovFlag"), col("columnIndex"), col("columnReference"), col("enumeration"), col("rowLevelSecurity")],
      );
      onProgress(Math.min(columns.length, i + BATCH));
    }
    await client.query(
      `INSERT INTO dictionary_load (version, kind, file_hash, row_count, loaded_at) VALUES ($1, 'column', $2, $3, now())
       ON CONFLICT (version, kind) DO UPDATE SET file_hash = EXCLUDED.file_hash, row_count = EXCLUDED.row_count, loaded_at = now()`,
      [version, hash, columns.length],
    );
  });
}
