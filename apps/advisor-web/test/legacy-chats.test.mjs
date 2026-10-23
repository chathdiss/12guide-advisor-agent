// Run with `npm test`. Chats from before the tabs existed have no tab: a Quick Report chat among them is found by the design in its answers,
// and every other chat stays in Advisor Chat.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { chatKind, hasQuickReportDesign } from "../src/lib/chat/types.ts";

const design = JSON.parse(readFileSync(new URL("../../../packages/quick-reports/examples/weekly-cash-report.sample.design.json", import.meta.url), "utf8"));
const fence = "```";
const withDesign = (d = design) => `Here is the design.\n\n# A review page\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n${fence}json\n${JSON.stringify(d, null, 2)}\n${fence}\n\nPlease approve the design.`;

const msg = (role, content, extra = {}) => ({ id: Math.random().toString(36), role, content, createdAt: 1, ...extra });
const chat = (messages, extra = {}) => ({ messages, ...extra });

describe("a chat from before the tabs existed", () => {
  it("is a Quick Reports chat when the assistant answered it with a quick report design", () => {
    const c = chat([msg("user", "Create a quick report 'Weekly Cash Report' with columns A, B"), msg("assistant", withDesign())]);
    assert.equal(chatKind(c), "quickReport");
  });

  it("is still one when the design was changed in a later answer, and when it was not the first answer", () => {
    const c = chat([msg("user", "q"), msg("assistant", "Which customer?"), msg("user", "Sample Customer"), msg("assistant", withDesign()), msg("user", "add a column"), msg("assistant", withDesign())]);
    assert.equal(chatKind(c), "quickReport");
  });

  it("is an Advisor Chat chat when it only talks about quick reports", () => {
    const c = chat([
      msg("user", "Create a quick report with the columns Invoice No, Customer, Due Date and a parameter Company"),
      msg("assistant", "A quick report is made in the Quick Reports window. Give it a title, parameters and an SQL statement."),
    ]);
    assert.equal(chatKind(c), "advisor");
    assert.equal(chatKind(chat([msg("user", "How do I create a quick report?"), msg("assistant", "Open the window and choose New.")])), "advisor");
  });

  it("is an Advisor Chat chat when an answer holds some other json block, or a block that is not a design", () => {
    const other = `Example:\n\n${fence}json\n{"name":"x","dataSources":[1]}\n${fence}`;
    const broken = `${fence}json\n{"designVersion":1,"dataSources":[,\n${fence}`;
    const noColumns = `${fence}json\n{"designVersion":1,"dataSources":[]}\n${fence}`;
    for (const text of [other, broken, noColumns]) assert.equal(chatKind(chat([msg("user", "q"), msg("assistant", text)])), "advisor", text);
  });

  it("is not decided by a design that the consultant pasted, or by an answer that failed", () => {
    assert.equal(chatKind(chat([msg("user", withDesign()), msg("assistant", "I can explain this design.")])), "advisor");
    assert.equal(chatKind(chat([msg("user", "q"), msg("assistant", withDesign(), { error: true })])), "advisor");
  });

  it("is an Advisor Chat chat when it is empty or has plain answers", () => {
    assert.equal(chatKind(chat([])), "advisor");
    assert.equal(chatKind(chat([msg("user", "q"), msg("assistant", "a")])), "advisor");
  });
});

describe("a chat that was started in a tab", () => {
  it("keeps that tab, whatever its messages hold", () => {
    assert.equal(chatKind(chat([msg("user", "q"), msg("assistant", withDesign())], { kind: "advisor" })), "advisor");
    assert.equal(chatKind(chat([msg("user", "q"), msg("assistant", "plain")], { kind: "quickReport" })), "quickReport");
  });

  it("keeps that tab after a reload from the server, which keeps only the messages and their tag", () => {
    assert.equal(chatKind(chat([msg("user", "q", { mode: "advisor" }), msg("assistant", withDesign(), { mode: "advisor" })])), "advisor");
    assert.equal(chatKind(chat([msg("user", "q", { mode: "quickReport" }), msg("assistant", "Which customer?", { mode: "quickReport" })])), "quickReport");
  });
});

describe("the design block", () => {
  it("is found in the answer of a quick report, and in nothing else", () => {
    assert.equal(hasQuickReportDesign(withDesign()), true);
    assert.equal(hasQuickReportDesign("no block here"), false);
    assert.equal(hasQuickReportDesign(`${fence}json\n[1,2]\n${fence}`), false);
  });
});
