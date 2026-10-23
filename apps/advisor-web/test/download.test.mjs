// Run with `npm test`. The export file of Option B is given to the consultant from the browser, without going anywhere else.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { STRINGS } from "../src/lib/i18n.ts";
import { downloadFile } from "../src/lib/quick-report/download.ts";

const file = { name: "QuickReports_Test.xml", mimeType: "application/xml", content: "<QUICK_REPORT_LIST>&amp; é</QUICK_REPORT_LIST>", bytes: 50 };

describe("giving the export file to the consultant", () => {
  it("makes a download link with the file name and the content, clicks it once, removes it, and frees the address", async () => {
    const events = [];
    const link = { href: "", download: "", click: () => events.push("click"), remove: () => events.push("remove") };
    const doc = { createElement: (tag) => (events.push(`create ${tag}`), link), body: { appendChild: (el) => events.push(el === link ? "append" : "append other") } };
    let blob = null;
    const urls = {
      createObjectURL: (b) => ((blob = b), "blob:test-address"),
      revokeObjectURL: (u) => events.push(`revoke ${u}`),
    };
    downloadFile(file, doc, urls);
    assert.deepEqual(events, ["create a", "append", "click", "remove", "revoke blob:test-address"]);
    assert.equal(link.href, "blob:test-address");
    assert.equal(link.download, "QuickReports_Test.xml");
    assert.equal(blob.type, "application/xml;charset=utf-8");
    assert.equal(await blob.text(), file.content, "the content is exactly the file");
  });

  it("has the texts for it in English and Dutch", () => {
    for (const lang of ["en", "nl"]) for (const key of ["nextDownload", "nextHowToImport", "nextWarnings"]) assert.ok(STRINGS[lang][key].length > 0, `${lang}.${key}`);
  });
});
