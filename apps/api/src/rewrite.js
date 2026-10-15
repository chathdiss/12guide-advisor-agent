// Turns a question into search keywords with a small, cheap model (Haiku). The sources are in English,
// so a Dutch question is translated, abbreviations are expanded and a few synonyms are added.
// The answer itself is still written by the stronger model in n8n.

const API_URL = "https://api.anthropic.com/v1/messages";
export const DEFAULT_MODEL = "claude-haiku-4-5-20251001";
const DEFAULT_TIMEOUT_MS = 8000;
const MAX_KEYWORDS = 14;

export const RULES = `Rules:
- If the question is not in English (e.g. Dutch), translate it to English first.
- Expand abbreviations (e.g. CO → customer order, PO → purchase order).
- Keep exact technical terms unchanged: error codes, API names, field names
  (e.g. ORA-20110, CUSTOMER_ORDER_API).
- Add 3–5 likely synonyms or related IFS terms.
- Set "ifs_related" to false only when the question is clearly not about IFS, ERP or business software
  (for example arithmetic, general knowledge, jokes or small talk). Otherwise set it to true.
- Return ONLY valid JSON, no other text:
  {"language": "<en|nl>", "ifs_related": true, "keywords": ["...", "..."]}`;

// Reads the model's reply. Returns { language, keywords } or null when it is not usable.
export function parseRewrite(text) {
  const match = String(text ?? "").match(/\{[\s\S]*\}/); // tolerate a code fence around the JSON
  if (!match) return null;
  let data;
  try {
    data = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (!data || !Array.isArray(data.keywords)) return null;
  const keywords = data.keywords
    .filter((k) => typeof k === "string")
    .map((k) => k.trim().slice(0, 60))
    .filter(Boolean)
    .slice(0, MAX_KEYWORDS);
  const language = data.language === "nl" ? "nl" : "en";
  // a question that is clearly not about IFS finds nothing in the sources, so nothing is searched
  if (data.ifs_related === false) return { language, keywords, offTopic: true };
  if (keywords.length === 0) return null;
  return { language, keywords };
}

// Returns an async function (question) => { language, keywords } | null. It never throws:
// when the rewrite fails the caller searches with the words of the question instead.
export function createRewriter({ apiKey, model = DEFAULT_MODEL, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = fetch }) {
  return async (question) => {
    try {
      const res = await fetchImpl(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model,
          max_tokens: 300,
          system: RULES,
          messages: [{ role: "user", content: question }],
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`Anthropic API answered ${res.status}`);
      const data = await res.json();
      const text = (data.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("");
      return parseRewrite(text);
    } catch (err) {
      console.error(JSON.stringify({ time: new Date().toISOString(), rewrite: "failed", error: String(err?.message ?? err) }));
      return null;
    }
  };
}
