import { stripCitations } from "./cite.js";

// Checks a chat request from the web app before anything is sent on to the agent.
// The limits match the web app's own (apps/advisor-web/src/lib/chat/api-types.ts).

export const MAX_ATTACHMENTS = 4;
export const MAX_IMAGE_BASE64_CHARS = 6_000_000;
export const MAX_TEXT_CHARS = 200_000;
export const MAX_QUESTION_CHARS = 20_000;
const MAX_HISTORY_MESSAGES = 40;
const MAX_HISTORY_CHARS = 20_000;

// Returns { ok: true, value } or { ok: false, status, code, error }.
// `code` is what the web app translates into a message in the chosen language.
export function validateChatRequest(body) {
  if (!body || typeof body !== "object") {
    return fail(400, "invalid_request", "The request body must be a JSON object.");
  }

  const question = typeof body.question === "string" ? body.question.trim() : "";
  if (!question) return fail(400, "invalid_request", "A question is required.");
  if (question.length > MAX_QUESTION_CHARS) {
    return fail(400, "invalid_request", `The question is longer than ${MAX_QUESTION_CHARS} characters.`);
  }

  const attachments = validateAttachments(body.attachments);
  if (!attachments) {
    return fail(
      400,
      "attachments_invalid",
      `Invalid attachments. Up to ${MAX_ATTACHMENTS} images or text files, within the size limits.`,
    );
  }

  return {
    ok: true,
    value: {
      chatId: typeof body.chatId === "string" ? body.chatId.slice(0, 100) : "",
      question,
      language: body.language === "nl" ? "nl" : "en",
      // the customer and IFS version the consultant chose: lessons are scoped to them
      customer: typeof body.customer === "string" ? body.customer.trim().slice(0, 80) : "",
      ifsVersion: typeof body.ifsVersion === "string" ? body.ifsVersion.trim().slice(0, 80) : "",
      attachments,
      history: cleanHistory(body.history),
      // true when the consultant asks for a new answer instead of a saved one
      fresh: body.fresh === true,
    },
  };
}

function validateAttachments(input) {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input) || input.length > MAX_ATTACHMENTS) return null;

  const out = [];
  for (const a of input) {
    if (!a || typeof a.name !== "string" || typeof a.data !== "string" || typeof a.mimeType !== "string") return null;
    if (a.kind === "image") {
      if (!a.mimeType.startsWith("image/") || a.data.length > MAX_IMAGE_BASE64_CHARS) return null;
    } else if (a.kind === "text") {
      if (a.data.length > MAX_TEXT_CHARS) return null;
    } else {
      return null;
    }
    out.push({ name: a.name.slice(0, 200), kind: a.kind, mimeType: a.mimeType, data: a.data });
  }
  return out;
}

// Earlier turns give the agent context; only well-formed, reasonably sized ones are passed on
function cleanHistory(input) {
  if (!Array.isArray(input)) return [];
  return input
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .slice(-MAX_HISTORY_MESSAGES)
    // the [n] markers of an earlier answer belong to the sources of that question: the agent must not see them next to new sources
    .map((m) => ({ role: m.role, content: (m.role === "assistant" ? stripCitations(m.content) : m.content).slice(0, MAX_HISTORY_CHARS) }));
}

// Lines of the prompt that are meant for the agent only (see the Build prompt node of the workflow). A model sometimes copies
// one into its answer: <search_tools status="on" calls="6"/>, <knowledge_status>ok</knowledge_status>, <tool_note>...</tool_note>.
const INTERNAL_TAGS = /<search_tools\b[^>]*>|<knowledge_status>[\s\S]*?<\/knowledge_status>|<tool_note>[\s\S]*?<\/tool_note>/gi;
export const stripInternalTags = (text) => String(text ?? "").replace(INTERNAL_TAGS, "").replace(/\n{3,}/g, "\n\n").trim();

// Keeps only the fields the web app understands, whatever the agent returned
export function cleanAgentResponse(data) {
  if (!data || typeof data.answer !== "string") return null;

  const followUps = Array.isArray(data.followUps)
    ? data.followUps
        .filter((q) => typeof q === "string" && q.trim().length > 0)
        .map((q) => q.trim().slice(0, 160))
        .slice(0, 3)
    : undefined;

  return {
    answer: stripInternalTags(data.answer),
    sources: Array.isArray(data.sources) ? data.sources : [],
    tier: ["lite", "full", "super"].includes(data.tier) ? data.tier : undefined,
    tierReason: typeof data.tierReason === "string" ? data.tierReason : undefined,
    followUps,
  };
}

function fail(status, code, error) {
  return { ok: false, status, code, error };
}
