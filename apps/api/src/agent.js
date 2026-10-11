import { cleanAgentResponse } from "./validate.js";

const DEFAULT_TIMEOUT_MS = 600_000; // complete answers are long: the model may write for several minutes

// Sends one question to the Advisor agent (the n8n webhook) and returns either
// { ok: true, value } with the cleaned answer, { ok: true, accepted: true } when n8n took the question and will post the
// answer to the callbackUrl later (see pending.js), or { ok: false, status, code, error }.
export async function askAgent(payload, { url, internalKey, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = fetch }) {
  if (!url) {
    return fail(500, "not_configured", "N8N_CHAT_URL is not configured on the server.");
  }

  const headers = { "Content-Type": "application/json" };
  if (internalKey) headers["X-Internal-Key"] = internalKey;

  let res;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    return timedOut
      ? fail(504, "too_slow", "The advisor took too long to respond.")
      : fail(504, "unreachable", "Could not reach n8n. Is it running?");
  }

  if (!res.ok) {
    // 404: wrong or inactive webhook. 401/403: the internal key does not match the one in n8n.
    if (res.status === 404) {
      return fail(502, "not_found", "n8n webhook not found. Is the workflow active and does the URL match?");
    }
    return fail(502, "n8n_status", `n8n returned ${res.status}.`);
  }

  // n8n answers 200 with an empty body when a node in the workflow fails
  const raw = await res.text();
  let data = null;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    // handled below
  }
  // a workflow that answers later replies at once with { accepted: true } and no answer
  if (data && data.accepted === true && typeof data.answer !== "string") return { ok: true, accepted: true };
  const value = cleanAgentResponse(data);
  if (!value) {
    return fail(
      502,
      "no_answer",
      "The n8n workflow did not return an answer. Check the Executions tab in n8n for the failing node.",
    );
  }
  return { ok: true, value };
}

function fail(status, code, error) {
  return { ok: false, status, code, error };
}
