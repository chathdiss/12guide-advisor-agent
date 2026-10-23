// Option B of the quick report flow: an export file that the consultant imports into IFS by hand (Quick Reports page > Import > Browse XML).
//
// The file has the structure of a real IFS export (packages/quick-reports/src/export-xml.js). It is checked here as far as is possible without IFS: it is
// well-formed, and has the same tags as a real export. Whether IFS accepts it can only be seen by importing it, so the first one should be a harmless test
// report. IFS is never opened or changed by this option.
import { buildQuickReportExport, checkExportXml } from "../../../packages/quick-reports/src/export-xml.js";

const failed = (outcome, detail, message) => ({
  ok: false,
  outcome,
  created: false,
  touchedIfs: "none",
  steps: [{ name: "Export file", status: "failed", detail }],
  message,
});

export function createExporter() {
  return {
    // nothing outside this program is needed
    availability: () => ({ available: true, missing: [] }),

    async run(design) {
      const built = buildQuickReportExport(design);
      if (!built.ok) return failed("unsupported", built.errors.join(" "), "No export file was made. IFS was not opened or changed.");
      const checked = checkExportXml(built.file.content);
      if (!checked.ok) return failed("failed", `The file did not pass its own check: ${checked.problems.join(" ")}`, "No export file was given out. IFS was not opened or changed.");

      const { file, reportId, title } = built;
      return {
        ok: true,
        outcome: "exported",
        created: false,
        touchedIfs: "none",
        file,
        reportId,
        title,
        steps: [
          { name: "Export file", status: "ok", detail: `${file.name}, ${file.bytes} bytes, report id ${reportId}.` },
          { name: "Check the file", status: "ok", detail: "Well-formed XML with the same tags as a real IFS export. IFS has not read it yet." },
          { name: "Import it in IFS (you do this)", status: "not done", detail: "See the instructions below. IFS was not opened or changed." },
        ],
        instructions: [
          "Download the file.",
          "In IFS open Solution Manager > Reporting and Analysis > Ad-hoc Reporting > Quick Reports.",
          "Click Import, then Browse XML..., choose the file, and click OK.",
          "If IFS asks whether to replace an existing quick report, answer No, unless you mean to update the report with that title.",
          "Open the new report: choose its Category and Domain if you need them (the file leaves them empty).",
          "Test it with View Report. The SQL has not been run on IFS.",
        ],
        warnings: [
          ...built.warnings,
          `The file gives the report the id ${reportId}, from a range that IFS does not use. Import a harmless test report first, to see that your IFS accepts the file.`,
        ],
        message: "The export file is ready. IFS was not opened or changed. Import it yourself, as described below.",
      };
    },
  };
}
