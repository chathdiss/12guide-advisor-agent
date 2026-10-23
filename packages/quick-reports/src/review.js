// The review page of a design (step 4 of the pipeline): what the consultant reads before the report is built. Markdown, so that it can be shown
// in the advisor chat or saved as a file.

const cell = (v) => String(v ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");

export function reviewMarkdown(design) {
  const d = design;
  const lines = [];
  lines.push(`# ${d.report.title} (${d.type})`, "");
  lines.push(`Customer ${d.spec.customer}, ticket ${d.spec.ticket}, specification ${d.spec.specRevision}.`, "", d.report.purpose, "");

  lines.push("## Parameters", "", "| Parameter | Type | Mandatory | Default | Used in the SQL as |", "|---|---|---|---|---|");
  for (const p of d.parameters) lines.push(`| ${cell(p.label)} | ${cell(p.type)} | ${p.mandatory ? "yes" : "no"} | ${cell(p.default ?? "none")} | \`${cell(p.usedAs)}\` |`);

  lines.push("", "## Columns of the report", "", "| # | Column | Where the specification takes it from | Source in IFS |", "|---|---|---|---|");
  d.columns.forEach((c, i) => lines.push(`| ${i + 1} | ${cell(c.label)}${c.dynamic ? ` (one per ${cell(c.dynamic.per)})` : ""} | ${cell(c.specSource)} | \`${cell(c.expression)}\` |`));

  if (d.formulas?.length) {
    lines.push("", "## Calculations in the specification", "");
    for (const f of d.formulas) {
      lines.push(`**${f.name}**`, "", "```", f.text, "```", "");
      if (f.notes?.length) for (const n of f.notes) lines.push(`- ${n}`);
      if (f.workedExample) lines.push(`- Worked example from the screenshots of the specification: ${f.workedExample}`);
      lines.push("");
    }
  }

  for (const s of d.dataSources) {
    lines.push("", `## Data source: ${s.id} (${s.status ?? "ready"})`, "", s.purpose, "");
    if (s.entitiesUsed?.length) {
      lines.push("Views used:", "");
      for (const e of s.entitiesUsed) lines.push(`- \`${e.view}\`: ${e.role}${e.inDataDictionary ? "" : " (not found in the data dictionary)"}`);
      lines.push("");
    }
    if (s.sql) lines.push("```sql", s.sql, "```", "");
    else {
      lines.push("**No SQL yet.** Blocked by:", "");
      for (const b of s.blockedBy ?? []) lines.push(`- ${b}`);
      if (s.knownParts?.length) {
        lines.push("", "What is already known:", "");
        for (const k of s.knownParts) lines.push(`- ${k}`);
      }
      lines.push("");
    }
    if (s.assumptions?.length) {
      lines.push("Assumptions:", "");
      for (const a of s.assumptions) lines.push(`- ${a}`);
    }
  }

  if (d.decisions?.length) {
    lines.push("", "## Decisions for the consultant", "");
    for (const dec of d.decisions) {
      lines.push(`### ${dec.title}`, "", dec.question, "");
      for (const o of dec.options) lines.push(`- **${o.label}**: ${o.consequence}`);
      lines.push("");
    }
  }

  lines.push("", "## Validation", "", `Status: **${d.validation.status}**.`, "");
  if (d.validation.offlineChecks) {
    const o = d.validation.offlineChecks;
    lines.push(`Checked against the IFS data dictionary (${o.version ?? "version not given"}): ${o.checked} column reference(s) checked, ${o.unknownColumns?.length ?? 0} unknown, ${o.unknownViews?.length ?? 0} unknown view(s).`, "");
  }
  lines.push("To confirm when the SQL is run on a test environment:", "");
  for (const c of d.validation.toConfirmOnTheTestEnvironment ?? []) lines.push(`- ${c}`);

  lines.push("", "## Questions for the consultant", "");
  d.openQuestions.forEach((q, i) => lines.push(`${i + 1}. ${q}`));
  lines.push("", "Approve the design, or tell me what to change.");
  return lines.join("\n");
}
