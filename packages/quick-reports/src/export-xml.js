// The export file of a quick report: the XML that the Import button of the IFS Quick Reports page reads (Import_Reports__ in IFS 25R2).
//
// The structure is that of a real IFS export of one SQL quick report (test/fixtures/quick-report-export.structure.json holds its tags and data types);
// the rules come from the IFS source and documentation:
//   - the title (DESCRIPTION) is at most 50 characters and must be unique; the comments are at most 2000 characters
//   - a new report takes QUICK_REPORT_ID from the file. IFS gives its own reports ids from a sequence, so a file for a NEW report gets an id from a high
//     range that IFS does not use yet, made from the title: the same title always gives the same id, so importing it again replaces the same report
//     (IFS asks first). An id that exists already would replace that report; IFS asks, and the answer must be No.
//   - category and domain are matched by their text and are left empty here: choose them in IFS after the import
//   - & and < in the SQL must be written as entities; a parameter such as &Company is written &amp;Company in the file
// Nothing here talks to IFS. Whether IFS accepts a file can only be seen by importing it: do that first with a harmless test report.
import { createHash } from "node:crypto";

export const TITLE_MAX = 50;
export const COMMENTS_MAX = 2000;
const ID_BASE = 9_000_000;
const ID_RANGE = 900_000;

const NOT_GIVEN = /^(not given|none|n\/a|-|)$/i;

// characters that XML 1.0 does not allow are dropped; & < > are written as entities in the text of an element, as IFS does in its own export (quotes need none there)
export function xmlEscape(value) {
  return String(value ?? "")
    .replace(/[^\u0009\u000A\u000D -퟿-�]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// The id for a new report: from a range that IFS does not use, the same for the same title
export function reportIdFor(title) {
  const n = parseInt(createHash("sha256").update(String(title).trim().toLowerCase()).digest("hex").slice(0, 8), 16);
  return ID_BASE + (n % ID_RANGE);
}

export function exportFileName(title) {
  const safe = String(title).replace(/[^A-Za-z0-9 _.-]/g, "").trim().slice(0, 60) || "report";
  return `QuickReports_${safe}.xml`;
}

const element = (name, datatype, value, indent = "  ") =>
  value === null || value === undefined || value === ""
    ? `${indent}<${name} datatype="${datatype}"/>`
    : `${indent}<${name} datatype="${datatype}">${xmlEscape(value)}</${name}>`;

// The comments of the report in IFS: what the design is for, and that its SQL has not been run
export function commentsFor(design) {
  const tail = "Created from a design that the consultant approved in the Advisor agent. The SQL has been checked against the IFS data dictionary only; it has not been run on IFS.";
  const purpose = String(design.report?.purpose ?? "").trim();
  const room = COMMENTS_MAX - tail.length - 2;
  return purpose ? `${purpose.length > room ? `${purpose.slice(0, room - 1)}…` : purpose}\n\n${tail}` : tail;
}

// design: the normalized design of review-design.js. Returns { ok, errors, warnings, reportId, title, file: { name, mimeType, content, bytes } }.
export function buildQuickReportExport(design) {
  const errors = [];
  const sources = (Array.isArray(design?.dataSources) ? design.dataSources : []).filter((s) => s && s.sql);
  const title = String(design?.report?.title || design?.spec?.title || "").trim();
  if (!title) errors.push("The report has no title.");
  else if (title.length > TITLE_MAX) errors.push(`The report title is ${title.length} characters; IFS allows at most ${TITLE_MAX}.`);
  if (sources.length === 0) errors.push("There is no data source with SQL.");
  if (sources.length > 1) errors.push(`A quick report has one SQL statement, and this design has ${sources.length} data sources with SQL. Keep one, or make one report per data source.`);
  if (errors.length > 0) return { ok: false, errors, warnings: [] };

  const sql = sources[0].sql.replace(/\r\n/g, "\n").trim().replace(/;\s*$/, "");
  const id = reportIdFor(title);
  const lines = [
    "<QUICK_REPORT_LIST><QUICK_REPORT>",
    element("QUICK_REPORT_ID", "Number", id),
    element("DESCRIPTION", "Text", title),
    element("SQL_EXPRESSION", "Text", sql),
    element("COMMENTS", "Text", commentsFor(design)),
    element("CATEGORY_ID", "Number", null),
    element("CATEGORY_DESCRIPTION", "Text", null),
    element("DOMAIN_ID", "Number", null),
    element("DOMAIN_DESCRIPTION", "Text", null),
    element("FILE_NAME", "Text", null),
    element("QR_TYPE", "Enum", "SQL"),
    element("PO_ID", "Text", null),
    element("QUERY", "Text", null),
    element("ROW_TYPE", "Text", null),
    element("APP_CONFIG_PACKAGE", "Text", null),
    '  <QUICK_REPORT_CATEGORY datatype="Aggregate">',
    "    <REPORT_CATEGORY>",
    element("CATEGORY_ID", "Number", null, "      "),
    element("DESCRIPTION", "Text", null, "      "),
    "    </REPORT_CATEGORY>",
    "  </QUICK_REPORT_CATEGORY>",
    '  <QUICK_REPORT_DOMAIN datatype="Aggregate">',
    "    <REPORT_DOMAIN>",
    element("DOMAIN_ID", "Number", null, "      "),
    element("DESCRIPTION", "Text", null, "      "),
    "    </REPORT_DOMAIN>",
    "  </QUICK_REPORT_DOMAIN>",
    "</QUICK_REPORT></QUICK_REPORT_LIST>",
    "",
  ];
  const content = lines.join("\n");
  const warnings = [];
  if (sources[0].status === "draft") warnings.push("The SQL rests on assumptions (see the review page). Check them when you test the report.");
  return { ok: true, errors: [], warnings, reportId: id, title, file: { name: exportFileName(title), mimeType: "application/xml", content, bytes: Buffer.byteLength(content, "utf8") } };
}

// Reads the tags of an XML text without a parser (the file is made here, so its shape is known): the tag names, their data types and their depth,
// and what is wrong with it: tags that do not match, a stray < or & in the text. Returns { ok, problems, tags: ["0:QUICK_REPORT_LIST", ...] }.
export function readExportXml(xml) {
  const problems = [];
  const tags = [];
  const stack = [];
  let last = 0;
  const text = String(xml);
  const checkText = (chunk) => {
    if (/</.test(chunk)) problems.push("A < is not written as &lt; in the text.");
    if (/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(chunk)) problems.push("A & is not written as &amp; in the text.");
  };
  for (const m of text.matchAll(/<(\/?)([A-Za-z_][A-Za-z0-9_]*)((?:\s+[A-Za-z_:][\w:.-]*="[^"]*")*)\s*(\/?)>/g)) {
    checkText(text.slice(last, m.index));
    last = m.index + m[0].length;
    const [, closing, name, attrs, selfClosing] = m;
    if (closing) {
      if (stack.pop() !== name) problems.push(`The closing tag </${name}> does not match.`);
      continue;
    }
    const datatype = (attrs.match(/datatype="([^"]+)"/) || [])[1];
    tags.push(`${stack.length}:${name}${datatype ? `:${datatype}` : ""}`);
    if (!selfClosing) stack.push(name);
  }
  checkText(text.slice(last));
  if (stack.length > 0) problems.push(`The tag <${stack.at(-1)}> is not closed.`);
  if (tags.length === 0) problems.push("There are no tags.");
  return { ok: problems.length === 0, problems: [...new Set(problems)], tags };
}

// The tags of a real IFS export of one SQL quick report, in order, as depth:name:datatype (test/fixtures/quick-report-export.structure.json has the same list)
export const EXPORT_STRUCTURE = [
  "0:QUICK_REPORT_LIST", "1:QUICK_REPORT", "2:QUICK_REPORT_ID:Number", "2:DESCRIPTION:Text", "2:SQL_EXPRESSION:Text", "2:COMMENTS:Text", "2:CATEGORY_ID:Number",
  "2:CATEGORY_DESCRIPTION:Text", "2:DOMAIN_ID:Number", "2:DOMAIN_DESCRIPTION:Text", "2:FILE_NAME:Text", "2:QR_TYPE:Enum", "2:PO_ID:Text", "2:QUERY:Text",
  "2:ROW_TYPE:Text", "2:APP_CONFIG_PACKAGE:Text", "2:QUICK_REPORT_CATEGORY:Aggregate", "3:REPORT_CATEGORY", "4:CATEGORY_ID:Number", "4:DESCRIPTION:Text",
  "2:QUICK_REPORT_DOMAIN:Aggregate", "3:REPORT_DOMAIN", "4:DOMAIN_ID:Number", "4:DESCRIPTION:Text",
];

// Is this a well-formed file with the tags of a real IFS export? It says nothing about whether IFS accepts it: only an import can.
export function checkExportXml(xml) {
  const read = readExportXml(xml);
  const problems = [...read.problems];
  if (JSON.stringify(read.tags) !== JSON.stringify(EXPORT_STRUCTURE)) problems.push("The tags are not those of a real IFS export of a quick report.");
  return { ok: problems.length === 0, problems };
}
