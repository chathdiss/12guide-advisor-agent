import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { askAgent } from "./agent.js";
import { estimateSaved, reusable } from "./answer-cache.js";
import { buildCitations, repairCitations } from "./cite.js";
import { createEvidence } from "./evidence.js";
import { createRateLimiter } from "./rate-limit.js";
import { formatToolResult } from "./tools.js";
import { createPendingAnswers } from "./pending.js";
import { cleanAgentResponse, validateChatRequest } from "./validate.js";

const MEMORY_MAX_BODY_BYTES = 3 * 1024 * 1024; // a stored chat, a lesson
const DEFAULT_MAX_BODY_BYTES = 30 * 1024 * 1024; // up to 4 images of about 6 MB each, as base64

// config: { n8nChatUrl, internalKey, rateLimitPerMinute, agentTimeoutMs, maxBodyBytes, fetchImpl, retrieve,
//           memory (see memory.js: createMemory), reviewKey, customers, versions,
//           corsOrigins: addresses of websites that may call this backend from the browser,
//           publicUrl: this backend's own public address; with it the agent may deliver an answer later (pending.js) }
// retrieve(question, history) searches the knowledge base: { status: "ok" | "unavailable", passages }
// tools (see tools.js) are the search tools the agent may call while it works; they need publicUrl as well, because n8n calls them
export function createApp(config) {
  const maxBodyBytes = config.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const limiter = createRateLimiter({ limit: config.rateLimitPerMinute ?? 30 });
  const pending = createPendingAnswers();
  const evidence = createEvidence({ maxToolCalls: config.maxToolCalls ?? 6 });
  const publicUrl = String(config.publicUrl ?? "").trim().replace(/\/+$/, "");

  // A complete answer takes a minute or more, longer than a website host (such as Netlify) keeps a forwarded request
  // open, so the website can call this backend directly. The browser then needs the backend's permission (CORS) for
  // the websites listed in corsOrigins; every other website gets no permission.
  const corsOrigins = new Set((config.corsOrigins ?? []).map((o) => String(o).trim().replace(/\/+$/, "")));

  const server = createServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;

    const origin = String(req.headers.origin ?? "");
    if (origin && corsOrigins.has(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Client-Id, X-Review-Key");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
      res.setHeader("Access-Control-Max-Age", "600");
    }
    if (req.method === "OPTIONS") {
      res.writeHead(corsOrigins.has(origin) ? 204 : 403);
      return res.end();
    }

    if (path === "/api/health" && req.method === "GET") {
      return sendJson(res, 200, { status: "ok" });
    }

    if (path === "/api/chat") {
      if (req.method !== "POST") return sendJson(res, 405, { error: "Use POST.", code: "invalid_request" });
      return handleChat(req, res);
    }

    // n8n posts a finished answer here (see pending.js); only n8n knows the key and the one-time id
    if (path.startsWith("/api/internal/answer/")) {
      if (req.method !== "POST") return sendJson(res, 405, { error: "Use POST.", code: "invalid_request" });
      if (config.internalKey && !sameSecret(String(req.headers["x-internal-key"] ?? ""), config.internalKey)) {
        return sendJson(res, 401, { error: "Wrong key.", code: "unauthorized" });
      }
      const id = decodeURIComponent(path.slice("/api/internal/answer/".length));
      const body = await readJson(req, maxBodyBytes);
      if (!body.ok) return sendJson(res, body.status, { error: body.error, code: body.code });
      return pending.deliver(id, body.value) ? sendJson(res, 200, { ok: true }) : sendJson(res, 404, { error: "Nobody is waiting for this answer.", code: "invalid_request" });
    }

    // the agent's search tools (see tools.js): n8n calls them while it writes an answer, with the same key
    if (path.startsWith("/api/internal/tools/")) {
      if (req.method !== "POST") return sendJson(res, 405, { error: "Use POST.", code: "invalid_request" });
      if (config.internalKey && !sameSecret(String(req.headers["x-internal-key"] ?? ""), config.internalKey)) {
        return sendJson(res, 401, { error: "Wrong key.", code: "unauthorized" });
      }
      return handleTool(req, res, path.slice("/api/internal/tools/".length).split("/").map(decodeURIComponent));
    }

    if (path.startsWith("/api/memory/")) {
      try {
        return await handleMemory(req, res, path);
      } catch (err) {
        console.error(JSON.stringify({ time: new Date().toISOString(), memory: "error", error: String(err?.message ?? err) }));
        return sendJson(res, 500, { error: "Memory is not available right now.", code: "memory_unavailable" });
      }
    }

    return sendJson(res, 404, { error: "Not found.", code: "invalid_request" });
  });

  // Memory: chats of one browser, thumbs up (saved answers) and thumbs down (reported problems), and the reviewer's queue (see memory.js)
  async function handleMemory(req, res, path) {
    const memory = config.memory;
    if (!memory) return sendJson(res, 503, { error: "Memory is not configured (needs DATABASE_URL).", code: "memory_unavailable" });
    const parts = path.split("/").filter(Boolean).slice(2); // after /api/memory
    const clientId = String(req.headers["x-client-id"] ?? "");
    const query = new URL(req.url ?? "/", "http://localhost").searchParams;

    if (req.method !== "GET" && !limiter.allow(clientAddress(req))) {
      return sendJson(res, 429, { error: "Too many requests. Please wait a moment.", code: "rate_limited" });
    }

    // choices for the two dropdowns of the chat
    if (parts[0] === "scopes" && req.method === "GET") {
      return sendJson(res, 200, { customers: config.customers ?? [], versions: config.versions ?? [] });
    }

    if (parts[0] === "chats") {
      if (parts.length === 1 && req.method === "GET") return sendJson(res, 200, { chats: await memory.listChats(clientId) });
      if (parts.length === 2 && req.method === "PUT") {
        const body = await readJson(req, MEMORY_MAX_BODY_BYTES);
        if (!body.ok) return sendJson(res, body.status, { error: body.error, code: body.code });
        const saved = await memory.saveChat(clientId, parts[1], body.value);
        return saved.ok ? sendJson(res, 200, { ok: true }) : sendJson(res, saved.status, { error: saved.error, code: "invalid_request" });
      }
      if (parts.length === 2 && req.method === "DELETE") {
        await memory.deleteChat(clientId, parts[1]);
        return sendJson(res, 200, { ok: true });
      }
    }

    // A thumbs up saves the answer at once (no review); a thumbs down needs an explanation and is stored as unverified
    if (parts[0] === "feedback" && parts.length === 1 && req.method === "POST") {
      const body = await readJson(req, MEMORY_MAX_BODY_BYTES);
      if (!body.ok) return sendJson(res, body.status, { error: body.error, code: body.code });
      const done = await memory.saveFeedback({ ...body.value, clientId });
      return done.ok ? sendJson(res, 201, done) : sendJson(res, 400, { error: done.error, code: "invalid_request" });
    }

    if (parts[0] === "lessons" || parts[0] === "stats") {
      // everything below is for the reviewer
      if (!config.reviewKey) return sendJson(res, 503, { error: "Review is switched off: REVIEW_API_KEY is not set.", code: "review_disabled" });
      if (!sameSecret(String(req.headers["x-review-key"] ?? ""), config.reviewKey)) {
        return sendJson(res, 401, { error: "Wrong review key.", code: "unauthorized" });
      }
      if (parts[0] === "stats" && req.method === "GET") {
        return sendJson(res, 200, await memory.cacheStats({ days: Number(query.get("days")) || 30 }));
      }
      if (parts.length === 1 && req.method === "GET") {
        return sendJson(res, 200, { lessons: await memory.listLessons({ status: query.get("status") ?? "unverified" }) });
      }
      if (parts.length === 3 && parts[2] === "review" && req.method === "POST") {
        const body = await readJson(req, MEMORY_MAX_BODY_BYTES);
        if (!body.ok) return sendJson(res, body.status, { error: body.error, code: body.code });
        const done = await memory.reviewLesson(parts[1], body.value ?? {});
        return done.ok ? sendJson(res, 200, { lesson: done.lesson }) : sendJson(res, done.error === "Lesson not found." ? 404 : 400, { error: done.error, code: "invalid_request" });
      }
    }

    return sendJson(res, 404, { error: "Not found.", code: "invalid_request" });
  }

  // One call of a search tool. A problem is answered as text with status 200, so that the agent reads it and goes on:
  // an error status would stop its whole run.
  async function handleTool(req, res, [runId, tool]) {
    if (!config.tools) return sendJson(res, 503, { error: "The search tools are not configured.", code: "tools_unavailable" });
    if (!evidence.has(runId)) return sendJson(res, 404, { error: "Nobody is waiting for this question any more.", code: "invalid_request" });
    const body = await readJson(req, 100_000);
    if (!body.ok) return sendJson(res, body.status, { error: body.error, code: body.code });
    const args = body.value && typeof body.value === "object" ? body.value : {};
    const reply = (text) => {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
      res.end(text);
    };
    const run = { search_knowledge: config.tools.search, find_files: config.tools.findFiles, describe_entity: config.tools.describeEntity, read_document: config.tools.readDocument }[tool];
    if (!run) return sendJson(res, 404, { error: "Unknown tool.", code: "invalid_request" });
    if (!evidence.useCall(runId)) {
      return reply("<tool_note>No tool calls left. Write the answer now from the sources you already have, and say plainly what they do not cover.</tool_note>");
    }
    try {
      const out = await run({
        query: args.query,
        source: args.source,
        name: args.name,
        model: args.model === true || args.model === "true",
        path: args.path,
        fromLine: args.from_line,
        toLine: args.to_line,
      });
      // a tool returns the passages, or { passages, note } when it also has something to say (no such entity ...)
      const found = Array.isArray(out) ? out : out?.passages ?? [];
      const passages = evidence.add(runId, found);
      const full = passages.length === 0 && found.length > 0 ? "The limit on the number of sources was reached. Answer from the sources you have." : "";
      return reply(formatToolResult(passages, { note: [Array.isArray(out) ? "" : out?.note, full].filter(Boolean).join(" "), callsLeft: evidence.callsLeft(runId) }));
    } catch (err) {
      console.error(JSON.stringify({ time: new Date().toISOString(), tool, error: String(err?.message ?? err) }));
      return reply("<tool_note>The search tool failed. Answer from the sources you already have.</tool_note>");
    }
  }

  async function handleChat(req, res) {
    const started = Date.now();
    const client = clientAddress(req);

    if (!limiter.allow(client)) {
      log({ status: 429, code: "rate_limited", ms: Date.now() - started });
      return sendJson(res, 429, { error: "Too many requests. Please wait a moment.", code: "rate_limited" });
    }

    const body = await readJson(req, maxBodyBytes);
    if (!body.ok) {
      log({ status: body.status, code: body.code, ms: Date.now() - started });
      return sendJson(res, body.status, { error: body.error, code: body.code });
    }

    const checked = validateChatRequest(body.value);
    if (!checked.ok) {
      log({ status: checked.status, code: checked.code, ms: Date.now() - started });
      return sendJson(res, checked.status, { error: checked.error, code: checked.code });
    }

    // An answer that a consultant rated with a thumbs up, for the same question, customer, IFS version and language:
    // it is returned as it is, before anything that calls an AI model (the keyword rewrite and the agent). Any
    // problem with the memory just means "no saved answer".
    const askedCached = config.memory?.findCachedAnswer && !checked.value.fresh && reusable(checked.value);
    if (askedCached) {
      const saved = await config.memory
        .findCachedAnswer({ question: checked.value.question, history: checked.value.history, customer: checked.value.customer, ifsVersion: checked.value.ifsVersion, language: checked.value.language })
        .catch(() => null);
      if (saved) {
        const tokensSaved = estimateSaved(saved.answer);
        config.memory.recordCacheEvent?.({ outcome: "hit", answerId: saved.id, tokensSaved });
        config.memory.usedAnswer?.(saved.id);
        log({ status: 200, cached: saved.match, savedTokens: tokensSaved, ms: Date.now() - started });
        return sendJson(res, 200, {
          answer: saved.answer,
          sources: saved.sources,
          ...(saved.tier ? { tier: saved.tier } : {}),
          ...(saved.tierReason ? { tierReason: saved.tierReason } : {}),
          ...(saved.followUps ? { followUps: saved.followUps } : {}),
          cached: { id: saved.id, savedAt: saved.savedAt, match: saved.match },
        });
      }
      config.memory.recordCacheEvent?.({ outcome: "miss" });
    }

    // Search the approved sources first: the agent may only answer from what is found here
    const knowledge = config.retrieve
      ? await config.retrieve(checked.value.question, checked.value.history)
      : { status: "unavailable", passages: [] };

    // Lessons that a reviewer approved for this customer and IFS version; a failure here never stops an answer
    const lessons = config.memory
      ? await config.memory.findLessons({ customer: checked.value.customer, ifsVersion: checked.value.ifsVersion, question: checked.value.question }).catch(() => [])
      : [];

    // Concerns that consultants reported about similar questions (thumbs down). They are not verified: the agent only
    // uses them to check the passages again
    const reports = config.memory?.findReports
      ? await config.memory.findReports({ customer: checked.value.customer, ifsVersion: checked.value.ifsVersion, question: checked.value.question }).catch(() => [])
      : [];

    // With a public address, the agent may answer later: it gets a one-time return address, and the answer is awaited
    // here while the browser's request stays open. A workflow that answers at once works as before.
    // The evidence of this question (see evidence.js) holds the passages sent now and those the agent finds with its tools
    const requestId = randomUUID();
    evidence.start(requestId, knowledge.passages);
    const waiter = publicUrl ? pending.expect(requestId) : null;
    let result = await askAgent(
      {
        ...checked.value,
        knowledge: knowledge.status,
        passages: knowledge.passages,
        lessons,
        reports,
        ...(publicUrl ? { callbackUrl: `${publicUrl}/api/internal/answer/${requestId}` } : {}),
        // where the agent's search tools are; without it the agent works with the passages above only
        ...(publicUrl && config.tools && knowledge.status === "ok" ? { toolsUrl: `${publicUrl}/api/internal/tools/${requestId}`, toolCalls: config.maxToolCalls ?? 6 } : {}),
      },
      {
        url: config.n8nChatUrl,
        internalKey: config.internalKey,
        timeoutMs: config.agentTimeoutMs,
        fetchImpl: config.fetchImpl,
      },
    );
    if (result.ok && result.accepted) {
      const delivered = await waiter.wait(config.agentTimeoutMs ?? 600_000);
      const value = delivered === null ? null : cleanAgentResponse(delivered);
      result =
        delivered === null
          ? { ok: false, status: 504, code: "too_slow", error: "The advisor took too long to respond." }
          : value
            ? { ok: true, value }
            : { ok: false, status: 502, code: "no_answer", error: "The n8n workflow did not return an answer. Check the Executions tab in n8n for the failing node." };
    } else {
      waiter?.cancel();
    }

    if (!result.ok) {
      evidence.end(requestId);
      log({ status: result.status, code: result.code, ms: Date.now() - started });
      return sendJson(res, result.status, { error: result.error, code: result.code });
    }

    // markers the model put under the wrong number are moved to the passage that holds the fact
    // (the passages are those sent with the question and those the agent found with its tools)
    const passages = evidence.passages(requestId);
    const used = evidence.stats(requestId);
    evidence.end(requestId);
    const repair = repairCitations(result.value.answer, passages);
    const cited = buildCitations(repair.answer, passages);
    const value = {
      ...result.value,
      answer: cited.answer,
      sources: cited.sources,
      // so the page can show that confirmed lessons were available for this answer
      ...(lessons.length > 0 ? { lessons: lessons.map((l) => ({ id: l.id, correction: l.correction })) } : {}),
    };

    // Only metadata is logged, never the questions or answers
    log({
      status: 200,
      tier: value.tier,
      knowledge: knowledge.status,
      found: knowledge.passages.length,
      toolCalls: used.toolCalls,
      foundWithTools: used.passages - knowledge.passages.length,
      cited: value.sources.length,
      repaired: repair.repaired,
      unverified: repair.unverified,
      ms: Date.now() - started,
    });
    return sendJson(res, 200, value);
  }

  server.on("close", () => limiter.stop());
  return server;
}

// Compares two secrets without leaking, through timing, how much of them matched
function sameSecret(given, expected) {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function sendJson(res, status, data) {
  const text = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store",
  });
  res.end(text);
}

// Reads and parses the JSON body, refusing anything larger than `limit` bytes
function readJson(req, limit) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;

    req.on("data", (chunk) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > limit) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooLarge) {
        return resolve({ ok: false, status: 413, code: "attachments_invalid", error: "The request is too large." });
      }
      try {
        resolve({ ok: true, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
      } catch {
        resolve({ ok: false, status: 400, code: "invalid_request", error: "Invalid JSON body." });
      }
    });
    req.on("error", () => resolve({ ok: false, status: 400, code: "invalid_request", error: "Could not read the request." }));
  });
}

// Behind Netlify and Render the real client is the first address in X-Forwarded-For
function clientAddress(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) return forwarded.split(",")[0].trim();
  return req.socket.remoteAddress ?? "unknown";
}

function log(fields) {
  console.log(JSON.stringify({ time: new Date().toISOString(), route: "/api/chat", ...fields }));
}
