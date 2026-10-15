import { readFile } from "node:fs/promises";

// Reads a source file as text, whatever its encoding: UTF-16 (with byte-order mark),
// UTF-8 with or without a mark, or the old Windows code page.
export async function readTextFile(path) {
  const buf = await readFile(path);

  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.toString("utf16le").replace(/^﻿/, "").replace(/\u0000/g, "");
  }

  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    text = new TextDecoder("windows-1252").decode(buf);
  }
  return text.replace(/^﻿/, "").replace(/\u0000/g, "");
}
