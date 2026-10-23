// Checks the SQL of a design against the IFS data dictionary, without any IFS environment: every view in FROM and JOIN must be a view of the
// dictionary, and every column must be a column of its view. A column written alias.column is checked against the view of that alias. A column
// written without a table alias is checked too: in a query with one view it must be a column of that view; in a query with several views it
// is reported (write alias.column), because it cannot be told which view it belongs to. Columns of a sub-select (its own alias) cannot be
// checked here; they are counted as skipped. The lookup is a function: view name -> Set of column names (upper case), or null when the
// dictionary has no such view.

const KEYWORDS = new Set(
  ("SELECT FROM WHERE AND OR NOT IN IS NULL LIKE BETWEEN EXISTS ORDER BY GROUP HAVING ASC DESC AS JOIN LEFT RIGHT INNER OUTER FULL CROSS NATURAL ON USING " +
    "UNION ALL DISTINCT UNIQUE MINUS INTERSECT CASE WHEN THEN ELSE END OVER PARTITION WITH FETCH FIRST NEXT ROWS ROW ONLY OFFSET DATE TIMESTAMP INTERVAL " +
    "DAY MONTH YEAR HOUR MINUTE SECOND SYSDATE SYSTIMESTAMP CURRENT_DATE CURRENT_TIMESTAMP ROWNUM ROWID DUAL TRUE FALSE ANY SOME ESCAPE NULLS LAST FOR " +
    "CONNECT START PRIOR LEVEL SIBLINGS TO AT TIME ZONE").split(" "),
);

const TABLE_WORDS = new Set(["ON", "WHERE", "JOIN", "LEFT", "RIGHT", "INNER", "OUTER", "FULL", "CROSS", "GROUP", "ORDER", "UNION", "HAVING", "CONNECT", "START", "AND", "OR", "USING"]);

function clean(sql) {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (c === "'") {
      let j = i + 1;
      while (j < sql.length && !(sql[j] === "'" && sql[j + 1] !== "'")) j += sql[j] === "'" ? 2 : 1;
      out += "''";
      i = j + 1;
    } else if (c === '"') {
      const j = sql.indexOf('"', i + 1);
      out += '""';
      i = j < 0 ? sql.length : j + 1;
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

// IFS documents that the database objects of a SQL quick report are written with the schema owner in front of them (IFSAPP.CUSTOMER_INFO): it is how
// IFS grants the permissions of the report. The owner is not part of the view name in the data dictionary, so it is left out when the SQL is checked.
const OWNER = "IFSAPP";

// the views of FROM and JOIN with their aliases and owners: [{ view: 'CUSTOMER_INFO', alias: 'CUST', owner: 'IFSAPP' }] (owner is null without one)
export function tableReferences(sql) {
  const refs = [];
  for (const m of clean(sql).matchAll(/\b(?:FROM|JOIN)\s+(?:([A-Za-z_][A-Za-z0-9_]*)\s*\.\s*)?([A-Za-z_][A-Za-z0-9_]*)(?:\s+(?:AS\s+)?([A-Za-z_][A-Za-z0-9_]*))?/gi)) {
    const alias = m[3] && !TABLE_WORDS.has(m[3].toUpperCase()) ? m[3] : m[2];
    refs.push({ view: m[2].toUpperCase(), alias: alias.toUpperCase(), owner: m[1] ? m[1].toUpperCase() : null });
  }
  return refs;
}

// the SQL without the owner in front of a view, or of an API call, so that what is left can be checked as it is
function withoutOwner(text) {
  return text.replace(/(\b(?:FROM|JOIN)\s+)[A-Za-z_][A-Za-z0-9_]*\s*\.\s*(?=[A-Za-z_])/gi, "$1").replace(new RegExp(`\\b${OWNER}\\s*\\.\\s*`, "gi"), "");
}

// the words of a SQL that stand without a table alias and can be a column: not a keyword, a function, an alias or a view
function bareWords(text, aliases, views) {
  const stripped = text.replace(/\b[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*\b/g, " ");
  const out = [];
  for (const m of stripped.matchAll(/\b[A-Za-z_][A-Za-z0-9_]*\b/g)) {
    const word = m[0].toUpperCase();
    if (KEYWORDS.has(word) || aliases.has(word) || views.has(word)) continue;
    if (/^\s*\(/.test(stripped.slice(m.index + m[0].length))) continue; // a function: SUM(, ROW_NUMBER(, TO_DATE(
    out.push(word);
  }
  return [...new Set(out)];
}

export async function checkAgainstDictionary(sql, lookup) {
  const text = withoutOwner(clean(sql));
  const refs = tableReferences(sql);
  const byAlias = new Map(refs.map((r) => [r.alias, r.view]));
  const columnsOf = new Map();
  for (const view of new Set(refs.map((r) => r.view))) columnsOf.set(view, await lookup(view));

  const unknownViews = [...columnsOf].filter(([, cols]) => !cols).map(([view]) => view);
  const unknownColumns = [];
  let checked = 0;
  let skipped = 0;
  const seen = new Set();
  for (const m of text.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\b/g)) {
    const alias = m[1].toUpperCase();
    const column = m[2].toUpperCase();
    const key = `${alias}.${column}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const view = byAlias.get(alias);
    const cols = view ? columnsOf.get(view) : null;
    if (!view || !cols) {
      skipped++;
      continue;
    }
    checked++;
    if (!cols.has(column)) unknownColumns.push({ alias, view, column });
  }

  // the columns without a table alias
  const known = new Map([...columnsOf].filter(([, cols]) => cols));
  const declared = new Set([...refs.map((r) => r.alias), ...[...text.matchAll(/\bAS\s+([A-Za-z_][A-Za-z0-9_]*)/gi)].map((m) => m[1].toUpperCase()), ...[...text.matchAll(/\)\s*([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1].toUpperCase())]);
  const hasSubselect = /\(\s*SELECT\b/i.test(text);
  const unqualified = [];
  const ambiguous = [];
  const unresolved = [];
  if (known.size > 0 && unknownViews.length === 0) {
    for (const word of bareWords(text, declared, new Set(refs.map((r) => r.view)))) {
      const owners = [...known].filter(([, cols]) => cols.has(word)).map(([view]) => view);
      if (owners.length === 0) {
        // with one view and no sub-select, a word that is no keyword, function or alias can only be a column of that view
        if (known.size === 1 && !hasSubselect) unknownColumns.push({ alias: null, view: [...known.keys()][0], column: word });
        else unresolved.push(word);
      } else if (known.size === 1) {
        checked++;
        unqualified.push({ column: word, view: owners[0] });
      } else ambiguous.push({ column: word, views: owners });
    }
  }
  const ok = unknownViews.length === 0 && unknownColumns.length === 0 && ambiguous.length === 0;
  // the views that are written without the owner: IFS documents that they should have it
  const unprefixed = [...new Set(refs.filter((r) => !r.owner).map((r) => r.view))];
  return { views: [...columnsOf.keys()], unknownViews, unknownColumns, unqualified, ambiguous, unresolved, unprefixed, checked, skipped, ok };
}
