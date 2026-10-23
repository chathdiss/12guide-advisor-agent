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

The backend still does the first search before it sends the question to n8n. When it has a public address (`PUBLIC_API_URL`) and the knowledge base answered, it also sends `toolsUrl` (`<public address>/api/internal/tools/<one-time id>`) and `toolCalls` (how many calls are allowed). The AI Agent node in n8n then has five HTTP Request tools, and loops by itself until it has what it needs:

| Tool (n8n node) | Endpoint (POST, `X-Internal-Key`) | Arguments | What it does |
|---|---|---|---|
| `search_knowledge` | `<toolsUrl>/search_knowledge` | `query`, `source` (`all`, `documentation`, `code`, `community`, `api`) | Searches again with the agent's own words |
| `describe_entity` | `<toolsUrl>/describe_entity` | `name` | Reads the IFS data dictionary (`dictionary_lu`, `dictionary_column`, see `packages/knowledge/README.md`): base table, view and package, all the columns of the view with type, prompt and flags, the joins, the parent (header) entity or the detail entities, the other views. Without the dictionary, or for a unit that is not in it, it reads the entity's `.entity` model file (`packages/knowledge/src/entity.js`). The agent uses it to confirm that a column exists, and whether an entity is a header or a line, before it writes SQL |
| `find_columns` | `<toolsUrl>/find_columns` | `query`, `entity` | Searches the dictionary for columns of entity views by the words of the column name or its prompt (the label in the screens), for example `planned delivery date`; `entity` limits it to one logical unit |
| `find_files` | `<toolsUrl>/find_files` | `name`, `model` | The files named like an entity or package (`customer order` is `CustomerOrder...`); package code by default |
| `read_document` | `<toolsUrl>/read_document` | `path`, `from_line`, `to_line` | More lines of a file or page that a source showed only a part of |

**Evidence.** Everything the agent is shown, the first passages and everything the tools return, is kept for the question (`src/evidence.js`) under numbers 1, 2, 3, ... The agent cites them as `[n]`, and when the answer is back the markers are checked against this full list (`src/cite.js`), so a passage found halfway can be cited as safely as the first ones. A passage that comes back again keeps its number.

**History.** The earlier answers of a chat are sent to the agent as context, but without their `[n]` markers (`stripCitations` in `src/cite.js`, applied in `validateChatRequest`): those numbers belong to the sources of the earlier question, and an agent that sees them next to a new set of sources may cite the wrong one. The workflow prompt says the same (rule *Earlier messages*).

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

## Quick reports: what happens after a design is approved

In the Quick Reports tab, when the latest answer holds a design, the page offers the next steps under it: **Approve design**, and then a choice between two options. Nothing is created, exported or opened before the consultant chooses, and the SQL status stays `not run` (the page separates the data dictionary check, the offline design checks and a real run, which has not happened).

| | Option A: create it in IFS | Option B: export file |
|---|---|---|
| What it does | Opens the IFS environment with Playwright, opens the New Report dialog, fills it in with the design, and saves it. IFS gives the report its own id | Makes the export file (XML) that you import into IFS yourself: Quick Reports page > Import > Browse XML |
| Status | Implemented, but its selectors are **not verified against IFS yet**. Until you switch the rehearsal off, it fills in the dialog and cancels it: **nothing is saved**. The SQL is never run | Implemented. The file has the structure of a real IFS export and is checked offline; whether your IFS accepts it can only be seen by importing it (test with a harmless report first) |
| Needs | `IFS_AUTOMATION=on`, `IFS_BASE_URL`, `IFS_STORAGE_STATE`, Playwright (below); `IFS_REHEARSAL=off` to really create | Nothing: it never opens IFS |

**Rehearsal (Option A).** `IFS_REHEARSAL` is on unless it is set to `off`. A rehearsal opens a visible browser, opens the New Report dialog, fills in title, type, query and comments, reads them back, and presses Cancel. It shows whether the screens are found as expected, and saves nothing. The confirmation in the page says which of the two it will do. Switch it off only after a rehearsal has worked. A real run is done without a window unless `IFS_HEADED=on` is set: set it for the first real run, so that you can watch it.

**Checked on IFS (Option A):** on 2026-10-23 a real run created a test report (ZZ TEST - DIALOG CHECK) through the New Report dialog on the dev environment, and read it back from its detail page (title and SQL); the rehearsal had worked first. Category and domain are left empty, and the SQL is not run. One earlier attempt lost the answer of the backend and could not be explained; if a run ends without an answer, look in the Quick Reports list in IFS before trying again, and in the backend log for run_started / run_done.

**The export file (Option B).** The structure is that of a real IFS export of one SQL quick report; the rules come from the IFS source (`Import_Reports__`): the title has at most 50 characters and must be unique; a quick report has one SQL statement; category and domain are left empty (choose them in IFS). IFS takes `QUICK_REPORT_ID` from the file, so a new report gets an id from a high range that IFS does not use, made from the title (the same title always gives the same id). If IFS asks whether to replace an existing report when you import, answer No unless you mean to update it. **Checked on IFS:** on 2026-10-23 a test file from this option (ZZ TEST - XML CHECK, id in the high range) was imported on the dev environment, and the report appeared in the Quick Reports list as type SQL Statement, with no category or domain.

Endpoints: `POST /api/quick-report/check` (read-only: is the design ready, and what each option needs) `POST /api/quick-report/run` (only with a named option, `approved: true`, the fingerprint of the approved design, and for Option A `confirmed: true`). and `POST /api/quick-report/test` (the test run below: needs `approved: true`, `confirmed: true`, the fingerprint of the approved design, the report id, and the values of the parameters).

### Test run: running the SQL in IFS (read-only)

After a report exists in IFS (Option A created it, or you imported the Option B file), the result panel offers **Test run in IFS**. IFS runs the SQL of the report (a quick report is a SELECT that IFS runs with your rights), and the page shows what IFS returns: whether the columns are those of the design, the first 20 rows, how long it took, an error if IFS gives one, and a screenshot of the result. The status of the real environment then changes from `not run` to what happened (for example "ran on your-environment: 20 row(s) read in 2.1 s, columns match the design"). An error of IFS, a timeout, or a rehearsal leave it at `not run`.

- **You type the values.** The panel shows one box for each parameter, and the id of the report (read from the new report for Option A, and the id in the file for Option B). A mandatory parameter needs a value; an empty optional one gets a warning, because it may return all rows. A value may not contain quotes, semicolons, ampersands or comment marks (it is put into the SQL as text), and at most 100 characters.
- **Only the approved report is run.** The run page of the report must have the title of the approved design, or Execute is not pressed.
- **Rehearsal first.** `IFS_TEST_EXECUTE` is off unless it is set to `on`. Without it a test run opens the report in a visible browser, finds the parameters and fills them in, and does **not** press Execute: nothing is run. Use it to see that the screens are found, then set `IFS_TEST_EXECUTE=on` (and restart the backend) to run for real. The confirmation in the page says which of the two it will do.
- **The results stay on the page.** The rows and the screenshot can contain customer data. They are shown to you only: they are not logged (the log has counts and timings), not stored, not part of the chat history, and not sent to the AI model.
- **Not known until it has been tried:** how IFS lays out the result. The result is looked for as a grid whose headers are the column labels of the design. When it cannot be read, the report is still run and the screenshot shows what IFS displays.

### Setting up Option A (on the computer that runs the automation only)

1. In `apps/api`: `npm install playwright` and then `npx playwright install chromium`.
2. Sign in to IFS yourself and save the session: `npm run ifs:login`. It asks you to type `yes`, opens a browser at IFS, and waits. Sign in there (including any second step), wait until the IFS home page is open, and press Enter in the terminal: the session is saved then, and not before. Close the browser by typing `q`, not by closing the window first. The file (`IFS_STORAGE_STATE`) must be outside the repository; the command refuses a folder inside it. The backend never types a user name or a password, never reads the file itself (Playwright does), and the command never shows what is in it.
3. In `.env` set `IFS_AUTOMATION=on`, `IFS_BASE_URL` (https address of the environment) and `IFS_STORAGE_STATE` (the path of the file), and restart the backend. Never switch `IFS_AUTOMATION` on in the hosted backend.
4. A session lasts some hours (the login cookie of IFS has an end time). When it has expired, IFS shows its sign-in page, the run says "IFS needs a new signed-in session" and creates nothing; run `npm run ifs:login` again.

### Looking at the IFS Quick Reports screens first (read-only inspection)

Before the steps that create a quick report can be built, the screens have to be looked at. `npm run ifs:inspect` (in `apps/api`) does that without changing anything in IFS:

1. It checks the setup (`IFS_BASE_URL`, `IFS_STORAGE_STATE`, `IFS_INSPECTION_DIR`, Playwright and Chromium), prints what it will do, and asks you to type `yes`. Anything else cancels, and IFS is not opened. It does not need `IFS_AUTOMATION=on`.
2. A visible browser opens with your saved session. **You** navigate to the Quick Reports screens. The script never clicks, types, selects or runs a script in the page. Do not press New, Save, Delete or Run in IFS while you look around: it cannot block those, because IFS reads its data with POST requests too.
3. Wait until the page has finished loading, then press Enter in the terminal to record the page that is open (its path, its title, and the roles and labels of its controls). Type `q` to quit. If you close the browser, nothing else happens. The recording also has the number of elements of each role (so that what is not recorded can be seen), the number of grid cells that were left out, and for controls without a name (icon buttons) their tooltip, test id, class hint and place on the page. Nothing is clicked or hovered to find these out.
4. The recording goes to `IFS_INSPECTION_DIR`, which must be outside the repository: a `.json` file and a readable `.outline.txt`. No screenshots are taken. Grid cells and everything in them, text, field values, link addresses, and the query and key parts of the page address are left out, and long numbers and e-mail addresses in labels are masked. A button or link label can still hold a name now and then, so read the file before you share it.
