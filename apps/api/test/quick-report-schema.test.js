// The introduction of a quick report answer, and the prompt of both n8n versions: the schema owner in front of a view, and the approval in the chat.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { limitIntroduction } from "../src/quickreport.js";

const AFTER = "[[REVIEW_PAGE]]\n\n[[DESIGN_JSON]]\n\nPlease approve the design.";

describe("the introduction", () => {
  it("is cut to three sentences, whatever they say", () => {
    const text = `The design lists the open invoices. The views are written with IFSAPP in front of them. It has two parameters. The Amount is still open.\n\n${AFTER}`;
    assert.equal(limitIntroduction(text), `The design lists the open invoices. The views are written with IFSAPP in front of them. It has two parameters.\n\n${AFTER}`);
  });

  it("keeps an introduction of three sentences or less as it is", () => {
    const text = `The design lists the open invoices. The Amount is still open.\n\n${AFTER}`;
    assert.equal(limitIntroduction(text), text);
  });
});

describe("the prompt of the two workflow files", () => {
  const load = (f) => JSON.parse(readFileSync(new URL(`../../../agents/advisor/${f}`, import.meta.url), "utf8"));
  const files = ["n8n-agent-workflow.json", "n8n-agent-workflow-2.34.6.json"];

  it("tells the agent to write every view with the schema owner, as IFS documents, and keeps the other SQL rules", () => {
    for (const f of files) {
      const build = load(f).nodes.find((n) => n.name === "Build prompt").parameters.jsCode;
      assert.match(build, /Write every view with the schema owner in front of it, as IFS documents for SQL quick reports \(FROM IFSAPP\.CUSTOMER_INFO c\)/, f);
      assert.match(build, /look the view up without it/, f);
      assert.ok(!/never add advice about a schema prefix/.test(build), `${f}: the old rule is gone`);
      assert.match(build, /Give every view a table alias and write every column as alias\.column/, f);
      assert.match(build, /A parameter is written '&Name' in the SQL and is declared in parameters/, f);
      assert.match(build, /never say or imply that the SQL was validated, run or tested/, f);
    }
  });
});

describe("the approval in the chat", () => {
  const load = (f) => JSON.parse(readFileSync(new URL(`../../../agents/advisor/${f}`, import.meta.url), "utf8"));
  it("sends the consultant to the Approve design button, and never lets the agent create, export or choose", () => {
    for (const f of ["n8n-agent-workflow.json", "n8n-agent-workflow-2.34.6.json"]) {
      const build = load(f).nodes.find((n) => n.name === "Build prompt").parameters.jsCode;
      assert.match(build, /use the Approve design button under the design/, f);
      assert.match(build, /create the report directly in the IFS environment, or generate an export file/, f);
      assert.match(build, /never choose an option for them, and never claim that anything was created, exported or tested/, f);
      assert.ok(!/are not available yet/.test(build), f);
    }
  });
});

describe("the names of the parameters", () => {
  const load = (f) => JSON.parse(readFileSync(new URL(`../../../agents/advisor/${f}`, import.meta.url), "utf8"));
  it("tells the agent that IFS shows a parameter by its name, and to use a short readable CamelCase name", () => {
    for (const f of ["n8n-agent-workflow.json", "n8n-agent-workflow-2.34.6.json"]) {
      const build = load(f).nodes.find((n) => n.name === "Build prompt").parameters.jsCode;
      assert.match(build, /IFS shows the consultant a parameter by the name that follows the & \(the label is not shown\)/, f);
      assert.match(build, /short readable name in CamelCase without spaces or underscores, such as &NameStartsWith or &DueBefore, never &P1 or &PARAM_1/, f);
      assert.match(build, /A parameter is written '&Name' in the SQL and is declared in parameters/, f);
    }
  });
});
