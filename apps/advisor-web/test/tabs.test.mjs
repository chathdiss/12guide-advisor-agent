// Run with `npm test`. The two tabs of the app: which chat belongs to which tab, and the texts of both tabs in both languages.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { STRINGS } from "../src/lib/i18n.ts";
import { chatKind } from "../src/lib/chat/types.ts";

const msg = (extra = {}) => ({ id: "m", role: "user", content: "x", createdAt: 1, ...extra });

describe("the tab that a chat belongs to", () => {
  it("is Advisor Chat for a chat from before the tabs existed", () => {
    assert.equal(chatKind({ messages: [msg(), msg({ role: "assistant" })] }), "advisor");
    assert.equal(chatKind({ messages: [] }), "advisor");
  });

  it("is Quick Reports for a chat that was started there", () => {
    assert.equal(chatKind({ kind: "quickReport", messages: [msg()] }), "quickReport");
  });

  it("is still Quick Reports when the chat comes back from the server, which keeps only the messages", () => {
    assert.equal(chatKind({ messages: [msg({ mode: "quickReport" }), msg({ role: "assistant", mode: "quickReport" })] }), "quickReport");
  });

  it("is never decided by what the messages say, so a general question about quick reports stays in Advisor Chat", () => {
    assert.equal(chatKind({ kind: "advisor", messages: [msg({ content: "Create a quick report with columns A, B" })] }), "advisor");
  });
});

describe("the texts of the tabs", () => {
  const keys = ["tabsLabel", "tabAdvisor", "tabQuickReports", "quickReportTitle", "quickReportSub", "quickReportHint", "quickReportPlaceholder", "newQuickReport"];

  it("exist in English and Dutch, with three example questions and three labels for Quick Reports", () => {
    for (const lang of ["en", "nl"]) {
      for (const key of keys) assert.ok(typeof STRINGS[lang][key] === "string" && STRINGS[lang][key].length > 0, `${lang}.${key}`);
      assert.equal(STRINGS[lang].quickReportExamples.length, 3, lang);
      assert.equal(STRINGS[lang].quickReportLabels.length, 3, lang);
      assert.equal(STRINGS[lang].examples.length, STRINGS[lang].exampleLabels.length, lang);
    }
  });

  it("have the same texts on both sides, and no example that needs a file that is not attached", () => {
    assert.deepEqual(Object.keys(STRINGS.en).sort(), Object.keys(STRINGS.nl).sort());
    for (const lang of ["en", "nl"]) for (const q of STRINGS[lang].quickReportExamples) assert.ok(!/attached|bijgevoegde/i.test(q), q);
  });

  it("name the SQL check honestly: the data dictionary only, never an IFS environment", () => {
    assert.match(STRINGS.en.quickReportHint, /data dictionary only/);
    assert.match(STRINGS.nl.quickReportHint, /alleen gecontroleerd/);
  });
});
