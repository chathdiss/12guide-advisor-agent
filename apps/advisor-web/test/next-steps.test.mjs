// Run with `npm test`. The approval and the choice of Option A or B after a quick report design was reviewed.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { STRINGS } from "../src/lib/i18n.ts";
import { initialNextState, nextStepsReducer, runRequest } from "../src/lib/quick-report/next-steps.ts";

const validation = { dictionary: { checked: 5, unknownViews: 0, unknownColumns: 0 }, offline: "design checks passed", realEnvironment: "not run" };
const info = (patch = {}) => ({
  ready: true,
  blockers: [],
  openQuestions: [],
  designHash: "a".repeat(64),
  validation,
  options: { A: { available: true, missing: [], target: "env.build.ifs.cloud" }, B: { available: true, missing: [] } },
  ...patch,
});
const result = (patch = {}) => ({ option: "A", ok: false, outcome: "unsupported", created: false, touchedIfs: "read-only visit", steps: [], message: "m", validation, ...patch });
const play = (actions, from = initialNextState) => actions.reduce(nextStepsReducer, from);

describe("when the options are shown", () => {
  it("starts by checking, and shows the approval only for a design that is ready", () => {
    assert.equal(initialNextState.step, "checking");
    assert.equal(play([{ type: "checked", info: info() }]).step, "review");
  });

  it("shows what blocks a design that is not ready, and no approval and no options", () => {
    const blocked = play([{ type: "checked", info: info({ ready: false, blockers: ["Decision not made yet: Amount."] }) }]);
    assert.equal(blocked.step, "blocked");
    assert.equal(play([{ type: "approve" }], blocked).step, "blocked", "cannot be approved");
    assert.equal(play([{ type: "choose", option: "B" }], blocked).step, "blocked", "cannot choose");
    assert.equal(play([{ type: "checked", info: info({ designHash: null }) }]).step, "blocked", "no fingerprint, no approval");
  });

  it("shows the options only after the consultant approved, never straight after the check", () => {
    const review = play([{ type: "checked", info: info() }]);
    assert.equal(review.step, "review");
    assert.equal(play([{ type: "choose", option: "A" }], review).step, "review", "a choice before the approval does nothing");
    assert.equal(play([{ type: "choose", option: "B" }], review).step, "review");
    assert.equal(play([{ type: "approve" }], review).step, "options");
  });

  it("can check again after a failed check or a block, and a failure of the check is shown", () => {
    const failed = play([{ type: "checkFailed", message: "down" }]);
    assert.deepEqual(failed, { step: "unavailable", message: "down" });
    assert.equal(play([{ type: "recheck" }], failed).step, "checking");
    assert.equal(play([{ type: "recheck" }], play([{ type: "checked", info: info({ ready: false, blockers: ["x"] }) }])).step, "checking");
  });
});

describe("the choice of an option", () => {
  const options = play([{ type: "checked", info: info() }, { type: "approve" }]);

  it("Option A needs a confirmation first, and nothing runs before it", () => {
    const confirm = play([{ type: "choose", option: "A" }], options);
    assert.equal(confirm.step, "confirmA");
    assert.equal(runRequest(confirm, "{}"), null, "no request exists while the consultant has not confirmed");
    const running = play([{ type: "confirm" }], confirm);
    assert.equal(running.step, "running");
    assert.deepEqual(runRequest(running, '{"d":1}'), { design: '{"d":1}', designHash: "a".repeat(64), option: "A", approved: true, confirmed: true });
  });

  it("Option A can be cancelled, and then nothing has run and the options are shown again", () => {
    const back = play([{ type: "choose", option: "A" }, { type: "cancel" }], options);
    assert.equal(back.step, "options");
    assert.equal(runRequest(back, "{}"), null);
  });

  it("Option B starts at once, without a confirmation, and its request does not say that it was confirmed", () => {
    const running = play([{ type: "choose", option: "B" }], options);
    assert.equal(running.step, "running");
    assert.deepEqual(runRequest(running, "{}"), { design: "{}", designHash: "a".repeat(64), option: "B", approved: true });
  });

  it("cannot confirm without choosing A first, and cannot choose an option that is not available", () => {
    assert.equal(play([{ type: "confirm" }], options).step, "options");
    const noA = play([{ type: "checked", info: info({ options: { A: { available: false, missing: ["IFS_AUTOMATION"] }, B: { available: true, missing: [] } } }) }, { type: "approve" }]);
    assert.equal(play([{ type: "choose", option: "A" }], noA).step, "options");
    const noB = play([{ type: "checked", info: info({ options: { A: { available: true, missing: [] }, B: { available: false, missing: ["template"] } } }) }, { type: "approve" }]);
    assert.equal(play([{ type: "choose", option: "B" }], noB).step, "options");
    assert.equal(play([{ type: "choose", option: "C" }], options).step, "options");
  });

  it("a second choice while one is running changes nothing", () => {
    const running = play([{ type: "choose", option: "B" }], options);
    for (const action of [{ type: "choose", option: "A" }, { type: "choose", option: "B" }, { type: "confirm" }, { type: "approve" }, { type: "cancel" }, { type: "back" }]) {
      assert.deepEqual(nextStepsReducer(running, action), running, JSON.stringify(action));
    }
  });
});

describe("the result and a retry", () => {
  const running = play([{ type: "checked", info: info() }, { type: "approve" }, { type: "choose", option: "B" }]);

  it("shows the actual result, and goes back to the options, where nothing runs until a new choice", () => {
    const done = play([{ type: "finished", result: result({ option: "B", outcome: "unavailable" }) }], running);
    assert.equal(done.step, "done");
    assert.equal(done.result.created, false);
    const back = play([{ type: "back" }], done);
    assert.equal(back.step, "options");
    assert.equal(runRequest(back, "{}"), null);
  });

  it("shows a failure and allows a retry through the options", () => {
    const failed = play([{ type: "failed", message: "boom" }], running);
    assert.equal(failed.step, "failed");
    assert.equal(failed.message, "boom");
    const again = play([{ type: "back" }, { type: "choose", option: "B" }], failed);
    assert.equal(again.step, "running");
  });

  it("ignores a result or a failure that arrives when nothing is running", () => {
    const options = play([{ type: "checked", info: info() }, { type: "approve" }]);
    assert.equal(play([{ type: "finished", result: result() }], options).step, "options");
    assert.equal(play([{ type: "failed", message: "x" }], options).step, "options");
  });
});

describe("a request is built only from a running state", () => {
  it("never from any other state, and not without the fingerprint of the approved design", () => {
    const states = [
      initialNextState,
      { step: "unavailable", message: "x" },
      { step: "blocked", info: info() },
      { step: "review", info: info() },
      { step: "options", info: info() },
      { step: "confirmA", info: info() },
      { step: "done", info: info(), result: result() },
      { step: "failed", info: info(), option: "A", message: "x" },
    ];
    for (const s of states) assert.equal(runRequest(s, "{}"), null, s.step);
    assert.equal(runRequest({ step: "running", info: info({ designHash: null }), option: "B" }, "{}"), null);
  });
});

describe("the texts of the next steps", () => {
  it("exist in English and Dutch, with the two options named and the SQL status stated honestly", () => {
    const keys = ["nextChecking", "nextCheckFailed", "nextRetry", "nextBlockedTitle", "nextReadyTitle", "nextReadySub", "nextOpenQuestions", "nextApprove", "nextOptionsTitle", "nextNothingYet", "nextOptionATitle", "nextOptionADesc", "nextOptionBTitle", "nextOptionBDesc", "nextChooseA", "nextChooseB", "nextNeeds", "nextConfirmTitle", "nextConfirmYes", "nextCancel", "nextRunning", "nextResultTitle", "nextBack", "nextStepOk", "nextStepFailed", "nextStepNotDone"];
    for (const lang of ["en", "nl"]) {
      for (const key of keys) assert.ok(typeof STRINGS[lang][key] === "string" && STRINGS[lang][key].length > 0, `${lang}.${key}`);
      assert.match(STRINGS[lang].nextOptionATitle, /A/);
      assert.match(STRINGS[lang].nextOptionBTitle, /B/);
      assert.match(STRINGS[lang].nextConfirmBody("host.example"), /host\.example/);
      assert.match(STRINGS[lang].nextValidation(5, 0, 0), /5/);
    }
    assert.match(STRINGS.en.nextValidation(5, 0, 0), /has not been run on any IFS environment/);
    assert.match(STRINGS.nl.nextValidation(5, 0, 0), /niet uitgevoerd op een IFS-omgeving/);
    assert.match(STRINGS.en.nextNothingYet, /Nothing happens until you choose/);
  });
});

describe("the confirmation of Option A: a rehearsal or a real creation", () => {
  it("has the texts for both, in English and Dutch, and the rehearsal says that nothing is saved", () => {
    for (const lang of ["en", "nl"]) {
      for (const key of ["nextConfirmTitleRehearsal", "nextConfirmYesRehearsal"]) assert.ok(STRINGS[lang][key].length > 0, `${lang}.${key}`);
      assert.match(STRINGS[lang].nextConfirmBodyRehearsal("host.example"), /host\.example/);
    }
    assert.match(STRINGS.en.nextConfirmTitleRehearsal, /Nothing will be saved/);
    assert.match(STRINGS.en.nextConfirmBodyRehearsal("h"), /cancels it\. Nothing is saved/);
    assert.match(STRINGS.en.nextConfirmYesRehearsal, /nothing is saved/);
    assert.match(STRINGS.en.nextConfirmBody("h"), /changes the IFS environment/);
    assert.match(STRINGS.nl.nextConfirmBodyRehearsal("h"), /Er wordt niets opgeslagen/);
  });

  it("passes the mode of Option A on, and a choice of A still needs the confirmation in both modes", () => {
    for (const mode of ["rehearsal", "create"]) {
      const options = play([
        { type: "checked", info: info({ options: { A: { available: true, missing: [], target: "env.build.ifs.cloud", mode }, B: { available: true, missing: [] } } }) },
        { type: "approve" },
      ]);
      const confirm = play([{ type: "choose", option: "A" }], options);
      assert.equal(confirm.step, "confirmA", mode);
      assert.equal(confirm.info.options.A.mode, mode);
      assert.equal(runRequest(confirm, "{}"), null, "nothing is sent before the confirmation");
      assert.equal(play([{ type: "confirm" }], confirm).step, "running");
    }
  });
});
