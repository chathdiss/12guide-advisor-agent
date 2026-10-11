-- Memory of the Advisor.
--
-- memory_answers: an answer that a consultant rated with a thumbs up. It is saved at once (no review) and returned
-- as it is, without calling an AI model, when the same or a very similar question is asked again for the same
-- customer, IFS version and language (see apps/api/src/answer-cache.js). A thumbs down on it switches it off.
--
-- memory_lessons: what a consultant wrote after a thumbs down: what is wrong, unsupported or missing. It starts
-- 'unverified'. The agent sees it as a reported concern for similar questions, never as a fact. A reviewer can mark
-- it 'approved' (a confirmed correction, which the agent follows) or 'rejected' (dismissed, no longer shown).
-- A customer or version that is empty means "all".
--
-- memory_cache_events: one row for every question that could have been answered from memory: a hit (no AI call) or
-- a miss. Used to show how many tokens the saved answers have saved.
--
-- memory_chats: the chats of one browser, kept on the server so they survive a cleared browser and can be
-- opened elsewhere. There are no user accounts yet, so a chat belongs to the random client_id that the web
-- app creates (it acts like a password for that person's chats). Accounts can replace it later.

CREATE TABLE IF NOT EXISTS memory_lessons (
  id           BIGSERIAL PRIMARY KEY,
  customer     TEXT NOT NULL DEFAULT '',
  ifs_version  TEXT NOT NULL DEFAULT '',
  question     TEXT NOT NULL,
  answer       TEXT NOT NULL DEFAULT '',   -- the answer that was rated (shortened)
  rating       TEXT NOT NULL CHECK (rating IN ('up', 'down')),
  correction   TEXT NOT NULL,              -- what the consultant says is wrong, unsupported or missing
  status       TEXT NOT NULL DEFAULT 'unverified',
  suggested_by TEXT NOT NULL,              -- client_id of the person who wrote it
  review_note  TEXT NOT NULL DEFAULT '',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at  TIMESTAMPTZ,
  tsv          TSVECTOR GENERATED ALWAYS AS (to_tsvector('simple', question || ' ' || correction)) STORED
);

-- Databases made before the thumbs-down redesign: new status 'unverified' (was 'pending' until a reviewer looked)
ALTER TABLE memory_lessons DROP CONSTRAINT IF EXISTS memory_lessons_status_check;
ALTER TABLE memory_lessons ADD CONSTRAINT memory_lessons_status_check CHECK (status IN ('unverified', 'pending', 'approved', 'rejected'));
ALTER TABLE memory_lessons ALTER COLUMN status SET DEFAULT 'unverified';
UPDATE memory_lessons SET status = 'unverified' WHERE status = 'pending' AND rating = 'down';

CREATE INDEX IF NOT EXISTS memory_lessons_tsv_idx ON memory_lessons USING GIN (tsv);
CREATE INDEX IF NOT EXISTS memory_lessons_scope_idx ON memory_lessons (status, customer, ifs_version);

CREATE TABLE IF NOT EXISTS memory_answers (
  id            BIGSERIAL PRIMARY KEY,
  customer      TEXT NOT NULL DEFAULT '',
  ifs_version   TEXT NOT NULL DEFAULT '',
  language      TEXT NOT NULL DEFAULT 'en',
  question      TEXT NOT NULL,             -- as the consultant asked it
  question_key  TEXT NOT NULL,             -- its content words (stopwords and word endings removed), in order
  answer        TEXT NOT NULL,
  sources       JSONB NOT NULL DEFAULT '[]',
  context_key   TEXT NOT NULL DEFAULT '',  -- '' for a question that stands on its own, otherwise a code of the earlier questions of the chat
  tier          TEXT,
  tier_reason   TEXT,
  follow_ups    JSONB,
  likes         INTEGER NOT NULL DEFAULT 1,
  dislikes      INTEGER NOT NULL DEFAULT 0,
  uses          INTEGER NOT NULL DEFAULT 0,  -- how often it was returned instead of calling the AI
  disabled      BOOLEAN NOT NULL DEFAULT false,
  saved_by      TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at  TIMESTAMPTZ,
  tsv           TSVECTOR GENERATED ALWAYS AS (to_tsvector('simple', question_key)) STORED
);

-- Databases made before answers could be saved in the middle of a chat: add the conversation code, and make it part of the key
ALTER TABLE memory_answers ADD COLUMN IF NOT EXISTS context_key TEXT NOT NULL DEFAULT '';
DROP INDEX IF EXISTS memory_answers_key_idx;
CREATE UNIQUE INDEX IF NOT EXISTS memory_answers_ctx_key_idx ON memory_answers (question_key, context_key, lower(customer), lower(ifs_version), language);
CREATE INDEX IF NOT EXISTS memory_answers_tsv_idx ON memory_answers USING GIN (tsv);

CREATE TABLE IF NOT EXISTS memory_cache_events (
  id            BIGSERIAL PRIMARY KEY,
  at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  outcome       TEXT NOT NULL CHECK (outcome IN ('hit', 'miss')),
  answer_id     BIGINT,
  tokens_saved  INTEGER NOT NULL DEFAULT 0   -- an estimate: the prompt that was not sent plus the answer that was not written
);

CREATE INDEX IF NOT EXISTS memory_cache_events_at_idx ON memory_cache_events (at);

CREATE TABLE IF NOT EXISTS memory_chats (
  client_id    TEXT NOT NULL,
  chat_id      TEXT NOT NULL,
  title        TEXT NOT NULL DEFAULT '',
  customer     TEXT NOT NULL DEFAULT '',
  ifs_version  TEXT NOT NULL DEFAULT '',
  messages     JSONB NOT NULL DEFAULT '[]',
  created_at   BIGINT NOT NULL,            -- milliseconds, as the web app keeps them
  updated_at   BIGINT NOT NULL,
  PRIMARY KEY (client_id, chat_id)
);

CREATE INDEX IF NOT EXISTS memory_chats_client_idx ON memory_chats (client_id, updated_at DESC);
