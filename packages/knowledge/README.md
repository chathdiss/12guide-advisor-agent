# Knowledge

Code that fills and searches the Advisor's knowledge base: it reads documents, splits them into chunks and stores them in PostgreSQL (see `packages/db`).

**The documents themselves are never committed.** This repository is public, and the IFS source files and 12Guide documents are not. Keep them in a folder outside the repo and point the scripts at it.

## Run

```powershell
cd packages/knowledge
npm install

# 1. Only count what would be indexed (no database needed)
npm run ingest:ifs:dry -- --dir D:\Gotli\advisor-knowledge\ifs-apps10-upd29

# 2. Create the tables, then store the chunks (needs the database from packages/db and its .env)
npm run db:init
npm run ingest:ifs -- --dir D:\Gotli\advisor-knowledge\ifs-apps10-upd29
```

Ingestion can be run again at any time. Files that did not change are skipped (the file's hash is kept in `meta`), changed files replace what was stored for them, and new files are added, so there are no duplicates and a repeat run takes seconds. Add `--prune` to also remove documents whose file is no longer in the folder, for example when the source folder is reorganised.

Try the search with `npm run search -- "your question"`.

## What is indexed from the IFS source

Kept: `.plsql`, `.plsvc`, `.views`, `.apv`, `.cdb`, `.cre`, `.storage`, `.upg`, `.cs`, `.csv`, `.xml`, `.java`.
Left out: installation data (`.ins`), UI resource files (`.resx`), generated form layouts (`*.Designer.cs`), icons, project files. In the field description files, the `UNUSED` lines are dropped.

Each chunk is about 1,600 characters, cut at a blank line or the start of a declaration, with a few lines repeated at the start of the next chunk. It carries its file path, version, component and layer, so an answer can say where it came from.

For the keyword search, the words inside identifiers are indexed too (`Customer_Order_API` also matches "customer order").

The folder layout is `<root>/<Version>/<component>/<layer>/…/<file>`, for example `Apps10_UPD29/accrul/database/Voucher_API.plsql`. The first folder becomes the version label shown with every passage, so two code versions (Apps 10 and IFS Cloud) can be loaded side by side without mixing: give each its own version folder. Each version folder is its own source (`Apps10_UPD29` becomes `ifs-apps10-upd29`, `IFS_Cloud_25R2` becomes `ifs-cloud-25r2`), and `--prune` only removes files of the versions that are in the folder you point it at. IFS Cloud adds the model files `.entity`, `.projection`, `.client`, `.fragment`, `.enumeration` and `.utility`, which are indexed too. The interface report files (`prifs/nobuild/interfacereports`, lists of methods added or removed in each update) are left out on purpose: they are not source code and their method names would crowd out real code. A download from OneDrive can contain `*_Error.txt` placeholders for files it could not fetch; they are skipped, but check `___All_Errors.txt` in each zip. Keep a version's files together in one root folder; a folder that has an extra level (such as `25.2.4/checkout/<component>`) must be arranged to match before loading.

## Tests

```bash
npm test
```

## More sources

| Source | Command | How it is read |
|---|---|---|
| IFS source code | `npm run ingest:ifs -- --dir <folder>` | Files from the SharePoint zip (kept outside the repository) |
| dsj23.me blog | `npm run ingest:dsj23` | The public WordPress.com API; only posts about IFS; links to the real post |
| IFS Community | `npm run crawl:community -- --out <folder>`, then `npm run ingest:community -- --dir <folder>` | Every public topic from the sitemap, with all replies (long topics are read page by page) and the accepted answer marked; see below |
| IFS technical documentation | `npm run ingest:docs -- --file <search.json> --release 25R2` | The text of every page, from the one search index file the site itself loads (`docs.ifs.com/techdocs/<release>/search.json`); each page is stored with its real link |
| IFS.ai and Lifecycle Experience documentation | `npm run ingest:docs -- --file <search.json> --release aidocs --source ifs-aidocs --base-url https://docs.ifs.com/aidocs/ --version "IFS.ai documentation"` (and the same with `ifs-ale`, `https://docs.ifs.com/techdocs/ale/en/`) | The same kind of search index file, with their own address and label |
| IFS guides as files (PDF, PowerPoint, Word) | `npm run ingest:files -- --dir <folder>` | The folder holds the downloaded files and a `manifest.json` (title, link, file name, group). Every page or slide is marked in the text (`[Page 12]`). |
| Single docs.ifs.com pages (Power BI example reports, policies, PSO start page) | `npm run ingest:pages -- --dir <folder>` | Pages behind the site's browser check, read in a browser and saved as `pages*.jsonl`; every page carries a checksum and a page that does not match is refused |
| IFS Community articles (release notes, support policies, webinars, country solutions) | `npm run ingest:pages -- --dir <folder>` (same loader) | Article-type items that only signed-in members can open. A signed-in browser reads them and saves `pages*.jsonl`; each record names its own `source`, `origin` and `version` and is stored like a Community topic |

All loaders skip what did not change, so they can be run again at any time.

## What is loaded now

| Source | Origin shown in answers | Size |
|---|---|---|
| IFS Community topics (all public ones, with replies and the accepted answer marked) | IFS community | about 43,600 topics |
| IFS Community articles (signed-in members only) | IFS community | 121 articles (17 link-only pages left out) |
| IFS technical documentation 25R2, IFS.ai, Lifecycle Experience, guide files, single pages | IFS documentation | about 2,700 pages and files |
| IFS source code, Apps 10 UPD29 | IFS source code | 1,047 files |
| IFS source code, IFS Cloud 25R2 (182 of 296 components, including the PL/SQL packages of `order`, `invent`, `invoic`, `purch`, `payled`, `wo`; see below for what is missing) | IFS source code | 45,670 files, about 272,000 chunks |
| dsj23.me blog (IFS posts) | IFS technical blog | 34 posts |

Not loaded yet: the part of the IFS Cloud source that OneDrive could not download (114 of the 296 components have nothing, such as `srv*`, `tm*`, `mrp*` and `timrep`, and some are only partly there, such as `shpord` with about 50 of 250 database files; the list is made from the `___All_Errors.txt` file inside every OneDrive zip), the rest of the Apps 10 code (only a part of the components came in the SharePoint zip, and the zip has no PL/SQL), other documentation releases, Maintenix help, and the roughly 11 Community topics restricted to a select group of members.

## How search mixes the sources

Every word of the question is weighted by how rare it is (`knowledge_term_stats`, rebuilt by the loaders): a word found in few chunks, such as `payee` or `INVVOUTYPE2`, counts far more than `payment` or `error`. Codes with punctuation (`CAMT.053`, `ORA-20110`) are indexed as plain words as well. The best chunks of every source are collected first, so the large source code cannot push the others out. The official documentation gets the largest boost, question-and-answer sources (community, blog) a smaller one, in proportion to how well the chunk matches, field description files a small penalty, and no single source may fill more than half of the results while others have matches.

**Huge chunks.** A few pages have chunks that cannot be split, such as a table of 68,000 characters and 1,400 different words (the list of predefined database tasks, the IFS.ai Copilot page). A chunk like that holds almost every word by chance and used to appear for questions that have nothing to do with it. Its score is lowered in proportion to how far it is above the size of a large normal chunk (300 different words; 99% of chunks are below 220). The words are counted in the program, and only for chunks over 3,000 characters (about 1 in 200), and the result is remembered per chunk, so a search pays almost nothing for it. A chunk is left alone when the question is about its page: at least half of the words of the page title are in the question.

**How well a chunk covers the question.** By rarity weight alone one rare word is worth more than two common ones, so for "which procedure posts a supplier invoice" a chunk with only "posts" beat the chunks that have both "supplier" and "invoice". The coverage is therefore a blend: 70% the rarity-weighted share of the words, 30% the plain share of the words that the chunk has. A chunk is kept when either number reaches the cut-off, so nothing that was found before is lost. When what is kept comes from fewer than three documents it is not used alone (a document gives at most two results), and the best of everything is used instead.

**Questions about code.** `preferCode: true` lets source code count as much as the official documentation, which otherwise has a boost. The backend sets it for a question about code, so a documentation page that merely mentions the same words does not lead.

**Files named like the question.** IFS names its code after the entity: "customer order line" is `CustomerOrderLine.plsql`, "company" is `Company.plsql`. In a plain-language question about code those files hold the answer, yet they are not among the best-matching chunks, because thousands of chunks mention the same common words. `findByName` therefore turns neighbouring words of the question into file names (`namePhrases`: longest first, plurals made singular, "code" and "work" kept inside names) and returns the best-fitting chunks of the files with that name: package files (.plsql, .plsvc, .views, .storage) for a question about a method, procedure or package, and model files (.projection, .entity, .client, .fragment) when the question asks for them. The lookup takes 60 to 90 ms. It only helps when the file is loaded: a question about a customer order line cannot find `CustomerOrderLine.plsql` while that file is missing from the data.

**Pages named in the question.** `findByTitle` also takes the unquoted phrases of the question (`titleNgrams` in `apps/api`: groups of 2 to 5 words, hyphens and punctuation as spaces, not starting or ending with a filler word). A documentation page whose title has two or more words and is exactly such a phrase goes first, with its first two chunks (at most two pages). So "What is the high-level architecture of IFS Cloud?" finds the page *High Level Architecture*, which the pages with the most mentions of "layers" and "tiers" would otherwise outrank. Community topics and other sources never count here, and a quoted title still works for any source.

**Word forms.** The index has no stemmer, and IFS names its methods `Validate___` and `Create_New___`, so a question word also matches its endings (-s, -es, -ed, -ing): "validates" finds validate, validated and validating. Related words ("validation", "configuration") are not mixed in. The forms are looked up in `knowledge_term_stats` together with the question words, count when a chunk is scored, and do not choose which chunks are fetched, so a common form cannot slow the search down. In a search of the source code alone, words that only say "this is code" (package, file, method, PL/SQL) are left out.

`searchKnowledge(db, query, options)` takes `limit`, `perDocument`, `keywords` (the words an AI rewrite made of the question, see `apps/api`) and `origin` (search one origin only, for example `"IFS source code"`) `stemming` (word forms, on by default) and `preferCode` (see above). `findByTitle(db, phrases)` returns the documents whose title is exactly one of the phrases, used when a question quotes a title. There is no vector search and no embeddings provider: the search is PostgreSQL full-text search.

## The IFS Community crawl

`crawl:community` reads the topic list the community publishes itself (`sitemap-topics-1.xml`), fetches each public topic page and saves it as JSON lines (`topics-0001.jsonl` and so on, in a folder outside the repository). It waits between requests (about 100 topics a minute, two at a time), identifies itself with its own name, and can be stopped and started again: `done.jsonl` remembers what is saved, together with the topic's last-modified date, so a later run reads only what changed.

- Every reply is kept, with the accepted answer marked, and a topic is marked solved or not. Author names are not stored.
- Topics the community restricts to a select group of members answer "403" or "Access denied" and are left out. They are listed in `errors.jsonl`.
- Article-type items (release notes, policies, webinars) are not public. They are loaded separately with `ingest:pages` from a signed-in browser, see the table above.
- `ingest:community` builds one document per topic (question, then each reply) and stores it with its real link, so every answer can point to the topic.
- A full run takes about 7 hours and downloads roughly 10 GB, so it is meant to be run once and then refreshed.

