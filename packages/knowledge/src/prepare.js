import { createHash } from "node:crypto";
import { chunkText } from "./chunk.js";
import { splitIdentifiers } from "./identifiers.js";
import { readTextFile } from "./read-text.js";

// Splits a text into the chunks that are stored. `doc` needs docKey and title.
export function chunkDocument(text, doc) {
  return chunkText(text).map((chunk, index) => ({
    chunkIndex: index,
    startLine: chunk.startLine,
    endLine: chunk.endLine,
    content: chunk.text,
    // what the keyword search looks at: the text, where it comes from, and the words inside identifiers
    searchText: [doc.docKey, chunk.text, splitIdentifiers(`${doc.title} ${chunk.text}`)].join("\n"),
  }));
}

// Turns one file into the rows that are stored: a document and its chunks.
export async function prepareDocument(file) {
  let text = await readTextFile(file.absPath);

  // field description files list thousands of UNUSED entries, which only add noise
  if (file.ext === ".csv") {
    text = text
      .split(/\r\n|\n|\r/)
      .filter((line) => !/;UNUSED;/i.test(line))
      .join("\n");
  }

  const chunks = chunkDocument(text, file);

  const hash = hashText(text);
  return { chunks, characters: text.length, hash };
}

// a change in the text, or in how it is cut up, changes the hash, so only then is it stored again
export function hashText(text) {
  return createHash("sha1").update(`v2
${text}`).digest("hex");
}
