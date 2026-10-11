import { createHash } from "node:crypto";

// Answers that consultants rated with a thumbs up are kept and reused: when the same or a very similar question
// is asked again for the same customer, IFS version and language, the saved answer is returned and nothing is
// sent to an AI model (no keyword rewrite, no agent), which saves the tokens of that answer.
//
// Matching is deliberately strict, because a wrong saved answer is worse than a few spent tokens, and it uses no AI:
//   - the customer, the IFS version and the language must be equal (an empty choice only matches an empty choice)
//   - the questions are compared by their content words (stopwords and endings removed): equal, or in a long question
//     (8 or more content words) one word more or less per 8 words, with the word pairs still in the same order.
//     A short question must match completely: in "reopen a closed period" the one word "reopen" changes the answer.
//   - codes, numbers and names (ORA-20110, 25R2, CustomerOrderLine, work_task_tab, "quoted text") must be identical
//   - a question with a negation ("not", "without", "niet") never matches one without
// A thumbs up saves the answer wherever it was given, also in the middle of a chat:
//   - a question that stands on its own is saved without its conversation and reused anywhere
//   - a question that leans on earlier messages ("and in 25R2?", "explain it again") is saved together with the earlier
//     questions of that chat, and reused only when the same earlier questions came before it
//   - an answer given in a chat with attached files is never saved, and a question with attachments is never answered from memory

export const WORDS_PER_DIFFERENCE = 8;
const MIN_PAIR_SIMILARITY = 0.4;
const MAX_QUESTION_CHARS = 1000; // a long question (a pasted log, a scenario) is too specific to reuse
const MAX_ANSWER_CHARS = 60_000;
const MAX_SOURCES_BYTES = 300_000;
const MAX_SCOPE_CHARS = 80;
const CANDIDATES = 30;
const DEFAULT_TTL_DAYS = 60;

// The size of the part of a normal request that a hit saves: the instructions and the passages that are sent
// with every question. An estimate, shown as such.
export const ESTIMATED_PROMPT_TOKENS = 6000;
export const estimateTokens = (text) => Math.ceil(String(text ?? "").length / 4);
export const estimateSaved = (answer) => ESTIMATED_PROMPT_TOKENS + estimateTokens(answer);

// ---- comparing questions (no database) ------------------------------------------------------------------

const STOPWORDS = new Set(
  (
    "a an the and or of to in on for with is are was were be been being how do does did can could should would what which who whom when where why " +
    "i we you it its this that these those my our your me us about from into by as at if then than so there here will shall may might have has had having " +
    "please help show explain tell give describe need want know using use used make get " +
    "de het een en of van te in op voor met is zijn was waren wordt worden hoe wat welke wie wanneer waar waarom ik we je jij u " +
    "dit dat deze die mijn onze uw als dan zo er hier om aan bij naar uit door ook maar kan kun kunnen moet moeten graag heeft hebben had " +
    "ifs cloud"
  ).split(" "),
);
const NEGATIONS = new Set(["not", "no", "never", "without", "cannot", "cant", "dont", "doesnt", "isnt", "niet", "geen", "zonder", "nooit"]);

// "Creating", "creates" and "created" are the same word for this purpose; words with digits or underscores stay as typed
function stem(word) {
  if (/[0-9_]/.test(word) || word.length <= 4) return word;
  let w = word;
  if (w.endsWith("ies")) w = `${w.slice(0, -3)}y`;
  else if (w.endsWith("ing") && w.length > 5) w = w.slice(0, -3);
  else if (w.endsWith("ed") && w.length > 4) w = w.slice(0, -2);
  else if (w.endsWith("es") && /(ch|sh|x|z|ss)es$/.test(w)) w = w.slice(0, -2);
  else if (w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);
  return w.endsWith("e") ? w.slice(0, -1) : w;
}

// Anything that is an exact name rather than a topic: codes with digits, underscores or dots, CamelCase names and quoted text
const HARD = /[A-Za-z0-9_]*[0-9_][A-Za-z0-9_]*|[A-Za-z0-9_]+(?:[.\-/][A-Za-z0-9_]+)+|\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+\b/g;

// { words: stems in order, key: they joined, hard: Set of exact names, negated }
export function analyze(question) {
  const text = String(question ?? "").normalize("NFKC");
  const hard = new Set((text.match(HARD) ?? []).map((t) => t.toLowerCase()));
  for (const m of text.matchAll(/"([^"]{2,80})"/g)) hard.add(m[1].trim().toLowerCase().replace(/\s+/g, " "));
  const raw = (text.toLowerCase().match(/[a-z0-9_]+/g) ?? []).map((w) => w.replace(/'/g, ""));
  const negated = raw.some((w) => NEGATIONS.has(w));
  const words = [];
  for (const w of raw) {
    if (w.length < 2 || STOPWORDS.has(w) || NEGATIONS.has(w)) continue;
    const s = stem(w);
    if (s.length >= 2 && !words.includes(s)) words.push(s);
  }
  return { words, key: words.join(" "), hard, negated };
}

const sameSet = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));
const jaccard = (a, b) => {
  const A = new Set(a);
  const B = new Set(b);
  const shared = [...A].filter((x) => B.has(x)).length;
  return shared / (A.size + B.size - shared || 1);
};
const pairs = (words) => words.slice(1).map((w, i) => `${words[i]} ${w}`);

// { match, exact, score } for two analyzed questions. `wordsPerDifference`: how many content words a question needs
// for each word that may differ (8 = a question of 8 to 15 words may differ in one word, 16 or more in two).
export function compare(a, b, { wordsPerDifference = WORDS_PER_DIFFERENCE } = {}) {
  const none = { match: false, exact: false, score: 0 };
  if (a.words.length === 0 || b.words.length === 0) return none;
  if (a.negated !== b.negated || !sameSet(a.hard, b.hard)) return none;
  if (a.key === b.key) return { match: true, exact: true, score: 1 };
  const score = jaccard(a.words, b.words);
  const inB = new Set(b.words);
  const inA = new Set(a.words);
  const different = a.words.filter((w) => !inB.has(w)).length + b.words.filter((w) => !inA.has(w)).length;
  if (different > Math.floor(Math.max(a.words.length, b.words.length) / wordsPerDifference)) return { ...none, score };
  // the same words in a different order can say something else ("from A to B", "to A from B")
  if (a.words.length > 1 && b.words.length > 1 && jaccard(pairs(a.words), pairs(b.words)) < MIN_PAIR_SIMILARITY) return { ...none, score };
  return { match: true, exact: false, score };
}

// Can this request be answered from a saved answer, and can its answer be saved? Not with attachments, and not a very long question.
export const reusable = ({ question, attachments }) =>
  typeof question === "string" && question.length <= MAX_QUESTION_CHARS && (!attachments || attachments.length === 0);

// Words that point back at the conversation: a question with one of them does not stand on its own. Common words such as
// "it", "that" or the Dutch "het" and "die" count too, which only means such questions are tied to their conversation.
const REFERENCE = /\b(it|its|this|that|these|those|they|them|their|he|she|above|previous|earlier|before|again|also|same|more|another|other|former|latter|het|dit|dat|deze|die|ze|hen|hun|bovenstaande|vorige|eerder|opnieuw|ook|zelfde|meer|ander|andere)\b/i;

// A question that stands on its own: at least four topic words and nothing that points back at earlier messages
export const selfContained = (question) => analyze(question).words.length >= 4 && !REFERENCE.test(String(question ?? ""));

// The conversation a saved answer belongs to: "" for a question that stands on its own or opens a chat, otherwise a code
// of the last six earlier questions of the chat (the answers of the assistant vary, the questions are what was asked).
export function contextOf(history, question) {
  if (selfContained(question)) return "";
  const asked = (Array.isArray(history) ? history : [])
    .filter((m) => m && m.role === "user" && typeof m.content === "string")
    .slice(-6)
    .map((m) => analyze(m.content).key)
    .filter(Boolean);
  return asked.length === 0 ? "" : createHash("sha1").update(asked.join("|")).digest("hex").slice(0, 16);
}

const clip = (value, max) => (typeof value === "string" ? value.trim().slice(0, max) : "");
const scopeOf = (value) => clip(value, MAX_SCOPE_CHARS);
const languageOf = (value) => (value === "nl" ? "nl" : "en");

// ---- the database ---------------------------------------------------------------------------------------

function cachedRow(r, how) {
  return {
    id: Number(r.id),
    question: r.question,
    answer: r.answer,
    sources: r.sources ?? [],
    tier: r.tier ?? undefined,
    tierReason: r.tier_reason ?? undefined,
    followUps: r.follow_ups ?? undefined,
    savedAt: r.updated_at,
    likes: r.likes,
    match: how,
  };
}

const COLUMNS = "id, question, question_key, answer, sources, tier, tier_reason, follow_ups, likes, updated_at";

// The best saved answer for a question, or null. The caller treats an error like "no saved answer".
export async function findCachedAnswer(db, { question, history = [], customer = "", ifsVersion = "", language = "en", ttlDays = DEFAULT_TTL_DAYS, wordsPerDifference = WORDS_PER_DIFFERENCE }) {
  const asked = analyze(question);
  if (asked.words.length === 0) return null;
  const scope = [scopeOf(customer).toLowerCase(), scopeOf(ifsVersion).toLowerCase(), languageOf(language), `${Math.max(Number(ttlDays) || DEFAULT_TTL_DAYS, 1)} days`, contextOf(history, question)];
  const inScope = "NOT disabled AND lower(customer) = $1 AND lower(ifs_version) = $2 AND language = $3 AND updated_at > now() - $4::interval AND context_key = $5";

  // 1. the same question (up to wording): one index lookup
  const exact = await db.query(`SELECT ${COLUMNS} FROM memory_answers WHERE ${inScope} AND question_key = $6 ORDER BY likes DESC, updated_at DESC LIMIT 5`, [...scope, asked.key]);
  for (const r of exact.rows) {
    if (compare(asked, analyze(r.question), { wordsPerDifference }).match) return cachedRow(r, "exact");
  }

  // 2. a very similar long question: the saved questions that share words, compared one by one
  if (asked.words.length < wordsPerDifference) return null;
  const { rows } = await db.query(
    `SELECT ${COLUMNS}, ts_rank(tsv, to_tsquery('simple', $6)) AS rank FROM memory_answers
      WHERE ${inScope} AND tsv @@ to_tsquery('simple', $6) ORDER BY rank DESC LIMIT ${CANDIDATES}`,
    [...scope, asked.words.join(" | ")],
  );
  let best = null;
  for (const r of rows) {
    const c = compare(asked, analyze(r.question), { wordsPerDifference });
    if (c.match && (!best || c.score > best.score || (c.score === best.score && r.likes > best.row.likes))) best = { row: r, score: c.score };
  }
  return best ? cachedRow(best.row, "similar") : null;
}

// Saves an answer that got a thumbs up. Returns { ok: true, id, created } or { ok: false, reason }.
export async function saveAnswer(db, { clientId, question, history = [], customer = "", ifsVersion = "", language = "en", answer, sources = [], tier, tierReason, followUps }) {
  const q = clip(question, MAX_QUESTION_CHARS);
  const text = typeof answer === "string" ? answer.trim() : "";
  if (!q) return { ok: false, reason: "no_question" };
  if (text.length < 20) return { ok: false, reason: "no_answer" };
  if (text.length > MAX_ANSWER_CHARS) return { ok: false, reason: "too_long" };
  const analyzed = analyze(q);
  if (analyzed.words.length === 0) return { ok: false, reason: "no_topic" };
  const sourceList = Array.isArray(sources) ? sources : [];
  if (Buffer.byteLength(JSON.stringify(sourceList)) > MAX_SOURCES_BYTES) return { ok: false, reason: "too_long" };
  const follow = Array.isArray(followUps) ? followUps.filter((x) => typeof x === "string").slice(0, 3) : null;

  // The same question again: the saved answer keeps its place and counts the like. A saved answer that was
  // switched off (somebody gave it a thumbs down) is replaced by the new one.
  const { rows } = await db.query(
    `INSERT INTO memory_answers (customer, ifs_version, language, question, question_key, answer, sources, tier, tier_reason, follow_ups, saved_by, context_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10::jsonb, $11, $12)
     ON CONFLICT (question_key, context_key, lower(customer), lower(ifs_version), language) DO UPDATE SET
       likes = memory_answers.likes + 1,
       updated_at = now(),
       answer = CASE WHEN memory_answers.disabled THEN EXCLUDED.answer ELSE memory_answers.answer END,
       sources = CASE WHEN memory_answers.disabled THEN EXCLUDED.sources ELSE memory_answers.sources END,
       tier = CASE WHEN memory_answers.disabled THEN EXCLUDED.tier ELSE memory_answers.tier END,
       tier_reason = CASE WHEN memory_answers.disabled THEN EXCLUDED.tier_reason ELSE memory_answers.tier_reason END,
       follow_ups = CASE WHEN memory_answers.disabled THEN EXCLUDED.follow_ups ELSE memory_answers.follow_ups END,
       dislikes = CASE WHEN memory_answers.disabled THEN 0 ELSE memory_answers.dislikes END,
       disabled = false
     RETURNING id, (xmax = 0) AS created`,
    [scopeOf(customer), scopeOf(ifsVersion), languageOf(language), q, analyzed.key, text, JSON.stringify(sourceList), ["lite", "full", "super"].includes(tier) ? tier : null, clip(tierReason, 500) || null, follow ? JSON.stringify(follow) : null, clientId ?? null, contextOf(history, q)],
  );
  return { ok: true, id: Number(rows[0].id), created: rows[0].created === true };
}

// A thumbs down: the saved answer for this question (the one with this id, or the same text) is no longer reused
export async function disableAnswer(db, { cacheId, question, customer = "", ifsVersion = "", language = "en", answer }) {
  const key = analyze(question).key;
  const { rowCount } = await db.query(
    `UPDATE memory_answers SET disabled = true, dislikes = dislikes + 1, updated_at = now()
      WHERE id = $1 OR (question_key = $2 AND lower(customer) = $3 AND lower(ifs_version) = $4 AND language = $5 AND md5(answer) = md5($6))`,
    [Number(cacheId) || 0, key, scopeOf(customer).toLowerCase(), scopeOf(ifsVersion).toLowerCase(), languageOf(language), String(answer ?? "").trim()],
  );
  return rowCount;
}

// What the saved answers have saved: every request that could have been reused is logged as a hit or a miss
export function recordCacheEvent(db, { outcome, answerId = null, tokensSaved = 0 }) {
  return db
    .query("INSERT INTO memory_cache_events (outcome, answer_id, tokens_saved) VALUES ($1, $2, $3)", [outcome, answerId, tokensSaved])
    .catch(() => {});
}

export function usedAnswer(db, id) {
  return db.query("UPDATE memory_answers SET uses = uses + 1, last_used_at = now() WHERE id = $1", [id]).catch(() => {});
}

export async function cacheStats(db, { days = 30 } = {}) {
  const since = `${Math.min(Math.max(Number(days) || 30, 1), 365)} days`;
  const events = await db.query(
    `SELECT count(*) FILTER (WHERE outcome = 'hit')::int AS hits, count(*) FILTER (WHERE outcome = 'miss')::int AS misses,
            COALESCE(sum(tokens_saved) FILTER (WHERE outcome = 'hit'), 0)::bigint AS tokens
       FROM memory_cache_events WHERE at > now() - $1::interval`,
    [since],
  );
  const saved = await db.query("SELECT count(*) FILTER (WHERE NOT disabled)::int AS active, count(*) FILTER (WHERE disabled)::int AS switched_off FROM memory_answers");
  const { hits, misses, tokens } = events.rows[0];
  return {
    days: Number(days) || 30,
    hits,
    misses,
    hitRate: hits + misses > 0 ? hits / (hits + misses) : 0,
    estimatedTokensSaved: Number(tokens),
    savedAnswers: saved.rows[0].active,
    switchedOff: saved.rows[0].switched_off,
  };
}
