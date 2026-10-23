// The calculations of the Shop Order Report, as the specification writes them (two equations in section 5.1 of the specification, recovered from
// the Word document). They are here so that the design can be tested, and so that the SQL that implements them can be compared with them.

// Standard labour cost per unit of one routing operation:
//   Setup Labour rate x Setup Crew Size x (Labour Setup Time / Std Lot Size)
// + Setup Overhead rate x (Labour Setup Time / Std Lot Size)
// + Labour rate x Crew Size x Labour run factor
// + Overhead rate x Labour run factor
// As specified, the overhead terms do not use the crew size. All rates come from cost set 1 of the labour class.
export function standardLabourCostPerUnit(op) {
  const need = ["setupLabourRate", "setupCrewSize", "labourSetupTime", "stdLotSize", "setupOverheadRate", "labourRate", "crewSize", "labourRunFactor", "overheadRate"];
  for (const key of need) if (typeof op[key] !== "number" || Number.isNaN(op[key])) throw new Error(`${key} must be a number.`);
  if (op.stdLotSize <= 0) throw new Error("stdLotSize must be greater than zero.");
  const setupPerUnit = op.labourSetupTime / op.stdLotSize;
  return op.setupLabourRate * op.setupCrewSize * setupPerUnit + op.setupOverheadRate * setupPerUnit + op.labourRate * op.crewSize * op.labourRunFactor + op.overheadRate * op.labourRunFactor;
}

// The standard cost per work centre: the operations that share a work centre are added up (two operations can be on the same work centre).
// operations: [{ workCentre, cost }]  ->  Map(workCentre -> cost)
export function standardCostPerWorkCentre(operations) {
  const out = new Map();
  for (const { workCentre, cost } of operations) out.set(workCentre, (out.get(workCentre) ?? 0) + cost);
  return out;
}

// The actual labour cost of a shop order (from the general ledger) spread over the work centres in the proportion of their standard cost:
//   Actual cost of a work centre = Actual labour cost from GL x (standard cost of the work centre / sum of the standard cost of all work centres)
// Returns Map(workCentre -> actual cost), or null when the standard costs add up to zero: the specification does not say what to show then.
export function spreadActualCost(actualCost, standardByWorkCentre) {
  const total = [...standardByWorkCentre.values()].reduce((a, b) => a + b, 0);
  if (total === 0) return null;
  return new Map([...standardByWorkCentre].map(([workCentre, cost]) => [workCentre, actualCost * (cost / total)]));
}

// The actual labour cost from the general ledger: the sum of the amounts of the postings of the shop order, multiplied by -1.
export function actualLabourCostFromGl(amounts) {
  return -1 * amounts.reduce((a, b) => a + b, 0);
}
