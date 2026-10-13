# Advisor agent

The logic of the Advisor agent, built as an n8n workflow. The chat web app (`apps/advisor-web`) sends each question to this workflow through a webhook.

## Files

Two files with the same workflow, for different n8n versions. Import the one that matches your server (n8n shows its version under **Help → About n8n**):

| File | Use it on | Claude node | Models (Lite / Full / Super) |
|---|---|---|---|
| `n8n-agent-workflow.json` | n8n **2.41.5** and newer | 1.6 | Haiku 4.5 / Sonnet 5.5 / Opus 5.5 |
| `n8n-agent-workflow-2.34.6.json` | n8n **2.34.6** (and other versions that bundle `@langchain/anthropic` older than 1.5) | 1.5 | Haiku 4.5 / Sonnet 4.5 / Opus 4.5 |

They differ in two ways:
- **Claude node version.** A newer file on an older n8n fails to import, because that node version does not exist there.
- **Models.** n8n 2.34.6 bundles an Anthropic library (1.3.27) that adds `thinking: disabled` to every request. Sonnet 5.5 and Opus 5.5 reject it ("thinking.type.disabled is not supported for this model"), while Haiku 4.5 and the 4.5 models accept it. From `@langchain/anthropic` 1.5 on (n8n 2.41.5), the setting is only sent when chosen, so the 5.x models work. If the server is upgraded, switch to `n8n-agent-workflow.json`.

The models are set in one place, at the top of the **Complexity router** node. Import with **Workflows → Import from file**.

## Setup

1. Import the file for your n8n version (see above) and rename the workflow, on a shared server for example `Advisor – Chat agent`.
2. Open the **Claude** node and select an Anthropic credential (create `Advisor – Anthropic` with the API key). Credentials are not part of the file.
3. Open the **Webhook** node. **Authentication** is already set to **Header Auth** in the file, so the node shows a warning until you choose a credential. Create one named `Advisor – internal key` with header name `X-Internal-Key` and the shared secret as value. The same secret goes into the backend as `INTERNAL_API_KEY`. Without it, anyone who finds the URL could use the agent, and n8n will not let you activate the workflow while the credential is missing.
4. Save and set the workflow to **Active**. The webhook path is `advisor-chat`, so the production URL is `http://<n8n host>/webhook/advisor-chat`. Put that URL in the backend (`apps/api`) as `N8N_CHAT_URL`.
5. Test it: a request with the right `X-Internal-Key` header must be answered, and one without it must be refused.

`n8n-agent-workflow.json` was run on n8n 2.41.5 (Node 24). `n8n-agent-workflow-2.34.6.json` was checked against the node definitions shipped with n8n 2.34.6 (every node and node version exists there), but has not been run on a 2.34.6 server.

The Claude node must be version **1.5 or newer**, which is where the `Thinking Mode` setting appears: older versions always send a `thinking` setting that the newest Claude models reject.

## Answering later (long answers)

A complete answer takes a minute or more, but a gateway in front of a shared n8n server may cut a request after about 60 seconds. So the workflow can answer in two steps. When the request has a `callbackUrl` (the backend adds a one-time return address when it knows its public address), the node **Accept request** replies `{"accepted": true}` at once, and the run continues. When the answer is ready, **Send answer** posts it to the `callbackUrl` with the `X-Internal-Key` header; if the agent fails, **Failure answer** posts an error instead, so nobody waits for nothing. Without a `callbackUrl` the workflow answers at once, as before.

After importing, open **Send answer** and select the same Header Auth credential as the Webhook node (`Advisor – internal key`). The nodes **Answer later?** and **Deliver later?** only choose between the two ways.

## How a question flows

`Webhook → Build prompt → Complexity router → Advisor Agent (Claude) → Format response → Respond to Webhook`

- **Build prompt** turns the question, the last 10 messages of history and any attachments into one prompt. Images are passed to Claude as images; text files are placed in the prompt.
- **Complexity router** scores the question (length, several questions, attachments, wording such as migration or integration, long conversations) and picks a tier. The model per tier is set at the top of that node:

  | Tier | Model |
  |---|---|
  | Lite | claude-haiku-4-5 |
  | Full | claude-sonnet-5-5 |
  | Super | claude-opus-5-5 |

- **Advisor Agent** holds the system prompt: answer language, professional format, no invented URLs, and 2 or 3 suggested follow-up questions.
- **Format response** separates the follow-up questions from the answer text.

The request and response shapes are defined in `apps/advisor-web/src/lib/chat/api-types.ts`.

## Grounded search (Step 8)

Grounded search: the backend searches `packages/knowledge` and sends the passages to this workflow with each question; the agent answers only from them and cites them. Re-import the workflow file after changes to the prompts. More sources (IFS Community, 12Guide) and vector search come later.

## Searching further (agentic loop)

The backend does the first search, but one search can miss the point (for example only the line entity of an order, not its header). So the AI Agent node has four tools that let it look further itself, and it loops by itself (n8n's tool-calling agent) until it has what it needs:

| Tool node | URL it calls | What the agent uses it for |
|---|---|---|
| `search_knowledge` | `<toolsUrl>/search_knowledge` | Search again with its own words, in all sources or only documentation, code or community |
| `describe_entity` | `<toolsUrl>/describe_entity` | What an entity is, from its entity model file: view, all columns with type, key, parent (header) entity, references, states. How the agent checks that a column exists and whether an entity is a header or a line before it writes SQL |
| `find_files` | `<toolsUrl>/find_files` | The files named like an entity or package (package code by default; `model=true` for the entity, projection and client files) |
| `read_document` | `<toolsUrl>/read_document` | More lines of a file or page that a source showed only a part of |

They are *HTTP Request Tool* nodes (`n8n-nodes-base.httpRequestTool`) connected to the **Advisor Agent** as tools. The URL starts with `toolsUrl`, which the backend adds to the request together with `toolCalls` (the number of calls it allows) and which holds a one-time id of the question. **Build prompt** adds a line `<search_tools status="on" calls="N"/>` (or `off`), and the system prompt has a rule *Searching further* that says when to make a call and when to stop. Everything a tool returns is a numbered `<source>` like the first ones, and the backend checks the `[n]` markers against all of them (see `apps/api/README.md`).

After importing:
1. Open each of the four tool nodes and select the same Header Auth credential as the Webhook node (`Advisor – internal key`), as for **Send answer**.
2. The backend needs `PUBLIC_API_URL` (n8n calls it over HTTP) and `DATABASE_URL`. Without a public address no `toolsUrl` is sent: the line says `off` and the agent works with the first sources, as before.
3. **Max Iterations** of the agent is 12. The backend allows `AGENT_MAX_TOOL_CALLS` (default 6) calls, below that on purpose: n8n stops with an error when it reaches its own limit, while a backend that has no calls left just tells the agent to answer.

The tool nodes and `Build prompt` use the nodes' parameters as defined in n8n 2.41.5 (checked against its node definitions). The workflow was not run on a server yet: after importing, ask a question that needs a second search and look at the **Executions** tab, where every tool call of the agent shows. The backend log of such a question has `toolCalls` and `foundWithTools`.

## Memory (Step 9)

The backend adds confirmed lessons (`lessons`) and unverified concerns from thumbs-down notes (`reports`) to the request, with the `customer` and `ifsVersion` the consultant chose. The Build prompt node puts them in a `<confirmed_lessons>` and a `<reported_issues status="unverified">` block next to the sources. The Memory rule tells the agent to use a confirmed lesson when it applies (saying in words that it rests on one, without a [n] marker) and to follow it over a source when they conflict; the Reported issues rule tells it that a report is not verified and never a source, to use it only as a reason to check the passages again, and to ignore it when the passages do not support it. Answers that got a thumbs up are returned by the backend without calling this workflow at all. **Re-import both workflow files after pulling this change.** See `apps/api/README.md` for how answers are saved and reused and how notes are reviewed.

## Not built yet

- The tier rules and prompts live inside the workflow JSON. They can be moved into code in this folder when the team decides how the agent is deployed.
