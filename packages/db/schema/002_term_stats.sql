-- How many chunks contain each word. The search uses it to weigh words by how rare they are: a word found
-- in few chunks ("payee", "invvoutype2") says more than one found in most ("payment", "error").
-- The table is rebuilt from the index by the loaders after they store documents (refreshTermStats).

CREATE TABLE IF NOT EXISTS knowledge_term_stats (
  term TEXT PRIMARY KEY,
  df   INT NOT NULL
);
