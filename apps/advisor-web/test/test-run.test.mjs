// Run with `npm test`. The test run of a quick report that exists in IFS: each step is an explicit action, nothing is sent before the confirmation, and the
// values that the consultant types are checked first.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { STRINGS } from "../src/lib/i18n.ts";
import { MAX_VALUE_CHARS, UNSAFE_VALUE, checkTestInputs, initialTestRunState, parametersOf, testRequest, testRunReducer } from "../src/lib/quick-report/test-run.ts";

const validation = { dictionary: { checked: 2, unknownViews: 0, unknownColumns: 0 }, offline: "design checks passed", realEnvironment: "not run" };
const result = (patch = {}) => ({ ok: true, outcome: "tested", touchedIfs: "x", steps: [], message: "m", validation, ...patch });
const play = (actions, from = initialTestRunState) => actions.reduce(testRunReducer, from);
const parameters = [{ name: "NameStartsWith", mandatory: false }, { name: "Country", mandatory: true }];
const input = (patch = {}) => ({ design: "{}", designHash: "a".repeat(64), reportId: "123456", parameters, values: { NameStartsWith: "A", Country: "Sweden" }, ...patch });

describe("the steps of a test run", () => {
  it("needs a start and a confirmation, and sends nothing before the confirmation", () => {
    const confirming = play([{ type: "start" }]);
    assert.equal(confirming.step, "confirming");
    assert.equal(testRequest(confirming, input()), null);
    assert.equal(testRequest(initialTestRunState, input()), null);
    const running = play([{ type: "start" }, { type: "confirm" }]);
    assert.equal(running.step, "running");
    assert.deepEqual(testRequest(running, input()), {
      design: "{}",
      designHash: "a".repeat(64),
      approved: true,
      confirmed: true,
      reportId: "123456",
      params: { NameStartsWith: "A", Country: "Sweden" },
    });
  });

  it("cannot be confirmed without being started, and cancelling goes back without anything having run", () => {
    assert.equal(play([{ type: "confirm" }]).step, "idle");
    const back = play([{ type: "start" }, { type: "cancel" }]);
    assert.equal(back.step, "idle");
    assert.equal(testRequest(back, input()), null);
  });

  it("ignores a second start, a second confirmation, and a result that comes when nothing is running", () => {
    const running = play([{ type: "start" }, { type: "confirm" }]);
    for (const action of [{ type: "start" }, { type: "confirm" }, { type: "cancel" }, { type: "reset" }]) assert.deepEqual(testRunReducer(running, action), running, action.type);
    assert.equal(play([{ type: "finished", result: result() }]).step, "idle");
    assert.equal(play([{ type: "failed", message: "x" }]).step, "idle");
    assert.equal(play([{ type: "start" }, { type: "finished", result: result() }]).step, "confirming");
  });

  it("shows the result or the failure, and goes back to the start, where nothing runs until the next confirmation", () => {
    const done = play([{ type: "start" }, { type: "confirm" }, { type: "finished", result: result({ message: "ran" }) }]);
    assert.equal(done.step, "done");
    assert.equal(done.result.message, "ran");
    const again = play([{ type: "reset" }], done);
    assert.equal(again.step, "idle");
    assert.equal(testRequest(again, input()), null);
    const failed = play([{ type: "start" }, { type: "confirm" }, { type: "failed", message: "boom" }]);
    assert.deepEqual(failed, { step: "failed", message: "boom" });
    assert.equal(play([{ type: "reset" }], failed).step, "idle");
  });

  it("does not build a request without the fingerprint of the approved design", () => {
    const running = play([{ type: "start" }, { type: "confirm" }]);
    assert.equal(testRequest(running, input({ designHash: null })), null);
  });

  it("sends every parameter of the design, empty ones as empty text, and trims the report id", () => {
    const running = play([{ type: "start" }, { type: "confirm" }]);
    const request = testRequest(running, input({ reportId: " 123456 ", values: { Country: "Sweden" } }));
    assert.deepEqual(request.params, { NameStartsWith: "", Country: "Sweden" });
    assert.equal(request.reportId, "123456");
  });
});

describe("what the consultant types", () => {
  it("reads the parameters of the design, and none from a design that cannot be read", () => {
    assert.deepEqual(parametersOf(JSON.stringify({ parameters: [{ name: "A", mandatory: true }, { name: "B" }] })), [{ name: "A", mandatory: true }, { name: "B", mandatory: false }]);
    assert.deepEqual(parametersOf("not json"), []);
    assert.deepEqual(parametersOf("{}"), []);
  });

  it("accepts a number as the report id, and nothing else", () => {
    const codes = (id) => checkTestInputs([], {}, id).problems.map((p) => p.code);
    assert.deepEqual(codes("123456"), []);
    assert.deepEqual(codes(" 123456 "), []);
    for (const bad of ["", "75x", "../1", "-1", "1234567890123", "1.5"]) assert.deepEqual(codes(bad), ["id"], bad);
  });

  it("needs a value for a mandatory parameter, and only warns about an empty optional one", () => {
    const r = checkTestInputs(parameters, { NameStartsWith: "", Country: "" }, "1");
    assert.deepEqual(r.problems, [{ code: "mandatory", name: "Country" }]);
    assert.deepEqual(r.warnings, [{ code: "empty", name: "NameStartsWith" }]);
    const ok = checkTestInputs(parameters, { NameStartsWith: "A", Country: "Sweden" }, "1");
    assert.deepEqual(ok, { problems: [], warnings: [] });
  });

  it("refuses long values, and values that could change the SQL around them, as the backend does", () => {
    assert.equal(MAX_VALUE_CHARS, 100);
    assert.deepEqual(checkTestInputs(parameters, { NameStartsWith: "x".repeat(101), Country: "S" }, "1").problems, [{ code: "long", name: "NameStartsWith" }]);
    for (const bad of ["a'b", 'a"b', "a;b", "a&b", "a--b", "a/*b", "a*/b"]) {
      assert.deepEqual(checkTestInputs(parameters, { NameStartsWith: bad, Country: "S" }, "1").problems, [{ code: "unsafe", name: "NameStartsWith" }], bad);
    }
    for (const good of ["A", "Acme Industries", "100", "a-b"]) assert.ok(!UNSAFE_VALUE.test(good), good);
  });
});

describe("the texts of the test run", () => {
  const keys = ["nextTestTitle", "nextTestIntro", "nextTestImportFirst", "nextTestRehearsalMode", "nextTestReportId", "nextTestReportIdHint", "nextTestParameters", "nextTestStart", "nextTestConfirmTitleRun", "nextTestConfirmTitleRehearsal", "nextTestPrivacy", "nextTestYesRun", "nextTestYesRehearsal", "nextTestRunning", "nextTestResultTitle", "nextTestColumnsMatch", "nextTestColumnsDiffer", "nextTestScreenshot", "nextTestAgain", "nextTestRealEnvironment", "nextTestLost"];

  it("exist in English and Dutch", () => {
    for (const lang of ["en", "nl"]) {
      const t = STRINGS[lang];
      for (const key of keys) assert.ok(typeof t[key] === "string" && t[key].length > 0, `${lang}.${key}`);
      assert.match(t.nextTestConfirmBodyRun("host.example"), /host\.example/);
      assert.match(t.nextTestConfirmBodyRehearsal("host.example"), /host\.example/);
      for (const code of ["id", "long", "unsafe", "mandatory"]) assert.ok(t.nextTestProblem(code, "X").length > 0, `${lang} ${code}`);
      assert.match(t.nextTestEmpty("X"), /X/);
      assert.match(t.nextTestRows(3, true), /3\+/);
      assert.match(t.nextTestSeconds(2.5), /2\.5/);
    }
  });

  it("say that a rehearsal does not run the SQL, that the SQL is run by IFS and changes nothing, and that the results stay on the page", () => {
    const en = STRINGS.en;
    assert.match(en.nextTestConfirmTitleRehearsal, /The SQL will not be run/);
    assert.match(en.nextTestConfirmBodyRehearsal("h"), /does not press Execute/);
    assert.match(en.nextTestConfirmBodyRun("h"), /Nothing in IFS is changed/);
    assert.match(en.nextTestPrivacy, /not saved, not logged, not part of the chat, and not sent to the AI model/);
    assert.match(en.nextTestLost, /not known whether the report was run in IFS/);
    assert.match(STRINGS.nl.nextTestPrivacy, /niet opgeslagen, niet gelogd/);
  });
});
