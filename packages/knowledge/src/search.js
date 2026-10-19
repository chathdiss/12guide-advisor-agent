import { createHash } from "node:crypto";
import { splitIdentifiers } from "./identifiers.js";

// Words that say nothing about the topic, in English and Dutch, plus the product name itself
const STOPWORDS = new Set(
  (
    "a an the and or of to in on for with is are was were be been how do does did can could should would what which who when where why " +
    "i we you it this that these those my our your me about from into by as at not no if then than so there here " +
    "de het een en of van te in op voor met is zijn was waren wordt worden hoe wat welke wie wanneer waar waarom ik we je jij u " +
    "dit dat deze die mijn onze uw niet geen als dan zo er hier om aan bij naar uit door ook maar kan kun kunnen moet moeten " +
    "ifs cloud please help show explain tell give using use used make"
  ).split(" "),
);

// The words of a question that are worth searching for. Identifiers such as CodeBHandling
// are searched both whole and as the words inside them.
export function queryTerms(query, max = 12) {
  const terms = new Set();
  const add = (word) => {
    const w = word.toLowerCase().replace(/[^a-z0-9_]/g, "");
    if (w.length >= 2 && !STOPWORDS.has(w)) terms.add(w);
  };
  for (const token of query.match(/[A-Za-z0-9_]+/g) ?? []) {
    add(token);
    for (const part of splitIdentifiers(token).split(" ")) if (part) add(part);
  }
  return [...terms].slice(0, max);
}

// IFS names its tables after the entity: "work task" -> work_task_tab. When the question asks for a table,
// a view or a column, those names are guessed from the words of the question; a guess that exists nowhere
// is dropped later, so a wrong guess costs nothing.
export function guessIdentifiers(query, max = 12) {
  if (!/\b(tables?|views?|columns?)\b/i.test(query)) return [];
  const skip = /^(tables?|views?|columns?|find|information|info|data|details?|stored?|stores|where|give|list)$/;
  const words = (query.toLowerCase().match(/[a-z][a-z0-9]{2,}/g) ?? []).filter((w) => !STOPWORDS.has(w) && !skip.test(w));
  const out = new Set();
  for (let size = 3; size >= 2; size--) {
    for (let i = 0; i + size <= words.length; i++) {
      const name = words.slice(i, i + size).join("_");
      out.add(name);
      out.add(`${name}_tab`);
    }
  }
  return [...out].slice(0, max);
}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Word forms. The index has no stemmer, and IFS names its methods Validate___, Check_Insert___ and Create_New___, so a
// question word such as "validates" or "creating" must also find "validate" and "create". Only the endings of a word
// are handled (-s, -es, -ed, -ing: validates, validate, validated, validating), not related words such as
// "validation" or "configuration": they say something else and would bring in far too many chunks. Words under
// 5 letters, and words with digits, underscores or other signs (error codes, API and table names) stay as they are.
const MIN_BASE = 5;
const MAX_FORMS = 6;

// In a search of the source code alone, words that only say "this is about code" tell nothing about the topic:
// every file is a package with methods. They are left out, so "Which PL/SQL package validates a voucher in accrul,
// and which file is it in?" is searched as "validates voucher accrul" (unless fewer than two words would be left).
const CODE_FILLER = new Set([
  "pl", "sql", "plsql", "package", "packages", "file", "files", "method", "methods", "procedure", "procedures",
  "function", "functions", "code", "source", "show", "relevant", "involved", "implemented", "work", "works",
]);

// The forms a word might have; which of them exist in the index is looked up afterwards.
export function inflections(term) {
  if (!/^[a-z]+$/.test(term) || term.length < MIN_BASE) return [];
  const bases = new Set();
  const add = (b) => b.length >= MIN_BASE && bases.add(b);
  const doubled = (b) => b.length > 1 && b.at(-1) === b.at(-2); // stopped -> stop, running -> run
  if (term.endsWith("ies") || term.endsWith("ied")) {
    add(term.slice(0, -3) + "y");
  } else if (term.endsWith("ing")) {
    const b = term.slice(0, -3);
    add(b);
    add(b + "e");
    if (doubled(b)) add(b.slice(0, -1));
  } else if (term.endsWith("ed")) {
    const b = term.slice(0, -2);
    add(b);
    add(b + "e");
    if (doubled(b)) add(b.slice(0, -1));
  } else if (term.endsWith("es")) {
    add(term.slice(0, -2));
    add(term.slice(0, -1));
  } else if (term.endsWith("s") && !term.endsWith("ss")) {
    add(term.slice(0, -1));
  } else {
    add(term);
  }
  const forms = new Set();
  for (const b of bases) {
    for (const ending of ["", "s", "es", "ed", "d", "ing"]) forms.add(b + ending);
    if (b.endsWith("e")) forms.add(b.slice(0, -1) + "ing");
    if (b.endsWith("y")) {
      forms.add(b.slice(0, -1) + "ies");
      forms.add(b.slice(0, -1) + "ied");
    }
  }
  forms.delete(term);
  return [...forms];
}

// Finds the chunks that best match a question. `db` is a pg Pool or Client.
// Chunks must contain most of the terms; at most `perDocument` chunks per file are returned.
// `keywords` (optional) are the words an AI rewrite made of the question: translated, abbreviations
// expanded, with synonyms. They replace the words of the question. Because synonyms widen the list,
// a chunk then only has to contain a quarter of the terms instead of half.
// `stemming: false` turns the word forms off (for comparing).
// `preferCode: true` (for a question about code) lets source code count as much as the official documentation.
// `excludeOrigin` leaves one source out of the search (the 23,000 API cards, which have their own search and only slow down the others)
export async function searchKnowledge(db, query, { limit = 6, perDocument = 2, candidates = 30, keywords = null, origin = null, excludeOrigin = null, stemming = true, preferCode = false } = {}) {
  const rewritten = Array.isArray(keywords) && keywords.length > 0 ? queryTerms(keywords.join(" "), 24) : [];
  const wanted = [...new Set([...(rewritten.length > 0 ? rewritten : queryTerms(query, 30)), ...guessIdentifiers(query)])];
  const specific = origin ? wanted.filter((t) => !CODE_FILLER.has(t)) : wanted;
  const asked = specific.length >= 2 ? specific : wanted;
  if (asked.length === 0) return [];
  const minCoverage = rewritten.length > 0 ? 0.25 : 0.5;

  // Words found in most chunks ("error", "type") would make nearly every chunk a candidate. Only the
  // rarer words choose the candidates; all words still count when the candidates are scored.
  // The possible forms of every word (validates -> validate, validated, validating) are looked up in the same query.
  const possible = new Map(asked.map((t) => [t, stemming ? inflections(t) : []]));
  const { rows: statRows } = await db.query(
    "SELECT term, df, (SELECT count(*) FROM knowledge_chunks) AS n FROM knowledge_term_stats WHERE term = ANY($1)",
    [[...new Set([...asked, ...[...possible.values()].flat()])]],
  );
  const total = Number(statRows.find((r) => r.n !== undefined)?.n ?? Infinity);
  const frequency = new Map(statRows.filter((r) => r.term !== undefined).map((r) => [r.term, Number(r.df)]));
  // Names with underscores (work_task_tab) are split into words by the index and matched as a phrase, so
  // the statistics have no row for them: count those directly.
  if (frequency.size > 0) {
    const unknown = asked.filter((t) => !frequency.has(t));
    const counts = await Promise.all(
      unknown.map((t) => db.query("SELECT count(*) AS n FROM knowledge_chunks WHERE tsv @@ to_tsquery('simple', $1)", [t])),
    );
    unknown.forEach((t, i) => counts[i].rows[0]?.n > 0 && frequency.set(t, Number(counts[i].rows[0].n)));
  }
  // The forms that exist in the index count with their word: a chunk that has any of them matches the word, and
  // the word weighs as much as all its forms together are common. The forms are not used to choose the
  // candidates (below), only to score them, so a common form cannot flood the search.
  const forms = new Map(
    asked.map((t) => {
      const found = possible.get(t).filter((f) => (frequency.get(f) ?? 0) > 0).sort((a, b) => frequency.get(b) - frequency.get(a)).slice(0, MAX_FORMS);
      return [t, { forms: found, df: found.reduce((n, f) => n + frequency.get(f), 0) }];
    }),
  );
  const variantsOf = (t) => [t, ...forms.get(t).forms];
  const ownFrequency = (t) => frequency.get(t) ?? 0;
  const frequencyOf = (t) => ownFrequency(t) + forms.get(t).df;
  // a word that is in no chunk at all (a typo, a guessed name that does not exist) cannot match anything and
  // must not lower the match score of every chunk
  const hasStatistics = frequency.size > 0;
  const terms = hasStatistics ? asked.filter((t) => frequencyOf(t) > 0) : asked;
  if (terms.length === 0) return [];
  // a word that is itself not in the index (only its forms are) is searched through its forms
  const candidateWord = (t) => (ownFrequency(t) > 0 || forms.get(t).forms.length === 0 ? t : variantsOf(t).join(" | "));
  const rare = terms.filter((t) => (ownFrequency(t) > 0 ? ownFrequency(t) : frequencyOf(t)) < total * 0.1);
  const searchTerms = candidateTerms(rare.length >= 2 ? rare : terms, (t) => ownFrequency(t) || frequencyOf(t));

  // Every word gets a weight: a word found in few chunks ("payee", "camt") tells more than one found in
  // most ("payment", "error"). The best `candidates` chunks of every source are kept, by that weighted
  // score, so a large source (the code) cannot push the others out.
  const { rows } = await db.query(
    `WITH t AS MATERIALIZED (
       SELECT u.term, to_tsquery('simple', u.forms) AS q,
              LN(1 + (SELECT count(*) FROM knowledge_chunks)::float8 / (1 + u.df)) AS w
         FROM unnest($3::text[], $4::int[], $6::text[]) AS u(term, df, forms)
     )
     SELECT * FROM (
       SELECT x.*, ROW_NUMBER() OVER (PARTITION BY x.origin ORDER BY x.wscore DESC, x.rank DESC) AS n FROM (
         SELECT c.id, c.content, c.search_text, c.start_line, c.end_line,
                d.title, d.doc_key, d.origin, d.url, d.version, d.component, d.meta,
                ts_rank_cd(c.tsv, qq.query, 32) AS rank,
                (SELECT COALESCE(SUM(t.w), 0) FROM t WHERE c.tsv @@ t.q) AS wscore,
                (SELECT json_agg(json_build_object('t', t.term, 'w', t.w)) FROM t) AS weights
           FROM knowledge_chunks c
           JOIN knowledge_documents d ON d.id = c.document_id
           CROSS JOIN (SELECT to_tsquery('simple', $1) AS query) qq
          WHERE c.tsv @@ qq.query AND ($5::text IS NULL OR d.origin = $5) AND ($7::text IS NULL OR d.origin <> $7)
       ) x
     ) ranked
      WHERE n <= $2
      ORDER BY wscore DESC, rank DESC`,
    [
      searchTerms.map(candidateWord).join(" | "),
      candidates,
      terms,
      terms.map(frequencyOf),
      origin,
      terms.map((t) => variantsOf(t).join(" | ")),
      excludeOrigin,
    ],
  );

  const weight = new Map((rows[0]?.weights ?? []).map((x) => [x.t, Number(x.w)]));
  const weightOf = (t) => weight.get(t) ?? 1;
  const totalWeight = terms.reduce((n, t) => n + weightOf(t), 0);
  const patterns = terms.map((t) => ({ w: weightOf(t), re: new RegExp(`(^|[^a-z0-9])(?:${variantsOf(t).map(escapeRegExp).join("|")})`) }));
  const askedWords = terms.flatMap(variantsOf);
  const scored = rows.map((r) => {
    const hay = r.search_text.toLowerCase();
    let matchedWeight = 0;
    let matchedCount = 0;
    for (const p of patterns) {
      if (!p.re.test(hay)) continue;
      matchedWeight += p.w;
      matchedCount++;
    }
    const weighted = matchedWeight / totalWeight;
    const coverage = blendedCoverage(weighted, matchedCount / terms.length);
    // the source weight counts in proportion to how well the chunk matches: a weak match gets little of it
    return { r, coverage, weighted, score: (coverage * (10 + sourceWeight(r, preferCode)) + Number(r.rank)) * (titleIsAsked(r.title, askedWords) ? 1 : cachedSizeFactor(r)) };
  });

  // keep chunks that cover enough of the terms (by weight as before, or by the blend), unless that would leave almost nothing
  let kept = scored.filter((s) => s.weighted >= minCoverage || s.coverage >= minCoverage);
  // (counted in documents: a document gives at most `perDocument` results, so three chunks of one file are almost nothing)
  if (new Set(kept.map((k) => k.r.doc_key)).size < 3) kept = scored;
  kept.sort((a, b) => b.score - a.score);

  // No single source may fill more than half of the results while others have matches
  const perOrigin = new Map();
  const originCap = origin ? limit : Math.max(1, Math.ceil(limit / 2));
  const perDoc = new Map();
  const out = [];
  const skipped = [];
  const take = ({ r, coverage, score }) => {
    perDoc.set(r.doc_key, (perDoc.get(r.doc_key) ?? 0) + 1);
    perOrigin.set(r.origin, (perOrigin.get(r.origin) ?? 0) + 1);
    out.push({
      ref: createHash("sha1").update(`${r.doc_key}#${r.id}`).digest("hex").slice(0, 8),
      title: r.title,
      path: r.doc_key,
      origin: r.origin,
      url: r.url,
      version: r.version,
      component: r.component,
      startLine: r.start_line,
      endLine: r.end_line,
      content: r.content,
      coverage: Number(coverage.toFixed(2)),
      score: Number(score.toFixed(3)),
    });
  };
  for (const item of kept) {
    if (out.length >= limit) break;
    if ((perDoc.get(item.r.doc_key) ?? 0) >= perDocument) continue;
    if ((perOrigin.get(item.r.origin) ?? 0) >= originCap) {
      skipped.push(item);
      continue;
    }
    take(item);
  }
  // fill the remaining places with the best of what was held back
  for (const item of skipped) {
    if (out.length >= limit) break;
    if ((perDoc.get(item.r.doc_key) ?? 0) >= perDocument) continue;
    take(item);
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

// Documents whose title is exactly one of the phrases (a question that quotes a title: "Start IFS Cloud
// Workflow using REST API"). Returns the first chunk of each, in the shape of searchKnowledge.
export async function findByTitle(db, phrases, { limit = 3, implicit = [], implicitLimit = 2, implicitChunks = 2 } = {}) {
  const wanted = [...new Set(phrases.map((p) => p.trim().toLowerCase()).filter(Boolean))];
  const guessed = [...new Set((implicit ?? []).map((p) => p.trim().toLowerCase()).filter(Boolean))];
  if (wanted.length === 0 && guessed.length === 0) return [];
  let rows = [];
  if (wanted.length > 0) {
    ({ rows } = await db.query(
      `SELECT DISTINCT ON (d.id) c.id, c.content, c.start_line, c.end_line,
              d.title, d.doc_key, d.origin, d.url, d.version, d.component
         FROM knowledge_documents d
         JOIN knowledge_chunks c ON c.document_id = d.id
        WHERE lower(d.title) = ANY($1)
        ORDER BY d.id, c.chunk_index
        LIMIT $2`,
      [wanted, limit],
    ));
  }
  // Phrases of the question without quotes (see titleNgrams in apps/api): only a documentation page whose title has
  // two or more words and is exactly such a phrase counts, with its first chunks, so the page that carries the very
  // name that was asked about is among the results. Community topics and other sources never count here.
  if (guessed.length > 0) {
    const { rows: pages } = await db.query(
      `SELECT c.id, c.content, c.start_line, c.end_line, c.chunk_index,
              d.id AS doc_id, d.title, d.doc_key, d.origin, d.url, d.version, d.component
         FROM knowledge_documents d
         JOIN knowledge_chunks c ON c.document_id = d.id
        WHERE d.origin = 'IFS documentation'
          AND lower(btrim(regexp_replace(d.title, '[^A-Za-z0-9]+', ' ', 'g'))) = ANY($1)
          AND array_length(string_to_array(btrim(regexp_replace(d.title, '[^A-Za-z0-9]+', ' ', 'g')), ' '), 1) >= 2
        ORDER BY d.id, c.chunk_index
        LIMIT $2`,
      [guessed, implicitLimit * implicitChunks * 3],
    );
    const perDoc = new Map();
    for (const r of pages) {
      const n = perDoc.get(r.doc_id) ?? 0;
      if (n >= implicitChunks || (n === 0 && perDoc.size >= implicitLimit)) continue;
      perDoc.set(r.doc_id, n + 1);
      if (!rows.some((x) => x.id === r.id)) rows.push(r);
    }
  }
  return rows.map((r) => ({
    ref: createHash("sha1").update(`${r.doc_key}#${r.id}`).digest("hex").slice(0, 8),
    title: r.title,
    path: r.doc_key,
    origin: r.origin,
    url: r.url,
    version: r.version,
    component: r.component,
    startLine: r.start_line,
    endLine: r.end_line,
    content: r.content,
    coverage: 1,
    score: 100,
  }));
}

// Files named after the thing a question is about. IFS names its code after the entity: "customer order line" is
// CustomerOrderLine.plsql, "company" is Company.plsql. In a plain-language question about code those files hold the
// answer, but they are not among the best-matching chunks: every file mentions "customer", "order" and "line",
// and a core file is one of thousands of chunks that do. So the file names are looked at directly.
const GENERIC_SINGLE = new Set([
  "number", "value", "values", "system", "object", "objects", "record", "records", "update", "create", "creates", "delete",
  "handle", "handles", "handling", "check", "checks", "status", "table", "tables", "field", "fields", "column", "columns",
  "client", "server", "service", "services", "projection", "projections", "entity", "entities", "fragment", "fragments",
  "update", "updates", "posts", "posting", "validate", "validates", "calls", "called", "using", "used", "uses",
]);
const EXTENSION_ORDER = ["plsql", "plsvc", "projection", "entity", "views", "client", "fragment", "storage"];
const toSingular = (w) => (w.length > 4 && w.endsWith("ies") ? w.slice(0, -3) + "y" : w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);

// The names a question could mean: neighbouring words joined together, longest first ("customer order line" ->
// customerorderline, customerorder, orderline). Plurals become singular. A single word only counts when it is long
// and not a general word, so "invoice" or "voucher" can name a file but "method" or "number" cannot.
const NAME_PARTS = new Set(["code", "work"]); // filler in a search of the code, but part of names such as CurrencyCode and WorkTask
export function namePhrases(query) {
  const words = (String(query).toLowerCase().match(/[a-z]+/g) ?? []).map((w) => (STOPWORDS.has(w) || (CODE_FILLER.has(w) && !NAME_PARTS.has(w)) || w.length < 2 ? null : toSingular(w)));
  const phrases = new Map(); // phrase -> number of words
  let run = [];
  const flush = () => {
    for (const size of [4, 3, 2]) for (let i = 0; i + size <= run.length; i++) phrases.set(run.slice(i, i + size).join(""), size);
    for (const w of run) if (w.length >= 6 && !GENERIC_SINGLE.has(w) && !phrases.has(w)) phrases.set(w, 1);
    run = [];
  };
  for (const w of words) (w === null ? flush() : run.push(w));
  flush();
  return [...phrases.entries()].map(([phrase, size]) => ({ phrase, size })).sort((a, b) => b.size - a.size || b.phrase.length - a.phrase.length);
}

// Finds the files whose name matches (see namePhrases) and returns their chunks that fit the rest of the question best,
// in the shape of searchKnowledge. Files that match more words, and package files before model files, come first.
export async function findByName(db, query, { origin = "IFS source code", limit = 4, perDocument = 2, maxFiles = 6 } = {}) {
  const phrases = namePhrases(query);
  if (phrases.length === 0) return [];
  // a question about a method, procedure or package is answered by the package files; the model files (projection, entity,
  // client, fragment) only when the question asks for them
  const asksModel = /\b(projection|entity|entities|client|fragment|model|enumeration)s?\b/i.test(String(query));
  const kinds = asksModel ? ["plsvc", "projection", "entity", "client", "fragment"] : ["plsql", "plsvc", "views", "storage"];
  const exact = phrases.map((p) => `${p.phrase}.%`);
  const prefix = phrases.filter((p) => p.size >= 2 && p.phrase.length >= 8).map((p) => `${p.phrase}%`);
  const { rows: files } = await db.query(
    `SELECT d.id, d.title, d.version, lower(d.title) AS name
       FROM knowledge_documents d
      WHERE d.origin = $1 AND (lower(d.title) LIKE ANY($2) OR lower(d.title) LIKE ANY($3))
        AND regexp_replace(lower(d.title), '^.*[.]', '') = ANY($4)
      LIMIT 300`,
    [origin, exact, prefix, kinds],
  );
  if (files.length === 0) return [];

  // how well does each file name match: the most words first, then the closest length, then package files before model files
  const scored = files.map((f) => {
    const stem = f.name.replace(/\.[a-z0-9]+$/, "");
    const ext = f.name.slice(stem.length + 1);
    let best = null;
    for (const p of phrases) {
      const hit = stem === p.phrase ? 2 : p.size >= 2 && p.phrase.length >= 8 && stem.startsWith(p.phrase) ? 1 : 0;
      if (!hit) continue;
      const value = p.size * 100 + hit * 40 - Math.min(40, stem.length - p.phrase.length);
      if (best === null || value > best) best = value;
    }
    const order = EXTENSION_ORDER.indexOf(ext);
    return { f, best: best ?? 0, order: order === -1 ? 99 : order, version: /cloud/i.test(f.version) ? 0 : 1 };
  }).filter((x) => x.best > 0);
  scored.sort((a, b) => b.best - a.best || a.order - b.order || a.version - b.version);
  const chosen = scored.slice(0, maxFiles).map((x) => x.f.id);
  if (chosen.length === 0) return [];

  // within those files: the chunks that fit the other words of the question (create, quantity, hand ...)
  const base = queryTerms(String(query), 12).filter((t) => !CODE_FILLER.has(t));
  const words = [...new Set(base.flatMap((t) => [t, ...inflections(t)]))].filter((t) => /^[a-z0-9_]+$/.test(t)).slice(0, 40);
  if (words.length === 0) return [];
  const { rows } = await db.query(
    `SELECT c.id, c.content, c.start_line, c.end_line, d.title, d.doc_key, d.origin, d.url, d.version, d.component,
            ts_rank_cd(c.tsv, to_tsquery('simple', $2), 32) AS rank
       FROM knowledge_chunks c JOIN knowledge_documents d ON d.id = c.document_id
      WHERE c.document_id = ANY($1) AND c.tsv @@ to_tsquery('simple', $2)
      ORDER BY rank DESC LIMIT 60`,
    [chosen, words.join(" | ")],
  );
  const order = new Map(chosen.map((id, i) => [id, i]));
  const perDoc = new Map();
  const out = [];
  for (const r of rows) {
    if (out.length >= limit) break;
    const n = perDoc.get(r.doc_key) ?? 0;
    if (n >= perDocument) continue;
    perDoc.set(r.doc_key, n + 1);
    out.push({
      ref: createHash("sha1").update(`${r.doc_key}#${r.id}`).digest("hex").slice(0, 8),
      title: r.title, path: r.doc_key, origin: r.origin, url: r.url, version: r.version, component: r.component,
      startLine: r.start_line, endLine: r.end_line, content: r.content, coverage: 1, score: 50 + Number(r.rank),
    });
  }
  return out;
}

// The whole text of documents, put back together from their chunks (the few overlapping lines at the
// cut are removed). Returns a Map: doc_key -> text. Used to give the agent a complete topic instead of
// one small piece of it.
export async function loadDocumentTexts(db, docKeys) {
  const keys = [...new Set(docKeys)];
  if (keys.length === 0) return new Map();
  const { rows } = await db.query(
    `SELECT d.doc_key, c.start_line, c.end_line, c.content
       FROM knowledge_chunks c
       JOIN knowledge_documents d ON d.id = c.document_id
      WHERE d.doc_key = ANY($1)
      ORDER BY d.doc_key, c.chunk_index`,
    [keys],
  );
  const texts = new Map();
  let current = null;
  let lastEnd = 0;
  let lines = [];
  const flush = () => current !== null && texts.set(current, lines.join("\n"));
  for (const r of rows) {
    if (r.doc_key !== current) {
      flush();
      current = r.doc_key;
      lastEnd = 0;
      lines = [];
    }
    const chunkLines = r.content.split("\n");
    const skip = Math.max(0, lastEnd - r.start_line + 1); // lines this chunk repeats from the previous one
    lines.push(...chunkLines.slice(skip));
    lastEnd = Math.max(lastEnd, r.end_line);
  }
  flush();
  return texts;
}

// Official documentation first, then question-and-answer sources (they explain how to do things); code field descriptions only name columns
// Only the rarest few words choose which chunks are fetched. For "which method creates a customer order line" about
// half of all chunks match at least one word, and scoring them all took 7 to 15 seconds; the three rarest words find
// the same documents (every word still counts when the candidates are scored). Two words lose results.
export const CANDIDATE_TERMS = 3;
export function candidateTerms(words, frequencyOf, max = CANDIDATE_TERMS) {
  if (words.length <= max) return words;
  return [...words].sort((a, b) => frequencyOf(a) - frequencyOf(b)).slice(0, max);
}

// How well a chunk covers the question. By weight alone one rare word is worth more than two common ones: for "which
// procedure posts a supplier invoice" a chunk with only "posts" would beat the chunks that have both "supplier" and
// "invoice". So a part of the coverage is simply the share of the question's words that the chunk has.
const DISTINCT_SHARE = 0.3;
export const blendedCoverage = (weighted, distinct) => (1 - DISTINCT_SHARE) * weighted + DISTINCT_SHARE * distinct;

// Some chunks are huge: a table that the chunker cannot split (the list of predefined database tasks is one chunk of
// 68,000 characters with 1,400 different words, a normal chunk has 1,700 characters and 85 words). A chunk like that
// holds nearly every word by chance and would match almost any question. Its score is lowered in proportion to how
// far it is above the size of a large normal chunk (99% of all chunks have fewer than 220 different words).
// The words are counted here, and only for chunks over 3,000 characters (about 1 in 200): counting them in the database
// for every row would cost every search extra time. A long chunk with few different words, such as a table with
// repeated values, is not touched.
const NORMAL_WORDS = 300;
const COUNT_ABOVE_CHARS = 3000;
// The huge chunks are the same few in every search, so the result is remembered per chunk (the id and the text length
// tell if it is the same chunk). The memory is emptied when it grows large.
const sizeFactors = new Map();
function cachedSizeFactor(r) {
  if (String(r.content ?? "").length <= COUNT_ABOVE_CHARS) return 1;
  const key = `${r.id}:${r.content.length}`;
  let factor = sizeFactors.get(key);
  if (factor === undefined) {
    if (sizeFactors.size > 5000) sizeFactors.clear();
    factor = sizeFactor(r);
    sizeFactors.set(key, factor);
  }
  return factor;
}

// ... unless the question is about that page: when at least half of the words of its title are in the question
// ("Which database tasks archive transaction rows?" for "List of Predefined Database Tasks"), the page is wanted.
export function titleIsAsked(title, askedWords) {
  const words = queryTerms(String(title ?? ""), 12);
  if (words.length === 0) return false;
  const asked = new Set(askedWords);
  return words.filter((w) => asked.has(w)).length / words.length >= 0.5;
}

export function sizeFactor(r) {
  // the chunk's own text decides whether to count (the search text is longer: it also holds the split names)
  if (String(r.content ?? "").length <= COUNT_ABOVE_CHARS) return 1;
  const text = String(r.search_text ?? r.content);
  const words = new Set(text.toLowerCase().match(/[a-z0-9_]+/g) ?? []).size;
  return words > NORMAL_WORDS ? Math.sqrt(NORMAL_WORDS / words) : 1;
}

// the IFS projection (REST/OData API) cards: see projection-cards.js
export const API_DOC_ORIGIN = "IFS API documentation";

export function sourceWeight(r, preferCode = false) {
  // the API cards (23,000 of them) are neutral here: a question that is not about REST must not be filled with them. A question about
  // REST gets its own search among them (see apps/api/src/api-docs.js), where the weight does not matter.
  if (r.origin === API_DOC_ORIGIN) return 0;
  if (r.origin === "IFS documentation") return 4; // the official documentation outranks what people say about it
  // a question about code: the code is as good a source as the documentation, not a lesser one
  if (preferCode && r.origin === "IFS source code" && r.meta?.kind !== "field descriptions") return 4;
  if (r.origin === "IFS community" || r.origin === "IFS technical blog") return 2;
  if (r.meta?.kind === "field descriptions") return -2;
  return 0;
}
