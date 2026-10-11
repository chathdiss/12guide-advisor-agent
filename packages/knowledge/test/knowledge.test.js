import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { chunkText } from "../src/chunk.js";
import { splitIdentifiers } from "../src/identifiers.js";
import { prepareDocument } from "../src/prepare.js";
import { blendedCoverage, candidateTerms, findByName, findByTitle, inflections, loadDocumentTexts, namePhrases, searchKnowledge, sizeFactor, sourceWeight, titleIsAsked } from "../src/search.js";
import { walkIfsSource } from "../src/sources/ifs-source.js";

const plsql = (n) =>
  Array.from({ length: n }, (_, i) => `PROCEDURE Proc_${i} (\n  a_ IN VARCHAR2 )\nIS\nBEGIN\n   NULL; -- ${"x".repeat(60)}\nEND Proc_${i};\n`).join("\n");

describe("chunkText", () => {
  it("keeps a short text in one chunk", () => {
    const chunks = chunkText("line one\nline two");
    assert.equal(chunks.length, 1);
    assert.deepEqual([chunks[0].startLine, chunks[0].endLine], [1, 2]);
  });

  it("never returns an empty chunk, and drops whitespace-only text", () => {
    assert.deepEqual(chunkText("\n\n   \n"), []);
    for (const c of chunkText(plsql(40))) assert.ok(c.text.trim().length > 0);
  });

  it("cuts long text into bounded chunks that cover every line", () => {
    const text = plsql(80);
    const total = text.split("\n").length;
    const chunks = chunkText(text);
    assert.ok(chunks.length > 3);
    for (const c of chunks) assert.ok(c.text.length <= 2400 + 200, `chunk too big: ${c.text.length}`);

    const covered = new Set();
    for (const c of chunks) for (let l = c.startLine; l <= c.endLine; l++) covered.add(l);
    for (let l = 1; l <= total; l++) {
      const blank = text.split("\n")[l - 1].trim() === "";
      assert.ok(covered.has(l) || blank, `line ${l} is in no chunk`);
    }
  });

  it("moves forward and repeats a few lines between neighbours", () => {
    const chunks = chunkText(plsql(60));
    for (let i = 1; i < chunks.length; i++) {
      assert.ok(chunks[i].startLine > chunks[i - 1].startLine, "chunks must advance");
      assert.ok(chunks[i].startLine <= chunks[i - 1].endLine + 1, "no gap between chunks");
    }
  });

  it("prefers to cut where a declaration starts", () => {
    const chunks = chunkText(plsql(60));
    const starts = chunks.slice(1).map((c) => c.text.split("\n").slice(0, 4).join("\n"));
    assert.ok(starts.some((s) => /PROCEDURE/.test(s)), "some chunk should begin at or just before a PROCEDURE");
  });

  it("copes with one huge line and with Windows line endings", () => {
    const huge = chunkText("a".repeat(10000));
    assert.equal(huge.length, 1);
    const crlf = chunkText("one\r\ntwo\r\nthree");
    assert.equal(crlf[0].text, "one\ntwo\nthree");
  });
});

describe("splitIdentifiers", () => {
  it("opens up snake_case and CamelCase names", () => {
    const words = splitIdentifiers("Customer_Order_API CodeBHandling AccLibCurrencyAmount").split(" ");
    for (const w of ["customer", "order", "api", "code", "handling", "acc", "lib", "currency", "amount"]) {
      assert.ok(words.includes(w), `missing ${w}`);
    }
  });

  it("ignores ordinary words and numbers", () => {
    assert.equal(splitIdentifiers("select the amount from account where id = 12345"), "");
  });

  it("respects the size limit", () => {
    assert.ok(splitIdentifiers("Some_Name ".repeat(5000), 100).length <= 100);
  });
});

describe("IFS source files", () => {
  it("indexes the useful files, skips the noise, and reads version, component and layer from the path", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ifs-"));
    const put = async (rel, body = "x") => {
      const full = path.join(root, ...rel.split("/"));
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, body);
    };
    await put("Apps10_UPD29/accrul/database/Account.plsql", "PROCEDURE X IS BEGIN NULL; END X;");
    await put("Apps10_UPD29/accrul/client/Ifs.Application.Accrul/Forms/frmA.cs", "class A {}");
    await put("Apps10_UPD29/accrul/client/Ifs.Application.Accrul/Forms/frmA.Designer.cs", "generated");
    await put("Apps10_UPD29/accrul/database/Big_Data.ins", "data");
    await put("Apps10_UPD29/accrul/client/Strings.resx", "<root/>");

    const found = [];
    for await (const f of walkIfsSource(root)) found.push(f);
    const keys = found.map((f) => f.docKey).sort();

    assert.deepEqual(keys, [
      "Apps10_UPD29/accrul/client/Ifs.Application.Accrul/Forms/frmA.cs",
      "Apps10_UPD29/accrul/database/Account.plsql",
    ]);
    const account = found.find((f) => f.title === "Account.plsql");
    assert.equal(account.version, "Apps10 UPD29");
    assert.equal(account.component, "ACCRUL");
    assert.equal(account.layer, "database");
    assert.equal(account.kind, "PL/SQL package");
  });

  it("reads the model files of IFS Cloud and gives every version folder its own source", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ifs-"));
    const put = async (rel, body = "x") => {
      const full = path.join(root, ...rel.split("/"));
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, body);
    };
    await put("IFS_Cloud_25R2/accrul/model/accrul/Voucher.entity", "entity Voucher {}");
    await put("IFS_Cloud_25R2/accrul/model/accrul/Voucher.projection", "projection VoucherHandling;");
    await put("IFS_Cloud_25R2/accrul/model/accrul/Voucher.client", "client Voucher;");
    await put("IFS_Cloud_25R2/accrul/model/accrul/Voucher.fragment", "fragment F;");
    await put("IFS_Cloud_25R2/accrul/model/accrul/Types.enumeration", "enumeration T {}");
    await put("IFS_Cloud_25R2/accrul/translation/errors.txt", "noise");
    await put("Apps10_UPD29/accrul/database/Account.plsql", "PROCEDURE X IS BEGIN NULL; END X;");

    const found = [];
    for await (const f of walkIfsSource(root)) found.push(f);
    assert.deepEqual(found.map((f) => f.title).sort(), ["Account.plsql", "Types.enumeration", "Voucher.client", "Voucher.entity", "Voucher.fragment", "Voucher.projection"]);
    const cloud = found.find((f) => f.title === "Voucher.projection");
    assert.equal(cloud.source, "ifs-cloud-25r2");
    assert.equal(cloud.version, "IFS Cloud 25R2");
    assert.equal(cloud.kind, "projection (API)");
    assert.equal(found.find((f) => f.title === "Account.plsql").source, "ifs-apps10-upd29");
  });

  it("drops the UNUSED lines of field description files and indexes split identifiers", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ifs-"));
    const file = path.join(root, "f.csv");
    await writeFile(file, 'colA;UNUSED;""\ncolSupplierTaxInfo;Tax info of the supplier;"Shown in the form"\ncolB;UNUSED;""');
    const { chunks } = await prepareDocument({ absPath: file, docKey: "f.csv", title: "f.csv", ext: ".csv" });
    assert.equal(chunks.length, 1);
    assert.ok(!/UNUSED/.test(chunks[0].content));
    assert.ok(/supplier tax info/.test(chunks[0].searchText) || /supplier/.test(chunks[0].searchText));
  });
});

describe("blog posts", async () => {
  const { htmlToText } = await import("../src/html-to-text.js");
  const { isIfsPost, postToDocument } = await import("../src/sources/dsj23-source.js");

  it("keeps headings, lists, inline code and code blocks", () => {
    const text = htmlToText(
      '<h2>Set up</h2><p>Use <code>Authorization</code> &amp; more.</p><ul><li>one</li><li>two</li></ul><pre>a &lt; b\n  c</pre>',
    );
    assert.match(text, /^## Set up/);
    assert.match(text, /Use `Authorization` & more\./);
    assert.match(text, /- one\n- two/);
    assert.match(text, /```\na < b\n {2}c\n```/);
  });

  it("drops scripts and decodes numeric entities", () => {
    assert.equal(htmlToText("<script>alert(1)</script><p>it&#8217;s &#x41;</p>"), "it’s A");
  });

  it("picks the IFS posts and links to the https page", () => {
    assert.equal(isIfsPost({ title: "Trip", tags: { Travel: {} } }), false);
    assert.equal(isIfsPost({ title: "Trip", tags: { "IFS Cloud": {} } }), true);
    assert.equal(isIfsPost({ title: "Using IFS Connect", tags: {} }), true);
    const doc = postToDocument({ ID: 1, URL: "http://dsj23.me/2024/a/", title: "A &amp; B", date: "2024-05-01T10:00:00", content: "<p>text</p>", tags: {} });
    assert.equal(doc.url, "https://dsj23.me/2024/a/");
    assert.equal(doc.title, "A & B");
    assert.equal(doc.version, "blog 2024");
    assert.match(doc.text, /^# A & B\n\ntext$/);
  });
});

describe("search with rewritten keywords", () => {
  const row = (id, text) => ({
    id, content: text, search_text: text, start_line: 1, end_line: 2, rank: 0.1,
    title: `T${id}`, doc_key: `doc${id}`, origin: "o", url: null, version: "", component: "", meta: {},
  });
  const fakeDb = (rows) => ({ async query(sql, params) { fakeDb.terms = params[0]; return { rows }; } });

  it("searches the keywords instead of the question and accepts a chunk with a quarter of them", async () => {
    // the Dutch question has no English words; the keywords carry the translation and synonyms
    const db = fakeDb([row(1, "customer order is released"), row(2, "unrelated text")]);
    const found = await searchKnowledge(db, "klantorder vrijgeven", {
      keywords: ["customer order", "release", "reserve", "deliver", "ship", "CUSTOMER_ORDER_API"],
    });
    assert.match(fakeDb.terms, /customer/);
    assert.doesNotMatch(fakeDb.terms, /klantorder/);
    assert.equal(found[0].title, "T1");
  });

  it("falls back to the question without keywords", async () => {
    await searchKnowledge(fakeDb([]), "currency amount", { keywords: [] });
    assert.match(fakeDb.terms, /currency/);
  });
});

describe("word forms", () => {
  it("gives a verb its endings: validates, validate, validated, validating", () => {
    const forms = inflections("validates");
    for (const f of ["validate", "validated", "validating"]) assert.ok(forms.includes(f), f);
    assert.ok(!forms.includes("validates"), "not the word itself");
    for (const f of ["create", "created", "creating"]) assert.ok(inflections("creates").includes(f), f);
    assert.ok(inflections("vouchers").includes("voucher"));
    assert.ok(inflections("voucher").includes("vouchers"));
    assert.ok(inflections("stopped").includes("stop") === false, "a base under 5 letters is not used");
  });

  it("does not turn a word into a related word: validation and configuration stay apart", () => {
    assert.ok(!inflections("validates").includes("validation"));
    assert.ok(!inflections("configure").includes("configuration"));
    assert.ok(!inflections("validation").includes("validate"));
  });

  it("leaves short words, codes, names with underscores and words with digits alone", () => {
    for (const w of ["post", "type", "camt053", "customer_order", "ora-20110", "CAMT", "ifs", "a"]) assert.deepEqual(inflections(w), [], w);
  });

  const row = (id, text) => ({
    id, content: text, search_text: text, start_line: 1, end_line: 2, rank: 0.1,
    title: `T${id}`, doc_key: `doc${id}`, origin: "o", url: null, version: "", component: "", meta: {},
  });
  // the statistics query answers with the words that exist in the index and how many chunks have them
  const index = { validates: 232, validate: 14000, validated: 900, validating: 380, voucher: 300, accrul: 900, package: 9000, file: 9000, method: 9000, sql: 9000 };
  const database = () => ({
    async query(sql, params) {
      if (/knowledge_term_stats WHERE term = ANY/.test(sql)) {
        return { rows: params[0].filter((t) => index[t]).map((t) => ({ term: t, df: index[t], n: 250000 })) };
      }
      database.sql = sql;
      database.params = params;
      return { rows: [row(1, "procedure validate_voucher___ checks the voucher")] };
    },
  });

  it("scores with the forms of a word but chooses the candidates by the word itself", async () => {
    const db = database();
    const found = await searchKnowledge(db, "validates a voucher");
    const [candidates, , terms, frequencies, , wordForms] = database.params;
    // the candidates come from the words as typed: a common form cannot flood the search
    assert.equal(candidates, "validates | voucher");
    // every word is one entry with its forms; its weight counts the forms together
    const at = terms.indexOf("validates");
    assert.equal(wordForms[at], "validates | validate | validated | validating");
    assert.equal(frequencies[at], 232 + 14000 + 900 + 380);
    assert.equal(wordForms[terms.indexOf("voucher")], "voucher");
    assert.equal(found[0].title, "T1");
  });

  it("searches a word that is only in the index in another form through that form", async () => {
    const db = database();
    await searchKnowledge(db, "voucher validated again", { keywords: ["validatings"] });
    assert.match(database.params[0], /validatings|validating/);
  });

  it("leaves out the words that only say it is about code when the search is in the code alone", async () => {
    const db = database();
    await searchKnowledge(db, "Which PL/SQL package validates a voucher in accrul, and which file is it in?", { origin: "IFS source code" });
    assert.equal(database.params[0], "validates | voucher | accrul");
    assert.ok(!database.params[2].some((t) => ["package", "file", "sql", "pl"].includes(t)));
    // in a search of everything the words stay: they can be the topic ("install a package")
    await searchKnowledge(db, "Which package validates a voucher in accrul");
    assert.ok(database.params[2].includes("package"));
    // and when fewer than two words would be left, nothing is removed
    await searchKnowledge(db, "package file method", { origin: "IFS source code" });
    assert.ok(database.params[2].includes("package"));
  });

  it("can be switched off, and then searches the exact words as before", async () => {
    const db = database();
    await searchKnowledge(db, "which package validates a voucher", { stemming: false });
    assert.ok(database.params[5].every((q) => !q.includes(" | ")));
  });
});

describe("identifier splitting on very long text", () => {
  it("handles a very long run of letters and digits in linear time and still finds codes with punctuation", () => {
    // base64 inside an XML file: one run of 300,000 characters. The search for codes such as CAMT.053 used to retry
    // from every position of the run, which took minutes.
    const blob = "AbC1".repeat(75000);
    const started = Date.now();
    const words = splitIdentifiers(`${blob} and the code CAMT.053 or ORA-20110`);
    assert.ok(Date.now() - started < 2000, "took " + (Date.now() - started) + " ms");
    for (const w of ["camt", "053", "ora", "20110"]) assert.ok(words.split(" ").includes(w), w);
  });
});

describe("oversized chunks", () => {
  it("lowers the score of a chunk with far more words than a normal one, and leaves normal chunks alone", () => {
    const text = (words) => Array.from({ length: words }, (_, i) => `word${i}`).join(" ");
    const chunk = (words) => ({ content: text(words), search_text: text(words) });
    assert.equal(sizeFactor(chunk(85)), 1);
    assert.equal(sizeFactor(chunk(300)), 1);
    assert.equal(sizeFactor({}), 1, "a row without text is not touched");
    assert.ok(sizeFactor(chunk(1200)) > 0.45 && sizeFactor(chunk(1200)) < 0.55);
    assert.ok(sizeFactor(chunk(1600)) < sizeFactor(chunk(600)));
    // a long text with few different words (a table with repeated values) is not a chunk that matches by chance
    const repeated = "status open closed ".repeat(2000);
    assert.equal(sizeFactor({ content: repeated, search_text: repeated }), 1);
  });

  it("does not lower a page the question is about: half of the words of its title are asked", () => {
    const title = "List of Predefined Database Tasks in IFS Cloud";
    assert.equal(titleIsAsked(title, ["database", "tasks", "archive", "transaction", "rows"]), true);
    assert.equal(titleIsAsked(title, ["validates", "voucher", "accrul"]), false);
    assert.equal(titleIsAsked("IFS.ai Copilot", ["set", "copilot"]), true);
    assert.equal(titleIsAsked("IFS.ai Copilot", ["voucher"]), false);
    assert.equal(titleIsAsked("", ["voucher"]), false);
  });

  // words: how many different words the chunk has (a huge table has over a thousand)
  const row = (id, title, words, text) => ({
    id, content: `${text} ${Array.from({ length: words }, (_, i) => `filler${i}`).join(" ")}`, search_text: `${text} ${Array.from({ length: words }, (_, i) => `filler${i}`).join(" ")}`, start_line: 1, end_line: 2, rank: 0.1,
    title, doc_key: `doc${id}`, origin: "IFS documentation", url: "https://x/" + id, version: "", component: "", meta: {},
  });
  const index = { voucher: 300, accrul: 900 };
  const fake = (rows) => ({
    async query(sql, params) {
      if (/knowledge_term_stats WHERE term = ANY/.test(sql)) return { rows: params[0].filter((t) => index[t]).map((t) => ({ term: t, df: index[t], n: 250000 })) };
      return { rows };
    },
  });

  it("ranks a normal chunk above a huge one that holds the same words", async () => {
    const found = await searchKnowledge(fake([row(1, "List of Predefined Database Tasks", 1400, "voucher accrul"), row(2, "Voucher posting", 90, "voucher accrul")]), "voucher accrul");
    assert.deepEqual(found.map((f) => f.title), ["Voucher posting", "List of Predefined Database Tasks"]);
  });

  it("keeps the huge page first when the question is about it", async () => {
    const found = await searchKnowledge(fake([row(1, "Voucher Accrul Tasks", 1400, "voucher accrul"), row(2, "Posting", 90, "voucher accrul")]), "voucher accrul tasks");
    assert.equal(found[0].title, "Voucher Accrul Tasks");
  });
});

describe("ranking by how many of the words a chunk has", () => {
  const chunk = (id, doc, text, origin = "IFS source code") => ({
    id, content: text, search_text: text, start_line: id, end_line: id + 1, rank: 0.1,
    title: doc, doc_key: doc, origin, url: null, version: "", component: "", meta: {},
  });
  // "posts" is rare, "supplier" and "invoice" are common: by weight alone the rare word is worth more than both
  const index = { posts: 300, supplier: 10000, invoice: 12000 };
  const fake = (rows) => ({
    async query(sql, params) {
      if (/knowledge_term_stats WHERE term = ANY/.test(sql)) return { rows: params[0].filter((t) => index[t]).map((t) => ({ term: t, df: index[t], n: 250000 })) };
      return { rows };
    },
  });

  it("blends the weighted coverage with the share of the words that are present", () => {
    assert.equal(blendedCoverage(1, 1), 1);
    assert.equal(blendedCoverage(0, 0), 0);
    assert.ok(blendedCoverage(0.5, 1) > blendedCoverage(0.5, 0.33));
  });

  it("puts a chunk with two of the three words above one that only has the rare word", async () => {
    const rare = chunk(1, "DopCosting.plsql", "this procedure posts the cost");
    const both = chunk(2, "SendSupplierInvoice.plsql", "sends the supplier invoice to the financials");
    const found = await searchKnowledge(fake([rare, both]), "posts supplier invoice");
    assert.deepEqual(found.map((f) => f.title), ["SendSupplierInvoice.plsql", "DopCosting.plsql"]);
  });

  it("does not drop other documents when the few chunks that pass all belong to one document", async () => {
    // three chunks of one file pass the cut-off, but a file gives at most two results: the others must not be lost
    const rows = [
      chunk(1, "A.plsql", "posts supplier invoice"),
      chunk(2, "A.plsql", "posts supplier invoice again"),
      chunk(3, "A.plsql", "posts supplier invoice a third time"),
      chunk(4, "B.plsql", "the invoice"),
      chunk(5, "C.plsql", "the supplier"),
    ];
    const found = await searchKnowledge(fake(rows), "posts supplier invoice");
    assert.ok(found.length >= 3, "more than the two chunks of A.plsql");
    assert.ok(found.some((f) => f.title === "B.plsql") || found.some((f) => f.title === "C.plsql"));
  });

  it("lets source code count as much as the documentation for a question about code, and not otherwise", () => {
    const code = { origin: "IFS source code", meta: {} };
    const docs = { origin: "IFS documentation", meta: {} };
    const fields = { origin: "IFS source code", meta: { kind: "field descriptions" } };
    assert.equal(sourceWeight(code), 0);
    assert.equal(sourceWeight(docs), 4);
    assert.equal(sourceWeight(code, true), 4);
    assert.equal(sourceWeight(docs, true), 4);
    assert.equal(sourceWeight(fields, true), -2, "field description files stay at the bottom");
  });

  it("ranks code above a documentation page that has the same words when asked for code", async () => {
    const page = chunk(1, "Delivery Continuity Tools", "validates posts supplier invoice", "IFS documentation");
    const file = chunk(2, "VoucherHandling.plsvc", "validates posts supplier invoice");
    const score = (found, title) => found.find((f) => f.title === title).score;
    const normal = await searchKnowledge(fake([page, file]), "validates posts supplier invoice");
    assert.ok(score(normal, "Delivery Continuity Tools") > score(normal, "VoucherHandling.plsvc"), "the documentation has the lead by default");
    const forCode = await searchKnowledge(fake([page, file]), "validates posts supplier invoice", { preferCode: true });
    assert.equal(score(forCode, "VoucherHandling.plsvc"), score(forCode, "Delivery Continuity Tools"), "the code is as good as the page");
  });
});

describe("pages whose title is in the question", () => {
  const row = (id, doc, title, chunk = 0) => ({ id, doc_id: doc, chunk_index: chunk, content: "text " + id, start_line: 1, end_line: 5, title, doc_key: "k" + doc, origin: "IFS documentation", url: "https://x/" + doc, version: "IFS Cloud 25R2", component: null });
  const fakeDb = (pages) => ({
    calls: [],
    async query(sql, params) {
      this.calls.push({ sql, params });
      return { rows: /regexp_replace/.test(sql) ? pages : [] };
    },
  });

  it("asks nothing when there are no phrases at all", async () => {
    const db = fakeDb([]);
    assert.deepEqual(await findByTitle(db, [], { implicit: [] }), []);
    assert.equal(db.calls.length, 0);
  });

  it("takes only documentation pages with a title of two or more words, and compares titles without punctuation", async () => {
    const db = fakeDb([]);
    await findByTitle(db, [], { implicit: ["High Level Architecture"] });
    assert.deepEqual(db.calls[0].params[0], ["high level architecture"]);
    assert.match(db.calls[0].sql, /origin = 'IFS documentation'/);
    assert.match(db.calls[0].sql, /regexp_replace\(d\.title, '\[\^A-Za-z0-9\]\+', ' ', 'g'\)/);
    assert.match(db.calls[0].sql, />= 2/);
  });

  it("returns the first two chunks of at most two pages, as results with the top score", async () => {
    const db = fakeDb([row(1, 10, "High Level Architecture", 0), row(2, 10, "High Level Architecture", 1), row(3, 10, "High Level Architecture", 2), row(4, 11, "Logical Architecture"), row(5, 12, "Physical Architecture")]);
    const found = await findByTitle(db, [], { implicit: ["high level architecture", "logical architecture"] });
    assert.deepEqual(found.map((f) => f.title), ["High Level Architecture", "High Level Architecture", "Logical Architecture"]);
    assert.ok(found.every((f) => f.score === 100 && f.origin === "IFS documentation" && f.url));
  });

  it("keeps working with quoted titles only, as before", async () => {
    const db = fakeDb([]);
    await findByTitle(db, ["Start IFS Cloud Workflow using REST API"]);
    assert.equal(db.calls.length, 1);
    assert.deepEqual(db.calls[0].params[0], ["start ifs cloud workflow using rest api"]);
  });
});

describe("words that choose the candidates", () => {
  const freq = { customer: 90000, order: 80000, line: 70000, create: 60000, payee: 40 };
  const by = (t) => freq[t];

  it("keeps only the three rarest words, rarest first", () => {
    assert.deepEqual(candidateTerms(["customer", "order", "line", "create", "payee"], by), ["payee", "create", "line"]);
  });

  it("leaves a question with three words or fewer alone, in its own order", () => {
    assert.deepEqual(candidateTerms(["order", "payee", "line"], by), ["order", "payee", "line"]);
    assert.deepEqual(candidateTerms([], by), []);
  });

  it("does not change the list it is given", () => {
    const words = ["customer", "order", "line", "create"];
    candidateTerms(words, by);
    assert.deepEqual(words, ["customer", "order", "line", "create"]);
  });
});

describe("files named like the question", () => {
  const phrases = (q) => namePhrases(q).map((p) => p.phrase);

  it("turns neighbouring words into file names, longest first, with plurals made singular", () => {
    const p = phrases("Which method creates a customer order line?");
    assert.equal(p[0], "customerorderline");
    for (const x of ["customerorder", "orderline"]) assert.ok(p.includes(x), x);
    assert.ok(phrases("Which projection handles voucher types in accrul?").includes("vouchertype"));
  });

  it("lets a single long word name a file, but not a general word", () => {
    assert.ok(phrases("Which method creates a voucher?").includes("voucher"));
    assert.ok(!phrases("Which method creates a number?").includes("number"), "a general word names nothing");
    assert.ok(!phrases("Which method creates an item?").includes("item"), "a short word names nothing");
  });

  it("keeps code and work inside a name, but not 'source code' or the filler words", () => {
    assert.ok(phrases("Which package handles a currency code in the source code?").includes("currencycode"));
    assert.ok(phrases("Which tables are used for a work task?").includes("worktask"));
    assert.ok(!phrases("Which package is in the source code?").some((x) => x.includes("sourcecode") || x.includes("package")));
  });

  // a fake database that answers the file lookup and the chunk lookup
  const fakeNameDb = (files, chunks) => ({
    async query(sql, params) {
      fakeNameDb.calls.push({ sql, params });
      if (/FROM knowledge_documents d/.test(sql)) return { rows: files };
      return { rows: chunks };
    },
  });
  fakeNameDb.calls = [];
  const file = (id, title, version = "IFS Cloud 25R2") => ({ id, title, version, name: title.toLowerCase() });
  const chunk = (id, doc, title, rank) => ({ id, content: "x", start_line: id, end_line: id + 1, title, doc_key: doc, origin: "IFS source code", url: null, version: "IFS Cloud 25R2", component: "ORDER", rank });

  it("returns the best chunks of the files that match the name, at most two per file", async () => {
    const db = fakeNameDb([file(1, "CustomerOrderLine.plsql"), file(2, "CustomerOrderLineHandling.plsvc")], [chunk(10, "a/CustomerOrderLine.plsql", "CustomerOrderLine.plsql", 0.9), chunk(11, "a/CustomerOrderLine.plsql", "CustomerOrderLine.plsql", 0.8), chunk(12, "a/CustomerOrderLine.plsql", "CustomerOrderLine.plsql", 0.7), chunk(20, "a/CustomerOrderLineHandling.plsvc", "CustomerOrderLineHandling.plsvc", 0.6)]);
    const found = await findByName(db, "Which method creates a customer order line?", { limit: 4 });
    assert.deepEqual(found.map((f) => f.title), ["CustomerOrderLine.plsql", "CustomerOrderLine.plsql", "CustomerOrderLineHandling.plsvc"]);
    assert.ok(found.every((f) => f.origin === "IFS source code" && f.score > 50));
  });

  it("looks at package files for a question about a method and at model files when the question asks for them", async () => {
    const db = fakeNameDb([], []);
    await findByName(db, "Which method creates a customer order line?");
    assert.deepEqual(fakeNameDb.calls.at(-1).params[3], ["plsql", "plsvc", "views", "storage"]);
    await findByName(db, "Which projection handles customer order lines?");
    assert.ok(fakeNameDb.calls.at(-1).params[3].includes("projection"));
    assert.ok(!fakeNameDb.calls.at(-1).params[3].includes("plsql"));
  });

  it("returns nothing when no file has the name, and asks the database nothing when the question has no name", async () => {
    const none = fakeNameDb([], []);
    assert.deepEqual(await findByName(none, "Which method creates a customer order line?"), []);
    const before = fakeNameDb.calls.length;
    assert.deepEqual(await findByName(none, "Which method is used?"), []);
    assert.equal(fakeNameDb.calls.length, before, "no name, no query");
  });
});

describe("community topics", async () => {
  const { parseSitemap, parseTopicHtml, topicToDocument } = await import("../src/sources/community-source.js");
  const page = (accepted) => `<html><head>
    <script type="application/ld+json">{"@type":"BreadcrumbList","itemListElement":[{"name":"Community"},{"name":"IFS Solutions"},{"name":"Finance (Financials)"},{"name":"How to X"}]}</script>
    <script type="application/ld+json">{"@type":"QAPage","mainEntity":{"name":"How to X","dateCreated":"2025-09-18T15:38:09+00:00","answerCount":2,"acceptedAnswer":${accepted ? '{"url":"https://community.ifs.com/a/how-to-x-1?postid=22#post22"}' : "null"}}}</script>
    </head><body>
    <div id="topic1" class="qa-topic-first-post qa-topic-post-box"><div class="post__content"><p>Where do I set <code>X</code>?</p></div></div>
    <div id="post21" class="qa-topic-post-box"><time datetime="2025-09-19T08:00:00+00:00"></time><div class="post__content"><p>Try the page designer.</p></div></div>
    <div id="post22" class="qa-topic-post-box"><div class="post__content"><p>Steps:</p><ul><li>Open it</li><li>Save</li></ul></div></div>
  </body></html>`;

  it("reads the question, every reply and the category", () => {
    const rec = parseTopicHtml(page(true), "https://community.ifs.com/a/how-to-x-1");
    assert.equal(rec.title, "How to X");
    assert.equal(rec.category, "Finance (Financials)");
    assert.equal(rec.date, "2025-09-18");
    assert.equal(rec.question, "Where do I set `X`?");
    assert.equal(rec.replies.length, 2);
    assert.equal(rec.replies[0].date, "2025-09-19");
    assert.match(rec.replies[1].text, /- Open it\n- Save/);
  });

  it("marks the accepted answer, and says so when there is none", () => {
    const solved = parseTopicHtml(page(true), "u");
    assert.deepEqual(solved.replies.map((r) => r.accepted), [false, true]);
    assert.equal(solved.solved, true);
    assert.match(topicToDocument(solved).text, /### Reply 2 \(ACCEPTED ANSWER\)/);

    const open = parseTopicHtml(page(false), "u");
    assert.equal(open.solved, false);
    assert.match(topicToDocument(open).text, /Status: Not marked as solved/);
  });

  it("shows a post that the page repeats only once, and keeps the accepted copy", () => {
    const rec = {
      title: "T", category: "C", date: "2026-01-01", solved: true, question: "Q",
      replies: [
        { id: "1", text: "Try this.\n\nThen that.", accepted: false },
        { id: "2", text: "Other idea.", accepted: false },
        { id: "3", text: "Try this.\n\n\tThen that.", accepted: true },
      ],
    };
    const text = topicToDocument(rec).text;
    assert.equal((text.match(/Try this/g) ?? []).length, 1);
    assert.match(text, /### Reply 2 \(ACCEPTED ANSWER\)/);
    assert.match(text, /### Reply 1\n\nOther idea\./);
  });

  it("keeps a topic whose question has no text", () => {
    const html = page(false).replace("<p>Where do I set <code>X</code>?</p>", "");
    const rec = parseTopicHtml(html, "u");
    assert.match(rec.question, /no text/);
    assert.equal(rec.replies.length, 2);
  });

  it("returns nothing for a page that is not a topic and reads sitemaps", () => {
    assert.equal(parseTopicHtml("<html><body><p>hello</p></body></html>", "u"), null);
    const urls = parseSitemap("<urlset><url><loc>https://community.ifs.com/a-1</loc><lastmod>2026-01-02T00:00:00Z</lastmod></url></urlset>");
    assert.deepEqual(urls, [{ url: "https://community.ifs.com/a-1", lastmod: "2026-01-02T00:00:00Z" }]);
  });
});

describe("whole documents", () => {
  it("puts chunks back together without the lines they repeat", async () => {
    const rows = [
      { doc_key: "u1", start_line: 1, end_line: 4, content: "a\nb\nc\nd" },
      { doc_key: "u1", start_line: 3, end_line: 6, content: "c\nd\ne\nf" },
      { doc_key: "u2", start_line: 1, end_line: 2, content: "x\ny" },
    ];
    const db = { query: async () => ({ rows }) };
    const texts = await loadDocumentTexts(db, ["u1", "u2", "u1"]);
    assert.equal(texts.get("u1"), "a\nb\nc\nd\ne\nf");
    assert.equal(texts.get("u2"), "x\ny");
  });

  it("asks nothing when there are no documents", async () => {
    const db = { query: async () => assert.fail("no query expected") };
    assert.equal((await loadDocumentTexts(db, [])).size, 0);
  });
});

describe("codes with punctuation", () => {
  it("indexes the parts of CAMT.053 and ORA-20110 as plain words", () => {
    const words = splitIdentifiers("Error for CAMT.053 in 25R1: ORA-20110 raised in Customer_Order_API.Get_Objstate").split(" ");
    for (const w of ["camt", "053", "ora", "20110", "customer", "order", "objstate"]) assert.ok(words.includes(w), `missing ${w}`);
  });
});

describe("IFS technical documentation", async () => {
  const { groupPages, pageToDocument } = await import("../src/sources/ifs-docs-source.js");
  const index = {
    items: [
      { location: "", level: 1, title: "Home", text: "", path: ["Home"] },
      { location: "030_admin/010_security/", level: 1, title: "Security", text: "", path: ["Solution Manager User Guide", "Security"] },
      { location: "030_admin/010_security/#security", level: 1, title: "Security", text: "<p>Access is <code>role</code> based.</p>", path: ["Solution Manager User Guide", "Security"] },
      { location: "030_admin/010_security/#grants", level: 2, title: "Grants", text: "<ul><li>Projections</li><li>Lobbies</li></ul>", path: ["Solution Manager User Guide", "Security"] },
      { location: "empty/page/", level: 1, title: "Nothing here", text: "", path: ["X"] },
    ],
  };

  it("groups the sections of a page and drops pages without text", () => {
    const pages = groupPages(index);
    assert.equal(pages.length, 1);
    assert.equal(pages[0].sections.length, 2);
  });

  it("builds a document that links to the real page", () => {
    const doc = pageToDocument(groupPages(index)[0], "25R2");
    assert.equal(doc.url, "https://docs.ifs.com/techdocs/25r2/030_admin/010_security/");
    assert.equal(doc.version, "IFS Cloud 25R2");
    assert.equal(doc.component, "Solution Manager User Guide");
    assert.match(doc.text, /^# Security\n\nWhere: Solution Manager User Guide > Security\n\nAccess is `role` based\.\n\n### Grants\n\n- Projections\n- Lobbies$/);
  });
});

describe("guessed table names", async () => {
  const { guessIdentifiers } = await import("../src/search.js");

  it("guesses entity table names only when the question asks for a table, a view or a column", () => {
    const guesses = guessIdentifiers("which ifs cloud table can I find the work task information in?");
    assert.ok(guesses.includes("work_task"));
    assert.ok(guesses.includes("work_task_tab"));
    assert.deepEqual(guessIdentifiers("How do I fix the CAMT.053 error?"), []);
  });
});

describe("reading PowerPoint and Word files", async () => {
  const { strToU8, zipSync } = await import("fflate");
  const { extractDocx, extractPptx, extractFile } = await import("../src/extract-file.js");
  const slide = (...paragraphs) =>
    `<p:sld>${paragraphs.map((t) => `<a:p><a:r><a:t>${t}</a:t></a:r></a:p>`).join("")}</p:sld>`;

  it("reads slides in order, with their speaker notes, and decodes entities", () => {
    const zip = zipSync({
      "ppt/slides/slide2.xml": strToU8(slide("Second &amp; last")),
      "ppt/slides/slide1.xml": strToU8(slide("First slide", "Step one")),
      "ppt/notesSlides/notesSlide1.xml": strToU8(slide("Say this first", "1")),
    });
    const pages = extractPptx(zip);
    assert.equal(pages.length, 2);
    assert.equal(pages[0], "First slide\nStep one\nSpeaker notes:\nSay this first");
    assert.equal(pages[1], "Second & last");
  });

  it("reads Word paragraphs, tabs included", () => {
    const xml = "<w:document><w:p><w:r><w:t>Heading</w:t></w:r></w:p><w:p><w:r><w:t>A</w:t></w:r><w:tab/><w:r><w:t>B</w:t></w:r></w:p></w:document>";
    const pages = extractDocx(zipSync({ "word/document.xml": strToU8(xml) }));
    assert.deepEqual(pages, ["Heading\nA B"]);
  });

  it("picks the reader by the file name and refuses other types", async () => {
    await assert.rejects(() => extractFile("notes.txt", Buffer.from("x")), /no reader for \.txt/);
    const docx = zipSync({ "word/document.xml": strToU8("<w:p><w:t>Hello</w:t></w:p>") });
    const result = await extractFile("a.DOCX", Buffer.from(docx));
    assert.equal(result.kind, "Word");
  });
});

describe("pages saved from a browser", async () => {
  const { checksum, isValidRecord, pageToDocument, readRecords } = await import("../src/sources/ifs-pages-source.js");
  const rec = { url: "https://docs.ifs.com/policy/", title: "Policy", group: "Policies", text: "Line one.\n\nLine two." };
  const signed = { ...rec, h: checksum(rec) };

  it("accepts a page whose checksum matches and refuses an altered or foreign one", () => {
    assert.equal(isValidRecord(signed), true);
    assert.equal(isValidRecord({ ...signed, text: "Line one." }), false);
    assert.equal(isValidRecord({ ...signed, url: "https://example.com/policy/" }), false);
    assert.equal(isValidRecord({ ...signed, text: "" }), false);
  });

  it("reads every pages*.jsonl file, counts the refused lines and builds a document", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "pages-"));
    const other = { ...rec, url: "https://docs.ifs.com/pso/", title: "PSO" };
    await writeFile(path.join(dir, "pages.jsonl"), `${JSON.stringify(signed)}\nnot json\n`);
    await writeFile(path.join(dir, "pages-2.jsonl"), `${JSON.stringify({ ...other, h: checksum(other) })}\n${JSON.stringify({ ...signed, h: "wrong" })}\n`);
    await writeFile(path.join(dir, "notes.txt"), "ignored");
    const { records, rejected } = readRecords(dir);
    assert.equal(records.length, 2);
    assert.equal(rejected, 2);
    const doc = pageToDocument(records.find((r) => r.url.endsWith("/policy/")));
    assert.equal(doc.url, "https://docs.ifs.com/policy/");
    assert.equal(doc.text, "# Policy\n\nLine one.\n\nLine two.");
    assert.equal(doc.component, "Policies");
  });
});
