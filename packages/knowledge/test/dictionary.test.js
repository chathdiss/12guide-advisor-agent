import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { strToU8, zipSync } from "fflate";
import { parseColumnRows, parseLuRows } from "../src/dictionary.js";
import { columnEntries, columnHitsText, luSummary, referenceTarget, shortType } from "../src/dictionary-summary.js";
import { columnIndex, decodeXml, readXlsxRows } from "../src/xlsx.js";

// A minimal .xlsx file: the workbook, its relationships, the shared strings and one sheet
function makeXlsx({ strings = [], sheetXml, sheetTarget = "worksheets/sheet1.xml" }) {
  const sst = `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${strings.map((s) => `<si>${s}</si>`).join("")}</sst>`;
  return Buffer.from(
    zipSync({
      "xl/workbook.xml": strToU8(`<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId7"/></sheets></workbook>`),
      "xl/_rels/workbook.xml.rels": strToU8(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId7" Type="worksheet" Target="${sheetTarget}"/></Relationships>`),
      "xl/sharedStrings.xml": strToU8(sst),
      [`xl/${sheetTarget}`]: strToU8(`<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetXml}</sheetData></worksheet>`),
    }),
  );
}

describe("reading an .xlsx file", () => {
  it("reads shared strings, inline strings and numbers, keeps empty cells in place and decodes entities", () => {
    const file = makeXlsx({
      strings: ["<t>MODULE</t>", "<t>Fish &amp; chips</t>", "<r><t>Hel</t></r><r><t>lo</t></r>", "<t>caf&#233; &lt;x&gt;</t>"],
      sheetXml: [
        `<row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row>`,
        `<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>42</v></c><c r="D2" t="inlineStr"><is><t>inline &amp; text</t></is></c><c r="E2" s="3"/></row>`,
        `<row r="3"><c r="B3" t="s"><v>3</v></c></row>`,
        `<row r="4"/>`,
      ].join(""),
    });
    assert.deepEqual(readXlsxRows(file), [
      ["MODULE", "", "Fish & chips"],
      ["Hello", "42", "", "inline & text"],
      ["", "café <x>"],
      [],
    ]);
  });

  it("finds the first sheet through the workbook relationships", () => {
    const file = makeXlsx({ sheetTarget: "worksheets/data.xml", sheetXml: `<row r="1"><c r="A1"><v>7</v></c></row>` });
    assert.deepEqual(readXlsxRows(file), [["7"]]);
  });

  it("reads a sheet that is larger than one piece, without losing or splitting a row", () => {
    // about 14 MB of XML: more than the 8 MB piece the reader decodes at a time
    const rows = [];
    for (let i = 1; i <= 130_000; i++) rows.push(`<row r="${i}"><c r="A${i}"><v>${i}</v></c><c r="B${i}" t="inlineStr"><is><t>value number ${i} with some padding text</t></is></c></row>`);
    const file = makeXlsx({ sheetXml: rows.join("") });
    const read = readXlsxRows(file);
    assert.equal(read.length, 130_000);
    assert.deepEqual(read[0], ["1", "value number 1 with some padding text"]);
    assert.deepEqual(read[64_999], ["65000", "value number 65000 with some padding text"]);
    assert.deepEqual(read.at(-1), ["130000", "value number 130000 with some padding text"]);
    assert.ok(read.every((r, i) => r[0] === String(i + 1)), "every row is whole and in order");
  });

  it("refuses a file that is not an .xlsx file", () => {
    assert.throws(() => readXlsxRows(Buffer.from("this is not a zip file")));
    assert.throws(() => readXlsxRows(Buffer.from(zipSync({ "hello.txt": strToU8("hi") }))), /not an .xlsx file/);
  });

  it("turns cell references into column positions and decodes numeric entities", () => {
    assert.deepEqual(["A1", "Z9", "AA1", "AB12"].map(columnIndex), [0, 25, 26, 27]);
    assert.equal(decodeXml("a &#65; &#x42; &quot;q&quot; &unknown;"), 'a A B "q" &unknown;');
  });
});

describe("the dictionary files", () => {
  it("finds the columns by the names in the header row, in any order", () => {
    const rows = [
      ["LU_NAME", "MODULE", "BASE_VIEW", "LU_PROMPT", "BASE_TABLE", "BASE_PACKAGE", "LOGICAL_UNIT_TYPE", "ENABLED_ROWKEY"],
      ["CustomerOrder", "ORDER", "CUSTOMER_ORDER", "Customer Order", "CUSTOMER_ORDER_TAB", "CUSTOMER_ORDER_API", "EntityWithState", "TRUE"],
      ["ScRevalIntervalUnit", "SRVCON", "", "Sc Reval Interval Unit", "", "SC_REVAL_INTERVAL_UNIT_API", "Enumeration", ""],
      ["", "ORDER", "", "", "", "", "", ""],
    ];
    const lus = parseLuRows(rows);
    assert.equal(lus.length, 2, "a row without a name is dropped");
    assert.deepEqual(lus[0], { module: "ORDER", luName: "CustomerOrder", luPrompt: "Customer Order", baseTable: "CUSTOMER_ORDER_TAB", baseView: "CUSTOMER_ORDER", basePackage: "CUSTOMER_ORDER_API", enabledRowkey: true, luType: "EntityWithState" });
    assert.equal(lus[1].enabledRowkey, false);
    assert.equal(lus[1].baseView, "");
  });

  it("names the columns that are missing in the header row", () => {
    assert.throws(() => parseLuRows([["MODULE", "LU_NAME"], ["A", "B"]]), /Logical units: these columns are missing in the header row: LU_PROMPT, BASE_TABLE/);
    assert.throws(() => parseColumnRows([["LU_NAME"]]), /View columns: these columns are missing/);
    assert.throws(() => parseColumnRows([]), /has no rows/);
  });

  it("reads view columns with their flags and index, and skips a row without a view or column", () => {
    const header = ["LU_NAME", "VIEW_NAME", "COLUMN_NAME", "COLUMN_DATATYPE", "COLUMN_PROMPT", "TYPE_FLAG", "REQUIRED_FLAG", "INSERT_FLAG", "UPDATE_FLAG", "LOV_FLAG", "COLUMN_INDEX", "COLUMN_REFERENCE", "ENUMERATION", "ROW_LEVEL_SECURITY"];
    const cols = parseColumnRows([
      header,
      ["CustomerOrderLine", "CUSTOMER_ORDER_LINE", "ORDER_NO", "STRING(12)/UPPERCASE", "Order No", "P", "M", "I", "-", "L", "1", "CustomerOrder"],
      ["CustomerOrderLine", "CUSTOMER_ORDER_LINE", "OBJSTATE", "", "", "", "", "", "", "", "166"],
      ["CustomerOrderLine", "", "NO_VIEW"],
      ["CustomerOrderLine", "CUSTOMER_ORDER_LINE", "", "STRING(1)"],
    ]);
    assert.equal(cols.length, 2);
    assert.deepEqual(cols[0], { luName: "CustomerOrderLine", viewName: "CUSTOMER_ORDER_LINE", columnName: "ORDER_NO", datatype: "STRING(12)/UPPERCASE", prompt: "Order No", typeFlag: "P", requiredFlag: "M", insertFlag: "I", updateFlag: "-", lovFlag: "L", columnIndex: 1, columnReference: "CustomerOrder", enumeration: "", rowLevelSecurity: "" });
    assert.equal(cols[1].columnIndex, 166);
    assert.equal(cols[1].datatype, "");
  });
});

describe("the text of a logical unit", () => {
  const lu = { version: "IFS Cloud 25R2", lu_name: "CustomerOrderLine", lu_prompt: "Customer Order Line", module: "ORDER", lu_type: "EntityWithState", base_table: "CUSTOMER_ORDER_LINE_TAB", base_view: "CUSTOMER_ORDER_LINE", base_package: "CUSTOMER_ORDER_LINE_API" };
  const col = (name, extra = {}) => ({ column_name: name, datatype: "STRING(20)/UPPERCASE", prompt: "", type_flag: "A", required_flag: "", column_reference: "", enumeration: "", row_level_security: "", ...extra });

  it("reads a reference the way the dictionary writes it", () => {
    assert.deepEqual(referenceTarget("CustomerInfoAddress(customer_no)/NOCHECK"), { lu: "CustomerInfoAddress", keys: "customer_no" });
    assert.deepEqual(referenceTarget("Site/NOCHECK"), { lu: "Site", keys: "" });
    assert.deepEqual(referenceTarget(""), { lu: "", keys: "" });
  });

  it("shortens the data types", () => {
    assert.deepEqual(["STRING(20)/UPPERCASE", "NUMBER", "DATE/DATETIME", "DATE/DATE", ""].map(shortType), ["string(20)", "number", "datetime", "date", ""]);
  });

  it("shows the prompt only when it says something else than the column name, and marks key, parent key and mandatory", () => {
    const text = luSummary({
      lu,
      columns: [
        col("ORDER_NO", { type_flag: "P", column_reference: "CustomerOrder" }),
        col("LINE_NO", { type_flag: "K" }),
        col("CONTRACT", { prompt: "Site", required_flag: "M" }),
        col("DATE_ENTERED", { datatype: "DATE/DATETIME", prompt: "Date Entered" }),
        col("OBJSTATE", { datatype: "" }),
      ],
      viewOf: new Map([["CustomerOrder", "CUSTOMER_ORDER"]]),
    });
    assert.match(text, /^Logical unit CustomerOrderLine \("Customer Order Line"\), module ORDER, type EntityWithState, from the IFS data dictionary \(IFS Cloud 25R2\)\./);
    assert.match(text, /base table CUSTOMER_ORDER_LINE_TAB, base view CUSTOMER_ORDER_LINE, base package CUSTOMER_ORDER_LINE_API/);
    assert.match(text, /DETAIL entity \(it has a parent key\). Parent \(header\) entity: CustomerOrder \(CUSTOMER_ORDER\), joined on ORDER_NO/);
    assert.match(text, /ORDER_NO \(string\(20\), parent key\), LINE_NO \(string\(20\), key\), CONTRACT \(string\(20\), prompt "Site", mandatory\), DATE_ENTERED \(datetime\)\./);
    assert.match(text, /System columns that IFS adds: OBJSTATE\./);
    assert.doesNotMatch(text, /prompt "Date Entered"/);
  });

  it("calls a unit without a parent key but with detail units a header, and lists joins, enumerations and other views", () => {
    const text = luSummary({
      lu: { ...lu, lu_name: "CustomerOrder", base_view: "CUSTOMER_ORDER" },
      columns: [col("ORDER_NO", { type_flag: "K" }), col("CUSTOMER_NO", { column_reference: "CustOrdCustomer" }), col("BILL_ADDR_NO", { column_reference: "CustomerInfoAddress(customer_no)" }), col("ADDR_FLAG", { enumeration: "CustOrdAddressFlag" })],
      children: ["CustomerOrderCharge", "CustomerOrderLine"],
      otherViews: ["CUSTOMER_ORDER_LOV", "CUSTOMER_ORDER_PUB"],
      similar: ["CustomerOrderAddress"],
      viewOf: new Map([["CustomerOrderLine", "CUSTOMER_ORDER_LINE"]]),
    });
    assert.match(text, /MASTER \(header\) entity. It has no parent key. Its detail entities.*CustomerOrderCharge, CustomerOrderLine \(CUSTOMER_ORDER_LINE\)/);
    assert.match(text, /Joins \(column -> logical unit it points to\): CUSTOMER_NO -> CustOrdCustomer, BILL_ADDR_NO -> CustomerInfoAddress \(with customer_no\)/);
    assert.match(text, /Enumerations: ADDR_FLAG -> CustOrdAddressFlag/);
    assert.match(text, /Other views of this logical unit: CUSTOMER_ORDER_LOV, CUSTOMER_ORDER_PUB/);
    assert.match(text, /Other logical units whose name starts like this one: CustomerOrderAddress/);
  });

  it("writes a column and its _DB twin as one entry, and loses no column", () => {
    const columns = [
      { column_name: "ORDER_NO", datatype: "STRING(12)/UPPERCASE", prompt: "Order No", type_flag: "K" },
      { column_name: "ADDR_FLAG", datatype: "STRING(20)", prompt: "Address Flag", enumeration: "GenYesNo" },
      { column_name: "ADDR_FLAG_DB", datatype: "STRING(20)", prompt: "Address Flag" },
      { column_name: "LAST_DB", datatype: "STRING(5)", prompt: "A column that only looks like a twin" },
      { column_name: "OBJID", datatype: "" },
      { column_name: "OBJVERSION", datatype: "" },
    ];
    const { entries, system } = columnEntries(columns);
    assert.deepEqual(entries, ["ORDER_NO (string(12), key)", 'ADDR_FLAG (string(20), prompt "Address Flag") +DB', 'LAST_DB (string(5), prompt "A column that only looks like a twin")']);
    assert.deepEqual(system, ["OBJID", "OBJVERSION"]);
    const text = luSummary({ lu, columns });
    assert.match(text, /All 6 columns/, "the count is of the columns of the view, as before");
    assert.match(text, /ADDR_FLAG \(string\(20\), prompt "Address Flag"\) \+DB/);
    assert.ok(!text.includes("ADDR_FLAG_DB (string"), "the twin is not listed again");
    assert.match(text, /System columns that IFS adds: OBJID, OBJVERSION\./);
  });

  it("says that a unit without a base view is not table-based, and caps a very long column list", () => {
    const none = luSummary({ lu: { ...lu, lu_name: "ScRevalIntervalUnit", lu_type: "Enumeration", base_table: "", base_view: "", base_package: "SC_API" } });
    assert.match(none, /It has no base table or view|base package SC_API/);
    const many = Array.from({ length: 450 }, (_, i) => col(`COLUMN_${i}`));
    const text = luSummary({ lu, columns: many });
    assert.match(text, /All 450 columns/);
    assert.match(text, /, and 50 more\./);
    assert.ok(!text.includes("COLUMN_449"));
  });

  it("writes the columns that a search found, one per line", () => {
    const text = columnHitsText(
      [{ view_name: "CUSTOMER_ORDER_LINE", column_name: "CONTRACT", datatype: "STRING(5)/UPPERCASE", prompt: "Site", type_flag: "A", column_reference: "Site", lu_name: "CustomerOrderLine", module: "ORDER" }],
      { query: "site", version: "IFS Cloud 25R2" },
    );
    assert.match(text, /^Columns of entity views that match "site" in the IFS data dictionary \(IFS Cloud 25R2\)/);
    assert.match(text, /CUSTOMER_ORDER_LINE\.CONTRACT \(string\(5\), prompt "Site", -> Site\) - CustomerOrderLine, ORDER$/);
  });
});
