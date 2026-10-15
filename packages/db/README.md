# Database

The PostgreSQL schema of the Advisor, and a Docker setup for a local database with the pgvector extension.

## Local database

```powershell
cd packages/db
copy .env.example .env        # then set POSTGRES_PASSWORD, and use the same password in DATABASE_URL
docker compose up -d          # PostgreSQL 16 with pgvector, on 127.0.0.1:5433
```

Open it in pgAdmin: host `localhost`, port `5433`, database `advisor`, user `advisor`.
Your normal PostgreSQL on port 5432 is not touched.

Create the tables with `npm run db:init` in `packages/knowledge`.

## Files

- `schema/001_knowledge.sql`: documents and chunks, with a full-text index. Works on any PostgreSQL.
- `schema/002_term_stats.sql`: how many chunks contain each word, for weighting search terms.
- `schema/003_memory.sql`: answers with a thumbs up (saved at once and reused without an AI call), notes after a thumbs down (unverified until a reviewer confirms them), the log of saved-answer hits and misses, and the chats kept on the server. It also moves databases made earlier to the new note status; running it again is safe.
- `schema/004_dictionary.sql`: the IFS data dictionary: every logical unit (entity) with its base table, view and package, and 380,000 view columns with type, prompt, flags and the joins to other entities (`dictionary_lu`, `dictionary_column`, `dictionary_load`). About 110 MB. Loaded with `npm run ingest:dictionary` in `packages/knowledge`; kept apart from the knowledge base so that it is looked up exactly and does not crowd out the documents in a text search.
- Vectors (pgvector) are added in a later numbered file, once the embeddings model is chosen: the size of the vectors depends on it.

`.env` is ignored by git. Never commit passwords or connection strings.
