// Reads Word (.docx) and PDF files in the browser and turns them into plain text, which is attached to the question like
// any text file (kind "text"): the backend and the n8n workflow need no change.
//
// Word: mammoth converts the document to HTML (headings, lists, tables), and htmlToText below turns that HTML into
// compact text that keeps the headings, list items and table rows. Pictures are dropped: they would only cost tokens.
// PDF: pdf.js reads the text page by page, and every page is marked ("[Page 3]") so the answer can say where something is.
// Both libraries are loaded when a file of that kind is attached, so they do not slow down the first page load.
//
// This file imports nothing but types, so the HTML conversion can be tested with plain `node --test`.

export class DocumentError extends Error {
  reason: "unreadable" | "noText" | "tooLong";
  constructor(reason: "unreadable" | "noText" | "tooLong") {
    super(reason);
    this.reason = reason;
  }
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decode(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === "#") {
      const n = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : whole;
    }
    return ENTITIES[code.toLowerCase()] ?? whole;
  });
}

// The HTML that mammoth writes (p, h1-h6, ul/ol/li, table, strong, em, a, br, img) as text:
//   headings   -> "# Heading", "## Heading" ...
//   lists      -> "- item" and "1. item", indented for a list inside a list
//   tables     -> one line per row: "| cell | cell |"
export function htmlToText(html: string): string {
  let out = "";
  const lists: { ordered: boolean; n: number }[] = [];
  let cell: string | null = null; // the text of the table cell that is being read
  let row: string[] | null = null;
  const emit = (s: string) => {
    if (cell !== null) cell += s.replace(/\n+/g, " ");
    else out += s;
  };

  for (const m of html.matchAll(/<!--[\s\S]*?-->|<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>|[^<]+|</g)) {
    const [token, closing, rawTag] = m;
    if (!rawTag) {
      if (!token.startsWith("<!--")) emit(decode(token).replace(/\s+/g, " "));
      continue;
    }
    const tag = rawTag.toLowerCase();
    if (!closing) {
      if (/^h[1-6]$/.test(tag)) emit(`\n\n${"#".repeat(Number(tag[1]))} `);
      else if (tag === "p") emit("\n\n");
      else if (tag === "br") emit("\n");
      else if (tag === "ul" || tag === "ol") {
        if (lists.length === 0) emit("\n"); // a list inside a list continues on the next line
        lists.push({ ordered: tag === "ol", n: 0 });
      } else if (tag === "li") {
        const list = lists[lists.length - 1];
        const indent = "  ".repeat(Math.max(0, lists.length - 1));
        emit(`\n${indent}${list?.ordered ? `${++list.n}. ` : "- "}`);
      } else if (tag === "table") emit("\n\n");
      else if (tag === "tr") row = [];
      else if (tag === "td" || tag === "th") cell = "";
    } else {
      if (/^h[1-6]$/.test(tag) || tag === "p") emit("\n");
      else if (tag === "ul" || tag === "ol") {
        lists.pop();
        if (lists.length === 0) emit("\n");
      } else if (tag === "td" || tag === "th") {
        row?.push((cell ?? "").replace(/\s+/g, " ").trim());
        cell = null;
      } else if (tag === "tr") {
        if (row && row.length > 0) out += `| ${row.join(" | ")} |\n`;
        row = null;
      } else if (tag === "table") out += "\n";
    }
  }

  return out
    .replace(/[ \t]+$/gm, "")
    .replace(/^(\s*(?:-|\d+\.) )\n+/gm, "$1") // a list marker followed by a paragraph break
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Word (.docx) -> text
export async function docxToText(buffer: ArrayBuffer): Promise<string> {
  const mammoth = await import("mammoth");
  let html: string;
  try {
    const result = await mammoth.convertToHtml(
      { arrayBuffer: buffer },
      // pictures are not sent to the advisor: they would be embedded as huge base64 strings
      { convertImage: mammoth.images.imgElement(() => Promise.resolve({ src: "" })) },
    );
    html = result.value;
  } catch {
    throw new DocumentError("unreadable");
  }
  const text = htmlToText(html);
  if (text.length < 20) throw new DocumentError("noText");
  return text;
}

// PDF -> text, one "[Page n]" block per page. Stops when the text is longer than `maxChars`.
export async function pdfToText(buffer: ArrayBuffer, maxChars: number): Promise<string> {
  const pdfjs = await import("pdfjs-dist");
  // the worker file is bundled as an asset and served from this site
  pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
  const task = pdfjs.getDocument({ data: new Uint8Array(buffer) });
  let doc: Awaited<typeof task.promise>;
  try {
    doc = await task.promise;
  } catch {
    await task.destroy().catch(() => {});
    throw new DocumentError("unreadable");
  }
  const pages: string[] = [];
  let total = 0;
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      const lines: string[] = [];
      let line = "";
      for (const item of content.items) {
        if (!("str" in item)) continue;
        line += item.str;
        if (item.hasEOL) {
          lines.push(line);
          line = "";
        }
      }
      if (line) lines.push(line);
      const text = lines.map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n");
      page.cleanup();
      if (!text) continue;
      pages.push(`[Page ${n}]\n${text}`);
      total += text.length + 12;
      if (total > maxChars) throw new DocumentError("tooLong");
    }
  } finally {
    await task.destroy();
  }
  if (pages.join("").length < 20) throw new DocumentError("noText"); // a scanned PDF has no text layer
  return pages.join("\n\n");
}
