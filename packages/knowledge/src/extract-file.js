// Reads the text of documents that are files: PDF, PowerPoint (.pptx) and Word (.docx).
// Every function returns the text per page, slide or paragraph group, so the pages can be marked in the text.
import { strFromU8, unzipSync } from "fflate";
import { decodeEntities } from "./html-to-text.js";

// PDF: one string per page
export async function extractPdf(buffer) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({ data: new Uint8Array(buffer), useSystemFonts: true, isEvalSupported: false, verbosity: 0 });
  const doc = await task.promise;
  const pages = [];
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      const lines = [];
      let line = "";
      for (const item of content.items) {
        line += item.str;
        if (item.hasEOL) {
          lines.push(line);
          line = "";
        }
      }
      if (line) lines.push(line);
      pages.push(lines.map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n"));
      page.cleanup();
    }
  } finally {
    await task.destroy();
  }
  return pages;
}

// The text inside <tag>...</tag> elements of one paragraph-like block, tabs and line breaks kept
function runs(xmlBlock, tag) {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>|<(?:w:tab|w:br)\\s*/>`, "g");
  let out = "";
  for (const m of xmlBlock.matchAll(re)) out += m[1] === undefined ? (m[0].startsWith("<w:tab") ? "\t" : "\n") : decodeEntities(m[1]);
  return out;
}

const paragraphs = (xml, para, tag) =>
  xml
    .split(`</${para}>`)
    .map((block) => runs(block, tag).replace(/[ \t]+/g, " ").trim())
    .filter(Boolean);

// PowerPoint: one string per slide, with its speaker notes
export function extractPptx(buffer) {
  const files = unzipSync(new Uint8Array(buffer));
  const number = (name) => Number(name.match(/(\d+)\.xml$/)?.[1] ?? 0);
  const slides = Object.keys(files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => number(a) - number(b));
  return slides.map((name) => {
    const text = paragraphs(strFromU8(files[name]), "a:p", "a:t");
    const notes = files[`ppt/notesSlides/notesSlide${number(name)}.xml`];
    const noteText = notes ? paragraphs(strFromU8(notes), "a:p", "a:t").filter((t) => !/^\d+$/.test(t)) : [];
    return [...text, ...(noteText.length ? ["Speaker notes:", ...noteText] : [])].join("\n");
  });
}

// Word: the paragraphs, in groups, so that a long document is not one string
export function extractDocx(buffer) {
  const files = unzipSync(new Uint8Array(buffer));
  const doc = files["word/document.xml"];
  if (!doc) return [];
  const all = paragraphs(strFromU8(doc), "w:p", "w:t");
  const groups = [];
  for (let i = 0; i < all.length; i += 40) groups.push(all.slice(i, i + 40).join("\n"));
  return groups;
}

// Picks the reader by the file name. Returns { kind, pages }
export async function extractFile(name, buffer) {
  const ext = name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  if (ext === "pdf") return { kind: "PDF", unit: "Page", pages: await extractPdf(buffer) };
  if (ext === "pptx") return { kind: "PowerPoint", unit: "Slide", pages: extractPptx(buffer) };
  if (ext === "docx") return { kind: "Word", unit: "Part", pages: extractDocx(buffer) };
  throw new Error(`no reader for .${ext} files`);
}
