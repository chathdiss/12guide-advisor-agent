// The search tools of the Advisor agent. After the first search (done by the backend before the question is sent to n8n)
// the agent may look further itself: search again with its own words, find the files named like an entity, or read more of
// a document it was shown a part of. n8n's AI Agent node calls these over HTTP (HTTP Request tool nodes that call
// /api/internal/tools/<request id>/<tool>, see server.js) and loops until it has what it needs.
//
// Every passage a tool returns is kept in the evidence of the question (evidence.js) under the next number, so the agent
// cites it as [n] and the backend can check the marker. The answer of a tool is text in the same <source> format as the
// passages that come with the question.
import { buildPassages } from "./knowledge.js";
import { reviewDesign } from "../../../packages/quick-reports/src/review-design.js";
import { entitySummary, parseEntityModel } from "../../../packages/knowledge/src/entity.js";
import { columnHitsText, luSummary, referenceTarget, viewSummary } from "../../../packages/knowledge/src/dictionary-summary.js";

const DICTIONARY_ORIGIN = "IFS data dictionary";
// words that say nothing about which column is meant
const COLUMN_FILLER = new Set("the of a an in on for to is are which what where column columns field fields holds hold has have with view views table tables and or".split(" "));

const RESULT_CHARS = 40_000; // the text one tool call may return
const READ_CHARS = 14_000; // one piece of a document
const SOURCES = {
  documentation: ["IFS documentation"],
  code: ["IFS source code"],
  community: ["IFS community", "IFS technical blog"],
  api: ["IFS API documentation"], // the cards of the REST/OData projections: endpoint, keys, fields, actions
};

const clean = (v) => String(v ?? "").replace(/"/g, "'");

// The text that goes back to the agent
export function formatToolResult(passages, { note = "", callsLeft = null } = {}) {
  const parts = [passages.length === 0 ? "<knowledge_status>no_match</knowledge_status>" : "<knowledge_status>ok</knowledge_status>"];
  for (const p of passages) {
    parts.push(
      `<source id="${Number(p.id)}" file="${clean(p.path)}" lines="${Number(p.startLine)}-${Number(p.endLine)}" version="${clean(p.version)}">\n${String(p.content ?? "").replace(/<\/source>/gi, "")}\n</source>`,
    );
  }
  if (note) parts.push(`<tool_note>${note}</tool_note>`);
  if (callsLeft !== null) parts.push(`<tool_note>Tool calls left: ${callsLeft}. At 0, write the answer from the sources you have.</tool_note>`);
  return parts.join("\n\n");
}

// search: searchKnowledge, find: findByName, loadFull: loadDocumentTexts (all from packages/knowledge); `db` is a pg Pool
export function createTools({ db, search, searchAll, loadFull, findNames = null, findApi = null }) {
  const shape = async (found) => {
    const full = loadFull ? await loadFull(db, found.filter((r) => r.url).map((r) => r.path)) : new Map();
    return buildPassages(found, full, { budget: RESULT_CHARS });
  };

  // the columns of a view of the IFS data dictionary (upper case), or null when the dictionary has no such view; it throws when it is not loaded
  const dictionaryLookup = async (view) => {
    const { rows } = await db.query("SELECT DISTINCT column_name FROM dictionary_column WHERE view_name = $1", [String(view).toUpperCase()]);
    return rows.length > 0 ? new Set(rows.map((r) => String(r.column_name).toUpperCase())) : null;
  };

  // --- the IFS data dictionary (packages/db/schema/004_dictionary.sql), when it has been loaded ---

  // The logical unit with this name (CustomerOrderLine), base view (CUSTOMER_ORDER_LINE) or prompt (Customer Order Line).
  // null when there is none, or when the dictionary tables do not exist (the dictionary is not loaded).
  const findLogicalUnit = async (letters) => {
    try {
      for (const key of [letters, letters.length > 4 && letters.endsWith("s") ? letters.slice(0, -1) : null].filter(Boolean)) {
        const { rows } = await db.query(
          `SELECT * FROM dictionary_lu
            WHERE lower(lu_name) = $1 OR replace(lower(base_view), '_', '') = $1 OR replace(lower(lu_prompt), ' ', '') = $1
            ORDER BY (lower(lu_name) = $1) DESC, (base_view <> '') DESC, version DESC LIMIT 1`,
          [key],
        );
        if (rows[0]) return rows[0];
      }
      return null;
    } catch (err) {
      if (err?.code === "42P01") return null; // undefined_table
      throw err;
    }
  };

  // A view of the dictionary by its name, also when it is not the base view of an entity (INVOICE_LEDGER_ITEM_CU_QRY): the columns of a query
  // view are what a quick report or a Lobby data source reads. null when there is none, or when the dictionary is not loaded.
  const describeDictionaryView = async (letters) => {
    try {
      const { rows } = await db.query(
        `SELECT version, view_name, lu_name FROM dictionary_column WHERE replace(lower(view_name), '_', '') = $1 ORDER BY version DESC LIMIT 1`,
        [letters],
      );
      const found = rows[0];
      if (!found) return null;
      const columns = (
        await db.query(
          `SELECT column_name, datatype, prompt, type_flag, required_flag, column_reference, enumeration, row_level_security
             FROM dictionary_column WHERE version = $1 AND view_name = $2 ORDER BY column_index`,
          [found.version, found.view_name],
        )
      ).rows;
      return {
        passages: [
          {
            title: `${found.view_name} (data dictionary view)`,
            path: `dictionary/${found.version}/view/${found.view_name}`,
            origin: DICTIONARY_ORIGIN,
            url: "",
            version: found.version,
            startLine: 1,
            endLine: Math.max(1, columns.length),
            content: viewSummary({ view: found.view_name, luName: found.lu_name, version: found.version, columns }),
          },
        ],
        note: "",
      };
    } catch (err) {
      if (err?.code === "42P01") return null;
      throw err;
    }
  };

  const describeFromDictionary = async (lu) => {
    const { version } = lu;
    const columns = lu.base_view
      ? (await db.query(
          `SELECT column_name, datatype, prompt, type_flag, required_flag, column_reference, enumeration, row_level_security
             FROM dictionary_column WHERE version = $1 AND view_name = $2 ORDER BY column_index`,
          [version, lu.base_view],
        )).rows
      : [];
    const otherViews = (await db.query(
      "SELECT DISTINCT view_name FROM dictionary_column WHERE version = $1 AND lu_name = $2 AND view_name <> $3 ORDER BY 1",
      [version, lu.lu_name, lu.base_view],
    )).rows.map((r) => r.view_name);
    // the detail entities: the logical units that have this one's key as a parent key
    const children = (await db.query(
      `SELECT DISTINCT c.lu_name FROM dictionary_column c
         JOIN dictionary_lu l ON l.version = c.version AND l.lu_name = c.lu_name AND l.base_view = c.view_name
        WHERE c.version = $1 AND c.type_flag = 'P' AND c.lu_name <> $2 AND l.lu_type IN ('Entity', 'EntityWithState')
          AND (c.column_reference = $2 OR c.column_reference LIKE $2 || '(%' OR c.column_reference LIKE $2 || '/%')
        ORDER BY 1`,
      [version, lu.lu_name],
    )).rows.map((r) => r.lu_name);
    const similar = (await db.query(
      `SELECT lu_name FROM dictionary_lu WHERE version = $1 AND lower(lu_name) LIKE $2 AND lu_name <> $3 AND base_view <> ''
        ORDER BY length(lu_name), lu_name LIMIT 20`,
      [version, `${lu.lu_name.toLowerCase()}%`, lu.lu_name],
    )).rows.map((r) => r.lu_name);
    // the base views of the units that are named in the text, so a join can say CustomerOrder (CUSTOMER_ORDER)
    const named = [...new Set([...children, ...columns.filter((c) => c.type_flag === "P").map((c) => referenceTarget(c.column_reference).lu)].filter(Boolean))];
    const viewOf = new Map(
      named.length === 0 ? [] : (await db.query("SELECT lu_name, base_view FROM dictionary_lu WHERE version = $1 AND lu_name = ANY($2)", [version, named])).rows.map((r) => [r.lu_name, r.base_view]),
    );
    return {
      passages: [
        {
          title: `${lu.lu_name} (data dictionary)`,
          path: `dictionary/${version}/${lu.lu_name}`,
          origin: DICTIONARY_ORIGIN,
          url: "",
          version: `${lu.module} ${version}`.trim(),
          startLine: 1,
          endLine: Math.max(1, columns.length),
          content: luSummary({ lu, columns, otherViews, children, similar, viewOf }),
        },
      ],
      note: "",
    };
  };

  return {
    // Columns of entity views whose name or prompt (the label in the screens) has these words, in the data dictionary: which
    // column holds "planned delivery date", and in which views. `entity` limits it to one logical unit.
    async findColumns({ query, entity = "" }) {
      const words = (String(query ?? "").toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => w.length > 1 && !COLUMN_FILLER.has(w)).slice(0, 8);
      if (words.length === 0) return { passages: [], note: "Give the words of the column, for example 'planned delivery date'." };
      const only = String(entity ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
      let version;
      try {
        version = (await db.query("SELECT version FROM dictionary_load WHERE kind = 'column' ORDER BY loaded_at DESC LIMIT 1")).rows[0]?.version;
      } catch (err) {
        if (err?.code !== "42P01") throw err;
      }
      if (!version) return { passages: [], note: "The IFS data dictionary is not loaded, so columns cannot be searched." };
      const search = async (operator) =>
        (await db.query(
          `SELECT c.view_name, c.column_name, c.datatype, c.prompt, c.type_flag, c.column_reference, c.lu_name, l.module
             FROM dictionary_column c
             JOIN dictionary_lu l ON l.version = c.version AND l.lu_name = c.lu_name AND l.base_view = c.view_name
            WHERE c.version = $1
              AND to_tsvector('simple', replace(c.column_name, '_', ' ') || ' ' || c.prompt) @@ to_tsquery('simple', $2)
              AND ($3 = '' OR lower(c.lu_name) = $3 OR replace(lower(l.lu_prompt), ' ', '') = $3 OR replace(lower(c.view_name), '_', '') = $3)
            ORDER BY (replace(lower(c.column_name), '_', '') = $4) DESC, length(c.column_name), length(c.view_name), c.view_name
            LIMIT 25`,
          [version, words.map((w) => `${w}:*`).join(operator), only, words.join("")],
        )).rows;
      // all the words first; when no column has them all, columns that have some of them
      let hits = await search(" & ");
      let widened = false;
      if (hits.length === 0 && words.length > 1) {
        hits = await search(" | ");
        widened = true;
      }
      if (hits.length === 0) return { passages: [], note: `No column of an entity view has the words '${words.join(" ")}'${only ? ` in ${entity}` : ""}.` };
      return {
        passages: [
          {
            title: `Columns matching "${words.join(" ")}" (data dictionary)`,
            path: `dictionary/${version}/columns/${words.join("+")}${only ? `/${only}` : ""}`,
            origin: DICTIONARY_ORIGIN,
            url: "",
            version,
            startLine: 1,
            endLine: hits.length,
            content: columnHitsText(hits, { query: words.join(" "), version }),
          },
        ],
        note: widened ? "No column has all the words; these columns have some of them." : "",
      };
    },

    // The words of the agent, searched in all sources or in one kind of source
    async search({ query, source = "all" }) {
      const text = String(query ?? "").trim().slice(0, 500);
      if (text.length < 2) return [];
      const origins = SOURCES[String(source).toLowerCase()];
      let found;
      if (!origins) {
        found = await searchAll(db, text, 8);
      } else {
        const lists = await Promise.all(origins.map((origin) => search(db, text, { limit: 6, origin, preferCode: origin === "IFS source code" })));
        // the lists are taken in turn, so one origin does not fill the answer
        found = [];
        for (let i = 0; found.length < 8 && lists.some((l) => i < l.length); i++) for (const l of lists) if (l[i] && found.length < 8) found.push(l[i]);
      }
      // for the REST/OData cards the cards that are named like the thing asked about (CustomerOrderSet for "customer order") come first
      if (String(source).toLowerCase() === "api" && findApi) {
        const named = await findApi(db, text, { limit: 4 });
        const seen = new Set(named.map((r) => r.ref ?? `${r.path}#${r.startLine}`));
        found = [...named, ...found.filter((r) => !seen.has(r.ref ?? `${r.path}#${r.startLine}`))].slice(0, 8);
      }
      return shape(found);
    },

    // The files that are named like an entity: "customer order line" is CustomerOrderLine.plsql. `model` asks for the model
    // files (entity, projection, client, fragment) instead of the package files.
    async findFiles({ name, model = false }) {
      const text = String(name ?? "").trim().slice(0, 200);
      if (text.length < 3 || !findNames) return [];
      return shape(await findNames(db, model ? `${text} model` : text, { limit: 6 }));
    },

    // Step 4 of the quick report workflow (packages/quick-reports): the design that the agent wrote is checked and turned into the review
    // page for the consultant. The SQL is NOT run: only its shape and its views and columns in the IFS data dictionary are checked.
    // The answer is plain text for the agent (it is not a source: nothing in it is cited).
    async reviewQuickReport({ designJson }) {
      const r = await reviewDesign(designJson, dictionaryLookup);
      // the page and the design go to the backend, not to the agent: they are put into the answer exactly as they are (quickreport.js)
      return { text: r.text, ...(r.reviewPage ? { artifacts: { reviewPage: r.reviewPage, designJson: r.designJson, ok: r.ok } } : {}) };
    },

    // The same review, as a whole (for the backend, not for the agent): the next steps of a design need its errors, its design and its fingerprint
    async checkQuickReport(designJson) {
      return reviewDesign(designJson, dictionaryLookup);
    },

    // What an entity is: its columns, key, parent (header) entity and references. This is how the agent checks that a column
    // exists, and whether an entity is a header or a line, before it puts them in a query. The IFS data dictionary is used when
    // it is loaded (exact view, table and package names, all columns of the view); otherwise the .entity model file.
    async describeEntity({ name }) {
      const letters = String(name ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
      if (letters.length < 3) return { passages: [], note: "Give the name of an entity, for example 'customer order' or CustomerOrderLine." };
      const lu = await findLogicalUnit(letters);
      if (lu) return describeFromDictionary(lu);
      const view = await describeDictionaryView(letters);
      if (view) return view;
      const { rows: files } = await db.query(
        `SELECT doc_key, title, version, component FROM knowledge_documents
          WHERE origin = 'IFS source code' AND lower(title) = $1 ORDER BY version DESC LIMIT 3`,
        [`${letters}.entity`],
      );
      // entities that start like it (CustomerOrder: CustomerOrderLine, CustomerOrderCharge ...), also when there is no exact match
      const { rows: similar } = await db.query(
        `SELECT DISTINCT regexp_replace(title, '[.]entity$', '') AS name FROM knowledge_documents
          WHERE origin = 'IFS source code' AND lower(title) LIKE $1 AND lower(title) <> $2 ORDER BY 1 LIMIT 15`,
        [`${letters}%.entity`, `${letters}.entity`],
      );
      const others = similar.map((r) => r.name);
      const file = files[0];
      const text = file ? (await loadFull(db, [file.doc_key])).get(file.doc_key) : null;
      const model = text ? parseEntityModel(text) : null;
      if (!file || !model) {
        const hint = others.length > 0 ? ` Entities with a similar name: ${others.join(", ")}.` : "";
        return { passages: [], note: `No entity model file was found for '${String(name).slice(0, 80)}'.${hint}` };
      }
      return {
        passages: [
          {
            title: `${file.title} (entity summary)`,
            path: file.doc_key,
            origin: "IFS source code",
            url: "",
            version: `${file.component ?? ""} ${file.version ?? ""}`.trim(),
            startLine: model.attributeLines[0],
            endLine: model.attributeLines[1],
            content: entitySummary(model, { others }),
          },
        ],
        note: "",
      };
    },

    // More of one document: the lines `from` to `to` of a file, page or topic that an earlier passage showed a part of
    async readDocument({ path, fromLine = 1, toLine = null }) {
      const key = String(path ?? "").trim();
      if (!key || !loadFull) return [];
      const text = (await loadFull(db, [key])).get(key);
      if (!text) return [];
      const lines = text.split("\n");
      const from = Math.min(Math.max(1, Number(fromLine) || 1), lines.length);
      let to = from - 1;
      let used = 0;
      const last = toLine ? Math.min(Math.max(from, Number(toLine) || from), lines.length) : lines.length;
      while (to < last && used + lines[to].length + 1 <= READ_CHARS) used += lines[to++].length + 1;
      if (to < from) return [];
      const meta = (await db.query("SELECT title, origin, url, version, component FROM knowledge_documents WHERE doc_key = $1 LIMIT 1", [key])).rows[0] ?? {};
      return [
        {
          title: meta.title ?? key,
          path: key,
          origin: meta.origin ?? "",
          url: meta.url ?? "",
          version: `${meta.component ?? ""} ${meta.version ?? ""}`.trim(),
          startLine: from,
          endLine: to,
          content: lines.slice(from - 1, to).join("\n"),
        },
      ];
    },
  };
}
