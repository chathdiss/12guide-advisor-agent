# Advisor web app

The chat web app of the Advisor agent: a ChatGPT-style interface where IFS consultants ask functional and technical questions in English or Dutch. Built with Next.js, React, TypeScript, Tailwind and shadcn/ui.

The agent itself (prompt, tier router, Claude calls) is an n8n workflow in [`agents/advisor`](../../agents/advisor). This app sends each question to it and shows the answer.

## Run locally

Needs Node 20.9 or newer (developed on Node 24).

Normal setup, with the backend in [`apps/api`](../api) running on port 4000:

```powershell
cd apps/advisor-web
npm install
$env:API_URL="http://localhost:4000"; npm run dev    # http://localhost:3000
```

`API_URL` is the address of the backend. Every `/api/...` call from the browser is forwarded there by a rewrite in `next.config.ts` (read when the server starts or the site is built), so the browser only talks to this site. In the deployed setup it is the Render address, set as an environment variable in Netlify, without a trailing `/`.

Quick alternative without the backend: leave `API_URL` unset, copy `.env.example` to `.env.local` and set `N8N_WEBHOOK_URL`. The app's own `/api/chat` route then calls the n8n webhook directly.

## What it does

- Chat with a sidebar of earlier chats, grouped by date, with search, rename and delete.
- English / Dutch switch: the whole interface and the answers follow the chosen language.
- Light, dark or system theme.
- Attach up to 4 files (drag, paste or pick): images (screenshots are read by the model), text files, **Word (.docx)** and **PDF**.
  A Word or PDF file is read in the browser and sent as text, so the backend and the n8n workflow are unchanged:
  Word goes through [mammoth](https://github.com/mwilliamson/mammoth.js) (to HTML, then to compact text that keeps headings, lists and table rows; pictures are left out),
  a PDF through pdf.js (text per page, marked `[Page n]`). Both libraries load only when such a file is attached. Limits: 25 MB per file and 200,000 characters of text.
  Old `.doc` files and scanned PDFs without a text layer are refused with a message that says what to do.
- Each answer shows the tier the router chose (Lite / Full / Super), can be copied, and suggests follow-up questions.
- Failed answers show an error with a Try again button.

## How it works

`Browser → /api/chat → backend (apps/api) → n8n webhook → Claude`

The request and response shapes are in `src/lib/chat/api-types.ts`. Without `API_URL`, `src/app/api/chat/route.ts` plays the role of the backend and calls n8n directly.

Forwarded requests wait up to 2 minutes (`experimental.proxyTimeout`). Next.js would otherwise give up after 30 seconds, which a Super-tier answer can exceed.

## Structure

- `src/app`: page, layout, global styles and the `/api/chat` route
- `src/components/chat`: sidebar, messages, message box, header controls
- `src/components/ui`: shadcn/ui building blocks
- `src/lib/chat`: chat state, attachment handling (`documents.ts` reads Word and PDF), shared types
- `test/`: `npm test` (HTML-to-text conversion and a Word fixture)
- `src/lib/i18n.ts`: all interface texts in English and Dutch

## Not built yet

- Chats are stored in the browser (localStorage). Server-side storage belongs to `apps/api` and `packages/db`.
- Source links stay empty until the knowledge search (`packages/knowledge`) exists, and answers are marked as not yet verified.
- Login (`packages/auth`) and feedback.
