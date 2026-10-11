import assert from "node:assert/strict";
import { createServer } from "node:http";
import { describe, it } from "node:test";
import { buildCitations } from "../src/cite.js";
import { asksAboutCode, createRetriever, quotedPhrases, searchBoth, retrievalQuery, titleNgrams } from "../src/knowledge.js";
import { createRewriter, parseRewrite } from "../src/rewrite.js";
import { createApp } from "../src/server.js";

const passage = (n) => ({
  id: n,
  title: `File${n}.plsql`,
  path: `accrul/database/File${n}.plsql`,
  origin: "IFS source code",
  url: "",
  version: "ACCRUL Apps10 UPD29",
  startLine: 10 * n,
  endLine: 10 * n + 9,
  content: `code of passage ${n}`,
});

describe("citations", () => {
  const passages = [passage(1), passage(2), passage(3)];

  it("renumbers in order of first use and lists only the cited passages", () => {
    const r = buildCitations("It is set in the third file [3]. The second also does it [2][3].", passages);
    assert.equal(r.answer, "It is set in the third file [1]. The second also does it [2][1].");
    assert.deepEqual(r.sources.map((s) => s.title), ["File3.plsql", "File2.plsql"]);
    assert.equal(r.sources[0].startLine, 30);
  });

  it("removes markers that match no passage", () => {
    const r = buildCitations("Claim [7] and another [1, 9].", passages);
    assert.equal(r.answer, "Claim and another [1].");
    assert.equal(r.sources.length, 1);
  });

  it("leaves code alone", () => {
    const r = buildCitations("Use `arr[1]` here [2].\n```\nx[1] = 2;\n```", passages);
    assert.equal(r.answer, "Use `arr[1]` here [1].\n```\nx[1] = 2;\n```");
  });

  it("returns no sources when nothing is cited", () => {
    assert.deepEqual(buildCitations("Not found in the approved sources.", passages).sources, []);
  });
});

describe("retrieval", () => {
  it("adds the previous question to a very short follow-up", () => {
    const history = [{ role: "user", content: "How is currency amount calculated?" }, { role: "assistant", content: "..." }];
    assert.match(retrievalQuery("and the rate?", history), /currency amount/);
    assert.equal(retrievalQuery("How is the currency rate calculated?", history), "How is the currency rate calculated?");
  });

  it("numbers the passages and survives a database failure", async () => {
    const ok = createRetriever({ db: {}, search: async () => [{ title: "A", path: "a/A", origin: "IFS source code", url: null, component: "ACCRUL", version: "UPD29", startLine: 1, endLine: 5, content: "x" }] });
    const found = await ok("question about something");
    assert.equal(found.status, "ok");
    assert.equal(found.passages[0].id, 1);
    assert.equal(found.passages[0].version, "ACCRUL UPD29");

    const broken = createRetriever({ db: {}, search: async () => { throw new Error("connection refused"); } });
    const originalError = console.error;
    console.error = () => {};
    try {
      assert.deepEqual(await broken("question about something"), { status: "unavailable", passages: [] });
    } finally {
      console.error = originalError;
    }
  });
});

describe("question rewrite", () => {
  it("reads the keywords and tolerates a code fence", () => {
    assert.deepEqual(parseRewrite('{"language":"nl","keywords":["customer order","CUSTOMER_ORDER_API"]}'), {
      language: "nl",
      keywords: ["customer order", "CUSTOMER_ORDER_API"],
    });
    const fenced = '```json\n{"language":"fr","keywords":[" a ",1,""]}\n```';
    assert.deepEqual(parseRewrite(fenced), { language: "en", keywords: ["a"] });
  });

  it("rejects anything that is not usable", () => {
    for (const bad of ["", "sorry", '{"keywords":"x"}', '{"keywords":[]}', "{not json}"]) assert.equal(parseRewrite(bad), null);
  });

  it("calls the Anthropic API with the rules and returns the keywords", async () => {
    let sent;
    const fetchImpl = async (url, init) => {
      sent = { url, headers: init.headers, body: JSON.parse(init.body) };
      return new Response(JSON.stringify({ content: [{ type: "text", text: '{"language":"nl","keywords":["customer order","delivery"]}' }] }), { status: 200 });
    };
    const result = await createRewriter({ apiKey: "k", fetchImpl })("klantorder levering");
    assert.deepEqual(result, { language: "nl", keywords: ["customer order", "delivery"] });
    assert.equal(sent.headers["x-api-key"], "k");
    assert.match(sent.body.model, /haiku/);
    assert.match(sent.body.system, /Expand abbreviations/);
    assert.equal(sent.body.messages[0].content, "klantorder levering");
  });

  it("returns null instead of throwing when the API fails", async () => {
    const originalError = console.error;
    console.error = () => {};
    try {
      const down = createRewriter({ apiKey: "k", fetchImpl: async () => new Response("no", { status: 500 }) });
      assert.equal(await down("question"), null);
      const broken = createRewriter({ apiKey: "k", fetchImpl: async () => { throw new Error("offline"); } });
      assert.equal(await broken("question"), null);
    } finally {
      console.error = originalError;
    }
  });

  it("searches the question as typed and with the keywords when there are some", async () => {
    const calls = [];
    const search = async (db, query, options) => {
      calls.push({ query, keywords: options.keywords });
      return [];
    };
    await createRetriever({ db: {}, search, rewrite: async () => ({ language: "nl", keywords: ["customer order"] }) })("klantorder status");
    await createRetriever({ db: {}, search, rewrite: async () => null })("klantorder status");
    await createRetriever({ db: {}, search })("klantorder status");
    assert.deepEqual(calls.map((c) => c.keywords), [undefined, ["customer order"], undefined, undefined]);
    assert.equal(calls[1].query, "klantorder status");
  });
});

describe("off-topic follow-up", () => {
  it("does not borrow the previous question for a short off-topic question", async () => {
    let searched = 0;
    const search = async () => (searched++, []);
    const rewrite = async (q) => ({ keywords: ["x"], offTopic: q === "what is 2+2" });
    const retrieve = createRetriever({ db: {}, search, rewrite });
    const history = [{ role: "user", content: "explain me about admin studio" }];
    assert.deepEqual(await retrieve("what is 2+2", history), { status: "ok", passages: [] });
    assert.equal(searched, 0);
    await retrieve("and the second step?", history);
    assert.ok(searched > 0);
  });
});

describe("phrases of the question that may be a page title", () => {
  it("turns hyphens and punctuation into spaces and offers groups of two to five words", () => {
    const p = titleNgrams("What is the high-level architecture of IFS Cloud, and what are the main layers or tiers?");
    assert.ok(p.includes("high level architecture"));
    assert.ok(p.includes("architecture of ifs cloud"));
    assert.ok(p.includes("main layers or tiers"), "a group inside the question is offered when it starts and ends on real words");
    assert.ok(!p.includes("architecture of"), "a group that ends on a filler word is not offered");
    assert.ok(!p.includes("of ifs cloud"), "a group that starts with a filler word is not offered");
  });

  it("offers nothing that starts or ends with a filler word, nor anything shorter than 8 characters", () => {
    for (const phrase of titleNgrams("how do I set up the IFS.ai Copilot in a test")) {
      const words = phrase.split(" ");
      assert.ok(!["a", "an", "the", "of", "to", "in", "how", "do", "i"].includes(words[0]), phrase);
      assert.ok(!["a", "an", "the", "of", "to", "in", "how", "do", "i"].includes(words.at(-1)), phrase);
      assert.ok(phrase.length >= 8, phrase);
    }
    assert.deepEqual(titleNgrams("hi"), []);
  });

  it("gives the phrases to the title lookup next to the quoted ones, without changing the quoted ones", async () => {
    let args = null;
    const findTitles = async (db, quoted, options) => ((args = { quoted, options }), []);
    await searchBoth(async () => [], {}, 'explain "Start IFS Cloud Workflow using REST API" and the high-level architecture', 12, null, findTitles);
    assert.deepEqual(args.quoted, ["Start IFS Cloud Workflow using REST API"]);
    assert.ok(args.options.implicit.includes("high level architecture"));
  });

  it("puts a page whose title is in the question first", async () => {
    const page = { ref: "p1", title: "High Level Architecture", path: "p", origin: "IFS documentation", startLine: 1, content: "x" };
    const other = { ref: "o1", title: "Logical Architecture", path: "o", origin: "IFS documentation", startLine: 1, content: "y" };
    const out = await searchBoth(async () => [other], {}, "high-level architecture of IFS Cloud", 12, null, async () => [page]);
    assert.deepEqual(out.map((r) => r.ref), ["p1", "o1"]);
  });
});

describe("named files in the merge", () => {
  const r = (ref) => ({ ref, path: ref, startLine: 1, content: ref });
  const search = async (db, q, o) => (o.origin ? [r("c1"), r("c2"), r("c3")] : [r("e1"), r("e2"), r("e3")]);
  const names = async () => [r("n1"), r("n2")];

  it("weaves the named files in behind the best results of the code search, for a question about code", async () => {
    const out = await searchBoth(search, {}, "Which method creates a customer order line?", 12, null, null, names);
    assert.deepEqual(out.map((x) => x.ref).slice(0, 4), ["c1", "n1", "e1", "c2"]);
    assert.ok(out.some((x) => x.ref === "n2"));
  });

  it("does not look for named files when the question is not about code", async () => {
    let asked = 0;
    const out = await searchBoth(search, {}, "How do I create a customer order line?", 12, null, null, async () => (asked++, [r("n1")]));
    assert.equal(asked, 0);
    assert.ok(!out.some((x) => x.ref === "n1"));
  });

  it("still works without a lookup of names", async () => {
    const out = await searchBoth(search, {}, "Which method creates a customer order line?", 12, null, null, null);
    assert.deepEqual(out.map((x) => x.ref).slice(0, 3), ["c1", "e1", "c2"]);
  });
});

describe("search merge", () => {
  it("searches the code alone when the question is about code", async () => {
    assert.ok(asksAboutCode("How does the voucher handling work in the ACCRUL source code?"));
    assert.ok(asksAboutCode("Show me the PL/SQL that validates a voucher, and which file it is in."));
    assert.ok(!asksAboutCode("How do I post a voucher in IFS Cloud?"));
    // naming the kind of model file asks for code; talking about projections in general does not
    assert.ok(asksAboutCode("Which projection handles voucher types in accrul?"));
    assert.ok(asksAboutCode("What entity defines the voucher row?"));
    assert.ok(!asksAboutCode("How do I grant access to a projection?"));
    assert.ok(!asksAboutCode("What is a projection in Aurena?"));
    const origins = [];
    const search = async (db, q, o) => (origins.push(o.origin ?? null), []);
    await searchBoth(search, {}, "Which files and methods are involved?", 4, null);
    await searchBoth(search, {}, "How do I post a voucher?", 4, null);
    assert.deepEqual(origins, [null, "IFS source code", null]);
  });

  it("puts a document whose title is quoted in the question first", async () => {
    assert.deepEqual(quotedPhrases('explain about "Start IFS Cloud Workflow using REST API" and “x”'), ["Start IFS Cloud Workflow using REST API"]);
    const titled = { ref: "t", path: "blog", startLine: 1, content: "" };
    const search = async () => [{ ref: "a", path: "a", startLine: 1, content: "" }];
    const findTitles = async (db, phrases) => (phrases.length ? [titled] : []);
    const out = await searchBoth(search, {}, 'explain "Some Exact Title"', 4, null, findTitles);
    assert.deepEqual(out.map((x) => x.ref), ["t", "a"]);
  });

  it("takes the results of the question and of the keywords in turn, without repeats", async () => {
    const r = (path, startLine = 1) => ({ path, startLine });
    const search = async (db, query, { keywords }) => (keywords ? [r("b"), r("a"), r("c")] : [r("a"), r("d")]);
    const out = await searchBoth(search, {}, "q", 4, ["x"]);
    assert.deepEqual(out.map((x) => x.path), ["a", "b", "d", "c"]);
    assert.deepEqual((await searchBoth(search, {}, "q", 4, null)).map((x) => x.path), ["a", "d"]);
  });
});

describe("chat with the knowledge base", () => {
  it("sends the passages to the agent and returns numbered sources", async () => {
    let received;
    const n8n = createServer(async (req, res) => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      received = JSON.parse(Buffer.concat(chunks).toString());
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ answer: "The amount is negated [2].", sources: [], tier: "lite" }));
    });
    await new Promise((r) => n8n.listen(0, "127.0.0.1", r));
    const retrieve = async () => ({ status: "ok", passages: [passage(1), passage(2)] });
    const api = createApp({ n8nChatUrl: `http://127.0.0.1:${n8n.address().port}/x`, retrieve });
    await new Promise((r) => api.listen(0, "127.0.0.1", r));

    const res = await fetch(`http://127.0.0.1:${api.address().port}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "How is the currency amount set?" }),
    });
    const body = await res.json();
    await Promise.all([api, n8n].map((s) => new Promise((r) => s.close(r))));

    assert.equal(received.knowledge, "ok");
    assert.equal(received.passages.length, 2);
    assert.equal(body.answer, "The amount is negated [1].");
    assert.deepEqual(body.sources.map((s) => s.title), ["File2.plsql"]);
  });
});

describe("questions that are not about IFS", () => {
  it("reads the off-topic flag and keeps the normal result unchanged", () => {
    assert.deepEqual(parseRewrite('{"language":"en","ifs_related":false,"keywords":["addition"]}'), { language: "en", keywords: ["addition"], offTopic: true });
    assert.deepEqual(parseRewrite('{"language":"en","ifs_related":false,"keywords":[]}'), { language: "en", keywords: [], offTopic: true });
    assert.deepEqual(parseRewrite('{"language":"en","ifs_related":true,"keywords":["voucher"]}'), { language: "en", keywords: ["voucher"] });
  });

  it("searches nothing for an off-topic question, so no passages reach the agent", async () => {
    let searched = false;
    const retrieve = createRetriever({
      db: {},
      search: async () => {
        searched = true;
        return [];
      },
      rewrite: async () => ({ language: "en", keywords: ["addition"], offTopic: true }),
    });
    assert.deepEqual(await retrieve("What is 2 + 2?"), { status: "ok", passages: [] });
    assert.equal(searched, false);
  });
});

describe("whole topics for the agent", () => {
  const hit = (path, url, content) => ({ title: path, path, origin: url ? "IFS community" : "IFS source code", url, component: "", version: "", startLine: 5, endLine: 9, content });

  it("sends a community topic in full, once, and keeps code as the piece that matched", async () => {
    const found = [
      hit("https://community.ifs.com/a-1", "https://community.ifs.com/a-1", "piece one"),
      hit("accrul/File.plsql", null, "code piece"),
      hit("https://community.ifs.com/a-1", "https://community.ifs.com/a-1", "piece two"),
    ];
    const asked = [];
    const retrieve = createRetriever({
      db: {},
      search: async () => found,
      loadFull: async (_db, keys) => {
        asked.push(...keys);
        return new Map([["https://community.ifs.com/a-1", "# Topic\n\nQuestion\n\nReply 1 (ACCEPTED ANSWER)\n\nDo this."]]);
      },
    });
    const { status, passages } = await retrieve("how do I do this thing");
    assert.equal(status, "ok");
    assert.deepEqual(asked, ["https://community.ifs.com/a-1", "https://community.ifs.com/a-1"]);
    assert.equal(passages.length, 2);
    assert.match(passages[0].content, /ACCEPTED ANSWER/);
    assert.equal(passages[0].startLine, 1);
    assert.equal(passages[0].endLine, 7);
    assert.equal(passages[1].content, "code piece");
    assert.deepEqual(passages.map((p) => p.id), [1, 2]);
  });

  it("stops adding passages when the size budget is used up", async () => {
    const big = "x".repeat(16000);
    const found = Array.from({ length: 14 }, (_, i) => hit(`https://community.ifs.com/t-${i}`, `https://community.ifs.com/t-${i}`, "p"));
    const retrieve = createRetriever({ db: {}, search: async () => found, loadFull: async (_db, keys) => new Map(keys.map((k) => [k, big])) });
    const { passages } = await retrieve("a long enough question here");
    const total = passages.reduce((n, p) => n + p.content.length, 0);
    assert.ok(total <= 150000, `sent ${total} characters`);
    assert.ok(passages.length >= 9 && passages.length < 14);
  });
});

describe("citation repair", async () => {
  const { repairCitations } = await import("../src/cite.js");
  const passages = [
    { id: 1, title: "Data Synchronization Development", content: "The entity JtTaskStep uses Work_Task_API.Get_Rowtype(:TASK_SEQ) to find the type of a work task." },
    { id: 2, title: "Enabling Time Zone", content: "Operational reports can show times in the time zone of the site." },
    { id: 3, title: "When updating to 25R2 the order delivery fails", content: "The script POST_Wrktsk_2510_UpgradeCmpuntExecutionToWorkList runs UPDATE work_task_tab and joins cmpunt_work_list_tab through task_seq." },
  ];

  it("moves a marker to the passage that holds the facts of the sentence", () => {
    const wrong = "The upgrade script POST_Wrktsk_2510_UpgradeCmpuntExecutionToWorkList updates work_task_tab and joins cmpunt_work_list_tab through task_seq [1].";
    const { answer, repaired } = repairCitations(wrong, passages);
    assert.equal(repaired, 1);
    assert.match(answer, /task_seq \[3\]\.$/);
  });

  it("leaves a correct marker, a weak sentence and code alone", () => {
    const right = "The entity JtTaskStep uses Work_Task_API.Get_Rowtype to find the type of a work task [1].";
    assert.equal(repairCitations(right, passages).repaired, 0);
    assert.equal(repairCitations("It works [2].", passages).repaired, 0);
    const code = "Use `x[1]` here and nothing else matches this sentence about bakeries and ovens [1].";
    assert.equal(repairCitations(code, passages).answer, code);
  });

  it("repairs each line of a list on its own", () => {
    const text = "- The entity JtTaskStep uses Work_Task_API.Get_Rowtype to find the type of a work task [1].\n- The script POST_Wrktsk_2510_UpgradeCmpuntExecutionToWorkList updates work_task_tab through task_seq [1].";
    const { answer, repaired } = repairCitations(text, passages);
    assert.equal(repaired, 1);
    assert.match(answer, /\[1\]\.\n- .*\[3\]\.$/);
  });
});

describe("citation of identifiers that no passage contains", async () => {
  const { repairCitations } = await import("../src/cite.js");
  const passages = [{ id: 1, title: "Security", content: "Permission sets control access to projections and lobbies." }];

  it("removes the marker when several named identifiers appear in no passage", () => {
    const { answer, unverified } = repairCitations("The table work_task_tab has the column task_seq and links to cmpunt_work_list_tab [1].", passages);
    assert.equal(unverified, 1);
    assert.equal(answer, "The table work_task_tab has the column task_seq and links to cmpunt_work_list_tab.");
  });

  it("keeps the marker when the identifiers are in the cited passage or there is only one", () => {
    const p = [{ id: 1, title: "Tables", content: "The table work_task_tab has the column task_seq." }];
    assert.equal(repairCitations("The table work_task_tab has the column task_seq [1].", p).unverified, 0);
    assert.equal(repairCitations("The table work_task_tab holds the data [1].", passages).unverified, 0);
  });
});

describe("one source per web page", async () => {
  const { buildCitations } = await import("../src/cite.js");
  const make = (n, url, lines) => ({ id: n, title: `T${n}`, path: url || `file${n}`, origin: "x", url, startLine: lines, endLine: lines + 5, content: "c" });

  it("lists two passages of the same page once", () => {
    const passages = [make(1, "https://community.ifs.com/a-1", 1), make(2, "https://community.ifs.com/b-2", 1), make(3, "https://community.ifs.com/a-1", 40)];
    const r = buildCitations("First [1]. Second [2]. Third [3]. Together [1, 3].", passages);
    assert.equal(r.sources.length, 2);
    assert.equal(r.answer, "First [1]. Second [2]. Third [1]. Together [1].");
  });

  it("keeps passages of one code file separate: they are different lines", () => {
    const passages = [make(1, "", 1), make(2, "", 90)];
    assert.equal(buildCitations("A [1]. B [2].", passages).sources.length, 2);
  });
});

describe("long documents", () => {
  it("sends the part around the match of a long guide, not its beginning", async () => {
    const lines = Array.from({ length: 4000 }, (_, i) => `line ${i + 1} of the guide`);
    const guide = lines.join("\n"); // far longer than one passage
    const retrieve = createRetriever({
      db: {},
      search: async () => [{ title: "Guide", path: "https://docs.ifs.com/g.pdf", origin: "IFS documentation", url: "https://docs.ifs.com/g.pdf", component: "", version: "PDF", startLine: 3000, endLine: 3010, content: "match" }],
      loadFull: async () => new Map([["https://docs.ifs.com/g.pdf", guide]]),
    });
    const { passages } = await retrieve("a question about the guide please");
    assert.equal(passages.length, 1);
    assert.ok(passages[0].startLine >= 2990 && passages[0].startLine <= 3000, `starts at ${passages[0].startLine}`);
    assert.ok(passages[0].content.includes("line 3000 of the guide"));
    assert.ok(!passages[0].content.includes("line 1 of the guide"));
    assert.ok(passages[0].content.length <= 16000);
  });

  it("includes a second match of the same long guide only when it is a different part", async () => {
    const guide = Array.from({ length: 4000 }, (_, i) => `line ${i + 1} of the guide`).join("\n");
    const hit = (startLine) => ({ title: "Guide", path: "u", origin: "IFS documentation", url: "u", component: "", version: "PDF", startLine, endLine: startLine + 5, content: "m" });
    const retrieve = createRetriever({ db: {}, search: async () => [hit(100), hit(120), hit(3500)], loadFull: async () => new Map([["u", guide]]) });
    const { passages } = await retrieve("a question about the guide please");
    assert.deepEqual(passages.map((p) => p.startLine > 3400), [false, true]); // 120 lies in the first part
  });
});
