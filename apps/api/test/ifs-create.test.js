// The steps of Option A in the IFS screens (src/ifs-create.js): open the Quick Reports page, open the New Report dialog, fill it in, and save it, or in a
// rehearsal cancel it. All offline: a fake page that behaves like the dialog of the recording. Nothing is opened in IFS.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { UI, createQuickReport } from "../src/ifs-create.js";

const LIST = "https://env.build.ifs.cloud/main/ifsapplications/web/page/QuickReport/List";
const sql = "SELECT i.invoice_no AS \"Invoice No\"\nFROM IFSAPP.INVOICE_LEDGER_ITEM_CU_QRY i\nWHERE i.company = '&Company'";
const design = {
  report: { title: "Open Customer Invoices", purpose: "Lists the open customer invoices." },
  dataSources: [{ id: "DS1", status: "draft", sql: `${sql};` }],
};
const options = (patch = {}) => ({ listUrl: LIST, timeoutMs: 50, ...patch });

// A fake of the screens. What it does when something is clicked is what IFS does, as far as the recording and the IFS source tell.
//   afterSave: where IFS is when the dialog has closed: "detail" (the new report), "list" (a row with the title) or "nowhere"
function fakeIfs({ gotoFails = false, headingMissing = false, newMissing = false, optionMissing = false, typeClickFails = false, refuseSave = null, afterSave = "detail", titleHeld = null } = {}) {
  const log = [];
  const st = { open: false, typeMenu: false, typeChosen: false, title: "", query: "", comments: "", saved: false, error: null };
  const fail = (what) => {
    throw new Error(`Timeout: ${what} not found`);
  };

  const fieldOf = (labels, name) => labels.find((l) => name.test(l));
  const dialogField = (role, label) => ({
    first: () => dialogField(role, label),
    fill: async (value) => {
      if (!st.open) fail(label);
      if (label === "Query *" && !st.typeChosen) fail("the Query field (it appears after the type is chosen)");
      log.push(`fill ${label}`);
      st[{ "Report Title": "title", "Query *": "query", Comments: "comments" }[label]] = value;
    },
    click: async () => {
      if (!st.open) fail(label);
      log.push(`click ${label}`);
      // clicking the field itself does not open the list
      if (label === "Type") st.typeMenu = false;
      if (label === "Cancel") {
        st.open = false;
        st.typeMenu = false;
      }
      if (label === "Save") {
        if (refuseSave) st.error = refuseSave;
        else {
          st.open = false;
          st.saved = true;
        }
      }
    },
    // the arrow button after the field: it opens the list of the Type field. The field itself does not open it.
    locator: (selector) => {
      if (label !== "Type" || selector !== UI.typeArrow) fail(`${label} ${selector}`);
      return {
        click: async () => {
          if (!st.open) fail("the arrow of the Type field");
          if (typeClickFails) fail("the arrow of the Type field");
          log.push("click Type arrow");
          st.typeMenu = true;
        },
      };
    },
    inputValue: async () => (label === "Report Title" ? (titleHeld ?? st.title) : label === "Query *" ? st.query : ""),
  });
  const dialog = {
    first: () => dialog,
    waitFor: async ({ state }) => {
      if (state === "visible" && !st.open) fail("the dialog");
      if (state === "hidden" && st.open) fail("the dialog to close");
    },
    getByRole: (role, { name }) => {
      const label = role === "textbox" ? fieldOf(["Report Title", "Type", "Query *", "Comments"], name) : fieldOf(["Save", "Cancel", "Close"], name);
      if (!label) fail(`${role} ${name}`);
      return dialogField(role, label);
    },
  };
  const onDetail = () => st.saved && afterSave === "detail";
  const pageField = (label) => ({
    first: () => pageField(label),
    waitFor: async () => {
      if (!onDetail()) fail(label);
    },
    inputValue: async () => (label === "Report Title" ? st.title : st.query),
  });

  const page = {
    goto: async (url) => {
      log.push(`goto ${url}`);
      if (gotoFails) throw new Error("net::ERR_CONNECTION_RESET");
    },
    getByText: (what, o) => {
      const isNew = what instanceof RegExp && what.test("New Report");
      return {
        or: () => page.getByText(what, o),
        first: () => page.getByText(what, o),
        click: async () => {
          if (!isNew || newMissing) fail("New Report");
          log.push("click New Report");
          st.open = true;
        },
        waitFor: async () => {
          if (!(afterSave === "list" && st.saved)) fail(`the text ${String(what)}`);
        },
      };
    },
    getByRole: (role, { name } = {}) => {
      if (role === "heading") return { first: () => page.getByRole(role, { name }), waitFor: async () => headingMissing && fail("the heading") };
      if (role === "dialog") return dialog;
      if (role === "button") return { or: (other) => other, first: () => page.getByRole(role, { name }), click: async () => fail("a button outside the dialog") };
      if (role === "option") {
        return {
          first: () => page.getByRole(role, { name }),
          click: async () => {
            if (optionMissing || !st.typeMenu) fail("the option SQL Statement");
            log.push("click option SQL Statement");
            st.typeChosen = true;
          },
        };
      }
      if (role === "alert") return { first: () => page.getByRole(role), innerText: async () => (st.error ? ` ${st.error} ` : fail("an alert")) };
      if (role === "textbox") return pageField(name.test("Report Title") ? "Report Title" : "Query *");
      throw new Error(`forbidden: getByRole ${role}`);
    },
  };
  return { page, log, st };
}

const stepNames = (r) => r.steps.map((s) => `${s.name}:${s.status}`);

describe("the rehearsal: fill in the dialog and cancel it", () => {
  it("opens the page and the dialog, fills in title, type, query and comments, reads them back, and presses Cancel, never Save", async () => {
    const ifs = fakeIfs();
    const r = await createQuickReport(ifs.page, design, options());
    assert.deepEqual(ifs.log, [
      `goto ${LIST}`,
      "click New Report",
      "fill Report Title",
      "click Type arrow",
      "click option SQL Statement",
      "fill Query *",
      "fill Comments",
      "click Cancel",
    ]);
    assert.ok(!ifs.log.includes("click Save"));
    assert.ok(!ifs.log.includes("click Type"), "the Type field itself does not open its list in IFS: the arrow is used");
    assert.equal(ifs.st.saved, false);
    assert.deepEqual(stepNames(r), ["Open the Quick Reports page:ok", "Open the New Report dialog:ok", "Fill in the dialog:ok", "Save:not done", "Test the quick report:not done"]);
    assert.equal(r.outcome, "rehearsed");
    assert.equal(r.ok, true);
    assert.equal(r.created, false);
    assert.match(r.touchedIfs, /cancelled it; nothing saved/);
    assert.match(r.steps.find((s) => s.name === "Save").detail, /rehearsal/);
  });

  it("is the default: without the option a run is a rehearsal", async () => {
    const ifs = fakeIfs();
    const r = await createQuickReport(ifs.page, design, { listUrl: LIST, timeoutMs: 50 });
    assert.equal(r.outcome, "rehearsed");
    assert.ok(!ifs.log.includes("click Save"));
  });

  it("types what the design says: the title, the SQL without the semicolon, and comments that say it has not been run", async () => {
    const ifs = fakeIfs();
    await createQuickReport(ifs.page, design, options());
    assert.equal(ifs.st.title, "Open Customer Invoices");
    assert.equal(ifs.st.query, sql);
    assert.ok(ifs.st.query.includes("IFSAPP.INVOICE_LEDGER_ITEM_CU_QRY"));
    assert.match(ifs.st.comments, /^Lists the open customer invoices\./);
    assert.match(ifs.st.comments, /it has not been run on IFS\.$/);
  });

  it("says that the SQL has not been run, and does not test the report", async () => {
    const r = await createQuickReport(fakeIfs().page, design, options());
    assert.match(r.steps.at(-1).detail, /has not been run on IFS\. Its status stays 'not run'/);
  });
});

describe("creating the report", () => {
  const create = (ifs) => createQuickReport(ifs.page, design, options({ rehearsal: false }));

  it("presses Save once, and reads the new report back from its detail page", async () => {
    const ifs = fakeIfs();
    const r = await create(ifs);
    assert.equal(ifs.log.filter((l) => l === "click Save").length, 1);
    assert.ok(!ifs.log.includes("click Cancel"));
    assert.equal(r.outcome, "created");
    assert.equal(r.ok, true);
    assert.equal(r.created, true);
    assert.equal(r.touchedIfs, "quick report created");
    assert.deepEqual(stepNames(r).slice(-3), ["Save:ok", "Check the new report:ok", "Test the quick report:not done"]);
    assert.match(r.steps.find((s) => s.name === "Check the new report").detail, /detail page of the new report shows the title and the SQL/);
    assert.match(r.message, /SQL has not been run/);
  });

  it("finds the report in the list when IFS does not open its detail page", async () => {
    const r = await create(fakeIfs({ afterSave: "list" }));
    assert.equal(r.outcome, "created");
    assert.match(r.steps.find((s) => s.name === "Check the new report").detail, /in the list\. Its SQL was not read back/);
  });

  it("does not claim a result that it could not see: a report that cannot be found afterwards is 'possibly created', with a warning against creating it twice", async () => {
    const r = await create(fakeIfs({ afterSave: "nowhere" }));
    assert.equal(r.outcome, "created_unverified");
    assert.equal(r.ok, false);
    assert.equal(r.created, true);
    assert.equal(r.touchedIfs, "quick report possibly created");
    assert.match(r.message, /Check the Quick Reports page in IFS before you try again, so that it is not created twice/);
  });

  it("does not say that it was created when IFS refuses it, shows the reason, and cancels the dialog", async () => {
    const ifs = fakeIfs({ refuseSave: "The report title must be unique." });
    const r = await create(ifs);
    assert.equal(r.outcome, "failed");
    assert.equal(r.created, false);
    assert.match(r.steps.find((s) => s.name === "Save").detail, /IFS did not take the report: The report title must be unique\./);
    assert.ok(ifs.log.includes("click Cancel"));
    assert.equal(ifs.st.saved, false);
    assert.match(r.touchedIfs, /cancelled it; nothing saved/);
  });
});

describe("when a screen is not as expected, nothing is saved", () => {
  const runOf = (patch, o = {}) => {
    const ifs = fakeIfs(patch);
    return createQuickReport(ifs.page, design, options({ rehearsal: false, ...o })).then((r) => ({ r, ifs }));
  };

  it("stops when the Quick Reports page does not open, without clicking anything", async () => {
    for (const patch of [{ gotoFails: true }, { headingMissing: true }]) {
      const { r, ifs } = await runOf(patch);
      assert.equal(r.outcome, "failed");
      assert.equal(r.created, false);
      assert.equal(r.touchedIfs, "read-only visit");
      assert.ok(!ifs.log.some((l) => l.startsWith("click") || l.startsWith("fill")));
    }
  });

  it("stops when the New Report button is not found", async () => {
    const { r, ifs } = await runOf({ newMissing: true });
    assert.equal(r.outcome, "failed");
    assert.match(r.steps.at(-1).detail, /New Report button or its dialog was not found/);
    assert.ok(!ifs.log.some((l) => l.startsWith("fill") || l === "click Save"));
  });

  it("cancels the dialog, and does not save, when a field is not found (the type list)", async () => {
    const { r, ifs } = await runOf({ optionMissing: true });
    assert.equal(r.outcome, "failed");
    assert.match(r.steps.at(-1).detail, /A field was not found or not filled/);
    assert.ok(ifs.log.includes("click Cancel"));
    assert.ok(!ifs.log.includes("click Save"));
    assert.match(r.touchedIfs, /cancelled it; nothing saved/);
  });

  it("says which step it was working on when the dialog could not be filled in", async () => {
    const option = await runOf({ optionMissing: true });
    assert.match(option.r.steps.at(-1).detail, /A field was not found or not filled \(the option SQL Statement in the Type list\): Timeout/);
    const typeField = await runOf({ typeClickFails: true });
    assert.match(typeField.r.steps.at(-1).detail, /\(the arrow of the Type field\): Timeout/);
    assert.ok(typeField.ifs.log.includes("fill Report Title"), "the title was filled in before the Type field failed");
    assert.ok(!typeField.ifs.log.includes("click Save"));
  });

  it("cancels the dialog, and does not save, when a field does not hold what was typed", async () => {
    const { r, ifs } = await runOf({ titleHeld: "something else" });
    assert.equal(r.outcome, "failed");
    assert.match(r.steps.at(-1).detail, /do not hold what was typed/);
    assert.ok(!ifs.log.includes("click Save"));
  });

  it("opens nothing for a design without a title or without SQL", async () => {
    for (const bad of [{ dataSources: [] }, { report: { title: "" }, spec: {} }]) {
      const ifs = fakeIfs();
      const r = await createQuickReport(ifs.page, { ...design, ...bad }, options({ rehearsal: false }));
      assert.equal(r.outcome, "failed");
      assert.equal(r.touchedIfs, "none");
      assert.deepEqual(ifs.log, []);
    }
  });

  it("keeps the error short, and does not put the page content in it", async () => {
    const ifs = fakeIfs({ gotoFails: true });
    ifs.page.goto = async () => {
      throw new Error(`line one\nsecret page content ${"x".repeat(500)}`);
    };
    const r = await createQuickReport(ifs.page, design, options());
    assert.ok(r.steps[0].detail.length < 300);
    assert.ok(!r.steps[0].detail.includes("secret page content"));
  });
});

describe("what this code is allowed to do in IFS", () => {
  const source = readFileSync(new URL("../src/ifs-create.js", import.meta.url), "utf8")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");

  it("clicks only the New Report button, the Type field and its option, Cancel and Save: never Delete, Execute, View Report, Schedule, Import or Export", () => {
    const dangerous = ["Delete", "Delete selected record(s)", "Execute", "View Report", "Schedule Report", "Import", "Export", "Refresh All Quick Reports", "Edit"];
    // no name that the code looks for matches one of them, and none is written in a locator of the code
    for (const word of dangerous) {
      for (const [key, pattern] of Object.entries(UI)) assert.ok(typeof pattern === "string" || !pattern.test(word), `UI.${key} matches ${word}`);
      const escaped = word.replace(/[()]/g, "\\$&");
      assert.ok(!new RegExp(String.raw`(?:getByRole|getByText)\([^)]*` + escaped).test(source), word);
    }
    const clicks = [...source.matchAll(/\.click\(/g)].length;
    assert.equal(clicks, 5, "New Report, Type, its option, Cancel, Save");
  });

  it("does not run a script in the page, change requests, take screenshots, press keys, or write the session", () => {
    assert.ok(!/\.(evaluate|evaluateHandle|route|addInitScript|exposeFunction|screenshot|storageState|press|type|check|setInputFiles|dispatchEvent)\s*\(/.test(source));
    assert.equal(UI.typeArrow, "xpath=following::button[1]");
    assert.ok(!/\b(keyboard|mouse)\b/.test(source));
    assert.ok(!/\bfetch\s*\(/.test(source));
  });

  it("has the names of the fields as the recording of the screens has them", () => {
    assert.ok(UI.title.test("Report Title") && UI.type.test("Type") && UI.query.test("Query *") && UI.comments.test("Comments"));
    assert.ok(UI.save.test("Save") && !UI.save.test("Save and new") && UI.cancel.test("Cancel"));
    assert.ok(UI.newReport.test("New Report") && UI.typeOption.test("SQL Statement"));
    assert.equal(UI.listPath, "/main/ifsapplications/web/page/QuickReport/List");
  });
});
