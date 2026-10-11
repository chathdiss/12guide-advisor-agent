// Memory of the Advisor (tables in packages/db/schema/003_memory.sql):
//   answers: answers with a thumbs up, saved at once and returned without an AI call (answer-cache.js)
//   lessons: what a consultant wrote after a thumbs down. It is unverified: the agent sees it as a reported concern,
//            and only a reviewer can turn it into a confirmed correction
//   chats:   the chats of one browser (identified by a random client id), kept on the server
// `db` is a pg Pool. Every function returns plain data; the HTTP side is in server.js.
import { queryTerms } from "../../../packages/knowledge/src/search.js";
import { cacheStats, disableAnswer, findCachedAnswer, recordCacheEvent, saveAnswer, usedAnswer } from "./answer-cache.js";

const MAX_SCOPE_CHARS = 80;
const MAX_QUESTION_CHARS = 2000;
const MAX_ANSWER_CHARS = 2000;
const MIN_CORRECTION_CHARS = 8;
const MAX_CORRECTION_CHARS = 4000;
const MAX_CHAT_BYTES = 2_000_000;
const MAX_CHATS_PER_CLIENT = 200;

const clip = (value, max) => (typeof value === "string" ? value.trim().slice(0, max) : "");

// A client id is a UUID made by the web app. It is the only "password" of someone's chats, so it must look random.
export const isClientId = (id) => typeof id === "string" && /^[0-9a-f-]{32,40}$/i.test(id);

export const cleanScope = (value) => clip(value, MAX_SCOPE_CHARS);

// ---- lessons -------------------------------------------------------------------------------------------

// A thumbs down with the consultant's explanation. It is stored as "unverified": it is not a correction until a
// reviewer approves it. Returns { ok: true, id } or { ok: false, error }.
export async function reportProblem(db, { clientId, customer, ifsVersion, question, answer, comment }) {
  if (!isClientId(clientId)) return { ok: false, error: "A client id is required." };
  const text = clip(comment, MAX_CORRECTION_CHARS);
  if (text.length < MIN_CORRECTION_CHARS) {
    return { ok: false, error: `Write at least ${MIN_CORRECTION_CHARS} characters about what is wrong, unsupported or missing.` };
  }
  const q = clip(question, MAX_QUESTION_CHARS);
  if (!q) return { ok: false, error: "The question is required." };

  const { rows } = await db.query(
    `INSERT INTO memory_lessons (customer, ifs_version, question, answer, rating, correction, status, suggested_by)
     VALUES ($1, $2, $3, $4, 'down', $5, 'unverified', $6) RETURNING id`,
    [cleanScope(customer), cleanScope(ifsVersion), q, clip(answer, MAX_ANSWER_CHARS), text, clientId],
  );
  return { ok: true, id: Number(rows[0].id) };
}

// For the reviewer: lessons with a given status, oldest first so nothing waits forever
export async function listLessons(db, { status = "unverified", limit = 100 } = {}) {
  const wanted = ["unverified", "approved", "rejected"].includes(status) ? status : "unverified";
  const { rows } = await db.query(
    `SELECT id, customer, ifs_version, question, answer, rating, correction, status, review_note, created_at, reviewed_at
       FROM memory_lessons WHERE status = $1 ORDER BY created_at ASC LIMIT $2`,
    [wanted, Math.min(Math.max(Number(limit) || 100, 1), 500)],
  );
  return rows.map(lessonRow);
}

// A reviewer approves or rejects, and may correct the wording first. Returns { ok, lesson } or { ok: false, error }.
export async function reviewLesson(db, id, { status, correction, note }) {
  if (status !== "approved" && status !== "rejected") return { ok: false, error: "The status must be approved or rejected." };
  const text = correction === undefined ? null : clip(correction, MAX_CORRECTION_CHARS);
  if (text !== null && text.length < MIN_CORRECTION_CHARS) return { ok: false, error: "The corrected text is too short." };
  const { rows } = await db.query(
    `UPDATE memory_lessons
        SET status = $2, correction = COALESCE($3, correction), review_note = $4, reviewed_at = now()
      WHERE id = $1
  RETURNING id, customer, ifs_version, question, answer, rating, correction, status, review_note, created_at, reviewed_at`,
    [Number(id), status, text, clip(note, 500)],
  );
  if (rows.length === 0) return { ok: false, error: "Lesson not found." };
  return { ok: true, lesson: lessonRow(rows[0]) };
}

// Lessons with a status ("approved" = confirmed by a reviewer, "unverified" = reported by a consultant) that belong
// to this customer and IFS version (or to all) and to the question. A lesson for exactly this customer ranks above
// one for everybody. Returns [{ id, question, correction, customer, ifsVersion }].
export async function findLessons(db, { customer = "", ifsVersion = "", question, limit = 3, status = "approved" }) {
  const terms = queryTerms(question ?? "", 16);
  if (terms.length === 0) return [];
  const { rows } = await db.query(
    `SELECT id, customer, ifs_version, question, correction, ts_rank(tsv, to_tsquery('simple', $1)) AS rank
       FROM memory_lessons
      WHERE status = $4
        AND (customer = '' OR lower(customer) = lower($2))
        AND (ifs_version = '' OR lower(ifs_version) = lower($3))
        AND tsv @@ to_tsquery('simple', $1)
      ORDER BY rank DESC LIMIT 20`,
    [terms.join(" | "), cleanScope(customer), cleanScope(ifsVersion), status === "unverified" ? "unverified" : "approved"],
  );
  // a lesson must share enough of the question's words, otherwise one common word would pull it in
  const need = terms.length >= 4 ? 0.4 : terms.length >= 2 ? 0.5 : 1;
  return rows
    .map((r) => {
      const words = new Set(queryTerms(`${r.question} ${r.correction}`, 200));
      const coverage = terms.filter((t) => words.has(t)).length / terms.length;
      const specific = (r.customer ? 1 : 0) + (r.ifs_version ? 1 : 0);
      return { r, coverage, specific };
    })
    .filter((x) => x.coverage >= need)
    .sort((a, b) => b.specific - a.specific || b.coverage - a.coverage || Number(b.r.rank) - Number(a.r.rank))
    .slice(0, limit)
    .map(({ r }) => ({ id: Number(r.id), question: r.question, correction: r.correction, customer: r.customer, ifsVersion: r.ifs_version }));
}

// Concerns that consultants reported (thumbs down) and nobody has verified: shown to the agent as such
export const findReports = (db, input) => findLessons(db, { ...input, status: "unverified", limit: input.limit ?? 2 });

// A thumbs up or a thumbs down under an answer.
//   up:   the answer is saved at once and reused for the same question (no review), also when it was given in the middle
//         of a chat (see answer-cache.js: contextOf). Not saved: an answer in a chat with attached files ("hadAttachments").
//   down: the explanation is stored as unverified, tied to the question and the answer, and the saved answer for this
//         question, if there is one, is switched off so that it is not returned again.
// Returns { ok: true, saved?, id? } or { ok: false, error }.
export async function saveFeedback(db, input) {
  const { clientId, rating } = input;
  if (!isClientId(clientId)) return { ok: false, error: "A client id is required." };
  if (rating !== "up" && rating !== "down") return { ok: false, error: "The rating must be up or down." };
  const scope = { customer: cleanScope(input.customer), ifsVersion: cleanScope(input.ifsVersion), language: input.language === "nl" ? "nl" : "en" };

  if (rating === "up") {
    if (input.hadAttachments === true) return { ok: true, saved: false, reason: "attachments" };
    const history = (Array.isArray(input.history) ? input.history : [])
      .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      .slice(-40)
      .map((m) => ({ role: m.role, content: m.content.slice(0, 20_000) }));
    const saved = await saveAnswer(db, { ...input, history, ...scope });
    return saved.ok ? { ok: true, saved: true, id: saved.id, created: saved.created } : { ok: true, saved: false, reason: saved.reason };
  }

  const reported = await reportProblem(db, { clientId, ...scope, question: input.question, answer: input.answer, comment: input.comment });
  if (!reported.ok) return reported;
  const switchedOff = await disableAnswer(db, { cacheId: input.cacheId, question: input.question, answer: input.answer, ...scope });
  return { ok: true, id: reported.id, switchedOff: switchedOff > 0 };
}

function lessonRow(r) {
  return {
    id: Number(r.id),
    customer: r.customer,
    ifsVersion: r.ifs_version,
    question: r.question,
    answer: r.answer,
    rating: r.rating,
    correction: r.correction,
    status: r.status,
    reviewNote: r.review_note,
    createdAt: r.created_at,
    reviewedAt: r.reviewed_at,
  };
}

// ---- chats ---------------------------------------------------------------------------------------------

export async function listChats(db, clientId) {
  if (!isClientId(clientId)) return [];
  const { rows } = await db.query(
    `SELECT chat_id, title, customer, ifs_version, messages, created_at, updated_at
       FROM memory_chats WHERE client_id = $1 ORDER BY updated_at DESC LIMIT $2`,
    [clientId, MAX_CHATS_PER_CLIENT],
  );
  return rows.map(chatRow);
}

// Stores one chat (replaces what was stored). Returns { ok: true } or { ok: false, status, error }.
export async function saveChat(db, clientId, chatId, chat) {
  if (!isClientId(clientId)) return { ok: false, status: 400, error: "A client id is required." };
  if (typeof chatId !== "string" || !/^[\w-]{8,100}$/.test(chatId)) return { ok: false, status: 400, error: "Invalid chat id." };
  if (!chat || !Array.isArray(chat.messages)) return { ok: false, status: 400, error: "Invalid chat." };
  const messages = JSON.stringify(chat.messages);
  if (Buffer.byteLength(messages) > MAX_CHAT_BYTES) return { ok: false, status: 413, error: "The chat is too large to store." };

  const created = Number(chat.createdAt) || Date.now();
  const updated = Number(chat.updatedAt) || created;
  const { rows } = await db.query("SELECT count(*)::int AS n FROM memory_chats WHERE client_id = $1 AND chat_id <> $2", [clientId, chatId]);
  if (rows[0].n >= MAX_CHATS_PER_CLIENT) return { ok: false, status: 409, error: "Too many chats stored. Delete some first." };

  await db.query(
    `INSERT INTO memory_chats (client_id, chat_id, title, customer, ifs_version, messages, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
     ON CONFLICT (client_id, chat_id) DO UPDATE
       SET title = EXCLUDED.title, customer = EXCLUDED.customer, ifs_version = EXCLUDED.ifs_version,
           messages = EXCLUDED.messages, updated_at = EXCLUDED.updated_at
     WHERE memory_chats.updated_at <= EXCLUDED.updated_at`,
    [clientId, chatId, clip(chat.title, 200), cleanScope(chat.customer), cleanScope(chat.ifsVersion), messages, created, updated],
  );
  return { ok: true };
}

export async function deleteChat(db, clientId, chatId) {
  if (!isClientId(clientId)) return false;
  const { rowCount } = await db.query("DELETE FROM memory_chats WHERE client_id = $1 AND chat_id = $2", [clientId, chatId]);
  return rowCount > 0;
}

function chatRow(r) {
  return {
    id: r.chat_id,
    title: r.title,
    customer: r.customer,
    ifsVersion: r.ifs_version,
    messages: r.messages,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

// The functions above bound to one database, as the server uses them
export function createMemory(db) {
  return {
    saveFeedback: (input) => saveFeedback(db, input),
    findCachedAnswer: (input) => findCachedAnswer(db, input),
    recordCacheEvent: (input) => recordCacheEvent(db, input),
    usedAnswer: (id) => usedAnswer(db, id),
    cacheStats: (options) => cacheStats(db, options),
    findReports: (input) => findReports(db, input),
    listLessons: (options) => listLessons(db, options),
    reviewLesson: (id, input) => reviewLesson(db, id, input),
    findLessons: (input) => findLessons(db, input),
    listChats: (clientId) => listChats(db, clientId),
    saveChat: (clientId, chatId, chat) => saveChat(db, clientId, chatId, chat),
    deleteChat: (clientId, chatId) => deleteChat(db, clientId, chatId),
  };
}
