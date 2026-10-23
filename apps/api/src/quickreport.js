// The quick report workflow in the chat (packages/quick-reports): which requests it is for, how its conversation is kept short, and how the
// review page and the design get into the answer exactly as the tool made them. Everything here is for quick report requests only: a request
// that is not one is handled as before.

// how many of the agent's tool calls are kept for review_quick_report, so that a design (and a changed design) is always reviewed
export const RESERVED_REVIEW_CALLS = 2;
// the passages the backend sends with a quick report request: the design comes from the data dictionary, which the agent looks up itself
export const QUICK_REPORT_PASSAGES = 4;

const MENTIONS = /\bquick[\s-]?reports?\b/i;
const INTENT = /\b(creat\w*|build\w*|make|design\w*|generat\w*|writ\w*|develop\w*|prepar\w*|implement\w*|need|want|require\w*|spec(?:ification)?)\b/i;
const SPEC_WORDS = /\b(columns?|parameters?|layout|filters?|sorted?|fields?|title)\b/i;

// The design that an earlier answer of this chat holds as a json block, or null
export function designBlockOf(text) {
  for (const m of String(text ?? "").matchAll(/```json\s*([\s\S]*?)```/g)) {
    if (!m[1].includes('"designVersion"')) continue;
    try {
      const design = JSON.parse(m[1]);
      if (design && typeof design === "object" && Array.isArray(design.dataSources)) return design;
    } catch {
      /* a block that is not valid JSON is not a design */
    }
  }
  return null;
}

// An assistant message with a design is kept as that design only (the review page is made again from it): it is the whole design, never cut
// in the middle of the JSON, and it is a fraction of the size of the answer.
export function compactDesignMessage(content) {
  const design = designBlockOf(content);
  if (!design) return null;
  return `My last answer was a quick report design. This is the design, which the consultant has seen as a review page (change only what the consultant asks):\n\n\`\`\`json\n${JSON.stringify(design)}\n\`\`\``;
}

// Is this request for the quick report workflow? Either a specification for a quick report, or a change to the design of the last answer.
export function isQuickReportRequest({ question = "", history = [], attachments = [] } = {}) {
  const last = [...history].reverse().find((m) => m.role === "assistant");
  if (last && designBlockOf(last.content)) return true;
  const files = attachments.filter((a) => a?.kind === "text").map((a) => String(a.data ?? "").slice(0, 20_000));
  const mentioned = MENTIONS.test(question) || files.some((f) => MENTIONS.test(f));
  if (!mentioned || !INTENT.test(question)) return false;
  // "How do I create a quick report?" is a question for the advisor; a specification has columns, parameters or a file
  return files.length > 0 || question.length >= 150 || SPEC_WORDS.test(question);
}

// The introduction before the review page is at most `max` sentences of plain prose: the page shows the details, and a model does not always keep
// to the instruction. List lines, headings, table lines and a line that only introduces a list are left out; what follows the page is not touched.
export const INTRO_SENTENCES = 3;
const ABBREVIATION = /(?:\be\.g|\bi\.e|\betc|\bvs|\bno|\bapprox|\bincl|\bcf)\.$/i;

export function limitIntroduction(answer, max = INTRO_SENTENCES) {
  const text = String(answer ?? "");
  const at = text.indexOf("[[REVIEW_PAGE]]");
  if (at <= 0) return text;
  const intro = text.slice(0, at);
  const prose = intro
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^([-*•]\s|\d+[.)]\s|#{1,6}\s|\|)/.test(l) && !l.endsWith(":"))
    .join(" ");
  const pieces = prose.split(/(?<=[.!?])\s+(?=[A-Z0-9"(“])/);
  const sentences = [];
  for (const piece of pieces) {
    if (sentences.length > 0 && ABBREVIATION.test(sentences.at(-1))) sentences[sentences.length - 1] += ` ${piece}`;
    else sentences.push(piece);
  }
  const kept = sentences.slice(0, max).join(" ").trim();
  return kept ? `${kept}\n\n${text.slice(at)}` : text.slice(at);
}

// The review page and the design replace the placeholders that the agent wrote. An agent that did not review the design has no page to insert,
// and then it must not look as if it did: the placeholders are replaced by a plain statement.
export function fillPlaceholders(answer, artifacts) {
  const text = String(answer ?? "");
  const hasPage = text.includes("[[REVIEW_PAGE]]");
  const hasDesign = text.includes("[[DESIGN_JSON]]");
  if (!artifacts) {
    return text
      .replaceAll("[[REVIEW_PAGE]]", "(No review page: the design was not checked with the review tool.)")
      .replaceAll("[[DESIGN_JSON]]", "(No design: the design was not checked with the review tool.)");
  }
  let out = text.replaceAll("[[REVIEW_PAGE]]", () => artifacts.reviewPage).replaceAll("[[DESIGN_JSON]]", () => `\`\`\`json\n${artifacts.designJson}\n\`\`\``);
  // the agent forgot the placeholders: the consultant still gets the exact page and design
  if (!hasPage) out += `\n\n${artifacts.reviewPage}`;
  if (!hasDesign) out += `\n\n\`\`\`json\n${artifacts.designJson}\n\`\`\``;
  return out;
}
