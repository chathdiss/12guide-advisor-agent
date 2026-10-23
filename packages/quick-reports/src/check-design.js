// Checks of a quick report design (see designs/*.design.json) that need no IFS environment. They run before the SQL is test-run:
// the shape of the design, a read-only SQL, the parameters of the SQL against the declared parameters, and the output columns
// against the report layout. Returns { ok, errors, warnings }.
//
// A data source has a status: "ready" (SQL written), "draft" (SQL written, with assumptions that are listed) or "blocked" (no SQL yet,
// because something is unknown; `blockedBy` says what). A column with `dynamic` is repeated, for example once per work centre.

// IFS shows a parameter to the consultant under the name that is written after the & in the SQL, so a name that is a code (P1, PARAM_2), a single letter,
// or has an underscore or a space is not a good one
const UNREADABLE_NAME = /^[A-Za-z]\d*$|^param(?:eter)?_?\d+$|_|\s/i;

const REQUIRED = ["designVersion", "spec", "type", "report", "parameters", "dataSources", "columns", "validation", "openQuestions"];

// words that change data or the session: a quick report only reads
const NOT_READ_ONLY = /\b(INSERT|UPDATE|DELETE|MERGE|DROP|ALTER|TRUNCATE|CREATE|GRANT|REVOKE|EXECUTE|EXEC|BEGIN|DECLARE|CALL|COMMIT|ROLLBACK|LOCK)\b/i;

// a parameter of a quick report is written &Name in the SQL, with optional query flags: &[MC--L]Name. &AO. is the application owner.
const PARAMETER = /&(?:\[[^\]]*\])?([A-Za-z_][A-Za-z0-9_]*)(?![A-Za-z0-9_.])/g;

// removes -- and /* */ comments, but not what stands between quotes: the query flag in '&[MC--L]Name' contains --
function withoutComments(sql) {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (c === "'") {
      let j = i + 1;
      while (j < sql.length && !(sql[j] === "'" && sql[j + 1] !== "'")) j += sql[j] === "'" ? 2 : 1;
      out += sql.slice(i, j + 1);
      i = j + 1;
    } else if (c === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
      out += " ";
    } else if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end < 0 ? sql.length : end + 2;
      out += " ";
    } else {
      out += c;
      i++;
    }
  }
  return out;
}
const withoutLiterals = (sql) => sql.replace(/'(?:[^']|'')*'/g, "''");

export function parametersUsed(sql) {
  return [...new Set([...withoutComments(sql).matchAll(PARAMETER)].map((m) => m[1]))];
}

// the output columns: the quoted aliases of the select list (AS "Customer ID")
export function outputColumns(sql) {
  return [...withoutComments(sql).matchAll(/\bAS\s+"([^"]+)"/gi)].map((m) => m[1]);
}

export function checkDesign(design) {
  const errors = [];
  const warnings = [];
  if (!design || typeof design !== "object") return { ok: false, errors: ["The design is not an object."], warnings };

  for (const key of REQUIRED) if (!(key in design)) errors.push(`Missing "${key}".`);
  if (errors.length > 0) return { ok: false, errors, warnings };

  if (!Array.isArray(design.parameters)) errors.push('"parameters" must be a list.');
  if (!Array.isArray(design.dataSources) || design.dataSources.length === 0) errors.push('"dataSources" must hold at least one data source.');
  if (!Array.isArray(design.columns) || design.columns.length === 0) errors.push('"columns" must hold at least one column.');
  if (errors.length > 0) return { ok: false, errors, warnings };

  const declared = design.parameters.map((p) => p.name);
  if (new Set(declared).size !== declared.length) errors.push("A parameter is declared twice.");

  const used = new Set();
  const withSql = [];
  for (const source of design.dataSources) {
    const id = source.id ?? "(no id)";
    const status = source.status ?? "ready";
    if (!["ready", "draft", "blocked"].includes(status)) errors.push(`Data source ${id}: unknown status "${status}".`);

    if (status === "blocked") {
      if (source.sql) errors.push(`Data source ${id} is blocked and must not have SQL.`);
      if (!Array.isArray(source.blockedBy) || source.blockedBy.length === 0) errors.push(`Data source ${id} is blocked: say by what (blockedBy).`);
      else warnings.push(`Data source ${id} is blocked: ${source.blockedBy.length} thing(s) unknown.`);
      continue;
    }
    if (status === "draft") warnings.push(`Data source ${id} is a draft: its SQL rests on assumptions.`);

    const sql = String(source.sql ?? "");
    if (!sql.trim()) {
      errors.push(`Data source ${id} has no SQL.`);
      continue;
    }
    withSql.push(source);
    const bare = withoutLiterals(withoutComments(sql)).trim();
    if (!/^(SELECT|WITH)\b/i.test(bare)) errors.push(`Data source ${id}: the SQL must start with SELECT or WITH.`);
    if (bare.includes(";")) errors.push(`Data source ${id}: the SQL must be one statement without a semicolon.`);
    const bad = bare.match(NOT_READ_ONLY);
    if (bad) errors.push(`Data source ${id}: the SQL is not read-only (${bad[1].toUpperCase()}).`);
    parametersUsed(sql).forEach((p) => used.add(p));
  }

  // the output columns of the SQL equal the layout when the report has one data source and no repeated column
  const fixedLabels = design.columns.filter((c) => !c.dynamic).map((c) => c.label);
  if (design.dataSources.length === 1 && withSql.length === 1 && !design.columns.some((c) => c.dynamic)) {
    const aliases = outputColumns(withSql[0].sql);
    if (JSON.stringify(aliases) !== JSON.stringify(fixedLabels)) {
      errors.push(`Data source ${withSql[0].id}: the output columns (${aliases.join(", ")}) differ from the report layout (${fixedLabels.join(", ")}).`);
    }
  }

  for (const p of used) if (!declared.includes(p)) errors.push(`The SQL uses &${p}, which is not a declared parameter.`);
  for (const p of declared) if (!used.has(p)) warnings.push(`The parameter ${p} is declared but not used in the SQL.`);
  for (const p of declared) {
    if (UNREADABLE_NAME.test(String(p))) warnings.push(`The parameter name ${p} is shown to the consultant in IFS as it is written: use a short readable name without underscore or spaces, such as NameStartsWith.`);
  }
  for (const c of design.columns) if (c.dynamic && !c.dynamic.per) errors.push(`The repeated column "${c.label}" must say what it is repeated per.`);

  if (design.validation?.status !== "validated") warnings.push("The SQL is not validated on a test environment yet.");
  if (design.openQuestions.length > 0) warnings.push(`${design.openQuestions.length} open question(s) for the consultant.`);

  return { ok: errors.length === 0, errors, warnings };
}
