import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { actualLabourCostFromGl, spreadActualCost, standardCostPerWorkCentre, standardLabourCostPerUnit } from "../src/formulas.js";

// the values of the screenshots in the specification: part TEST-PART-001, std lot size 10, labour class DEF (rate 50, overhead 60)
const base = { stdLotSize: 10, setupLabourRate: 50, setupOverheadRate: 60, labourRate: 50, overheadRate: 60 };
const op1 = { ...base, setupCrewSize: 5, crewSize: 3, labourSetupTime: 1, labourRunFactor: 2 };
const op2 = { ...base, setupCrewSize: 7, crewSize: 4, labourSetupTime: 2, labourRunFactor: 3 };

describe("the standard labour cost per unit of an operation", () => {
  it("follows the equation of the specification, term by term", () => {
    // 50 x 5 x (1 / 10) + 60 x (1 / 10) + 50 x 3 x 2 + 60 x 2
    assert.equal(standardLabourCostPerUnit(op1), 25 + 6 + 300 + 120);
    // 50 x 7 x (2 / 10) + 60 x (2 / 10) + 50 x 4 x 3 + 60 x 3
    assert.equal(standardLabourCostPerUnit(op2), 70 + 12 + 600 + 180);
  });

  it("uses the setup rates for the setup terms and the run rates for the run terms", () => {
    const o = { stdLotSize: 1, setupLabourRate: 10, setupCrewSize: 1, labourSetupTime: 1, setupOverheadRate: 100, labourRate: 1000, crewSize: 1, labourRunFactor: 1, overheadRate: 10000 };
    assert.equal(standardLabourCostPerUnit(o), 10 + 100 + 1000 + 10000);
  });

  it("does not multiply the overhead by the crew size, as written in the specification", () => {
    const small = standardLabourCostPerUnit({ ...op1, crewSize: 1, setupCrewSize: 1 });
    const big = standardLabourCostPerUnit({ ...op1, crewSize: 10, setupCrewSize: 10 });
    const overhead = base.setupOverheadRate * (1 / 10) + base.overheadRate * 2;
    assert.equal(small - overhead, 50 * 1 * (1 / 10) + 50 * 1 * 2);
    assert.equal(big - overhead, 50 * 10 * (1 / 10) + 50 * 10 * 2);
  });

  it("refuses a lot size that is not above zero and a value that is not a number", () => {
    assert.throws(() => standardLabourCostPerUnit({ ...op1, stdLotSize: 0 }), /stdLotSize/);
    assert.throws(() => standardLabourCostPerUnit({ ...op1, crewSize: undefined }), /crewSize/);
    assert.throws(() => standardLabourCostPerUnit({ ...op1, labourRate: Number.NaN }), /labourRate/);
  });
});

describe("the standard cost per work centre", () => {
  it("adds up the operations that share a work centre", () => {
    const m = standardCostPerWorkCentre([
      { workCentre: "WC 01", cost: standardLabourCostPerUnit(op1) },
      { workCentre: "WC 02", cost: standardLabourCostPerUnit(op2) },
      { workCentre: "WC 01", cost: 9 },
    ]);
    assert.deepEqual([...m], [["WC 01", 460], ["WC 02", 862]]);
  });
});

describe("spreading the actual labour cost over the work centres", () => {
  const standard = standardCostPerWorkCentre([
    { workCentre: "WC 01", cost: 451 },
    { workCentre: "WC 02", cost: 862 },
  ]);

  it("gives each work centre the share of its standard cost", () => {
    const spread = spreadActualCost(2626, standard);
    assert.equal(spread.get("WC 01"), 2626 * (451 / 1313));
    assert.equal(spread.get("WC 02"), 2626 * (862 / 1313));
  });

  it("spreads exactly the actual cost: the shares add up to it", () => {
    const spread = spreadActualCost(1000, standard);
    assert.ok(Math.abs([...spread.values()].reduce((a, b) => a + b, 0) - 1000) < 1e-9);
  });

  it("gives all of it to the only work centre", () => {
    assert.equal(spreadActualCost(500, new Map([["WC 01", 7]])).get("WC 01"), 500);
  });

  it("returns null when the standard costs add up to zero, because the specification does not say what to show", () => {
    assert.equal(spreadActualCost(500, new Map([["WC 01", 0], ["WC 02", 0]])), null);
  });
});

describe("the actual labour cost from the general ledger", () => {
  it("is the sum of the amounts multiplied by -1", () => {
    assert.equal(actualLabourCostFromGl([-100, -50.5, 20]), 130.5);
    assert.equal(actualLabourCostFromGl([]), -0);
  });
});
