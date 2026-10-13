// Run with `npm test`. Node strips the types of documents.ts itself, so no build step is needed.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import mammoth from "mammoth";
import { DocumentError, htmlToText } from "../src/lib/chat/documents.ts";

describe("htmlToText", () => {
  it("keeps headings, paragraphs and decodes entities", () => {
    const text = htmlToText("<h1>Title</h1><p>Fish &amp; chips &lt;fresh&gt; &quot;hot&quot; &#39;now&#39; &#x41;</p><h3>Sub</h3><p>Next</p>");
    assert.equal(text, "# Title\n\nFish & chips <fresh> \"hot\" 'now' A\n\n### Sub\n\nNext");
  });

  it("writes bullet and numbered lists, and indents a list inside a list", () => {
    const text = htmlToText("<ul><li>One</li><li>Two<ul><li>Inner</li></ul></li></ul><ol><li>First</li><li>Second</li></ol>");
    assert.equal(text, "- One\n- Two\n  - Inner\n\n1. First\n2. Second");
  });

  it("writes a table as one line per row, with paragraphs inside a cell on one line", () => {
    const text = htmlToText("<table><tr><th>Field</th><th>Value</th></tr><tr><td><p>Format</p><p>second line</p></td><td><strong>E-invoice</strong> Malaysia</td></tr></table>");
    assert.equal(text, "| Field | Value |\n| Format second line | E-invoice Malaysia |");
  });

  it("drops pictures, links keep their text, a line break stays a line break", () => {
    const text = htmlToText('<p>See <a href="https://example.com">the guide</a><br />here <img src="" /></p>');
    assert.equal(text, "See the guide\nhere");
  });

  it("copes with comments, stray angle brackets and no html at all", () => {
    assert.equal(htmlToText("<!-- note --><p>a < b</p>"), "a < b");
    assert.equal(htmlToText("just text"), "just text");
    assert.equal(htmlToText(""), "");
  });
});

describe("a Word document through mammoth", () => {
  // mammoth reads a buffer in Node and an arrayBuffer in the browser; the options are the ones documents.ts uses
  it("becomes text with its heading, list and table, and without pictures", async () => {
    const html = (await mammoth.convertToHtml({ buffer: readFileSync(new URL("./fixtures/sample.docx", import.meta.url)) }, { convertImage: mammoth.images.imgElement(() => Promise.resolve({ src: "" })) })).value;
    const text = htmlToText(html);
    assert.match(text, /^# E-invoice setup\n\nFill in the processing type & the routing before you send\./);
    assert.match(text, /## Checklist\n\n- Create the E-invoice Processing Type\n- Add the IFS Connect routing rule/);
    assert.match(text, /\| Field \| Value \|\n\| Message function \| SEND_EINVOICE_MESSAGE \|\n\| Format \| E-invoice Malaysia \|/);
    assert.match(text, /5 < 6 and a quote\.$/);
  });
});

describe("DocumentError", () => {
  it("carries the reason that the composer turns into a message", () => {
    assert.equal(new DocumentError("noText").reason, "noText");
    assert.ok(new DocumentError("unreadable") instanceof Error);
  });
});
