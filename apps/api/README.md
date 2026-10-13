# Advisor API

The backend of the Advisor web app. It receives questions from the website, checks them, forwards them to the Advisor agent (an n8n workflow, see [`agents/advisor`](../../agents/advisor)) and returns the answer. Plain Node.js, no build step; the only dependency is `pg`, for the knowledge base.

The Claude API key is **not** needed here. Claude is called by the n8n workflow, whose credential lives in n8n. This server only needs the n8n webhook URL and a shared secret.

## Endpoints

| Method and path | What it does |
|---|---|
| `GET /api/health` | Returns `{"status":"ok"}` |
| `POST /api/chat` | Takes `{ chatId, question, language, customer, ifsVersion, history, attachments }` and returns `{ answer, sources, tier, tierReason, followUps, lessons }` |
| `GET /api/memory/scopes` | The choices of the customer and IFS version dropdowns |
| `GET /api/memory/chats`, `PUT` and `DELETE /api/memory/chats/:id` | The chats of one browser, kept on the server. The browser is identified by the random id in the `X-Client-Id` header |
| `POST /api/memory/feedback` | A thumbs up or down under an answer: `{ rating: "up" | "down", customer, ifsVersion, language, question, answer, sources, tier, followUps, standalone, cacheId, comment }`. Up saves the answer at once (no review); down needs `comment` (at least 8 characters) |
| `GET /api/memory/lessons?status=unverified`, `POST /api/memory/lessons/:id/review`, `GET /api/memory/stats` | For the reviewer, with the key in the `X-Review-Key` header: list the notes of a status, confirm (`approved`) or dismiss (`rejected`) one and fix its wording; how many questions saved answers served and the tokens that saved |

Errors are returned as `{ error, code }`. The website turns the `code` into a message in the chosen language (`invalid_request`, `attachments_invalid`, `rate_limited`, `not_found`, `n8n_status`, `no_answer`, `too_slow`, `unreachable`, `not_configured`).

## Memory

Two kinds of memory are kept in PostgreSQL (`packages/db/schema/003_memory.sql`, code in `src/memory.js`):

- **Saved answers (thumbs up).** A thumbs up saves the question and its answer at once, with no review (`memory_answers`, `src/answer-cache.js`). When a consultant later asks the same or a very similar question, **before anything that calls an AI model** (the keyword rewrite and the agent), the server looks for a saved answer and returns it as it is, with its sources, tier and follow-up questions and a `cached` field, so the page shows "Saved answer" and a "Get a new answer" button (`fresh: true` skips the saved answer). A saved answer is used only when the customer, IFS version and language are equal (empty only matches empty), the question has no attachment and is at most 1,000 characters, the conversation fits (a question that stands on its own, with four or more topic words and no word such as "it", "that" or "again", is saved and reused anywhere; a question that leans on earlier messages is saved with the earlier questions of that chat and reused only after the same earlier questions; an answer in a chat with attached files is not saved), and the question matches: the content words are equal after removing filler words and word endings, or, in a question of 8 or more words, differ by one word per 8 words; codes, numbers, names and quoted text must be identical, and a negation (not, without, niet) never matches a question without one. A short question must therefore match completely. No AI is used for matching. A thumbs down on a saved answer switches it off, and a saved answer expires after 60 days. Every repeatable question is logged as a hit or a miss; a hit counts about 6,000 tokens for the prompt that was not sent plus the length of the answer (an estimate, shown on `/review`).
- **Thumbs down.** The consultant must write what is wrong, unsupported or missing. It is stored with the question and the answer as *unverified* (`memory_lessons`) and is never treated as a verified correction. For a similar question of the same customer and IFS version (or of all) the server sends up to two such notes to the agent as `<reported_issues status="unverified">`; the agent may only use them as a reason to check the passages again. On the page `/review` (needs `REVIEW_API_KEY`) a reviewer can confirm a note (then it is a lesson that the agent follows, sent as `<confirmed_lessons>` and shown as "Used 1 confirmed lesson") or dismiss it. Customer and version come from the two dropdowns above the chat. A note or answer of one customer is never used for another.
- **Chats.** The web app keeps each chat on the server too, so chats survive a cleared browser. There are no user accounts yet: a chat belongs to a random id that the browser creates once and sends in `X-Client-Id`. It works like a password for those chats, so it is never logged. Real accounts can replace it later.

Chats contain the questions and answers, so they are stored data: decide how long to keep them, and delete a chat in the web app to remove it from the server too. Memory needs `DATABASE_URL`; without it the app keeps working from the browser's own storage.

## How answers are grounded

For every question the server first searches the knowledge base (`packages/knowledge/src/search.js`) and sends the passages it found to the agent together with the question. The agent may only answer from those passages and marks each claim with `[1]`, `[2]`, ... (numbers valid for that request only). When the answer comes back, `src/cite.js` removes markers that match no passage, renumbers the rest in order of use, and returns exactly the cited passages as `sources`, each with file path, line range and the passage itself. If nothing relevant is found the agent says so instead of guessing, and if the database is down it answers from general knowledge with a warning line.

How the search is done (`src/knowledge.js`, `src/rewrite.js`):

- A small, cheap model (Claude Haiku, `ANTHROPIC_API_KEY`) turns the question into English search keywords: it translates, expands abbreviations, keeps codes and API names as they are and adds a few synonyms. It only does this; the answer itself is written by the Lite, Full or Super model that the n8n router picks. Without the key the question is searched as typed.
- The question is searched twice, as typed and with the keywords, and the results are taken in turn. The keywords alone would replace specific words ("Admin Studio", "July 2025") with general ones.
- A phrase in quotes is taken as a title: a document with exactly that title comes first.
- A question about code ("source code", PL/SQL, a method, a package, or "which file / projection / entity / fragment ...") also gets a search in the source code alone, with the words of the question (not the synonyms) and without the words that only say it is about code. The files named like the question ("customer order line" -> `CustomerOrderLine.plsql`) are looked up too and woven in behind the best code results. The searches run side by side, and for a code question the code results come first and the other searches let source code count as much as the documentation.
- The same model flags a question that is clearly not about IFS (for example "what is 2+2"). Nothing is searched for it, so the agent gets no passages and the router picks the Lite tier. A short follow-up question is judged on its own first, so it cannot borrow the previous question to look IFS-related.


## The agent's search tools (agentic loop)

The backend still does the first search before it sends the question to n8n. When it has a public address (`PUBLIC_API_URL`) and the knowledge base answered, it also sends `toolsUrl` (`<public address>/api/internal/tools/<one-time id>`) and `toolCalls` (how many calls are allowed). The AI Agent node in n8n then has four HTTP Request tools, and loops by itself until it has what it needs:

| Tool (n8n node) | Endpoint (POST, `X-Internal-Key`) | Arguments | What it does |
|---|---|---|---|
| `search_knowledge` | `<toolsUrl>/search_knowledge` | `query`, `source` (`all`, `documentation`, `code`, `community`) | Searches again with the agent's own words |
| `describe_entity` | `<toolsUrl>/describe_entity` | `name` | Reads the entity's `.entity` model file (`packages/knowledge/src/entity.js`) and returns its view, all its columns, key, parent (header) entity, references and states, and the names of entities that start like it. The agent uses it to confirm that a column exists before it writes SQL |
| `find_files` | `<toolsUrl>/find_files` | `name`, `model` | The files named like an entity or package (`customer order` is `CustomerOrder...`); package code by default |
| `read_document` | `<toolsUrl>/read_document` | `path`, `from_line`, `to_line` | More lines of a file or page that a source showed only a part of |

**Evidence.** Everything the agent is shown, the first passages and everything the tools return, is kept for the question (`src/evidence.js`) under numbers 1, 2, 3, ... The agent cites them as `[n]`, and when the answer is back the markers are checked against this full list (`src/cite.js`), so a passage found halfway can be cited as safely as the first ones. A passage that comes back again keeps its number.

**Limits.** At most `AGENT_MAX_TOOL_CALLS` calls (default 6) per question: after that a tool answers that no calls are left and the agent writes its answer. This is enforced here, below the maximum of 12 iterations set in n8n, because n8n stops with an error when it reaches its own limit. At most 60 passages, 120,000 extra characters and 40,000 characters per call. A tool that fails answers with a short text, not an error status, so the agent goes on. A one-time id only works while the question is being answered.

## Settings (environment variables)

| Variable | Needed | Meaning |
|---|---|---|
| `N8N_CHAT_URL` | yes | Production URL of the Advisor webhook in n8n |
| `INTERNAL_API_KEY` | yes | Shared secret, sent to n8n as the `X-Internal-Key` header |
| `DATABASE_URL` | no | The knowledge base ([`packages/db`](../../packages/db)). Without it the agent answers from general knowledge and says so |
| `REVIEW_API_KEY` | no | Key of the reviewer page `/review` (confirming or dismissing thumbs-down notes, statistics). Without it reviewing is switched off; saved answers and unverified notes still work |
| `MEMORY_CUSTOMERS`, `MEMORY_VERSIONS` | no | Comma-separated choices of the two dropdowns. Customers can also be typed freely; the versions have a default list |
| `PUBLIC_API_URL` | no | This backend's own public address, for example `https://assistant-api-hj0l.onrender.com`. Render sets `RENDER_EXTERNAL_URL` itself, which is used when this is empty. With it the backend gives n8n a one-time return address, so a workflow that answers later can post the finished answer to `POST /api/internal/answer/<id>` (with the `X-Internal-Key`) while the browser's request stays open. This gets around a gateway in front of n8n that cuts requests after about 60 seconds. A workflow that answers at once keeps working. It needs one running instance, because the waiting list is in memory |
| `CORS_ORIGINS` | no | Websites that may call the backend directly from the browser, comma separated, without a trailing slash (for example `https://12guide-assistant-test.netlify.app`). Needed on Netlify, which cuts a forwarded request after about 26 seconds while a complete answer takes a minute or more: build the website with `NEXT_PUBLIC_CHAT_API_URL` set to this backend so the chat goes straight to it |
| `PORT` | no | Defaults to 4000; Render sets it |
| `RATE_LIMIT_PER_MINUTE` | no | Requests per client per minute, default 30 |
| `AGENT_TIMEOUT_MS` | no | How long to wait for the agent, default 600000 (complete answers take minutes) |
| `AGENT_MAX_TOOL_CALLS` | no | How many times the agent may use its search tools for one question, default 6 (see "The agent's search tools"). The tools need `DATABASE_URL` and the public address (`PUBLIC_API_URL`), because n8n calls them over HTTP |

See `.env.example`. Never commit real values.

## Run locally

```powershell
cd apps/api
npm install
$env:N8N_CHAT_URL="http://localhost:5678/webhook/advisor-chat"; $env:INTERNAL_API_KEY="any-local-value"; npm start
```

Open http://localhost:4000/api/health. Then start the website with `API_URL=http://localhost:4000` (see `apps/advisor-web`).

**Easier: a `.env` file.** `npm start` only reads the real environment, which is what Render provides. For local work you can keep the values in a file instead of typing them each time:

```powershell
cp .env.example .env      # then fill in INTERNAL_API_KEY
npm run start:local       # or: npm run dev, which also restarts on every code change
```

`.env` is ignored by git, so it is never committed. If the file is missing, these scripts stop with `.env: not found`.

## Tests

```bash
npm test
```

The tests use a fake n8n server, so they need no keys or running services.

## Deploy on Render

| Field | Value |
|---|---|
| Root Directory | `apps/api` |
| Build Command | `npm install` |
| Start Command | `npm start` |
| Environment variables | `N8N_CHAT_URL`, `INTERNAL_API_KEY` |

## What it protects, and what it does not

- Requests above 30 MB, with invalid fields or too many attachments are refused before they reach the agent.
- Each client is limited per minute, to protect the Claude budget from loops and misuse. The counter is in memory and resets on restart.
- The log records only metadata (status, tier, duration), never questions or answers.
- There is no login yet, so anyone who knows the address can use it. Keep the address within the test group and set a spending limit in the Anthropic console.
