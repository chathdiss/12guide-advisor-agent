// The text of the data dictionary that the Advisor's tools (apps/api/src/tools.js) give to the agent. Pure functions: the
// database lookups are in tools.js, so this can be tested without a database.
//
// Flags in the dictionary: TYPE_FLAG K = key column, P = parent key (the column that points to the header: the sign of a
// line entity), A = attribute; REQUIRED_FLAG M = mandatory. A column without datatype is a system column (OBJID, OBJVERSION,
// OBJSTATE, OBJEVENTS, OBJKEY) that IFS adds to the view.

const MAX_COLUMNS = 400;
const MAX_LIST = 40;

// "CustomerInfoAddress(customer_no)/NOCHECK" -> { lu: "CustomerInfoAddress", keys: "customer_no" }
export function referenceTarget(reference) {
  const m = String(reference ?? "").match(/^([A-Za-z0-9_]+)(?:\(([^)]*)\))?/);
  return m ? { lu: m[1], keys: m[2] ?? "" } : { lu: "", keys: "" };
}

// STRING(20)/UPPERCASE -> string(20), NUMBER -> number, DATE/DATETIME -> datetime, DATE/DATE -> date
export function shortType(datatype) {
  const t = String(datatype ?? "").trim();
  if (!t) return "";
  if (/^DATE\/DATETIME/i.test(t)) return "datetime";
  if (/^DATE\/DATE/i.test(t)) return "date";
  return t.replace(/\/UPPERCASE$/i, "").toLowerCase();
}

const normalise = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
const more = (total, max) => (total > max ? `, and ${total - max} more` : "");

// The columns as entries. A column and its _DB twin (the database value of an enumeration column) are one entry, marked +DB, and the system
// columns that IFS adds to every view are named once. Every column is still there: only the repetition is gone.
export function columnEntries(columns) {
  const names = new Set(columns.map((c) => c.column_name));
  const entries = [];
  const system = [];
  for (const c of columns) {
    if (!shortType(c.datatype)) {
      system.push(c.column_name);
      continue;
    }
    if (c.column_name.endsWith("_DB") && names.has(c.column_name.slice(0, -3))) continue;
    entries.push(columnText(c) + (names.has(`${c.column_name}_DB`) ? " +DB" : ""));
  }
  return { entries, system };
}

function columnText(c) {
  const parts = [];
  const type = shortType(c.datatype);
  if (!type) return `${c.column_name} (system column)`;
  parts.push(type);
  // the prompt is the label in the user interface; it is only worth saying when it is not just the column name again
  if (c.prompt && normalise(c.prompt) !== normalise(c.column_name)) parts.push(`prompt "${c.prompt}"`);
  if (c.type_flag === "K") parts.push("key");
  else if (c.type_flag === "P") parts.push("parent key");
  else if (c.required_flag === "M") parts.push("mandatory");
  return `${c.column_name} (${parts.join(", ")})`;
}

// lu: a dictionary_lu row. columns: the dictionary_column rows of the base view, in order. viewOf: Map(lu name -> base view)
// for the logical units named in the text. children: logical units that have this one as parent. others: names that start alike.
export function luSummary({ lu, columns = [], otherViews = [], children = [], similar = [], viewOf = new Map() }) {
  const lines = [];
  lines.push(`Logical unit ${lu.lu_name}${lu.lu_prompt ? ` ("${lu.lu_prompt}")` : ""}, module ${lu.module || "unknown"}, type ${lu.lu_type || "unknown"}, from the IFS data dictionary (${lu.version}).`);
  const names = [lu.base_table && `base table ${lu.base_table}`, lu.base_view && `base view ${lu.base_view}`, lu.base_package && `base package ${lu.base_package}`].filter(Boolean);
  lines.push(names.length > 0 ? `${names.join(", ")}.` : "It has no base table or view (it is not a table-based entity).");

  const viewLabel = (name) => (viewOf.get(name) ? `${name} (${viewOf.get(name)})` : name);
  const parents = columns.filter((c) => c.type_flag === "P" && c.column_reference);
  if (parents.length > 0) {
    const byParent = new Map();
    for (const c of parents) {
      const target = referenceTarget(c.column_reference).lu;
      if (!byParent.has(target)) byParent.set(target, []);
      byParent.get(target).push(c.column_name);
    }
    const text = [...byParent].map(([parent, cols]) => `${viewLabel(parent)}, joined on ${cols.join(", ")}`).join("; ");
    lines.push(`Level: DETAIL entity (it has a parent key). ${byParent.size === 1 ? "Parent (header) entity" : "Parent entities"}: ${text}.`);
  } else if (children.length > 0) {
    lines.push(`Level: MASTER (header) entity. It has no parent key. Its detail entities, the entities that carry its key as a parent key: ${children.slice(0, MAX_LIST).map(viewLabel).join(", ")}${more(children.length, MAX_LIST)}.`);
  } else if (columns.length > 0) {
    lines.push("Level: no parent key and no detail entities in the dictionary, so a stand-alone entity.");
  }
  if (parents.length > 0 && children.length > 0) {
    lines.push(`Its own detail entities: ${children.slice(0, MAX_LIST).map(viewLabel).join(", ")}${more(children.length, MAX_LIST)}.`);
  }

  if (columns.length > 0) {
    const keys = columns.filter((c) => c.type_flag === "K" || c.type_flag === "P").map((c) => c.column_name);
    lines.push(`Key columns: ${keys.join(", ") || "none listed"}.`);
    const { entries, system } = columnEntries(columns);
    lines.push(`All ${columns.length} columns of the view ${lu.base_view} (type, prompt, flags; +DB: a column with the suffix _DB holds the database value of the enumeration and is not listed again): ${entries.slice(0, MAX_COLUMNS).join(", ")}${more(entries.length, MAX_COLUMNS)}.`);
    if (system.length > 0) lines.push(`System columns that IFS adds: ${system.join(", ")}.`);

    const joins = columns.filter((c) => c.column_reference && c.type_flag !== "P");
    if (joins.length > 0) {
      const text = joins.slice(0, MAX_LIST).map((c) => {
        const t = referenceTarget(c.column_reference);
        return `${c.column_name} -> ${t.lu}${t.keys ? ` (with ${t.keys})` : ""}`;
      });
      lines.push(`Joins (column -> logical unit it points to): ${text.join(", ")}${more(joins.length, MAX_LIST)}.`);
    }
    const enums = columns.filter((c) => c.enumeration);
    if (enums.length > 0) lines.push(`Enumerations: ${enums.slice(0, MAX_LIST).map((c) => `${c.column_name} -> ${c.enumeration}`).join(", ")}${more(enums.length, MAX_LIST)}.`);
    const secured = columns.filter((c) => c.row_level_security);
    if (secured.length > 0) lines.push(`Row-level security: ${secured.map((c) => `${c.column_name} (${c.row_level_security})`).join(", ")}.`);
  }
  if (otherViews.length > 0) {
    lines.push(`Other views of this logical unit: ${otherViews.slice(0, MAX_LIST).join(", ")}${more(otherViews.length, MAX_LIST)}.`);
  }
  if (similar.length > 0) lines.push(`Other logical units whose name starts like this one: ${similar.slice(0, 20).join(", ")}.`);
  return lines.join("\n");
}

// A view of the dictionary that is not the base view of an entity (INVOICE_LEDGER_ITEM_CU_QRY, a query view): its columns
export function viewSummary({ view, luName = "", version = "", columns = [] }) {
  const { entries, system } = columnEntries(columns);
  const lines = [`View ${view}${luName ? ` of the logical unit ${luName}` : ""} (a view that is not the base view of an entity), from the IFS data dictionary (${version}).`];
  lines.push(`All ${columns.length} columns of the view (type, prompt, flags; +DB: a column with the suffix _DB holds the database value of the enumeration and is not listed again): ${entries.slice(0, MAX_COLUMNS).join(", ")}${more(entries.length, MAX_COLUMNS)}.`);
  if (system.length > 0) lines.push(`System columns that IFS adds: ${system.join(", ")}.`);
  return lines.join("\n");
}

// The hits of a search for columns: one line per column
export function columnHitsText(hits, { query = "", version = "" } = {}) {
  const lines = [`Columns of entity views that match "${query}" in the IFS data dictionary (${version}). One line per column: VIEW.COLUMN (type, prompt) - logical unit, module.`];
  for (const h of hits) {
    const type = shortType(h.datatype);
    const extra = [type, h.prompt && `prompt "${h.prompt}"`, h.type_flag === "K" && "key", h.type_flag === "P" && "parent key", h.column_reference && `-> ${referenceTarget(h.column_reference).lu}`].filter(Boolean);
    lines.push(`${h.view_name}.${h.column_name}${extra.length > 0 ? ` (${extra.join(", ")})` : ""} - ${h.lu_name}${h.module ? `, ${h.module}` : ""}`);
  }
  return lines.join("\n");
}
