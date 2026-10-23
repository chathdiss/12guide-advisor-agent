// The export file of a quick report (src/export-xml.js), checked against the tags of a real IFS export (test/fixtures/quick-report-export.structure.json).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { EXPORT_STRUCTURE, TITLE_MAX, buildQuickReportExport, checkExportXml, commentsFor, exportFileName, readExportXml, reportIdFor, xmlEscape } from "../src/export-xml.js";
import { readiness } from "../src/next-steps.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/quick-report-export.structure.json", import.meta.url), "utf8"));
const copy = (o) => JSON.parse(JSON.stringify(o));

const design = {
  designVersion: 1,
  spec: { title: "Open Customer Invoices" },
  report: { title: "Open Customer Invoices", category: "not given", purpose: "Lists the open customer invoices of one company that are due before a given date." },
  dataSources: [
    {
      id: "DS1",
      status: "draft",
      sql: "SELECT i.invoice_no AS \"Invoice No\", i.due_date AS \"Due Date\"\nFROM IFSAPP.INVOICE_LEDGER_ITEM_CU_QRY i\nWHERE i.company = '&Company' AND i.due_date < TO_DATE('&DueBefore', 'YYYY-MM-DD') AND i.open_amount <> 0\nORDER BY i.due_date;",
    },
  ],
};

// what IFS does with the text of an element: the five entities are turned back
const unescape = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
const valueOf = (xml, tag) => unescape((xml.match(new RegExp(`<${tag} datatype="[A-Za-z]+">([\\s\\S]*?)</${tag}>`)) ?? [])[1] ?? "");

describe("the structure of a real IFS export", () => {
  it("is the list of tags that the file is checked against", () => {
    assert.deepEqual(EXPORT_STRUCTURE, fixture.tags);
  });

  it("is the structure of the file that is made", () => {
    const built = buildQuickReportExport(design);
    assert.equal(built.ok, true);
    assert.deepEqual(readExportXml(built.file.content).tags, fixture.tags);
    assert.deepEqual(checkExportXml(built.file.content), { ok: true, problems: [] });
  });
});

describe("the file of a design", () => {
  const built = buildQuickReportExport(design);
  const xml = built.file.content;

  it("has the title, the SQL, the type SQL, and no category, domain, query or file name", () => {
    assert.equal(valueOf(xml, "DESCRIPTION"), "Open Customer Invoices");
    assert.equal(valueOf(xml, "QR_TYPE"), "SQL");
    for (const empty of ["CATEGORY_ID", "CATEGORY_DESCRIPTION", "DOMAIN_ID", "DOMAIN_DESCRIPTION", "FILE_NAME", "PO_ID", "QUERY", "ROW_TYPE", "APP_CONFIG_PACKAGE"]) {
      assert.match(xml, new RegExp(`<${empty} datatype="[A-Za-z]+"/>`), empty);
    }
  });

  it("writes the SQL with its entities, and IFS reads the same SQL back", () => {
    const sql = valueOf(xml, "SQL_EXPRESSION");
    assert.ok(xml.includes("'&amp;Company'") && xml.includes("&lt; TO_DATE") && xml.includes("&lt;&gt; 0"), "the special characters are entities in the file");
    assert.equal(sql, design.dataSources[0].sql.replace(/;\s*$/, ""), "the same SQL, without the semicolon");
    assert.ok(sql.includes("IFSAPP.INVOICE_LEDGER_ITEM_CU_QRY"));
    assert.ok(sql.includes("\n"), "the lines of the SQL stay lines");
  });

  it("keeps the line breaks as one, whatever they were", () => {
    const d = copy(design);
    d.dataSources[0].sql = "SELECT 1\r\nFROM dual";
    assert.equal(valueOf(buildQuickReportExport(d).file.content, "SQL_EXPRESSION"), "SELECT 1\nFROM dual");
  });

  it("has comments that say what the report is for, and that its SQL has not been run on IFS", () => {
    const comments = valueOf(xml, "COMMENTS");
    assert.match(comments, /^Lists the open customer invoices/);
    assert.match(comments, /it has not been run on IFS\.$/);
  });

  it("gives the same id to the same title, an id from the high range, and another id to another title", () => {
    const id = Number(valueOf(xml, "QUICK_REPORT_ID"));
    assert.equal(id, built.reportId);
    assert.equal(id, reportIdFor("  open customer invoices "), "case and spaces do not matter");
    assert.ok(id >= 9_000_000 && id < 9_900_000);
    assert.notEqual(reportIdFor("Weekly Cash Report"), reportIdFor("Open Customer Invoices"));
    assert.equal(buildQuickReportExport(design).reportId, id, "the same file every time");
  });

  it("is a file name that is safe, and says what it is", () => {
    assert.equal(built.file.name, "QuickReports_Open Customer Invoices.xml");
    assert.equal(exportFileName('a/b\\c:d*e?"f<g>h|i'), "QuickReports_abcdefghi.xml");
    assert.equal(exportFileName(""), "QuickReports_report.xml");
    assert.equal(built.file.mimeType, "application/xml");
    assert.equal(built.file.bytes, Buffer.byteLength(xml, "utf8"));
  });

  it("warns that the SQL of a draft rests on assumptions", () => {
    assert.match(built.warnings.join(" "), /rests on assumptions/);
    const ready = copy(design);
    ready.dataSources[0].status = "ready";
    assert.deepEqual(buildQuickReportExport(ready).warnings, []);
  });
});

describe("what IFS does not allow", () => {
  const errorsOf = (patch) => buildQuickReportExport(patch(copy(design))).errors.join(" ");

  it("refuses a title of more than 50 characters, and no title", () => {
    assert.equal(buildQuickReportExport(Object.assign(copy(design), { report: { title: "x".repeat(TITLE_MAX) } })).ok, true);
    assert.match(errorsOf((d) => ((d.report.title = "x".repeat(TITLE_MAX + 1)), d)), /51 characters; IFS allows at most 50/);
    assert.match(errorsOf((d) => ((d.report.title = ""), (d.spec.title = ""), d)), /no title/);
  });

  it("refuses a design with no SQL, and one with more than one data source with SQL: a quick report has one", () => {
    assert.match(errorsOf((d) => ((d.dataSources = []), d)), /no data source with SQL/);
    assert.match(errorsOf((d) => (d.dataSources.push({ id: "DS2", sql: "SELECT 1 FROM dual" }), d)), /one SQL statement, and this design has 2/);
  });

  it("gives no file for a design that is refused", () => {
    const r = buildQuickReportExport(Object.assign(copy(design), { dataSources: [] }));
    assert.equal(r.ok, false);
    assert.equal("file" in r, false);
  });

  it("makes the same rules a reason why the design is not ready for either option", () => {
    const review = (d) => ({ design: d, errors: [], dictionary: { checked: 3 }, designJson: JSON.stringify(d) });
    const withDecisions = (d) => Object.assign(d, { decisions: [], openQuestions: [] });
    assert.equal(readiness(review(withDecisions(copy(design)))).ready, true);
    const long = withDecisions(copy(design));
    long.report.title = "x".repeat(51);
    assert.ok(readiness(review(long)).blockers.some((b) => /51 characters; IFS allows at most 50/.test(b)));
    const two = withDecisions(copy(design));
    two.dataSources.push({ id: "DS2", status: "ready", sql: "SELECT 1 FROM dual" });
    assert.ok(readiness(review(two)).blockers.some((b) => /one SQL statement/.test(b)));
  });
});

describe("the entities and the check of a file", () => {
  it("writes & < > as entities like IFS does, leaves quotes alone, and drops what XML does not allow", () => {
    assert.equal(xmlEscape(`a & b < c > d "e" 'f'`), "a &amp; b &lt; c &gt; d \"e\" 'f'");
    assert.equal(xmlEscape("a\u0000b\u0008c\u000bd"), "abcd");
    assert.equal(xmlEscape("tab\there\nand é ü"), "tab\there\nand é ü");
  });

  it("finds a file that is not well-formed: a bare &, a bare <, tags that do not match, a tag that is not closed", () => {
    assert.match(readExportXml("<A>x & y</A>").problems.join(" "), /& is not written as &amp;/);
    assert.match(readExportXml("<A>x < y</A>").problems.join(" "), /< is not written as &lt;/);
    assert.match(readExportXml("<A><B></A></B>").problems.join(" "), /does not match/);
    assert.match(readExportXml("<A><B>").problems.join(" "), /not closed/);
    assert.match(readExportXml("no tags").problems.join(" "), /no tags/);
    assert.equal(readExportXml("<A>x &amp; y &#38; z</A>").ok, true);
  });

  it("finds a file that has other tags than a real export", () => {
    const built = buildQuickReportExport(design).file.content;
    const changed = built.replace("<QR_TYPE datatype=\"Enum\">SQL</QR_TYPE>", "");
    assert.equal(checkExportXml(changed).ok, false);
    assert.match(checkExportXml(changed).problems.join(" "), /not those of a real IFS export/);
  });

  it("makes comments of at most 2000 characters, however long the purpose is", () => {
    const d = copy(design);
    d.report.purpose = "p".repeat(5000);
    const comments = commentsFor(d);
    assert.ok(comments.length <= 2000);
    assert.match(comments, /it has not been run on IFS\.$/);
    assert.match(commentsFor({ report: {} }), /^Created from a design/);
  });
});
