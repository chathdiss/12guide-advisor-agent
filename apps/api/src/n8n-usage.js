// The token counts of one answer, read from the execution that n8n stored for it. n8n keeps them on the model node, on the
// ai_languageModel connection (json.tokenUsage = { promptTokens, completionTokens, totalTokens }), where a Code node of the workflow
// cannot read them, but the execution of the public API can. They are available only after the execution has finished, which is
// after the answer was delivered, so this runs afterwards and never delays an answer.
//
// The API returns the whole execution: the prompts, the tool results, the answer. Only the numbers are taken from it; the response is
// read in memory, never logged, stored or passed on, and a failure never says what the response contained.

const MAX_BYTES = 25 * 1024 * 1024;

// config: { baseUrl, apiKey, modelNode, fetchImpl, attempts, delayMs, timeoutMs, sleep }. Returns null when it is not configured.
export function createUsageReader({ baseUrl, apiKey, modelNode = "Claude", fetchImpl = fetch, attempts = 6, delayMs = 1500, timeoutMs = 10_000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const base = cleanBase(baseUrl);
  if (!base || !apiKey) return null;

  // executionId -> { inputTokens, outputTokens, modelCalls } or null (never throws, never estimates)
  return async function readUsageOf(executionId) {
    if (!/^\d{1,15}$/.test(String(executionId ?? ""))) return null;
    const url = `${base}/api/v1/executions/${executionId}?includeData=true`;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      let res;
      try {
        res = await fetchImpl(url, { headers: { "X-N8N-API-KEY": apiKey, Accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
      } catch {
        res = null;
      }
      // 404: not stored yet; 5xx and network errors: try again. Anything else (401, 403: the key) will not get better.
      if (res && res.ok) {
        const execution = await readBody(res);
        if (execution === undefined) return null;
        const status = execution && execution.status;
        if (status === "running" || status === "new" || status === "waiting" || (execution && execution.finished === false && !status)) {
          // still running: wait for the end
        } else {
          return tokenUsageOf(execution, modelNode);
        }
      } else if (res && res.status !== 404 && res.status < 500) {
        return null;
      }
      if (attempt < attempts) await sleep(delayMs);
    }
    return null;
  };
}

// http(s) address of n8n without a path or a trailing slash; anything else is not used
function cleanBase(value) {
  try {
    const u = new URL(String(value ?? ""));
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return "";
  }
}

async function readBody(res) {
  try {
    if (Number(res.headers?.get?.("content-length")) > MAX_BYTES) return undefined;
    return await res.json();
  } catch {
    return undefined;
  }
}

// Adds up json.tokenUsage of every run of the model node. A run without a count adds nothing; no count at all: null.
export function tokenUsageOf(execution, modelNode = "Claude") {
  const data = execution && execution.data;
  const runs = data && typeof data === "object" ? data.resultData?.runData?.[modelNode] : null;
  if (!Array.isArray(runs)) return null;
  const total = { inputTokens: 0, outputTokens: 0, modelCalls: 0 };
  const whole = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : 0);
  for (const run of runs) {
    for (const branch of run?.data?.ai_languageModel ?? []) {
      for (const item of branch ?? []) {
        const tu = item?.json?.tokenUsage;
        if (!tu || typeof tu !== "object") continue;
        total.inputTokens += whole(tu.promptTokens);
        total.outputTokens += whole(tu.completionTokens);
        total.modelCalls += 1;
      }
    }
  }
  return total.modelCalls > 0 ? total : null;
}
