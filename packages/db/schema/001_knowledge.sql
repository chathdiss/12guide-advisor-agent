-- Knowledge base of the Advisor: documents, split into searchable chunks.
-- Works on any PostgreSQL. The vector column comes in 002_vectors.sql (needs pgvector).

CREATE TABLE IF NOT EXISTS knowledge_documents (
  id          BIGSERIAL PRIMARY KEY,
  source      TEXT NOT NULL,                 -- which collection: 'ifs-apps10-upd29', 'dsj23-blog', ...
  doc_key     TEXT NOT NULL,                 -- path or URL, unique inside the source
  title       TEXT NOT NULL,
  origin      TEXT NOT NULL,                 -- label shown next to the citation
  url         TEXT,                          -- clickable link; NULL for files that have none
  version     TEXT NOT NULL DEFAULT '',      -- e.g. 'Apps10 UPD29', '25R2'
  component   TEXT NOT NULL DEFAULT '',      -- e.g. 'ACCRUL'
  meta        JSONB NOT NULL DEFAULT '{}'::jsonb,
  indexed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source, doc_key)
);

CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id           BIGSERIAL PRIMARY KEY,
  document_id  BIGINT NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
  chunk_index  INT NOT NULL,
  start_line   INT,
  end_line     INT,
  content      TEXT NOT NULL,                -- the text shown to the model and quoted in answers
  search_text  TEXT NOT NULL,                -- content plus split identifiers (Customer_Order -> customer order)
  tsv          TSVECTOR GENERATED ALWAYS AS (to_tsvector('simple', search_text)) STORED,
  UNIQUE (document_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS knowledge_chunks_tsv_idx ON knowledge_chunks USING GIN (tsv);
CREATE INDEX IF NOT EXISTS knowledge_chunks_document_idx ON knowledge_chunks (document_id);
