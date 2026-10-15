// Single web pages of docs.ifs.com that cannot be fetched by a script (they sit behind the site's browser
// check) and have no search index: a person's browser reads them, and they are saved as JSON lines
// { url, title, group, text, h }. `h` is a checksum made in the browser over title and text, so a page that
// was altered or mistyped on the way is refused here.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

export const SOURCE_ID = "ifs-docs-pages";
export const ORIGIN = "IFS documentation";

export function checksum(rec) {
  return createHash("sha1").update(`${rec.title}\n${rec.text}`).digest("hex").slice(0, 12);
}

export function isValidRecord(rec) {
  return Boolean(
    rec &&
      typeof rec.url === "string" &&
      (rec.url.startsWith("https://docs.ifs.com/") || rec.url.startsWith("https://community.ifs.com/")) &&
      typeof rec.title === "string" &&
      typeof rec.text === "string" &&
      rec.title &&
      rec.text &&
      rec.h === checksum(rec),
  );
}

// Reads pages.jsonl, pages-2.jsonl and so on from the folder. Returns { records, rejected }
export function readRecords(dir) {
  const records = new Map(); // url -> record, later lines win
  let rejected = 0;
  const files = readdirSync(dir).filter((f) => /^pages.*[.]jsonl$/.test(f)).sort();
  for (const file of files) {
    // split on the newline character only: a page may contain other line separators
    for (const line of readFileSync(path.join(dir, file), "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line);
        if (isValidRecord(rec)) records.set(rec.url, rec);
        else rejected++;
      } catch {
        rejected++;
      }
    }
  }
  return { records: [...records.values()], rejected };
}

// One page as a document: { source, origin, docKey, url, title, version, component, text, meta }
// A record may name its own source, origin and version (Community articles are stored as "IFS community").
export function pageToDocument(rec) {
  return {
    source: rec.source ?? SOURCE_ID,
    origin: rec.origin ?? ORIGIN,
    docKey: rec.url,
    url: rec.url,
    title: rec.title,
    version: rec.version ?? "web page",
    component: rec.group ?? "",
    text: `# ${rec.title}\n\n${rec.text}`,
    meta: { group: rec.group, ...(rec.date ? { date: rec.date } : {}) },
  };
}
