import { createApp } from "./server.js";
import { createRetriever, searchBoth } from "./knowledge.js";
import { createTools } from "./tools.js";
import { createMemory } from "./memory.js";
import { createRewriter } from "./rewrite.js";
import { createUsageReader } from "./n8n-usage.js";
import { createQuickReportActions } from "./quickreport-actions.js";
import { createIfsRunner } from "./ifs-runner.js";
import { createExporter } from "./qr-export.js";
import { installProcessLog } from "./process-log.js";
import { findApiCards } from "../../../packages/knowledge/src/find-api.js";
import { findByName, findByTitle, loadDocumentTexts, searchKnowledge } from "../../../packages/knowledge/src/search.js";

// what stops or surprises the backend leaves a line in the log (process-log.js)
installProcessLog();

const port = Number(process.env.PORT) || 4000; // Render sets PORT itself

const config = {
  n8nChatUrl: process.env.N8N_CHAT_URL,
  internalKey: process.env.INTERNAL_API_KEY,
  rateLimitPerMinute: Number(process.env.RATE_LIMIT_PER_MINUTE) || 30,
  agentTimeoutMs: Number(process.env.AGENT_TIMEOUT_MS) || 600_000,
  // the choices of the customer and IFS version dropdowns, and the key of the lesson reviewer
  customers: list(process.env.MEMORY_CUSTOMERS),
  versions: list(process.env.MEMORY_VERSIONS, ["IFS Apps 10", "IFS Cloud 23R2", "IFS Cloud 24R1", "IFS Cloud 24R2", "IFS Cloud 25R1", "IFS Cloud 25R2", "IFS Cloud 26R1"]),
  reviewKey: process.env.REVIEW_API_KEY || "",
  // websites that may call this backend from the browser, for example https://12guide-assistant-test.netlify.app
  corsOrigins: list(process.env.CORS_ORIGINS),
  // this backend's own public address: n8n posts finished answers to it. Render sets RENDER_EXTERNAL_URL itself.
  publicUrl: process.env.PUBLIC_API_URL || process.env.RENDER_EXTERNAL_URL || "",
  // token counts from the executions of n8n (see n8n-usage.js): only with the address of n8n and an API key that may read executions
  usageReader: createUsageReader({ baseUrl: process.env.N8N_API_URL, apiKey: process.env.N8N_API_KEY }),
};

function list(value, fallback = []) {
  const items = String(value ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  return items.length > 0 ? items : fallback;
}

if (!config.n8nChatUrl) {
  console.warn("Warning: N8N_CHAT_URL is not set, so /api/chat will answer with a configuration error.");
}
if (!config.internalKey) {
  console.warn("Warning: INTERNAL_API_KEY is not set, so requests to n8n are sent without the X-Internal-Key header.");
}

// The knowledge base (PostgreSQL, see packages/db) is optional: without DATABASE_URL the agent
// answers from general knowledge and says so.
if (process.env.DATABASE_URL) {
  const { default: pg } = await import("pg");
  const db = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: 5,
    connectionTimeoutMillis: 10_000,
    // a question made of very common words ("customer order fields") needs 10 to 20 seconds in the biggest sources; the limit stops a
    // search that never ends, it must not cut one that is only slow
    statement_timeout: Number(process.env.KNOWLEDGE_STATEMENT_TIMEOUT_MS) || 60000,
  });
  // A small model (Haiku) turns the question into search keywords; optional, the search works without it
  const rewrite = process.env.ANTHROPIC_API_KEY
    ? createRewriter({ apiKey: process.env.ANTHROPIC_API_KEY, model: process.env.REWRITE_MODEL || undefined })
    : null;
  if (!rewrite) console.warn("Warning: ANTHROPIC_API_KEY is not set, so questions are searched as typed (no translation or synonyms).");
  config.memory = createMemory(db);
  // the search tools of the agent (needs PUBLIC_API_URL: n8n calls them over HTTP)
  config.tools = createTools({
    db,
    search: searchKnowledge,
    searchAll: (pool, query, limit) => searchBoth(searchKnowledge, pool, query, limit, null, findByTitle, findByName),
    loadFull: loadDocumentTexts,
    findNames: findByName,
    findApi: findApiCards,
  });
  config.maxToolCalls = Number(process.env.AGENT_MAX_TOOL_CALLS) || 6;
  // what happens after a quick report design was approved: Option A (IFS through Playwright, off unless IFS_AUTOMATION=on) and Option B (export file)
  config.quickReports = createQuickReportActions({
    check: (designJson) => config.tools.checkQuickReport(designJson),
    runner: createIfsRunner({
      enabled: String(process.env.IFS_AUTOMATION ?? "").toLowerCase() === "on",
      // a rehearsal fills in the New Report dialog and cancels it: only IFS_REHEARSAL=off creates reports
      rehearsal: String(process.env.IFS_REHEARSAL ?? "").toLowerCase() !== "off",
      // IFS_HEADED=on: a real run is done in a visible browser too (a rehearsal always is)
      headed: String(process.env.IFS_HEADED ?? "").toLowerCase() === "on",
      // IFS_TEST_EXECUTE=on: a test run of a report presses Execute (runs its SQL in IFS). Without it a test run is a rehearsal that does not.
      executeTests: String(process.env.IFS_TEST_EXECUTE ?? "").toLowerCase() === "on",
      baseUrl: process.env.IFS_BASE_URL,
      storageState: process.env.IFS_STORAGE_STATE,
    }),
    exporter: createExporter(),
    log: (fields) => console.log(JSON.stringify({ time: new Date().toISOString(), route: "/api/quick-report", ...fields })),
  });
  config.retrieve = createRetriever({ db, search: searchKnowledge, rewrite, loadFull: loadDocumentTexts, findTitles: findByTitle, findNames: findByName, findApi: findApiCards });
} else {
  console.warn("Warning: DATABASE_URL is not set, so answers are not grounded in the approved sources.");
}

createApp(config).listen(port, () => {
  console.log(`API running on port ${port}`);
});
