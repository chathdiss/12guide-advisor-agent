// Reads the first sheet of an .xlsx file as rows of text. An .xlsx file is a zip of XML files; only the parts that hold the
// cells are opened (the shared strings, the workbook and the sheet), with fflate, which is already a dependency.
//
// The dictionary exports are large (382,000 rows, 137 MB of XML in the sheet), so the sheet is decoded and cut into rows in
// pieces instead of as one string. Values are returned as text; empty cells are empty strings.
import { strFromU8, unzipSync } from "fflate";

const CHUNK_BYTES = 8 * 1024 * 1024;

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
export function decodeXml(text) {
  if (!text.includes("&")) return text;
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (whole, code) => {
    if (code[0] === "#") {
      const n = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : whole;
    }
    return ENTITIES[code] ?? whole;
  });
}

// "AB12" -> 27 (the zero-based position of the column)
export function columnIndex(ref) {
  let n = 0;
  for (const ch of ref.match(/^[A-Z]+/)?.[0] ?? "") n = n * 26 + ch.charCodeAt(0) - 64;
  return n - 1;
}

function sharedStrings(xml) {
  const out = [];
  for (const m of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
    // a string can be made of several runs: <r><t>Hello </t></r><r><t>world</t></r>
    out.push(decodeXml([...m[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join("")));
  }
  return out;
}

// The cells of one <row> element
function rowValues(rowXml, strings) {
  const cells = [];
  let width = 0;
  for (const m of rowXml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const attrs = m[1];
    const ref = attrs.match(/\br="([A-Z]+)\d+"/);
    if (!ref || m[2] === undefined) continue;
    const type = attrs.match(/\bt="([a-zA-Z]+)"/)?.[1];
    let value = "";
    if (type === "inlineStr") {
      value = decodeXml([...m[2].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join(""));
    } else {
      const v = m[2].match(/<v>([\s\S]*?)<\/v>/);
      if (v) value = type === "s" ? (strings[Number(v[1])] ?? "") : decodeXml(v[1]);
    }
    const index = columnIndex(ref[1]);
    cells[index] = value;
    width = Math.max(width, index + 1);
  }
  return Array.from({ length: width }, (_, i) => cells[i] ?? "");
}

// Returns an array of rows (arrays of text); the first row is the header.
export function readXlsxRows(buffer) {
  const files = unzipSync(new Uint8Array(buffer), {
    filter: (f) => /^xl\/(workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|worksheets\/[^/]+\.xml)$/.test(f.name),
  });
  if (!files["xl/workbook.xml"]) throw new Error("This is not an .xlsx file (no workbook found).");

  // the first sheet of the workbook, through its relationship id
  const workbook = strFromU8(files["xl/workbook.xml"]);
  const sheetTag = workbook.match(/<sheet\b[^>]*>/)?.[0] ?? "";
  const rid = sheetTag.match(/\br:id="([^"]+)"/)?.[1];
  const rels = files["xl/_rels/workbook.xml.rels"] ? strFromU8(files["xl/_rels/workbook.xml.rels"]) : "";
  let target = rid && [...rels.matchAll(/<Relationship\b[^>]*>/g)].map((m) => m[0]).find((t) => t.includes(`Id="${rid}"`))?.match(/Target="([^"]+)"/)?.[1];
  target = target ? target.replace(/^\//, "") : "worksheets/sheet1.xml";
  const sheet = files[target.startsWith("xl/") ? target : `xl/${target}`];
  if (!sheet) throw new Error(`The first sheet (${target}) was not found in the file.`);

  const strings = files["xl/sharedStrings.xml"] ? sharedStrings(strFromU8(files["xl/sharedStrings.xml"])) : [];

  const rows = [];
  const addRows = (xml) => {
    for (const m of xml.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) rows.push(m[1] === undefined ? [] : rowValues(m[1], strings));
  };
  const decoder = new TextDecoder("utf-8");
  let pending = "";
  for (let at = 0; at < sheet.length; at += CHUNK_BYTES) {
    pending += decoder.decode(sheet.subarray(at, Math.min(sheet.length, at + CHUNK_BYTES)), { stream: true });
    const end = pending.lastIndexOf("</row>");
    if (end < 0) continue;
    // only whole rows are read now; the start of the next one waits for the next piece
    addRows(pending.slice(0, end + 6));
    pending = pending.slice(end + 6);
  }
  addRows(pending + decoder.decode()); // what is left at the end, such as an empty <row/>
  return rows;
}
