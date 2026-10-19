// The agent cites the passages it was given as [1], [2], ... The numbers are only valid for one
// request, so they are checked here: markers that do not match a passage are removed, the rest are
// renumbered in order of first use, and the sources list holds exactly the passages that were cited.
import { API_ORIGIN } from "./api-docs.js";

const MARKER = /\s?\[(\d{1,2}(?:\s*,\s*\d{1,2})*)\]/g;
const CODE = /(```[\s\S]*?```|`[^`\n]*`)/;

// An earlier answer of the chat, without its markers. The numbers in it belong to the sources of that earlier question, so
// an agent that sees them next to a new set of sources may cite the wrong source under a number it has seen before.
// Code is left alone: arr[1] in a code sample is not a citation.
export function stripCitations(text) {
  return String(text ?? "")
    .split(CODE)
    .map((part, i) => (i % 2 === 1 ? part : part.replace(MARKER, "")))
    .join("");
}

export function buildCitations(answer, passages) {
  const order = []; // passage indexes in order of first citation
  const newNumber = new Map();

  // two passages from the same web page are one source: the page is listed once
  const firstOfUrl = new Map();
  const canonical = passages.map((p, i) => {
    if (!p.url) return i;
    if (!firstOfUrl.has(p.url)) firstOfUrl.set(p.url, i);
    return firstOfUrl.get(p.url);
  });

  // the same number twice in a row ([1][1], also after two passages of one page were merged) is written once
  const collapse = (text) => text.replace(/(\[\d{1,2}\])(?:\s?\1)+/g, "$1");

  const rewrite = (text) =>
    collapse(text.replace(MARKER, (whole, list) => {
      const numbers = [];
      for (const raw of list.split(",")) {
        const asked = Number(raw.trim()) - 1;
        if (!passages[asked]) continue;
        const index = canonical[asked];
        if (!newNumber.has(index)) {
          order.push(index);
          newNumber.set(index, order.length);
        }
        const n = newNumber.get(index);
        if (!numbers.includes(n)) numbers.push(n);
      }
      if (numbers.length === 0) return "";
      return `${whole.startsWith(" ") ? " " : ""}${numbers.map((n) => `[${n}]`).join("")}`;
    }));

  // code is left alone: arr[1] in a code sample is not a citation
  const text = answer
    .split(CODE)
    .map((part, i) => (i % 2 === 1 ? part : rewrite(part)))
    .join("");

  return { answer: text, sources: order.map((i) => toSource(passages[i])) };
}

// The model sometimes puts the right fact under the wrong number when it has many long passages. A
// sentence that names identifiers (work_task_tab, JT_TASK_API, ORA-20110, JtTaskStep ...) can be checked
// exactly: when the cited passages do not contain those identifiers but another passage does, the marker
// is moved to that passage. Sentences without identifiers, or without a clear match, are left as written.
const IDENTIFIER = /[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]+|[A-Za-z]+\d[A-Za-z0-9_]*|\b[A-Z][a-z]+[A-Z][A-Za-z]+\b/g;

function wordsOf(text) {
  const out = new Set();
  for (const w of text.toLowerCase().match(/[a-z][a-z0-9_]{2,}/g) ?? []) out.add(w);
  return out;
}

// Returns { answer, repaired, unverified }: repaired = sentences whose marker was moved to the passage that
// holds their identifiers; unverified = sentences naming several identifiers that no passage contains, whose
// marker was removed (a wrong source is worse than no source).
export function repairCitations(answer, passages, { minMatch = 0.75, minGain = 0.4 } = {}) {
  const sets = passages.map((p) => wordsOf(`${p.title} ${p.content}`));
  const SENTENCE_BREAK = /(?<=[.!?])(\s+)(?=[A-Z0-9`*-])/;
  let repaired = 0;
  let unverified = 0;

  const fixSentence = (sentence) => {
    const markers = [...sentence.matchAll(MARKER)];
    if (markers.length === 0) return sentence;
    const anchors = new Set((sentence.replace(MARKER, " ").match(IDENTIFIER) ?? []).map((w) => w.toLowerCase()).filter((w) => w.length >= 5));
    if (anchors.size === 0) return sentence;
    const score = (set) => [...anchors].filter((w) => set.has(w)).length / anchors.size;

    const cited = new Set(markers.flatMap((m) => m[1].split(",").map((x) => Number(x.trim()) - 1)).filter((i) => passages[i]));
    const bestCited = Math.max(0, ...[...cited].map((i) => score(sets[i])));
    let best = -1;
    let bestScore = 0;
    sets.forEach((set, i) => {
      const sc = score(set);
      if (sc > bestScore) {
        best = i;
        bestScore = sc;
      }
    });
    if (anchors.size >= 2 && bestScore < 0.5 && bestCited < 0.5) {
      unverified++;
      return sentence.replace(MARKER, "");
    }
    if (best < 0 || cited.has(best) || bestScore < minMatch || bestScore - bestCited < minGain) return sentence;

    repaired++;
    let first = true;
    return sentence.replace(MARKER, (whole) => {
      if (!first) return "";
      first = false;
      return `${whole.startsWith(" ") ? " " : ""}[${best + 1}]`;
    });
  };

  const fixPart = (part) =>
    part
      .split("\n")
      .map((line) => line.split(SENTENCE_BREAK).map((piece, i) => (i % 2 === 0 ? fixSentence(piece) : piece)).join(""))
      .join("\n");

  // code is left alone, as in buildCitations
  const text = answer
    .split(CODE)
    .map((part, i) => (i % 2 === 1 ? part : fixPart(part)))
    .join("");
  return { answer: text, repaired, unverified };
}

export function toSource(p) {
  return {
    title: p.title,
    // the link of an API card points to a development environment that needs a login: the card is used for the answer, the link is not shown
    url: p.origin === API_ORIGIN ? "" : (p.url ?? ""),
    origin: p.origin,
    path: p.path,
    startLine: p.startLine,
    endLine: p.endLine,
    version: p.version,
    excerpt: p.content.slice(0, 1200),
  };
}
