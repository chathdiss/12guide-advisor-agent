// Looks up the passages of the approved sources that belong to a question.
// `search(db, query)` is searchKnowledge from packages/knowledge; `db` is a pg Pool.

const MAX_PASSAGE_CHARS = 2400; // one piece of a source file
const MAX_TOPIC_CHARS = 16000; // a whole community topic or blog post
const MAX_TOTAL_CHARS = 150000; // everything sent to the agent for one question

// A short follow-up such as "and the second step?" finds nothing alone, so the previous question helps
export function retrievalQuery(question, history = []) {
  if (question.split(/\s+/).length >= 4) return question;
  const previous = [...history].reverse().find((m) => m.role === "user");
  return previous ? `${previous.content.slice(0, 300)} ${question}` : question;
}

// The rewrite turns "Admin Studio" or "July 2025" into general words ("system configuration", "security patch")
// that outweigh the exact ones, so the question is also searched as typed. Results of the two searches
// are taken in turn, without repeats, until `limit` is reached.
// A phrase in quotes is taken as a title: a document with exactly that title goes first.
const chunkKey = (r) => r.ref ?? `${r.path}:${r.startLine}:${r.content}`;
export const quotedPhrases = (text) => [...text.matchAll(/["“”']([^"“”']{6,200})["“”']/g)].map((m) => m[1]);

// A phrase without quotes can be a title as well: "high-level architecture" is the page "High Level Architecture",
// yet the pages that talk most about layers and tiers would otherwise rank above it. These are the groups of 2 to 5
// words of the question (hyphens and punctuation count as spaces) that neither start nor end with a filler word;
// the database keeps only those that are exactly the title of a documentation page.
const FILLER = new Set("a an the and or of to in on for with is are was were be how do does did can could should would what which who when where why i we you it this that these those my our your me about from into by as at if then than so there here not no".split(" "));
export function titleNgrams(text, { maxWords = 5, max = 40 } = {}) {
  const words = String(text ?? "").toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const out = new Set();
  for (let size = 2; size <= maxWords; size++) {
    for (let i = 0; i + size <= words.length; i++) {
      const group = words.slice(i, i + size);
      if (FILLER.has(group[0]) || FILLER.has(group[size - 1])) continue;
      const phrase = group.join(" ");
      if (phrase.length >= 8) out.add(phrase);
    }
  }
  return [...out].slice(0, max);
}

// A question about code ("source code", PL/SQL, a file, a method) also gets a search in the code alone: the
// general words of such a question ("files", "methods") otherwise pull in documentation first.
export const asksAboutCode = (text) =>
  /source code|pl\/?sql|\.(plsql|plsvc|views|entity|storage)\b|\b(which|what) (files?|projections?|entit(?:y|ies)|fragments?|procedures?|functions?|clients?|enumerations?)\b|\bmethods?\b|\bpackages?\b/i.test(text);
const CODE_ORIGIN = "IFS source code";

export async function searchBoth(search, db, query, limit, keywords, findTitles = null, findNames = null) {
  // the searches are independent: run them side by side
  const aboutCode = asksAboutCode(query);
  const [titled, exact, widened, code, named] = await Promise.all([
    findTitles ? findTitles(db, quotedPhrases(query), { implicit: titleNgrams(query) }) : [],
    search(db, query, { limit, preferCode: aboutCode }),
    keywords?.length ? search(db, query, { limit, keywords, preferCode: aboutCode }) : [],
    // the code is searched with the words of the question: synonyms ("accrual accounting") only dilute the names of code
    aboutCode ? search(db, query, { limit: 8, origin: CODE_ORIGIN }) : [],
    // the files that are named like the thing asked about (CustomerOrderLine.plsql for "customer order line")
    aboutCode && findNames ? findNames(db, query, { limit: 4 }) : [],
  ]);
  const out = [];
  const seen = new Set();
  for (const r of titled) {
    seen.add(chunkKey(r));
    out.push(r);
  }
  for (let i = 0; out.length < limit && (i < exact.length || i < widened.length || i < code.length || i < named.length); i++) {
    // for a question about code the code comes first, otherwise a page of the documentation leads
    // the first named file comes after the first code result, the second after the second one, and so on
    for (const r of code.length > 0 || named.length > 0 ? [code[i], named[i], exact[i], widened[i]] : [exact[i], widened[i]]) {
      if (!r || out.length >= limit) continue;
      const key = chunkKey(r);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(r);
    }
  }
  return out;
}

// Turns search results into the passages that are sent to the agent: a whole short document, or the part of a long one
// around the match, within a total number of characters. `full` is the Map of whole texts of web documents (loadFull).
export function buildPassages(found, full = new Map(), { budget = MAX_TOTAL_CHARS } = {}) {
  const passages = [];
  const seen = new Set(); // short documents, already included in full
  const covered = new Map(); // long documents: the last line of the part already included
  for (const r of found) {
    if (budget <= 0) break;
    const text = r.url ? full.get(r.path) : null;
    let content = r.content.slice(0, MAX_PASSAGE_CHARS);
    let startLine = r.startLine;
    let endLine = r.endLine;
    if (text && text.length <= MAX_TOPIC_CHARS) {
      // a community topic, a blog post, a documentation page: the whole of it
      if (seen.has(r.path)) continue;
      seen.add(r.path);
      content = text;
      startLine = 1;
      endLine = text.split("\n").length;
    } else if (text) {
      // a long document (a guide of hundreds of pages): the part around the match, not its beginning
      if (r.startLine <= (covered.get(r.path) ?? 0)) continue;
      const lines = text.split("\n");
      const from = Math.max(0, r.startLine - 4);
      let to = from;
      let used = 0;
      while (to < lines.length && used + lines[to].length + 1 <= MAX_TOPIC_CHARS) used += lines[to++].length + 1;
      content = lines.slice(from, to).join("\n");
      startLine = from + 1;
      endLine = to;
      covered.set(r.path, to);
    }
    content = content.slice(0, budget);
    budget -= content.length;
    passages.push({
      id: passages.length + 1,
      title: r.title,
      path: r.path,
      origin: r.origin,
      url: r.url || "",
      version: `${r.component} ${r.version}`.trim(),
      startLine,
      endLine,
      content,
    });
  }
  return passages;
}

// Returns a function (question, history) => { status: "ok" | "unavailable", passages }
// `rewrite` (optional) turns the question into keywords first; when it gives nothing, the search
// uses the words of the question as before. `loadFull` (optional) gives the whole text of web
// documents (community topics, blog posts) so the agent sees the complete discussion.
export function createRetriever({ db, search, rewrite = null, loadFull = null, findTitles = null, findNames = null, limit = 12 }) {
  return async (question, history) => {
    try {
      const query = retrievalQuery(question, history);
      // a short question gets the previous one in front of it; "what is 2+2" after an IFS question must
      // still be recognised as off-topic, so it is judged on its own first
      if (rewrite && query !== question && (await rewrite(question))?.offTopic) return { status: "ok", passages: [] };
      const rewritten = rewrite ? await rewrite(query) : null;
      if (rewritten?.offTopic) return { status: "ok", passages: [] };
      const found = await searchBoth(search, db, query, limit, rewritten?.keywords ?? null, findTitles, findNames);
      const full = loadFull ? await loadFull(db, found.filter((r) => r.url).map((r) => r.path)) : new Map();

      const passages = buildPassages(found, full);
      return { status: "ok", passages };
    } catch (err) {
      console.error(JSON.stringify({ time: new Date().toISOString(), knowledge: "unavailable", error: String(err?.message ?? err) }));
      return { status: "unavailable", passages: [] };
    }
  };
}
