// The IFS blog posts of dsj23.me, read through the public WordPress.com API (robots.txt of the blog
// points crawlers to WordPress's own API and forbids only its /public.api/ path on the blog itself).
import { htmlToText } from "../html-to-text.js";

export const SOURCE_ID = "dsj23-blog";
export const ORIGIN = "IFS technical blog";
const API = "https://public-api.wordpress.com/rest/v1.1/sites/dsj23.me/posts/";
const PAGE = 100;

// Posts about IFS: tagged IFS, or IFS in the title. The blog also has travel and photography.
export function isIfsPost(post) {
  const tags = Object.keys(post.tags ?? {});
  return tags.some((t) => /^ifs\b/i.test(t)) || /\bIFS\b/i.test(post.title ?? "");
}

export async function fetchPosts({ fetchImpl = fetch, pause = 300 } = {}) {
  const posts = [];
  for (let offset = 0; ; offset += PAGE) {
    const url = `${API}?number=${PAGE}&offset=${offset}&type=post&status=publish&fields=ID,URL,title,date,modified,tags,content`;
    const res = await fetchImpl(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`WordPress API answered ${res.status}`);
    const data = await res.json();
    posts.push(...(data.posts ?? []));
    if (!data.posts || data.posts.length < PAGE) break;
    await new Promise((r) => setTimeout(r, pause)); // be gentle
  }
  return posts;
}

// One post as a document: { docKey, url, title, text, version, meta }
export function postToDocument(post) {
  const title = htmlToText(post.title ?? "").replace(/\s+/g, " ") || "Untitled";
  const year = String(post.date ?? "").slice(0, 4);
  const url = String(post.URL).replace(/^http:\/\//, "https://");
  return {
    docKey: url,
    url,
    title,
    version: year ? `blog ${year}` : "blog",
    text: `# ${title}\n\n${htmlToText(post.content)}`,
    meta: { postId: post.ID, date: post.date, modified: post.modified, tags: Object.keys(post.tags ?? {}) },
  };
}
