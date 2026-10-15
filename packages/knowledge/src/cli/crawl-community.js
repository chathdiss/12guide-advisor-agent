// Reads the public topics of the IFS Community and saves them as JSON lines on disk.
//
//   npm run crawl:community -- --out D:\Gotli\advisor-knowledge\ifs-community-full
//   options: --limit 50   --category finance-financials-42   --concurrency 2   --delay 800
//
// It reads the sitemap, skips topics that are already saved and unchanged (by lastmod), waits between
// requests, and can be stopped (Ctrl+C) and started again at any time: it continues where it was.
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { parseSitemap, parseTopicHtml, SITE } from "../sources/community-source.js";

const argv = process.argv.slice(2);
const opt = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const out = opt("--out");
if (!out) {
  console.error("Give the folder with --out <path>.");
  process.exit(1);
}
const limit = Number(opt("--limit", Infinity));
const category = opt("--category", "");
const concurrency = Number(opt("--concurrency", 2));
const delayMs = Number(opt("--delay", 800));
const SHARD_SIZE = 500;
const UA = "Mozilla/5.0 (compatible; AdvisorKnowledgeBot/0.1; internal research)";

mkdirSync(out, { recursive: true });
const donePath = path.join(out, "done.jsonl");
const errorPath = path.join(out, "errors.jsonl");

// what is saved already: url -> lastmod
const done = new Map();
if (existsSync(donePath)) {
  for (const line of readFileSync(donePath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const { url, lastmod } = JSON.parse(line);
    done.set(url, lastmod);
  }
}
let shardNo = readdirSync(out).filter((f) => /^topics-\d+\.jsonl$/.test(f)).length;
let shardCount = SHARD_SIZE; // the next record starts a new shard
function save(rec) {
  if (shardCount >= SHARD_SIZE) {
    shardNo++;
    shardCount = 0;
  }
  appendFileSync(path.join(out, `topics-${String(shardNo).padStart(4, "0")}.jsonl`), JSON.stringify(rec) + "\n");
  shardCount++;
  appendFileSync(donePath, JSON.stringify({ url: rec.url, lastmod: rec.lastmod }) + "\n");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(url, tries = 4) {
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html,application/xml" }, signal: AbortSignal.timeout(45_000) });
      if (res.status === 429 || res.status === 403) return { status: res.status };
      if (res.status >= 500) throw new Error(`HTTP ${res.status}`);
      return { status: res.status, text: await res.text() };
    } catch (err) {
      if (attempt === tries) return { status: 0, error: String(err.message ?? err) };
      await sleep(2000 * attempt);
    }
  }
}

// 429 means "slow down": wait and ask again. A 403 on one page is that page being refused (a firewall
// rule), so it is tried once more and then skipped; only five refusals in a row, on different pages,
// mean that the site is blocking the reader (see the worker below).
async function getPolite(url) {
  let res = await get(url);
  for (let attempt = 1; (res.status === 429 || res.status === 403) && attempt <= 2; attempt++) {
    await sleep(res.status === 429 ? 60_000 * attempt : 10_000);
    res = await get(url);
  }
  return res;
}

const sitemap = await get(`${SITE}/sitemap-topics-1.xml`);
if (!sitemap.text) {
  console.error("Could not read the sitemap:", sitemap.status, sitemap.error ?? "");
  process.exit(1);
}
let todo = parseSitemap(sitemap.text).filter((t) => (!category || t.url.includes(`/${category}/`)) && done.get(t.url) !== t.lastmod);
const total = todo.length;
todo = todo.slice(0, limit);
console.log(`sitemap: ${total} topics to read${category ? ` in ${category}` : ""}, ${done.size} already saved; reading ${todo.length} now`);

let next = 0;
let saved = 0;
let skipped = 0;
let blocked = 0; // set to 5 when the site keeps refusing: the workers stop
let refused = 0; // refusals in a row
let stop = false;
process.on("SIGINT", () => {
  console.log("\nstopping after the current pages ...");
  stop = true;
});
const started = Date.now();

async function worker() {
  while (!stop && blocked < 5) {
    const i = next++;
    if (i >= todo.length) return;
    const { url, lastmod } = todo[i];
    const res = await getPolite(url);
    if (res.status === 429 || res.status === 403) {
      refused++;
      skipped++;
      appendFileSync(errorPath, JSON.stringify({ url, status: res.status, note: "refused by the site" }) + "\n");
      if (refused >= 5) {
        blocked = 5;
        console.warn("  five pages in a row were refused: stopping, try again later");
      }
      await sleep(delayMs);
      continue;
    }
    refused = 0;
    if (!res.text || res.status !== 200) {
      appendFileSync(errorPath, JSON.stringify({ url, status: res.status, error: res.error ?? "" }) + "\n");
      skipped++;
    } else {
      const rec = parseTopicHtml(res.text, url);
      if (rec) {
        // a long topic is split in pages of 25 posts (url/index2.html, index3.html, ...): read the others too
        const seenReplies = new Set(rec.replies.map((r) => r.id));
        for (let page = 2; rec.replies.length < rec.answerCount && page <= 60; page++) {
          await sleep(delayMs);
          const more = await getPolite(`${url}/index${page}.html`);
          const next = more.text ? parseTopicHtml(more.text, url) : null;
          const fresh = (next?.replies ?? []).filter((r) => !seenReplies.has(r.id));
          if (fresh.length === 0) break;
          fresh.forEach((r) => seenReplies.add(r.id));
          rec.replies.push(...fresh);
        }
        save({ ...rec, lastmod });
        saved++;
        if (rec.replies.length < Math.min(rec.answerCount, 200) - 1) {
          appendFileSync(errorPath, JSON.stringify({ url, note: `fewer replies read (${rec.replies.length}) than the topic reports (${rec.answerCount})` }) + "\n");
        }
      } else {
        appendFileSync(errorPath, JSON.stringify({ url, status: res.status, note: "not a topic page" }) + "\n");
        skipped++;
      }
    }
    if ((saved + skipped) % 100 === 0) {
      const mins = (Date.now() - started) / 60000;
      const rate = (saved + skipped) / mins;
      console.log(`  ${saved + skipped}/${todo.length} read (${saved} saved, ${skipped} skipped), ${rate.toFixed(0)}/min, about ${((todo.length - saved - skipped) / rate / 60).toFixed(1)} h left`);
    }
    await sleep(delayMs);
  }
}

await Promise.all(Array.from({ length: concurrency }, worker));
console.log(`\nfinished: ${saved} saved, ${skipped} skipped${blocked >= 5 ? " (stopped: the site kept refusing, try again later)" : ""}, in ${((Date.now() - started) / 60000).toFixed(1)} min`);
