// Reads the text of an IFS .entity model file and says what the entity is: its attributes (the columns of its view), its key,
// its parent (header) entity, its references and its states. Used by the Advisor's describe_entity tool (apps/api/src/tools.js).
//
// The files are XML, but mostly diagrams and history comments; only the attribute, association and state lists matter. The
// parts are cut out with plain patterns so that this needs no XML library (the backend has no other dependencies than pg).
// The diagrams and comments are blanked, not removed, so the line numbers still point into the original file.

// CustomerOrderLine -> CUSTOMER_ORDER_LINE (the IFS naming convention for views, tables and columns)
export const toDbName = (name) =>
  String(name)
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toUpperCase();

const tag = (xml, name) => {
  const m = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return m ? m[1].trim() : "";
};
const blank = (text, name) => text.replace(new RegExp(`<${name}>[\\s\\S]*?</${name}>`), (m) => m.replace(/[^\n]/g, " "));
const lineAt = (text, index) => text.slice(0, index).split("\n").length;
const all = (xml, name) => [...xml.matchAll(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "g"))].map((m) => m[1]);

// Returns { name, component, attributes, associations, states, attributeLines: [from, to] }, or null when the text is no entity.
export function parseEntityModel(raw) {
  const text = String(raw ?? "").replace(/\r\n?/g, "\n");
  const slim = blank(blank(text, "DIAGRAMS"), "COMMENTS");
  const a0 = slim.indexOf("<ATTRIBUTES>");
  const a1 = slim.indexOf("</ATTRIBUTES>", a0);
  if (a0 < 0 || a1 < 0) return null;
  const name = tag(slim.slice(0, a0), "NAME");
  if (!name) return null;

  const attributes = all(slim.slice(a0, a1), "ATTRIBUTE")
    .map((a) => ({
      name: tag(a, "NAME"),
      key: tag(a, "IS_PRIMARY_KEY") === "1",
      mandatory: tag(a, "IS_MANDATORY") === "1",
      derived: tag(a, "IS_DERIVED") === "1",
      datatype: tag(a, "DATATYPE"),
    }))
    .filter((a) => a.name);

  const s0 = slim.indexOf("<ASSOCIATIONS>", a1);
  const s1 = s0 < 0 ? -1 : slim.indexOf("</ASSOCIATIONS>", s0);
  const associations =
    s0 < 0 || s1 < 0
      ? []
      : all(slim.slice(s0, s1), "ASSOCIATION")
          .map((a) => ({
            name: tag(a, "NAME"),
            parent: tag(a, "IS_PARENT") === "1",
            to: tag(a, "TO_ENTITY"),
            columns: all(a, "ASSOCIATION_ATTRIBUTE").map((x) => tag(x, "NAME")).filter(Boolean),
          }))
          .filter((a) => a.to);

  const t0 = slim.indexOf("<STATES>", a1);
  const t1 = t0 < 0 ? -1 : slim.indexOf("</STATES>", t0);
  const states = t0 < 0 || t1 < 0 ? [] : all(slim.slice(t0, t1), "STATE").map((s) => tag(s, "NAME")).filter((s) => s && !s.startsWith("{"));

  return { name, component: tag(slim.slice(0, a0), "COMPONENT"), attributes, associations, states, attributeLines: [lineAt(text, a0), lineAt(text, a1)] };
}

const MAX_LIST = 40;

// The text the agent gets: what the entity is, with all its columns. `others` are the names of entities that start like this one.
export function entitySummary(model, { others = [] } = {}) {
  const view = toDbName(model.name);
  const parents = model.associations.filter((a) => a.parent && a.to !== model.name);
  const keys = model.attributes.filter((a) => a.key).map((a) => toDbName(a.name));
  const columns = model.attributes.map((a) => `${toDbName(a.name)} (${(a.datatype || "?").toLowerCase()}${a.key ? ", key" : a.mandatory ? ", mandatory" : ""}${a.derived ? ", derived" : ""})`);
  const refs = model.associations.filter((a) => !a.parent && a.to !== model.name);
  const lines = [
    `Entity ${model.name}${model.component ? ` (component ${model.component})` : ""}, from its entity model file.`,
    `Database view ${view}, table ${view}_TAB (IFS naming convention). The columns of the view are the attributes below, written in upper case with underscores.`,
    parents.length > 0
      ? `Level: DETAIL (line) entity. Parent (header) entity: ${parents.map((p) => `${p.to} (${toDbName(p.to)}), joined on ${p.columns.map(toDbName).join(", ") || "its key columns"}`).join("; ")}.`
      : "Level: no parent entity in the model, so a MASTER (header) entity or a stand-alone one.",
    `Key columns: ${keys.join(", ") || "none listed"}.`,
    `All ${model.attributes.length} attributes (type, key or mandatory): ${columns.join(", ")}.`,
  ];
  if (refs.length > 0) {
    const shown = refs.slice(0, MAX_LIST).map((r) => `${r.to} (${r.columns.map(toDbName).join(", ")})`);
    lines.push(`References to other entities: ${shown.join(", ")}${refs.length > MAX_LIST ? `, and ${refs.length - MAX_LIST} more` : ""}.`);
  }
  if (model.states.length > 0) lines.push(`States: ${model.states.join(", ")}.`);
  if (others.length > 0) {
    lines.push(`Other entities whose name starts like this one (their parent entity is in their own model file; ask describe_entity to see whether they are details of ${model.name}): ${others.slice(0, 15).join(", ")}.`);
  }
  return lines.join("\n");
}
