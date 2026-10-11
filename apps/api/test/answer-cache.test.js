import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { analyze, compare, contextOf, estimateSaved, reusable, selfContained } from "../src/answer-cache.js";

const same = (a, b) => compare(analyze(a), analyze(b));
const matches = (a, b) => same(a, b).match;

describe("matching questions for saved answers", () => {
  it("matches the same question in another wording of filler words, endings and case", () => {
    assert.ok(matches("How do I reopen a closed accounting period?", "how can i reopen the closed accounting period"));
    assert.ok(matches("Which method creates a voucher?", "which methods create vouchers"));
    assert.ok(matches("How do I configure a project budget in IFS Cloud?", "Please explain how to configure the project budget"));
    assert.equal(same("Which method creates a voucher?", "which method creates a voucher").exact, true);
  });

  const LONG = "How do I reopen a closed accounting period for company ACME in the accrul component of IFS";

  it("matches a long question that differs by one word, but a short question must match completely", () => {
    assert.ok(matches(LONG, `${LONG} please`.replace(" please", " again")), "one extra word in a long question");
    assert.ok(matches(LONG, LONG.replace("reopen", "reopen")));
    assert.ok(!matches(LONG, LONG.replace("reopen", "delete")), "a replaced word is two differences");
    assert.ok(!matches(LONG, `${LONG} again for another company`), "several extra words");
    assert.ok(!matches("How do I close an accounting period in accrul?", "How do I reopen a closed accounting period in accrul?"), "one word changes the answer of a short question");
    assert.ok(!matches("How to reopen a closed accounting period in accrul", "How to reopen a closed accounting period in accrul again"));
  });

  it("does not match a different question", () => {
    assert.ok(!matches("How do I create a customer order line?", "How do I delete a customer order line?"));
    assert.ok(!matches("How do I create a voucher?", "How do I create a supplier invoice?"));
    assert.ok(!matches("How do I reopen a closed accounting period?", "How do I close an accounting period?"));
    assert.ok(!matches("voucher", "voucher type"), "one shared word out of two is not enough");
  });

  it("never matches when a code, number or name differs", () => {
    assert.ok(!matches("What does error ORA-20110 mean?", "What does error ORA-20111 mean?"));
    assert.ok(!matches("Which projection handles purchase orders in 25R2?", "Which projection handles purchase orders in 24R1?"));
    assert.ok(!matches("Which package is CustomerOrderLine used in?", "Which package is CustomerOrderFlow used in?"));
    assert.ok(!matches("Which columns does work_task_tab have?", "Which columns does work_order_tab have?"));
    assert.ok(matches("Which columns does work_task_tab have?", "what columns has the work_task_tab"), "the same code does match");
    assert.ok(!matches('What does the "Prevent Edits" setting do?', 'What does the "Allow Edits" setting do?'));
  });

  it("never matches a question with a negation against one without", () => {
    assert.ok(!matches("Why can the voucher not be posted in accrul?", "Why can the voucher be posted in accrul?"));
    assert.ok(!matches("How do I post a voucher without approval?", "How do I post a voucher with approval?"));
    assert.ok(!matches("Waarom kan de boeking niet worden geboekt?", "Waarom kan de boeking worden geboekt?"));
  });

  it("does not match the same words in another order that changes the meaning", () => {
    assert.ok(!matches("copy company data from source to target tenant", "copy target data from company to source tenant"));
  });

  it("keeps the allowed difference under the caller's control", () => {
    const a = analyze("reopen closed accounting period accrul company");
    const b = analyze("reopen closed accounting period accrul");
    assert.equal(compare(a, b).match, false, "a short question must match completely");
    assert.equal(compare(a, b, { wordsPerDifference: 5 }).match, true);
  });

  it("matches nothing for an empty question", () => {
    assert.equal(matches("", "How do I reopen a period?"), false);
    assert.equal(matches("how do i", "how do i"), false, "only stopwords: nothing to compare");
  });

  it("answers from memory in the middle of a chat too, but never a question with attachments or a very long one", () => {
    assert.ok(reusable({ question: "How do I reopen a period?", history: [], attachments: [] }));
    assert.ok(reusable({ question: "And in 25R2?", history: [{ role: "user", content: "x" }], attachments: [] }));
    assert.ok(!reusable({ question: "What is in this screenshot?", history: [], attachments: [{ name: "a.png" }] }));
    assert.ok(!reusable({ question: "x".repeat(1001), history: [], attachments: [] }), "a long pasted question is too specific");
  });

  it("knows a question that stands on its own from one that leans on earlier messages", () => {
    assert.ok(selfContained("Explain about Building a simple AI Assistant for IFS using workflows"));
    assert.ok(selfContained("How do I reopen a closed accounting period?"));
    assert.ok(!selfContained("And in 25R2?"), "too few topic words");
    assert.ok(!selfContained("Explain that again with an example for accounting periods"), "points back with 'that' and 'again'");
    assert.ok(!selfContained("Kun je dit nog een keer uitleggen voor boekhoudperiodes"), "Dutch pointing word");
    assert.ok(!selfContained(""));
  });

  it("gives a question that stands on its own, or opens a chat, no conversation code", () => {
    const history = [{ role: "user", content: "How do I reopen a closed accounting period?" }, { role: "assistant", content: "Use the page." }];
    assert.equal(contextOf(history, "How do I reopen a closed accounting period in accrul?"), "");
    assert.equal(contextOf([], "And in 25R2?"), "");
    assert.equal(contextOf(undefined, "And in 25R2?"), "");
  });

  it("ties a question that leans on earlier messages to the earlier questions of that chat, not to the answers", () => {
    const q = (text) => ({ role: "user", content: text });
    const a = (text) => ({ role: "assistant", content: text });
    const one = [q("How do I reopen a closed accounting period?"), a("Answer one.")];
    const sameQuestionsOtherAnswers = [q("How do I reopen a closed accounting period?"), a("A completely different wording.")];
    const other = [q("How do I create a voucher type?"), a("Answer one.")];
    const code = contextOf(one, "And in 25R2?");
    assert.match(code, /^[0-9a-f]{16}$/);
    assert.equal(contextOf(sameQuestionsOtherAnswers, "And in 25R2?"), code);
    assert.notEqual(contextOf(other, "And in 25R2?"), code);
    // a re-worded earlier question is the same earlier question
    assert.equal(contextOf([q("how can I reopen the closed accounting period"), a("x")], "And in 25R2?"), code);
  });

  it("estimates the tokens a saved answer saves as the prompt plus the answer", () => {
    assert.equal(estimateSaved(""), 6000);
    assert.equal(estimateSaved("x".repeat(4000)), 7000);
  });
});
