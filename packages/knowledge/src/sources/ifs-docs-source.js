// The documentation sets of docs.ifs.com that are built as MkDocs sites (IFS Cloud Technical Documentation
// per release, IFS.ai, Lifecycle Experience). Each publishes the text of all its pages in one search index
// (search.json), the file its own search box loads. That file is saved outside the repository and read here;
// the pages themselves are not fetched one by one.
import { htmlToText } from "../html-to-text.js";

export const ORIGIN = "IFS documentation";
export const SITE = "https://docs.ifs.com/techdocs";

export const sourceId = (release) => `ifs-techdocs-${release.toLowerCase()}`;

// The index lists sections: a page has one entry per heading. location is "page/path/" or "page/path/#anchor".
// Returns [{ location, title, path, sections: [{ title, level, text }] }] in the order of the index.
export function groupPages(index) {
  const pages = new Map();
  for (const item of index?.items ?? []) {
    const page = String(item.location ?? "").split("#")[0]; // "" is the start page of the set
    if (!pages.has(page)) pages.set(page, { location: page, title: "", path: item.path ?? [], sections: [] });
    const entry = pages.get(page);
    const text = htmlToText(item.text ?? "");
    if (!entry.title && item.title) entry.title = String(item.title).trim();
    if (item.path?.length > entry.path.length) entry.path = item.path;
    if (text) entry.sections.push({ title: String(item.title ?? "").trim(), level: Number(item.level) || 2, text });
  }
  return [...pages.values()].filter((p) => p.sections.length > 0);
}

// One page as a document: { docKey, url, title, version, component, text, meta }
// `options` is { baseUrl, version } or, for the IFS Cloud technical documentation, just the release ("25R2").
export function pageToDocument(page, options) {
  const release = typeof options === "string" ? options : null;
  const baseUrl = release ? `${SITE}/${release.toLowerCase()}/` : options.baseUrl;
  const version = release ? `IFS Cloud ${release.toUpperCase()}` : options.version;
  const guide = page.path[0] ?? "";
  const trail = page.path.join(" > ");
  const parts = [`# ${page.title || page.path.at(-1) || page.location}`, trail && `Where: ${trail}`];
  for (const s of page.sections) {
    // a section that repeats the page title is the introduction of the page: no extra heading
    parts.push(s.title && s.title !== page.title ? `${"#".repeat(Math.min(Math.max(s.level, 1) + 1, 6))} ${s.title}\n\n${s.text}` : s.text);
  }
  const url = `${baseUrl.replace(/\/+$/, "")}/${page.location}`.replace(/\/$/, page.location ? "/" : "");
  return {
    docKey: url,
    url,
    title: page.title || page.path.at(-1) || page.location,
    version,
    component: guide,
    text: parts.filter(Boolean).join("\n\n"),
    meta: { guide, path: page.path, version },
  };
}
