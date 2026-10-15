// Stores one document with its chunks. Used by every loader.

const BATCH = 100; // chunks per INSERT

// doc: { source, docKey, title, origin, url, version, component, meta }
export async function storeDocument(client, doc, chunks) {
  const { rows } = await client.query(
    `INSERT INTO knowledge_documents (source, doc_key, title, origin, url, version, component, meta, indexed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
     ON CONFLICT (source, doc_key) DO UPDATE
       SET title = EXCLUDED.title, origin = EXCLUDED.origin, url = EXCLUDED.url, version = EXCLUDED.version,
           component = EXCLUDED.component, meta = EXCLUDED.meta, indexed_at = now()
     RETURNING id`,
    [doc.source, doc.docKey, doc.title, doc.origin, doc.url ?? null, doc.version ?? "", doc.component ?? "", doc.meta ?? {}],
  );
  const documentId = rows[0].id;

  // re-running replaces what was stored for this document, so there are never duplicates
  await client.query("DELETE FROM knowledge_chunks WHERE document_id = $1", [documentId]);

  for (let i = 0; i < chunks.length; i += BATCH) {
    const part = chunks.slice(i, i + BATCH);
    const values = [];
    const params = [];
    part.forEach((c, n) => {
      const o = n * 6;
      values.push(`($${o + 1}, $${o + 2}, $${o + 3}, $${o + 4}, $${o + 5}, $${o + 6})`);
      params.push(documentId, c.chunkIndex, c.startLine, c.endLine, c.content, c.searchText);
    });
    await client.query(
      `INSERT INTO knowledge_chunks (document_id, chunk_index, start_line, end_line, content, search_text)
       VALUES ${values.join(", ")}`,
      params,
    );
  }
  return documentId;
}

// Runs fn(client) inside a transaction
export async function inTransaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// Rebuilds knowledge_term_stats (word -> number of chunks that contain it) from the full-text index.
// Called by the loaders after they have stored documents; takes some seconds on a large knowledge base.
export async function refreshTermStats(pool) {
  await inTransaction(pool, async (client) => {
    await client.query("DELETE FROM knowledge_term_stats");
    await client.query(
      "INSERT INTO knowledge_term_stats (term, df) SELECT word, ndoc FROM ts_stat('SELECT tsv FROM knowledge_chunks')",
    );
  });
}
