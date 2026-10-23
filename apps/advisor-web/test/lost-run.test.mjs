// Run with `npm test`. When the answer of the backend to a run is lost, the page must not say "the design could not be checked": for Option A the report may
// have been created, and the consultant has to look before trying again.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { STRINGS } from "../src/lib/i18n.ts";
import { lostRunMessage } from "../src/lib/quick-report/next-steps.ts";

describe("a run whose answer was lost", () => {
  for (const lang of ["en", "nl"]) {
    it(`tells the consultant of Option A to check the list in IFS first, and that of Option B that it can be tried again (${lang})`, () => {
      const t = STRINGS[lang];
      assert.equal(lostRunMessage("A", t), t.nextRunLostA);
      assert.equal(lostRunMessage("B", t), t.nextRunLostB);
      assert.notEqual(t.nextRunLostA, t.nextCheckFailed, "not the message of a check that failed");
      assert.notEqual(t.nextRunLostB, t.nextCheckFailed);
    });
  }

  it("says for Option A that it is not known whether the report was created, and for Option B that IFS is never touched", () => {
    assert.match(STRINGS.en.nextRunLostA, /not known whether the quick report was created/);
    assert.match(STRINGS.en.nextRunLostA, /Check the Quick Reports list in IFS before you try again, so that it is not created twice/);
    assert.match(STRINGS.en.nextRunLostB, /never opens or changes IFS/);
    assert.match(STRINGS.nl.nextRunLostA, /niet bekend of het quick report is aangemaakt/);
  });
});
