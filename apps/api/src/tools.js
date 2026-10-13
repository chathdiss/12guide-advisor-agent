// The search tools of the Advisor agent. After the first search (done by the backend before the question is sent to n8n)
// the agent may look further itself: search again with its own words, find the files named like an entity, or read more of
// a document it was shown a part of. n8n's AI Agent node calls these over HTTP (HTTP Request tool nodes that call
// /api/internal/tools/<request id>/<tool>, see server.js) and loops until it has what it needs.
//
// Every passage a tool returns is kept in the evidence of the question (evidence.js) under the next number, so the agent
// cites it as [n] and the backend can check the marker. The answer of a tool is text in the same <source> format as the
// passages that come with the question.
import { buildPassages } from "./knowledge.js";
import { entitySummary, parseEntityModel } from "../../../packages/knowledge/src/entity.js";

const RESULT_CHARS = 40_000; // the text one tool call may return
const READ_CHARS = 14_000; // one piece of a document
const SOURCES = {
  documentation: ["IFS documentation"],
  code: ["IFS source code"],
  community: ["IFS community", "IFS technical blog"],
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
export function createTools({ db, search, searchAll, loadFull, findNames = null }) {
  const shape = async (found) => {
    const full = loadFull ? await loadFull(db, found.filter((r) => r.url).map((r) => r.path)) : new Map();
    return buildPassages(found, full, { budget: RESULT_CHARS });
  };

  return {
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
      return shape(found);
    },

    // The files that are named like an entity: "customer order line" is CustomerOrderLine.plsql. `model` asks for the model
    // files (entity, projection, client, fragment) instead of the package files.
    async findFiles({ name, model = false }) {
      const text = String(name ?? "").trim().slice(0, 200);
      if (text.length < 3 || !findNames) return [];
      return shape(await findNames(db, model ? `${text} model` : text, { limit: 6 }));
    },

    // What an entity is: its columns, key, parent (header) entity and references, read from its .entity model file. This is how the
    // agent checks that a column exists, and whether an entity is a header or a line, before it puts them in a query.
    async describeEntity({ name }) {
      const letters = String(name ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
      if (letters.length < 3) return { passages: [], note: "Give the name of an entity, for example 'customer order' or CustomerOrderLine." };
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
