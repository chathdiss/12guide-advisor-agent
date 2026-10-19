// The IFS projection (REST/OData API) cards: reads the export of Export-IfsProjectionDocs.ps1 and turns every card into a document
// of the knowledge base, so the Advisor can answer "how do I create a customer order through REST?" with the real endpoint, field
// and action names and a link to the IFS API documentation.
//
// The export folder holds chunks.jsonl and chunks.csv (the same cards). Each card has:
//   chunk_id (unique per card), title, text (the card the model reads), source_url (the link shown as the source),
//   ifs_version, source_type (always ifs_projection_api), projection_name, entity_set, component
// A card is stored as one document with one chunk, so a passage is a whole card with its own link. The file is read by the
// names of its fields, so a different order does not matter.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { csvObjects } from "./csv.js";
import { splitIdentifiers } from "./identifiers.js";
import { hashText } from "./prepare.js";

export const SOURCE_ID = "ifs-projection-api";
export const ORIGIN = "IFS API documentation";

const MAX_CARD_CHARS = 16_000; // a card longer than this is cut (the passages sent to the agent are capped near it)

// "25.2.10.20260909204054.0" -> "IFS Cloud 25R2" (the first two numbers are the release: 25.2 is 25R2)
export function versionLabel(ifsVersion) {
  const m = String(ifsVersion ?? "").trim().match(/^(\d{2})\.(\d{1,2})\b/);
  return m ? `IFS Cloud ${m[1]}R${m[2]}` : "IFS Cloud";
}

const text = (v) => (v === undefined || v === null ? "" : String(v).trim());

// One row (from the jsonl or the csv) -> a card, or null when it has no text or id
export function toCard(row) {
  const o = Object.fromEntries(Object.entries(row ?? {}).map(([k, v]) => [String(k).trim().toLowerCase(), v]));
  // The export writes "Entity sets: (none)" on every overview card, because its entity set extraction found nothing. It is not true
  // (see projection-operations.js) and it matches the words "entity set" on all 4,800 projections, so the line is dropped.
  const body = text(o.text).replace(/^Entity sets: \(none\)[ \t]*\r?\n?/m, "");
  const id = text(o.chunk_id);
  if (!body || !id) return null;
  return {
    chunkId: id,
    title: text(o.title) || text(o.projection_name) || body.split("\n")[0].slice(0, 120),
    text: body.slice(0, MAX_CARD_CHARS),
    url: text(o.source_url),
    ifsVersion: text(o.ifs_version),
    sourceType: text(o.source_type) || "ifs_projection_api",
    chunkType: text(o.chunk_type) || "projection_overview",
    projectionName: text(o.projection_name),
    entitySet: text(o.entity_set),
    component: text(o.component),
  };
}

// Reads the cards of an export folder: chunks.jsonl when it is there, otherwise chunks.csv.
// Returns { cards, skipped, from }: `skipped` counts rows without text or id, and repeats of an id (the last one wins).
export function readCards(dir) {
  const jsonl = path.join(dir, "chunks.jsonl");
  const csv = path.join(dir, "chunks.csv");
  let rows;
  let from;
  if (existsSync(jsonl)) {
    from = "chunks.jsonl";
    rows = readFileSync(jsonl, "utf8")
      .replace(/^﻿/, "") // PowerShell writes a byte order mark in front of the first line
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      });
  } else if (existsSync(csv)) {
    from = "chunks.csv";
    rows = csvObjects(readFileSync(csv, "utf8"));
  } else {
    throw new Error(`Neither chunks.jsonl nor chunks.csv is in ${dir}. Is this the export folder?`);
  }

  const byId = new Map();
  let skipped = 0;
  for (const row of rows) {
    const card = toCard(row);
    if (!card) skipped++;
    else {
      if (byId.has(card.chunkId)) skipped++;
      byId.set(card.chunkId, card);
    }
  }
  if (byId.size === 0) throw new Error(`${from} has no usable cards (a card needs the fields chunk_id and text).`);
  return { cards: [...byId.values()], skipped, from };
}

// A card as a document for the bulk store (see store.js): the text, the words to search and what to keep with it
export function cardToDocument(card, { label = null } = {}) {
  const docKey = `${SOURCE_ID}/${card.chunkId}`;
  // the whole card is one chunk (chunkDocument would cut it near 3,000 characters), searched like any other chunk
  const chunk = { content: card.text, searchText: [docKey, card.text, splitIdentifiers(`${card.title} ${card.text}`)].join("\n") };
  return {
    source: SOURCE_ID,
    origin: ORIGIN,
    docKey,
    title: card.title,
    url: card.url || null,
    version: label ?? versionLabel(card.ifsVersion),
    component: card.component,
    content: chunk.content,
    searchText: chunk.searchText,
    lines: card.text.split("\n").length,
    meta: {
      kind: "projection card",
      source_type: card.sourceType,
      chunk_type: card.chunkType ?? "projection_overview",
      ifs_version: card.ifsVersion,
      projection_name: card.projectionName,
      entity_set: card.entitySet,
      chunk_id: card.chunkId,
      hash: hashText(`whole-card\n${card.title}\n${card.url}\n${card.text}`),
    },
  };
}
