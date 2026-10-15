# 12Guide Digital Advisor

An AI assistant for 12Guide consultants working on IFS Cloud. Ask a functional or technical
question in English or Dutch and get an answer grounded in approved knowledge (12Guide project
documentation, IFS documentation and IFS projection API docs), with links back to every source.

## How it works

```
Consultant asks a question (web chat)
  → backend rewrites it into English search keywords (Claude Haiku, handles Dutch)
  → keyword search in PostgreSQL finds the 6 best knowledge passages
  → n8n workflow sends question + passages to Claude
  → Claude answers only from those passages and cites them [1], [2]
  → backend removes invented citations and builds the source list
  → web app shows the answer with clickable source cards
```

## What's in this repo

| Folder | Contents |
|---|---|
| `apps/advisor-web/` | Next.js chat interface. Chats are stored in the browser (localStorage) for now |
| `apps/api/` | Node.js backend: validation, query rewrite, knowledge search, citation clean-up |
| `n8n/` | Exported n8n workflows (`.json`) for the answer step and integrations |
| `tools/ifs-projection-export/` | PowerShell script that exports IFS projection (REST API) docs, plus SQL to load them into the knowledge base |
| `docs/` | Architecture diagrams and design notes |

## Knowledge sources
- 12Guide project and internal documentation
- IFS documentation (approved content only)
- IFS projection API docs, exported with `tools/ifs-projection-export/`
- IFS entities and base views, for lobby and SQL questions

## Running locally
1. Copy `.env.example` to `.env` in `apps/api` and fill in the values. Never commit `.env`.
2. Start the backend:
   ```bash
   cd apps/api
   npm install
   npm start
   ```
3. Start the web app in a second terminal:
   ```bash
   cd apps/advisor-web
   npm install
   npm run dev
   ```
4. Open http://localhost:3000

## Deployment (test)
- Frontend: Netlify
- Backend: Render (free tier) or the team VPS
- n8n: team VPS
- Database: PostgreSQL in Docker

## Ground rules
- Answers come only from approved sources and always show where they came from.
- No customer production data in prompts, knowledge or test environments.
- Keys and passwords live in environment variables or secret stores, never in Git.
