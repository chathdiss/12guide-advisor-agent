// Cards for the entity sets and the actions of the IFS projections, built from operations.csv of the projection export.
//
// The cards of the export itself (chunks.jsonl) are one overview per projection: its purpose, its service root and a cut-off list of
// projection-level actions. They do not name the entity sets, their keys or the actions bound to them, so "Which action releases a
// customer order?" or "How do I create a customer order through REST?" cannot be answered from them. operations.csv has every
// operation of every projection, and from it these cards are made:
//   ENTITY SET <Name>          the create / read calls, the key, the actions and functions bound to it, its navigation properties
//   PROJECTION ACTIONS         the actions of a projection that are not bound to an entity set
//   PROJECTION FUNCTIONS       its functions (the lookup functions Reference_<Name> are only counted)
// The fields (properties) of an entity set are not in the export, and the cards say so, so that the agent does not invent them.
// A projection with many operations gets several cards; each one repeats the heading, so it can be read alone.
//
// A row of operations.csv: projection_name, kind (action, function, bound_action, bound_function, navigation), name, bound_to
// (the entity set), http_method, path (relative to the service root), parameters, summary.

const ADD = /^Add new entity to\s+/i;

// "/CustomerOrderSet(OrderNo='{OrderNo}')/Release" -> ["OrderNo"]; "/CustomerOrderSet" -> []
export function entityKeys(path) {
  const m = String(path ?? "").match(/^\/[A-Za-z0-9_]+\(([^)]*)\)/);
  return m ? m[1].split(",").map((p) => p.split("=")[0].trim()).filter(Boolean) : [];
}

const clip = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 3)}...` : String(s));

// A list of names that is cut between names, never inside one: "A, B, C, and 12 more"
function nameList(names, maxChars) {
  const out = [];
  let size = 0;
  for (const name of names) {
    if (size + name.length + 2 > maxChars && out.length > 0) return `${out.join(", ")}, and ${names.length - out.length} more`;
    out.push(name);
    size += name.length + 2;
  }
  return out.join(", ");
}

// Packs lines into texts of at most `maxChars`, each starting with the heading `head(n, total)`
export function pack(lines, head, maxChars) {
  const parts = [];
  let current = [];
  let size = head(1, 1).length;
  for (const line of lines) {
    if (current.length > 0 && size + line.length + 1 > maxChars) {
      parts.push(current);
      current = [];
      size = head(parts.length + 1, 99).length;
    }
    current.push(line);
    size += line.length + 1;
  }
  if (current.length > 0 || parts.length === 0) parts.push(current);
  return parts.map((p, i) => ({ number: i + 1, total: parts.length, text: `${head(i + 1, parts.length)}\n${p.join("\n")}` }));
}

// overviews: Map(projection name -> { url, component, ifsVersion, purpose, serviceRoot })
// Returns cards in the shape of toCard (see projection-cards.js).
export function buildOperationCards(rows, overviews, { maxChars = 3400 } = {}) {
  const byProjection = new Map();
  for (const r of rows) {
    const name = r.projection_name;
    if (!name || !overviews.has(name)) continue;
    if (!byProjection.has(name)) byProjection.set(name, []);
    byProjection.get(name).push(r);
  }

  const cards = [];
  for (const [projection, ops] of byProjection) {
    const ov = overviews.get(projection);
    const root = ov.serviceRoot || "";
    const common = { url: ov.url ?? "", ifsVersion: ov.ifsVersion ?? "", sourceType: "ifs_projection_api", projectionName: projection, component: ov.component ?? "" };
    const where = `projection ${projection}, component ${ov.component || "?"}, IFS ${ov.ifsVersion || "?"}`;
    const intro = [ov.purpose ? `Purpose of the projection: ${clip(ov.purpose, 300)}` : "", root ? `Service root: ${root}` : ""].filter(Boolean);

    // the entity sets: what has operations bound to it, and what can be created
    const sets = new Map();
    const entry = (name) => {
      if (!sets.has(name)) sets.set(name, { create: null, list: null, byKey: null, keys: [], navs: new Set(), actions: [], functions: [] });
      return sets.get(name);
    };
    for (const o of ops) {
      if (o.bound_to) entry(o.bound_to);
      if (o.kind === "action" && ADD.test(o.summary ?? "")) entry(String(o.summary).replace(ADD, "").trim()).create = o;
    }
    const projectionActions = [];
    const projectionFunctions = new Map();
    let lookups = 0;
    for (const o of ops) {
      const set = o.bound_to ? sets.get(o.bound_to) : null;
      if (o.kind === "bound_action" && set) set.actions.push(o);
      else if (o.kind === "bound_function" && set) set.functions.push(o);
      else if (o.kind === "navigation" && set) set.navs.add(o.name);
      else if (o.kind === "action") {
        if (!ADD.test(o.summary ?? "")) projectionActions.push(o);
      } else if (o.kind === "function") {
        const own = sets.get(o.name);
        if (own && o.path.startsWith(`/${o.name}`)) {
          if (o.path === `/${o.name}`) own.list = o;
          else if (!own.byKey) own.byKey = o;
        } else if (o.name.startsWith("Reference_")) lookups++;
        else if (!projectionFunctions.has(o.name) || o.path.length < projectionFunctions.get(o.name).path.length) projectionFunctions.set(o.name, o);
      }
      if (set && o.path) {
        const keys = entityKeys(o.path);
        if (keys.length > set.keys.length) set.keys = keys;
      }
    }

    const push = (partsOf, idBase, titleBase, extra) =>
      partsOf.forEach((p) =>
        cards.push({
          ...common,
          chunkId: p.total > 1 ? `${projection}|${idBase}|part${p.number}` : `${projection}|${idBase}`,
          chunkType: extra.chunkType,
          title: p.total > 1 ? `${titleBase} (part ${p.number} of ${p.total})` : titleBase,
          text: p.text,
          entitySet: extra.entitySet ?? "",
        }),
      );

    for (const [name, s] of [...sets].sort((a, b) => a[0].localeCompare(b[0]))) {
      const lines = [];
      if (root) lines.push(`Entity set endpoint: ${root}/${name}`);
      if (s.create) lines.push(`Create: POST /${name}  (${s.create.summary})`);
      if (s.list) lines.push(`Read all: GET /${name}  (${s.list.summary})`);
      if (s.byKey) lines.push(`Read one: GET ${s.byKey.path}  (${s.byKey.summary})`);
      lines.push(s.keys.length > 0 ? `Key: ${s.keys.join(", ")}` : "Key: not shown in this export");
      lines.push("Fields (properties): not part of this export.");
      if (s.navs.size > 0) lines.push(`Navigation properties (related data, read with GET after the key): ${nameList([...s.navs], 900)}`);
      const seen = new Set();
      for (const a of s.actions) {
        const key = `${a.name}|${a.path}`;
        if (seen.has(key)) continue;
        seen.add(key);
        lines.push(`Action (POST): ${a.name}: ${clip(a.path, 260)}  (${a.summary})`);
      }
      for (const f of s.functions) lines.push(`Function (GET): ${f.name}: ${clip(f.path, 260)}  (${f.summary})`);
      push(
        pack(lines, (n, t) => `ENTITY SET: ${name}   (${where})${t > 1 ? `   [part ${n}]` : ""}\n${intro.join("\n")}`, maxChars),
        `set|${name}`,
        `${projection}: entity set ${name}`,
        { chunkType: "entity_set", entitySet: name },
      );
    }

    if (projectionActions.length > 0) {
      const seen = new Set();
      const lines = [];
      for (const a of projectionActions) {
        const key = `${a.name}|${a.path}`;
        if (!seen.has(key)) {
          seen.add(key);
          lines.push(`Action (POST): ${a.name}: ${clip(a.path, 260)}  (${a.summary})`);
        }
      }
      push(
        pack(lines, (n, t) => `PROJECTION ACTIONS, not bound to an entity set   (${where})${t > 1 ? `   [part ${n}]` : ""}\n${intro.join("\n")}`, maxChars),
        "actions",
        `${projection}: actions`,
        { chunkType: "projection_actions" },
      );
    }

    if (projectionFunctions.size > 0) {
      const lines = [...projectionFunctions.values()].map((f) => `Function (GET): ${f.name}: ${clip(f.path, 260)}  (${f.summary})`);
      if (lookups > 0) lines.push(`Lookup functions Reference_<Name> (lists of values): ${lookups} operations, not listed one by one.`);
      push(
        pack(lines, (n, t) => `PROJECTION FUNCTIONS   (${where})${t > 1 ? `   [part ${n}]` : ""}\n${intro.join("\n")}`, maxChars),
        "functions",
        `${projection}: functions`,
        { chunkType: "projection_functions" },
      );
    }
  }
  return cards;
}

// What the entity-set cards need from an overview card (the text of projection-cards.js: a line "Purpose: ..." and a line "Service root: ...")
export function overviewOf(card) {
  const line = (label) => card.text.match(new RegExp(`^${label}:\\s*(.+)$`, "m"))?.[1]?.trim() ?? "";
  return { url: card.url, component: card.component, ifsVersion: card.ifsVersion, purpose: line("Purpose"), serviceRoot: line("Service root") };
}
