// Topics of the IFS Community (community.ifs.com): the question and every reply, with the accepted
// answer marked. The pages are public, so they are read directly; `parseTopicHtml` turns one page
// into a record, `topicToDocument` turns a record into the text that is searched.
import * as cheerio from "cheerio";
import { htmlToText } from "../html-to-text.js";

export const SOURCE_ID = "ifs-community";
export const ORIGIN = "IFS community";
export const SITE = "https://community.ifs.com";

// A topic page: { url, title, category, section, date, answerCount, solved, question, replies: [...] }
// or null when the page is not a topic. replies[]: { id, date, accepted, text }
export function parseTopicHtml(html, url) {
  const $ = cheerio.load(html);
  const jsonld = (type) =>
    $('script[type="application/ld+json"]')
      .toArray()
      .map((s) => {
        try {
          return JSON.parse($(s).text());
        } catch {
          return null;
        }
      })
      .find((j) => j?.["@type"] === type);

  const qa = jsonld("QAPage")?.mainEntity;
  const crumbs = (jsonld("BreadcrumbList")?.itemListElement ?? []).map((c) => c.name);
  const title = clean(qa?.name || $("h1").first().text());
  if (!title) return null;

  const content = (el) => htmlToText($(el).find(".post__content").first().html() ?? "");
  // some questions are only a screenshot or an attachment: the title and the replies still carry the content
  const question = content($(".qa-topic-first-post").first()) || "(The question has no text: it was posted as an image or an attachment only.)";

  const acceptedId = (qa?.acceptedAnswer?.url?.match(/postid=(\d+)/) ?? [])[1] ?? null;
  const replies = [];
  const firstBoxId = $(".qa-topic-post-box").first().attr("id");
  $(".qa-topic-post-box").each((_, el) => {
    const box = $(el);
    const id = (box.attr("id") ?? "").replace(/^post/, "");
    if (box.attr("id") === firstBoxId || !/^\d+$/.test(id)) return; // the first box is the question itself
    const accepted = id === acceptedId;
    // a reply that is only an image is skipped, unless it is the accepted answer: that fact must stay visible
    const text = content(el) || (accepted ? "(The accepted answer has no text: it was posted as an image or an attachment only.)" : "");
    if (!text) return;
    replies.push({
      id,
      date: box.find("time[datetime]").first().attr("datetime")?.slice(0, 10) ?? "",
      accepted,
      text,
    });
  });

  // the accepted answer is sometimes shown only in the "Best answer" box of the question, not in the reply list
  if (acceptedId && !replies.some((r) => r.accepted)) {
    const text = htmlToText($(".qa-topic-first-post .best-answer-reply__content").first().html() ?? "");
    if (text) replies.unshift({ id: acceptedId, date: "", accepted: true, text });
  }

  return {
    url,
    title,
    category: crumbs.length >= 3 ? crumbs[crumbs.length - 2] : "",
    section: crumbs.length >= 4 ? crumbs[crumbs.length - 3] : "",
    date: String(qa?.dateCreated ?? "").slice(0, 10),
    answerCount: Number(qa?.answerCount ?? replies.length),
    solved: Boolean(acceptedId),
    question,
    replies,
  };
}

function clean(s) {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}

// One topic as a document: { docKey, url, title, version, component, text, meta }
export function topicToDocument(rec) {
  const year = String(rec.date ?? "").slice(0, 4);
  const status = rec.solved ? "Solved (has an accepted answer)" : rec.replies.length ? "Not marked as solved" : "No replies yet";
  const parts = [
    `# ${rec.title}`,
    [rec.category && `Category: ${rec.category}`, `Status: ${status}`, rec.date && `Posted: ${rec.date}`].filter(Boolean).join("\n"),
    `## Question\n\n${rec.question}`,
  ];
  // the page sometimes shows the same post twice (identical apart from spacing): keep one, and keep the accepted one
  const seen = new Map();
  rec.replies.forEach((r, i) => {
    const key = r.text.replace(/\s+/g, " ").trim();
    const at = seen.get(key);
    if (at === undefined) seen.set(key, i);
    else if (r.accepted) seen.set(key, i);
  });
  const replies = rec.replies.filter((r, i) => seen.get(r.text.replace(/\s+/g, " ").trim()) === i);
  if (replies.length > 0) {
    parts.push("## Replies");
    replies.forEach((r, i) => {
      const label = r.accepted ? `Reply ${i + 1} (ACCEPTED ANSWER)` : `Reply ${i + 1}`;
      parts.push(`### ${label}${r.date ? ` - ${r.date}` : ""}\n\n${r.text}`);
    });
  }
  return {
    docKey: rec.url,
    url: rec.url,
    title: rec.title,
    version: year ? `community ${year}` : "community",
    component: rec.category ?? "",
    text: parts.join("\n\n"),
    meta: { date: rec.date, category: rec.category, section: rec.section, solved: rec.solved, replies: replies.length, lastmod: rec.lastmod },
  };
}

// <loc> and <lastmod> of every <url> in a sitemap
export function parseSitemap(xml) {
  const out = [];
  for (const m of xml.matchAll(/<url>([\s\S]*?)<\/url>/g)) {
    const loc = m[1].match(/<loc>(.*?)<\/loc>/)?.[1];
    if (loc) out.push({ url: loc.trim(), lastmod: m[1].match(/<lastmod>(.*?)<\/lastmod>/)?.[1] ?? "" });
  }
  return out;
}
