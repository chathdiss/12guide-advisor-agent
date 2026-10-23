// What happens after a design has been reviewed: is it ready for the next step, and which exact design did the consultant approve.
// Nothing here talks to IFS. It only reads the result of reviewDesign (see review-design.js).
import { createHash } from "node:crypto";
import { TITLE_MAX } from "./export-xml.js";

// Key order must not matter: the same design always gives the same fingerprint, a changed design never does
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

// The fingerprint of a design (the designJson text of reviewDesign, or the design object). Approval belongs to this fingerprint: a design that was
// changed after the approval has another one, and must be approved again.
export function designHash(design) {
  const object = typeof design === "string" ? JSON.parse(design) : design;
  return createHash("sha256").update(canonical(object)).digest("hex");
}

// Is the reviewed design ready for the consultant to approve and choose what happens next? `review` is the result of reviewDesign.
// Blockers must be solved first. Open questions do not block: they are shown with the approval, and approving is the consultant's decision.
export function readiness(review) {
  const blockers = [];
  if (!review || !review.design) {
    return { ready: false, blockers: [...((review && review.errors) || ["The design could not be read."])], openQuestions: [], designHash: null };
  }
  const design = review.design;
  for (const e of review.errors ?? []) blockers.push(`Design check: ${e}`);
  const sources = Array.isArray(design.dataSources) ? design.dataSources : [];
  if (!sources.some((s) => s.sql)) blockers.push("There is no data source with SQL.");
  for (const s of sources) {
    if (s.status === "blocked" || !s.sql) blockers.push(`Data source ${s.id ?? "?"} is blocked${s.blockedBy ? `: ${s.blockedBy}` : ""}.`);
  }
  // what IFS allows in a quick report, for both options: one SQL statement, and a title of at most 50 characters
  const withSql = sources.filter((s) => s.sql);
  if (withSql.length > 1) blockers.push(`A quick report has one SQL statement, and this design has ${withSql.length} data sources with SQL.`);
  const title = String(design.report?.title || design.spec?.title || "").trim();
  if (!title) blockers.push("The report has no title.");
  else if (title.length > TITLE_MAX) blockers.push(`The report title has ${title.length} characters; IFS allows at most ${TITLE_MAX}.`);
  for (const d of Array.isArray(design.decisions) ? design.decisions : []) blockers.push(`Decision not made yet: ${d.title ?? d.id ?? "?"}.`);
  if (sources.some((s) => s.sql) && (review.dictionary?.checked ?? 0) === 0) blockers.push("The SQL could not be checked against the IFS data dictionary.");
  const openQuestions = (Array.isArray(design.openQuestions) ? design.openQuestions : []).map(String);
  return { ready: blockers.length === 0, blockers, openQuestions, designHash: designHash(review.designJson ?? design) };
}

// What has been checked, and what has not. The SQL status stays "not run" until it has really been run and the result verified.
export function validationLevels(review, executed = null) {
  const d = review?.dictionary ?? {};
  return {
    dictionary: { checked: d.checked ?? 0, unknownViews: (d.unknownViews ?? []).length, unknownColumns: (d.unknownColumns ?? []).length },
    offline: review?.ok ? "design checks passed" : "design checks found problems",
    realEnvironment: executed ?? "not run",
  };
}
