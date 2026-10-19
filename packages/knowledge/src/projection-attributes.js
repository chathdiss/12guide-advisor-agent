// Cards for the attributes and lookups that the entity set cards of the projection export leave out.
//
// An entity set card of the export lists the first 100 attributes and 25 lookups, then says "(+98 more attributes)" or "(+35 more)".
// The whole lists are in properties.csv (one row per attribute, grouped by entity set; 250 MB for the 25R2 export) and in the column
// `navigations` of entity_sets.csv. For every card that was cut, one or more cards are made with what is missing, so that
// "What fields does the customer order entity set have?" can be answered completely. Each of them repeats the heading, the endpoint
// and the key, and says that the first attributes are in the main description of the entity set.
import { csvRows } from "./csv.js";
import { pack } from "./projection-operations.js";

// columns that every entity set has and that the export cards do not list
const SYSTEM = new Set(["luname", "keyref", "objgrants", "objsite"]);

const lineOf = (card, label) => card.text.match(new RegExp(`^${label}:\\s*(.*)$`, "m"))?.[1] ?? "";

// "A (string, max 5, key); B (number); (+98 more attributes)" -> Set("a", "b")
const shownNames = (line, separator, cut) =>
  new Set(
    line
      .split(separator)
      .map((p) => p.trim())
      .filter((p) => p && !p.startsWith("(+"))
      .map((p) => p.split(cut)[0].trim().toLowerCase()),
  );

// the text of one attribute, as the export cards write it: Name (string, max 20, key) ; plus the allowed values
function attributeText(p) {
  const bits = [p.type];
  if (p.format) bits.push(p.format);
  if (p.max_length) bits.push(`max ${p.max_length}`);
  if (/^true$/i.test(p.is_key)) bits.push("key");
  let text = `${p.property} (${bits.join(", ")})`;
  if (p.enum_values) text += ` values: ${p.enum_values.split("|").join(", ")}`;
  // the note about the maximum length is on thousands of attributes and says nothing about this one
  const description = String(p.description ?? "").replace(/\s+/g, " ").replace(/\s*Note: The maxLength may be lesser than[^.]*\.?/i, "").trim();
  if (description) text += ` - ${description.slice(0, 200)}`;
  return text;
}

// joins pieces into lines of about `width` characters
function lines(pieces, width, prefix) {
  const out = [];
  let current = "";
  for (const piece of pieces) {
    if (current && current.length + piece.length + 2 > width) {
      out.push(current);
      current = "";
    }
    current += (current ? "; " : "") + piece;
  }
  if (current) out.push(current);
  return out.map((l, i) => (i === 0 ? `${prefix}${l}` : l));
}

// cards: the cards of the export (see projection-cards.js). propertiesText: the whole text of properties.csv, or "".
// entitySetRows: the rows of entity_sets.csv (csvObjects), or [].
export function buildAttributeCards(cards, propertiesText, entitySetRows, { maxChars = 3400 } = {}) {
  const cut = new Map(); // "projection|entity set" -> { card, missingAttributes: [], missingLookups: [] }
  for (const c of cards) {
    if (c.chunkType !== "entity_set" || !c.entitySet) continue;
    const moreAttributes = /\(\+\d+ more attributes\)/.test(c.text);
    const moreLookups = /\(\+\d+ more\)\s*$/m.test(lineOf(c, "Lookups \\(field -> referenced entity\\)") + "\n");
    if (moreAttributes || moreLookups) cut.set(`${c.projectionName}|${c.entitySet}`, { card: c, moreAttributes, moreLookups, attributes: [], lookups: [] });
  }
  if (cut.size === 0) return [];

  // the attributes that the cards do not show, read from the big file one row at a time
  if (propertiesText) {
    let header = null;
    for (const row of csvRows(propertiesText)) {
      if (!header) {
        header = row.map((h) => String(h).trim().toLowerCase());
        continue;
      }
      const entry = cut.get(`${row[header.indexOf("projection_name")]}|${row[header.indexOf("entity_set")]}`);
      if (!entry || !entry.moreAttributes) continue;
      const p = Object.fromEntries(header.map((h, i) => [h, row[i] ?? ""]));
      if (/^true$/i.test(p.is_navigation) || SYSTEM.has(String(p.property).toLowerCase())) continue;
      if (!entry.shown) entry.shown = shownNames(lineOf(entry.card, "Attributes"), ";", " (");
      if (!entry.shown.has(String(p.property).toLowerCase())) entry.attributes.push(p);
    }
  }

  // the lookups that the cards do not show, from the navigations of entity_sets.csv ("Name -> Entity; Name -> Entity")
  const navigations = new Map(entitySetRows.map((r) => [`${r.projection_name}|${r.entity_set}`, r.navigations ?? ""]));
  for (const [key, entry] of cut) {
    if (!entry.moreLookups) continue;
    const shown = new Set([...shownNames(lineOf(entry.card, "Lookups \\(field -> referenced entity\\)"), ";", " ->"), ...shownNames(lineOf(entry.card, "Child data \\(collections\\)"), ";", " ->")]);
    entry.lookups = (navigations.get(key) ?? "")
      .split(";")
      .map((p) => p.trim())
      .filter((p) => p && !shown.has(p.split("->")[0].trim().toLowerCase()));
  }

  const out = [];
  for (const [key, { card, attributes, lookups }] of cut) {
    if (attributes.length === 0 && lookups.length === 0) continue;
    const endpoint = lineOf(card, "REST endpoint");
    const keys = lineOf(card, "Keys");
    const where = `projection ${card.projectionName}, component ${card.component || "?"}, IFS ${card.ifsVersion || "?"}`;
    const body = [
      ...(attributes.length > 0 ? lines(attributes.map(attributeText), 700, "Fields (attributes), continued: ") : []),
      ...(lookups.length > 0 ? lines(lookups, 700, "Lookups (field -> referenced entity), continued: ") : []),
    ];
    const head = (n, total) =>
      [
        `ENTITY SET: ${card.entitySet}   (${where})   [more fields${total > 1 ? `, part ${n}` : ""}]`,
        endpoint ? `REST endpoint: ${endpoint}` : "",
        keys ? `Keys: ${keys}` : "",
        "More fields of this entity set. The first attributes, the child data and the actions are in the main description of the entity set.",
      ]
        .filter(Boolean)
        .join("\n");
    for (const part of pack(body, head, maxChars)) {
      out.push({
        chunkId: part.total > 1 ? `${key}|more|part${part.number}` : `${key}|more`,
        title: `${card.projectionName} / ${card.entitySet} (more fields${part.total > 1 ? `, part ${part.number} of ${part.total}` : ""})`,
        text: part.text,
        url: card.url,
        ifsVersion: card.ifsVersion,
        sourceType: card.sourceType,
        chunkType: "entity_set_more",
        projectionName: card.projectionName,
        entitySet: card.entitySet,
        component: card.component,
      });
    }
  }
  return out;
}

