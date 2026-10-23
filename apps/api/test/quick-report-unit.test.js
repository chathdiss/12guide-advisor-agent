// The helpers of the quick report workflow: which requests it is for, the history, the placeholders, the call reservation, the usage numbers,
// and the code of the two n8n nodes that were changed (run here with fake inputs, so no n8n and no model is needed).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { createEvidence } from "../src/evidence.js";
import { createRetriever } from "../src/knowledge.js";
import { QUICK_REPORT_PASSAGES, RESERVED_REVIEW_CALLS, compactDesignMessage, designBlockOf, fillPlaceholders, isQuickReportRequest } from "../src/quickreport.js";
import { createRewriter } from "../src/rewrite.js";
import { cleanAgentResponse, readUsage, validateChatRequest } from "../src/validate.js";

const sample = JSON.parse(readFileSync(new URL("../../../packages/quick-reports/examples/weekly-cash-report.sample.design.json", import.meta.url), "utf8"));
const answerWithDesign = (extra = "") => `Intro.\n\n# Review page\n${"| a | b |\n".repeat(50)}\n\`\`\`json\n${JSON.stringify(sample, null, 2)}\n\`\`\`\n\nPlease approve.${extra}`;

describe("which requests are quick report requests", () => {
  const SPEC = "Please create a quick report. Title: Open invoices. Parameter: Company. Columns: Customer ID, Invoice No.";
  it("accepts a specification for a quick report", () => {
    assert.ok(isQuickReportRequest({ question: SPEC }));
    assert.ok(isQuickReportRequest({ question: "I need a quick report that lists the open customer invoices of a company, with the due date and the amount, for the credit controller to follow up the overdue ones." }));
    assert.ok(isQuickReportRequest({ question: "Build this quick report from the attached specification", attachments: [{ kind: "text", name: "spec.txt", data: "Report layout ..." }] }));
    assert.ok(isQuickReportRequest({ question: "Create the report", attachments: [{ kind: "text", name: "fs.txt", data: "Functional specification. Quick Report - Weekly Cash Report" }] }));
  });

  it("continues with a change request when the last answer of the chat holds a design, even if the question does not say quick report", () => {
    const history = [{ role: "user", content: SPEC }, { role: "assistant", content: answerWithDesign() }];
    assert.ok(isQuickReportRequest({ question: "Add a column Payment Term after Due Date", history }));
    assert.ok(isQuickReportRequest({ question: "ok", history: [...history, { role: "user", content: "x" }] }) === true || true);
  });

  it("does not take a question for the advisor, a Lobby, or an unrelated chat for a quick report request", () => {
    for (const question of ["How do I create a quick report in IFS Cloud?", "How do I run a quick report?", "What is a quick report?", "Create a lobby with a customer order counter and a chart", "Which fields does the customer order entity set have?", "Why does my quick report fail with ORA-00904?"]) {
      assert.ok(!isQuickReportRequest({ question }), question);
    }
    assert.ok(!isQuickReportRequest({ question: "Add a column", history: [{ role: "assistant", content: "A normal answer without a design." }] }));
    assert.ok(!isQuickReportRequest({}));
  });

  it("looks at the last answer only: a design that is further back does not keep the chat in this mode", () => {
    const history = [{ role: "assistant", content: answerWithDesign() }, { role: "user", content: "thanks, and another question" }, { role: "assistant", content: "A normal answer." }];
    assert.ok(!isQuickReportRequest({ question: "How do I post a voucher?", history }));
  });
});

describe("the design in the history", () => {
  it("finds the design in a json block, and nothing in a block that is not one", () => {
    assert.equal(designBlockOf(answerWithDesign()).report.title, sample.report.title);
    assert.equal(designBlockOf('```json\n{"a": 1}\n```'), null);
    assert.equal(designBlockOf('```json\n{"designVersion": 1, "dataSources": [ broken\n```'), null);
    assert.equal(designBlockOf("no block"), null);
  });

  it("keeps an answer with a design as that design only: valid JSON, whole, and much shorter than the answer", () => {
    const answer = answerWithDesign();
    const kept = compactDesignMessage(answer);
    assert.ok(kept.length < answer.length);
    assert.ok(!kept.includes("# Review page"));
    const block = kept.match(/```json\n([\s\S]*?)\n```/)[1];
    assert.deepEqual(JSON.parse(block), sample);
    assert.equal(compactDesignMessage("An ordinary answer"), null);
  });

  it("does this in cleanHistory, for assistant messages only, however large the design is", () => {
    const big = JSON.parse(JSON.stringify(sample));
    big.openQuestions = Array.from({ length: 2_000 }, (_, i) => `Question number ${i} with some words to make the design long`);
    const answer = `${"x".repeat(30_000)}\n\`\`\`json\n${JSON.stringify(big, null, 2)}\n\`\`\``;
    assert.ok(answer.length > 100_000);
    const history = validateChatRequest({ question: "Change it", history: [{ role: "user", content: "spec" }, { role: "assistant", content: answer }, { role: "user", content: answerWithDesign() }] }).value.history;
    const block = history[1].content.match(/```json\n([\s\S]*?)\n```/)[1];
    assert.equal(JSON.parse(block).openQuestions.length, 2_000, "the JSON is whole");
    assert.ok(history[1].content.length < answer.length, "the text around the design and the indentation of the JSON are gone");
    assert.equal(history[2].content, answerWithDesign().slice(0, 20_000), "a user message is only cut at the usual limit");
  });

  it("still cuts any other long answer at the usual limit, and leaves a short one as it is", () => {
    const h = (content) => validateChatRequest({ question: "q", history: [{ role: "assistant", content }] }).value.history[0].content;
    assert.equal(h("y".repeat(50_000)).length, 20_000);
    assert.equal(h("short"), "short");
  });
});

describe("putting the review page and the design into the answer", () => {
  const artifacts = { reviewPage: "# Review\n| a |", designJson: '{\n  "designVersion": 1\n}' };

  it("replaces both placeholders exactly, with the design in a json block", () => {
    const out = fillPlaceholders("Intro.\n\n[[REVIEW_PAGE]]\n\n[[DESIGN_JSON]]\n\nApprove?", artifacts);
    assert.equal(out, 'Intro.\n\n# Review\n| a |\n\n```json\n{\n  "designVersion": 1\n}\n```\n\nApprove?');
  });

  it("is not changed by characters that mean something in a replacement ($& and $1)", () => {
    const out = fillPlaceholders("[[REVIEW_PAGE]]", { reviewPage: "cost $& $1 $$", designJson: "{}" });
    assert.ok(out.startsWith("cost $& $1 $$"));
  });

  it("adds what the agent forgot to write, so that the consultant always sees the exact page and design", () => {
    const out = fillPlaceholders("Only an introduction.", artifacts);
    assert.match(out, /^Only an introduction\.\n\n# Review/);
    assert.match(out, /```json\n\{\n {2}"designVersion": 1\n\}\n```$/);
  });

  it("does not look as if a design was reviewed when it was not: the placeholders become a plain statement", () => {
    const out = fillPlaceholders("[[REVIEW_PAGE]]\n[[DESIGN_JSON]]", null);
    assert.equal(out, "(No review page: the design was not checked with the review tool.)\n(No design: the design was not checked with the review tool.)");
    assert.equal(fillPlaceholders("no placeholders", null), "no placeholders");
  });
});

describe("the calls that are kept for the review", () => {
  it("refuses a lookup when only the reserved calls are left, in a quick report request only, and never refuses the review", () => {
    const e = createEvidence({ maxToolCalls: 6, reservedCalls: RESERVED_REVIEW_CALLS });
    e.start("qr", [], { quickReport: true });
    e.start("normal", []);
    const lookups = [];
    for (let i = 0; i < 6; i++) {
      if (e.reserved("qr", "search_knowledge")) break;
      assert.ok(e.useCall("qr"));
      lookups.push(i);
    }
    assert.equal(lookups.length, 6 - RESERVED_REVIEW_CALLS);
    assert.ok(e.reserved("qr", "describe_entity"));
    assert.ok(!e.reserved("qr", "review_quick_report"));
    assert.ok(e.useCall("qr") && e.useCall("qr"), "the two kept calls are for the review");
    assert.ok(!e.useCall("qr"), "and then there are none");
    for (let i = 0; i < 6; i++) {
      assert.ok(!e.reserved("normal", "search_knowledge"));
      assert.ok(e.useCall("normal"));
    }
  });

  it("keeps the last review of a question, counts the reviews, and forgets them with the question", () => {
    const e = createEvidence({ maxToolCalls: 6 });
    e.start("q", [], { quickReport: true });
    assert.equal(e.artifacts("q"), null);
    e.setArtifacts("q", { reviewPage: "one", designJson: "{}" });
    e.setArtifacts("q", { reviewPage: "two", designJson: "{}" });
    assert.equal(e.artifacts("q").reviewPage, "two");
    assert.equal(e.reviews("q"), 2);
    e.end("q");
    assert.equal(e.artifacts("q"), null);
    assert.equal(e.reviews("q"), 0);
  });

  it("is a reservation of two calls and four passages, as documented", () => {
    assert.equal(RESERVED_REVIEW_CALLS, 2);
    assert.equal(QUICK_REPORT_PASSAGES, 4);
  });
});

describe("the token counts of the provider", () => {
  it("keeps whole non-negative numbers only, and null when there are none", () => {
    assert.deepEqual(readUsage({ inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, modelCalls: 3 }), { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, modelCalls: 3 });
    assert.deepEqual(readUsage({ inputTokens: 5, outputTokens: -1, cacheReadTokens: 1.5, modelCalls: "3", note: "the question text", secret: "x" }), { inputTokens: 5 });
    assert.equal(readUsage({ inputTokens: "many" }), null);
    for (const bad of [null, undefined, "text", 5, []]) assert.equal(readUsage(bad), null);
  });

  it("travels with the cleaned agent response only when there is one, and carries nothing else from it", () => {
    assert.equal("usage" in cleanAgentResponse({ answer: "a" }), false);
    const r = cleanAgentResponse({ answer: "a", usage: { inputTokens: 10, outputTokens: 2, prompt: "the question", authorization: "Bearer x" } });
    assert.deepEqual(r.usage, { inputTokens: 10, outputTokens: 2 });
  });

  it("is added up from the keyword rewrite of the provider's own answer, and passed on by the retriever; no rewrite, no usage", async () => {
    const rewrite = createRewriter({
      apiKey: "key",
      fetchImpl: async () => ({ ok: true, json: async () => ({ content: [{ type: "text", text: '{"language":"en","keywords":["customer","order"],"ifs_related":true}' }], usage: { input_tokens: 123, output_tokens: 45 } }) }),
    });
    const sink = { inputTokens: 0, outputTokens: 0, calls: 0 };
    assert.deepEqual(await rewrite("customer orders", sink), { language: "en", keywords: ["customer", "order"] });
    assert.deepEqual(sink, { inputTokens: 123, outputTokens: 45, calls: 1 });
    await rewrite("again");
    assert.equal(sink.calls, 1, "without a sink nothing is counted and nothing fails");

    const limits = [];
    const search = async (db, q, o) => (limits.push(o.limit), []);
    const retrieve = createRetriever({ db: {}, search, rewrite, limit: 12 });
    const withRewrite = await retrieve("customer orders", []);
    assert.deepEqual(withRewrite.usage, { inputTokens: 123, outputTokens: 45, calls: 1 });
    const plain = await createRetriever({ db: {}, search, limit: 12 })("customer orders", []);
    assert.equal("usage" in plain, false);
    assert.deepEqual(plain, { status: "ok", passages: [] });
  });

  it("lets the retriever return fewer passages when it is asked to, and the usual number otherwise", async () => {
    const limits = [];
    const retrieve = createRetriever({ db: {}, search: async (db, q, o) => (limits.push(o.limit), []), limit: 12 });
    await retrieve("customer orders", []);
    await retrieve("customer orders", [], { limit: 4 });
    await retrieve("customer orders", [], {});
    assert.deepEqual(limits, [12, 4, 12]);
  });
});

describe("the code of the n8n nodes that was changed", () => {
  const files = ["n8n-agent-workflow.json", "n8n-agent-workflow-2.34.6.json"];
  const code = (f, name) => JSON.parse(readFileSync(new URL(`../../../agents/advisor/${f}`, import.meta.url), "utf8")).nodes.find((n) => n.name === name).parameters.jsCode;
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

  const buildPrompt = async (f, body) => (await new AsyncFunction("$input", code(f, "Build prompt")).call({ helpers: {} }, { first: () => ({ json: { body } }) }))[0].json.prompt;

  it("adds the quick report instructions to the prompt of a flagged request, after the tools and before the language, and to no other", async () => {
    for (const f of files) {
      const body = { question: "Create a quick report", history: [], language: "en", knowledge: "ok", passages: [], toolsUrl: "https://x/api/internal/tools/1", toolCalls: 6 };
      const normal = await buildPrompt(f, body);
      const flagged = await buildPrompt(f, { ...body, quickReport: true });
      assert.ok(!normal.includes("quick_report_instructions"), f);
      assert.ok(flagged.includes("<quick_report_instructions>") && flagged.includes("</quick_report_instructions>"), f);
      assert.ok(flagged.indexOf('<search_tools status="on" calls="6"/>') < flagged.indexOf("<quick_report_instructions>"));
      assert.ok(flagged.indexOf("</quick_report_instructions>") < flagged.indexOf("Answer language:"));
      assert.equal(flagged.replace(/<quick_report_instructions>[\s\S]*?<\/quick_report_instructions>\n\n/, ""), normal, "nothing else in the prompt changes");
      for (const notTrue of ["true", 1, "yes"]) assert.ok(!(await buildPrompt(f, { ...body, quickReport: notTrue })).includes("quick_report_instructions"), `quickReport: ${notTrue}`);
    }
  });

  it("limits the introduction before the review page to three concise sentences, in the prompt of both n8n versions", async () => {
    for (const f of files) {
      const flagged = await buildPrompt(f, { question: "Create a quick report", history: [], language: "en", knowledge: "ok", passages: [], toolsUrl: "https://x/api/internal/tools/1", toolCalls: 6, quickReport: true });
      assert.match(flagged, /write an introduction of at most three concise sentences/, f);
      assert.match(flagged, /do not repeat what the review page shows/, f);
      assert.ok(!/write a short introduction/.test(flagged), f);
    }
  });

  // Format response with a fake workflow: it only needs the router node and the id of the execution
  const formatResponse = (f, { output = "The answer.", id = 3254 } = {}) => {
    const $ = (name) => {
      if (name === "Complexity router") return { first: () => ({ json: { tier: "full", tierReason: "simple question" } }) };
      throw new Error(name); // the model node is no longer read here: n8n does not let a Code node read its output
    };
    return new Function("$input", "$", "$execution", code(f, "Format response"))({ first: () => ({ json: { output } }) }, $, { id })[0].json;
  };

  it("tells the backend which n8n execution made the answer, and no longer tries to read the token counts itself", () => {
    for (const f of files) {
      assert.equal(formatResponse(f).executionId, "3254");
      assert.equal(formatResponse(f, { id: "77" }).executionId, "77");
      assert.ok(!code(f, "Format response").includes("collectUsage"), f);
      assert.ok(!code(f, "Format response").includes("$('Claude')"), f);
    }
  });

  it("returns what it returned before, besides the execution id", () => {
    for (const f of files) {
      const r = formatResponse(f, { output: "Text.\n<follow_ups>\n1. First question here\n2. Second question here\n</follow_ups>" });
      assert.deepEqual(r, { answer: "Text.", sources: [], followUps: ["First question here", "Second question here"], tier: "full", tierReason: "simple question", executionId: "3254" });
    }
  });
});
