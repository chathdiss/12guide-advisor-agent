// Step 4 of the quick report workflow, as one function for the advisor: takes the design that the agent wrote (JSON text or an object), fills in
// what is missing, checks it, checks its SQL against the IFS data dictionary and builds the review page for the consultant.
// It never runs any SQL, and it never lets a design say that it was validated: validation.status is always "not run" here.
//
// The agent does not copy the review page or the design: the result has them as `reviewPage` and `designJson`, the backend puts them into the
// answer exactly as they are (see apps/api/src/quickreport.js), and the text that goes back to the agent only holds what it needs to correct the design.
import { checkDesign } from "./check-design.js";
import { checkAgainstDictionary } from "./dictionary-check.js";
import { reviewMarkdown } from "./review.js";

const GIVEN = "not given";
const NO_VALUE = /^\s*(none|empty|null|n\/a|na|nil|-|--|not given|no default|not set)?\s*$/i;

// the answer of a model can come in a code fence: ```json ... ```
export function parseDesign(input) {
  if (input && typeof input === "object") return { design: input };
  const text = String(input ?? "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  if (!text) return { error: "The design is empty. Give the whole design as JSON text in design_json." };
  try {
    const design = JSON.parse(text);
    return design && typeof design === "object" && !Array.isArray(design) ? { design } : { error: "The design must be one JSON object." };
  } catch (err) {
    return { error: `The design is not valid JSON (${String(err.message).slice(0, 120)}). Give the whole design as one JSON object.` };
  }
}

// fills in what a quick report design needs and the agent may leave out; returns the design and a list of the notes about it
export function normalizeDesign(raw) {
  const notes = [];
  const d = JSON.parse(JSON.stringify(raw));
  const title = d.report?.title ?? d.spec?.title ?? "Quick report";
  d.designVersion ??= 1;
  d.type ??= "SQL quick report";
  d.spec = { title, customer: GIVEN, ticket: GIVEN, specRevision: GIVEN, file: "", ...(d.spec ?? {}) };
  d.report = { title, category: null, permissionSets: "To be decided", purpose: "", ...(d.report ?? {}) };
  d.parameters = (Array.isArray(d.parameters) ? d.parameters : []).map((p) => {
    const parameter = { label: p.name, type: "string", mandatory: false, default: null, usedAs: `'&${p.name}'`, ...p };
    // "no default" is null, not the words none or empty
    if (typeof parameter.default === "string" && NO_VALUE.test(parameter.default)) parameter.default = null;
    return parameter;
  });
  d.dataSources = (Array.isArray(d.dataSources) ? d.dataSources : []).map((s) => ({ status: s.sql ? "ready" : "blocked", purpose: "", entitiesUsed: [], assumptions: [], ...s }));
  d.columns = Array.isArray(d.columns) ? d.columns : [];
  d.openQuestions = Array.isArray(d.openQuestions) ? d.openQuestions : [];
  if (d.validation?.status && d.validation.status !== "not run") notes.push(`The design said that the SQL was "${d.validation.status}". That was reset: this tool never runs SQL, so the status is "not run".`);
  d.validation = { toConfirmOnTheTestEnvironment: [], ...(d.validation ?? {}), status: "not run" };
  delete d.validation.offlineChecks; // only this tool writes it
  return { design: d, notes };
}

const MAX_VIEW_COLUMNS = 150;

// lookup: view name -> Set of column names (upper case), or null when the dictionary has no such view; it may throw when the dictionary is not loaded
export async function reviewDesign(input, lookup) {
  const parsed = parseDesign(input);
  if (parsed.error) return { ok: false, errors: [parsed.error], warnings: [], text: `<quick_report_review>\n<status>The design could not be read.</status>\n<design_checks ok="false">\nERROR ${parsed.error}\n</design_checks>\n</quick_report_review>` };

  const { design, notes } = normalizeDesign(parsed.design);
  const checks = checkDesign(design);
  const errors = [...checks.errors];
  const warnings = [...notes, ...checks.warnings];

  // the data dictionary: the views and columns of every SQL that is written
  const total = { version: null, sources: [], checked: 0, skipped: 0, unknownViews: [], unknownColumns: [] };
  const problemViews = new Set();
  let dictionaryAvailable = true;
  for (const source of design.dataSources) {
    if (!source.sql || !dictionaryAvailable) continue;
    try {
      const r = await checkAgainstDictionary(source.sql, lookup);
      total.sources.push(source.id);
      total.checked += r.checked;
      total.skipped += r.skipped;
      total.unknownViews.push(...r.unknownViews);
      total.unknownColumns.push(...r.unknownColumns.map((c) => ({ source: source.id, ...c })));
      const known = new Set(r.views.filter((v) => !r.unknownViews.includes(v)));
      for (const e of source.entitiesUsed) e.inDataDictionary = known.has(String(e.view).toUpperCase());
      if (r.unprefixed.length > 0) {
        warnings.push(`Data source ${source.id}: write ${r.unprefixed.join(", ")} with the schema owner in front, as IFS documents for SQL quick reports (IFSAPP.${r.unprefixed[0]}). It is how IFS grants the permissions of the report.`);
      }
      for (const c of r.ambiguous) {
        errors.push(`The column ${c.column} has no table alias and is in more than one view (${c.views.join(", ")}): write alias.column (data source ${source.id}).`);
        c.views.forEach((v) => problemViews.add(v));
      }
      for (const w of r.unresolved) warnings.push(`The word ${w} (data source ${source.id}) could not be checked: it is not a keyword, an alias or a column of a view in the query. Write columns as alias.column.`);
      for (const c of r.unknownColumns) problemViews.add(c.view);
    } catch {
      dictionaryAvailable = false;
    }
  }
  if (!dictionaryAvailable) warnings.push("The IFS data dictionary is not available, so the views and columns were not checked.");
  for (const v of total.unknownViews) errors.push(`The view ${v} is not in the IFS data dictionary.`);
  for (const c of total.unknownColumns) errors.push(`The column ${c.column} does not exist in the view ${c.view} (data source ${c.source}${c.alias ? `, alias ${c.alias}` : ", written without a table alias"}).`);
  if (dictionaryAvailable) design.validation.offlineChecks = total;
  const sqlWritten = design.dataSources.some((s) => s.sql);
  if (dictionaryAvailable && sqlWritten && total.checked === 0) warnings.push("No column of the SQL could be checked against the data dictionary.");

  // the real columns of the views that have a wrong or unclear column, so that the agent corrects the design without searching
  const viewColumns = [];
  if (dictionaryAvailable) {
    for (const view of problemViews) {
      try {
        const cols = await lookup(view);
        if (cols) viewColumns.push(`<view_columns view="${view}" count="${cols.size}">${[...cols].sort().slice(0, MAX_VIEW_COLUMNS).join(", ")}${cols.size > MAX_VIEW_COLUMNS ? ", ..." : ""}</view_columns>`);
      } catch {
        /* the columns are only a help */
      }
    }
  }

  const ok = errors.length === 0;
  const verified = dictionaryAvailable && total.checked > 0 && total.unknownViews.length + total.unknownColumns.length === 0;
  const review = reviewMarkdown(design);
  const problems = ok ? "" : `> **The check found problems that are not solved yet:**\n${errors.map((e) => `> - ${e}`).join("\n")}\n\n`;
  const designJson = JSON.stringify(design, null, 2);
  const list = (label, items) => items.map((i) => `${label} ${i}`).join("\n");
  const text = [
    "<quick_report_review>",
    "<status>Checked against the IFS data dictionary only. NOT validated: the SQL has not been run on any IFS environment, and there are no sample results.</status>",
    `<design_checks ok="${ok}">`,
    [list("ERROR", errors), list("WARNING", warnings)].filter(Boolean).join("\n") || "no problems found",
    "</design_checks>",
    dictionaryAvailable
      ? `<dictionary_check checked="${total.checked}" unknown_views="${total.unknownViews.length}" unknown_columns="${total.unknownColumns.length}">${verified ? "every view and column that could be checked exists in the data dictionary" : "the check is not complete: see the errors and warnings"}</dictionary_check>`
      : '<dictionary_check available="false"/>',
    ...viewColumns,
    ok
      ? "<next>No errors. Do not retype the review page or the design: the system inserts them exactly as they are. Write an introduction of at most three concise sentences in plain prose, without a bullet list or a heading (what the design does and, in one sentence, the open points that matter most; do not repeat what the review page shows; extra sentences are cut), then on their own lines the exact text [[REVIEW_PAGE]] and then [[DESIGN_JSON]], then ask the consultant for approval or changes. Do not say that the SQL was validated or run.</next>"
      : "<next>There are errors. Correct the design with the columns shown above (do not search again for them), then call this tool again. Keep your last calls for this tool.</next>",
    "</quick_report_review>",
  ].join("\n");
  return { ok, errors, warnings, design, review, reviewPage: problems + review, designJson, dictionary: total, text };
}
