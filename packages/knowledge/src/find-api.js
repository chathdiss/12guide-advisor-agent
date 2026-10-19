// The cards of the IFS projections (see projection-cards.js and projection-operations.js) that belong to the thing a question is about.
// IFS names its APIs after the entity: "customer order" is the entity set CustomerOrderSet of the projection CustomerOrderHandling,
// "customer order line" is CustomerOrderLineSet. In a plain-language question about REST those cards hold the answer, but thousands
// of cards mention the same common words, so the cards are looked up by their names first (as findByName does for source files),
// and then ranked by the other words of the question: "create", "release", "fields" ...
import { createHash } from "node:crypto";
import { API_DOC_ORIGIN, inflections, namePhrases, queryTerms } from "./search.js";

// words that say "this is about the API" and fit every card: they do not choose between cards
const API_WORDS = new Set(["rest", "restful", "odata", "api", "apis", "endpoint", "endpoints", "projection", "projections", "entity", "entities", "set", "sets", "service", "http", "json"]);

// words that ask for the attributes of an entity set
const FIELD_WORDS = /\b(fields?|attributes?|columns?|propert(?:y|ies)|lookups?)\b/i;

// Returns the best cards, in the shape of searchKnowledge. `[]` when the question names no entity that has cards.
export async function findApiCards(db, query, { origin = API_DOC_ORIGIN, limit = 4 } = {}) {
  // the names a question could mean, the most specific first: "customer order line", "customer order", "order"
  const names = [...new Set(namePhrases(String(query)).map((p) => p.phrase))].filter((n) => n.length >= 4).slice(0, 24);
  if (names.length === 0) return [];
  const { rows: found } = await db.query(
    `SELECT d.id, lower(d.meta->>'entity_set') AS entity_set, lower(d.meta->>'projection_name') AS projection
       FROM knowledge_documents d
      WHERE d.origin = $1 AND (lower(d.meta->>'entity_set') = ANY($2) OR lower(d.meta->>'projection_name') = ANY($3))
      LIMIT 2000`,
    [origin, names.flatMap((n) => [`${n}set`, n]), names.map((n) => `${n}handling`)],
  );
  // only the cards of the most specific name that has any: CustomerOrderSet, not every OrderSet of every projection
  const rank = (d) => names.findIndex((n) => d.entity_set === `${n}set` || d.entity_set === n || d.projection === `${n}handling`);
  const best = Math.min(...found.map(rank).filter((i) => i >= 0), Infinity);
  const ofBest = found.filter((d) => rank(d) === best);
  if (ofBest.length === 0) return [];
  // an entity set that is named like the question (CustomerOrderSet) beats the other cards of its projection (its actions, its functions)
  const exact = ofBest.filter((d) => d.entity_set === `${names[best]}set` || d.entity_set === names[best]);
  const docs = exact.length > 0 ? exact : ofBest;

  // the other words of the question choose between the cards (and between the parts of a long entity set)
  const words = [...new Set(queryTerms(String(query), 12).filter((t) => !API_WORDS.has(t)).flatMap((t) => [t, ...inflections(t)]))].filter((t) => /^[a-z0-9_]+$/.test(t)).slice(0, 40);
  const ids = docs.map((d) => d.id);
  const columns = "c.id, c.content, c.start_line, c.end_line, d.title, d.doc_key, d.origin, d.url, d.version, d.component, d.meta->>'chunk_type' AS chunk_type, d.meta->>'projection_name' AS projection, d.meta->>'entity_set' AS entity_set";
  const { rows } =
    words.length > 0
      ? await db.query(
          `SELECT ${columns}, ts_rank_cd(c.tsv, to_tsquery('simple', $2), 32) AS rank
             FROM knowledge_chunks c JOIN knowledge_documents d ON d.id = c.document_id
            WHERE c.document_id = ANY($1) AND c.tsv @@ to_tsquery('simple', $2)
            ORDER BY rank DESC, d.doc_key LIMIT 60`,
          [ids, words.join(" | ")],
        )
      : await db.query(
          // no other word: the cards of the entity sets themselves, the first part first
          `SELECT ${columns}, 0 AS rank FROM knowledge_chunks c JOIN knowledge_documents d ON d.id = c.document_id
            WHERE c.document_id = ANY($1) AND d.meta->>'chunk_type' = 'entity_set'
            ORDER BY d.doc_key LIMIT 60`,
          [ids],
        );

  const top = rows.slice(0, limit);
  // a question about the fields needs the whole list: the entity set card shows the first attributes, and its "more fields" cards the rest
  if (FIELD_WORDS.test(String(query)) && top[0]?.chunk_type === "entity_set") {
    const { rows: more } = await db.query(
      `SELECT ${columns}, 0 AS rank FROM knowledge_chunks c JOIN knowledge_documents d ON d.id = c.document_id
        WHERE d.origin = $1 AND d.meta->>'chunk_type' = 'entity_set_more' AND d.meta->>'projection_name' = $2 AND d.meta->>'entity_set' = $3
        ORDER BY length(d.doc_key), d.doc_key LIMIT 6`,
      [origin, top[0].projection, top[0].entity_set],
    );
    top.splice(1, 0, ...more.filter((m) => !top.some((t) => t.id === m.id)));
    top.splice(Math.max(limit, 1 + more.length));
  }

  return top.map((r) => ({
    ref: createHash("sha1").update(`${r.doc_key}#${r.id}`).digest("hex").slice(0, 8),
    title: r.title, path: r.doc_key, origin: r.origin, url: r.url, version: r.version, component: r.component,
    startLine: r.start_line, endLine: r.end_line, content: r.content, coverage: 1, score: 50 + Number(r.rank),
  }));
}
