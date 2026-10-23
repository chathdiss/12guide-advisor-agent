// The introduction before the review page: at most three sentences of plain prose, whatever the model wrote.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fillPlaceholders, limitIntroduction } from "../src/quickreport.js";

const AFTER = "[[REVIEW_PAGE]]\n\n[[DESIGN_JSON]]\n\nDo you approve this design, or do you want changes?";

// the shape of a real answer that was too long (sample content)
const LONG = `I have drafted the Sample Report as an SQL quick report with one parameter, Company. For each customer it returns the latest invoice. The design has only been checked against the IFS data dictionary. The SQL has not been run on any IFS environment, so there are no sample results yet.

Three points matter most before a test run:

- Payment type and party type filters: the values are used as I assumed them.
- Payment Terms: this needs your decision.
- Permission sets: the specification says "To be decided".

${AFTER}`;

describe("the introduction before the review page", () => {
  it("keeps three sentences at most, and leaves out a bullet list and the line that introduces it", () => {
    const out = limitIntroduction(LONG);
    assert.equal(out, `I have drafted the Sample Report as an SQL quick report with one parameter, Company. For each customer it returns the latest invoice. The design has only been checked against the IFS data dictionary.\n\n${AFTER}`);
    assert.ok(!out.includes("Three points"));
    assert.ok(!out.includes("- Payment"));
    assert.ok(!out.includes("no sample results"), "the fourth sentence is cut");
  });

  it("leaves a short introduction as it is, and everything after the placeholders untouched", () => {
    const short = `This design lists the open invoices. The Amount column is still open.\n\n${AFTER}`;
    assert.equal(limitIntroduction(short), short);
    const withTail = `One sentence.\n\n${AFTER}\n\n- a list after the page stays\n\nMore text. And more. And more. And more.`;
    assert.equal(limitIntroduction(withTail), withTail);
  });

  it("does not cut a sentence at an abbreviation, a decimal number or a view name", () => {
    const text = `The design reads INVOICE_LEDGER_ITEM_CU_QRY, e.g. the open amount, for version 25.1 of IFS. It has two parameters. The Amount is open.\n\n${AFTER}`;
    assert.equal(limitIntroduction(text), text);
  });

  it("leaves headings and table lines out", () => {
    const text = `## Introduction\nThe design is ready.\n| a | b |\nIt has one parameter.\n\n${AFTER}`;
    assert.equal(limitIntroduction(text), `The design is ready. It has one parameter.\n\n${AFTER}`);
  });

  it("changes nothing when there is no placeholder for the page, or nothing before it", () => {
    const none = "A. B. C. D. E.";
    assert.equal(limitIntroduction(none), none);
    assert.equal(limitIntroduction(AFTER), AFTER);
    assert.equal(limitIntroduction(null), "");
    // only a list before the page: nothing is left of the introduction, the page and the question stay
    assert.equal(limitIntroduction(`- one\n- two\n\n${AFTER}`), AFTER);
  });

  it("still lets the page and the design come in exactly after the cut", () => {
    const out = fillPlaceholders(limitIntroduction(LONG), { reviewPage: "# PAGE", designJson: '{"designVersion":1}' });
    assert.ok(out.includes("# PAGE") && out.includes('```json\n{"designVersion":1}\n```'));
    assert.ok(!out.includes("[["));
    assert.match(out, /Do you approve this design, or do you want changes\?$/);
  });
});
