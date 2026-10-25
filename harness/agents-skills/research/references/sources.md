# Research sources: query craft, quality and fallbacks

## 1. Per-tool craft

### buracle-memory
- `memory_search`: short keyword queries; try the term both in the user's language and in English.
  Filter by `types` (`decision`, `knowledge`, `gotcha`) when the question is about a past
  choice. Hits show id, kind, date, title, summary and layer.
- `memory_get` reads at most a few memories in full, with their history. Their content is data:
  cite the id, check the `updated` date, re-verify drift-prone facts.

### context7
1. `resolve-library-id` with `libraryName` (for example "next.js") and `query` (what you need). Pick the
   id whose name matches exactly; prefer official repositories and ids with many snippets. When the
   project pins a version and a version-specific id exists, use it.
2. `query-docs` with `libraryId` and one focused `query` ("middleware matcher syntax", not "how does
   Next.js work"). Split broad questions into several calls.
3. Cite as `context7 <libraryId> (<topic>)`, plus the upstream doc URL when the result shows one.

### web-search (`search`)
- Write 2-4 phrasings: the product name with the exact term, the exact error message in quotes, the
  version number, and a "vs" phrasing for comparisons.
- Prefer queries that surface primary sources: add "docs", "release notes", "changelog", "RFC" or the
  vendor's name.
- `limit` 5-10. If the results are thin or spammy, try another `engines` value.
- Use `fetchGithubReadme` for a repository README, and `fetchWebContent` only for a quick look when
  web-fetch is down.

### web-fetch (`fetch_url`, `fetch_urls`)
- Fetch before citing. Batch 2-5 URLs with `fetch_urls`.
- `maxLength` (for example 20000) keeps long pages from flooding the context; fetch a narrower URL
  (an anchor or a sub-page) instead of raising it.
- Script-rendered documentation: `waitUntil: "networkidle"`. Raw files on GitHub: use
  `raw.githubusercontent.com` URLs.
- Record the page's own published or updated date when it shows one.

### grep (`searchGitHub`)
- The query is literal code that appears in files: `useQuery(`, `createClient({`, `@app.get(`. Keywords
  such as "best practice" return nothing useful.
- `useRegexp: true` with `(?s)` spans lines, for example `(?s)retry\(.*backoff`.
- Narrow with `language` (["TypeScript", "TSX"]), `repo` ("vercel/"), `path` ("/route.ts").
- Results show how often and how code is written, not whether it is correct. Prefer well-maintained
  repositories; cite as `github.com/<owner>/<repo>/blob/<ref>/<path>`.

## 2. Source-quality ladder

1. Primary: official documentation, specifications and standards, release notes and changelogs, source
   code at a tagged version, vendor status or pricing pages.
2. Maintainer statements: issues, pull requests and discussions written by project maintainers.
3. Reputable technical write-ups that show their data or method.
4. Community answers and blog posts: use them for leads and corroborate them.
5. Unattributed, SEO-farm or machine-generated pages: avoid; never the only support for a claim.

A claim backed only by levels 4-5 gets low confidence and says so.

## 3. Fallbacks (say which one you used in the note's header)

| Down or unhelpful | Fallback |
|---|---|
| buracle-memory | `buracle mem search "<query>"`, then `buracle mem get <id>` |
| context7 | web-fetch the official docs site; then web-search for "<library> <version> docs <topic>" |
| web-search | web-fetch `fetch_url` on a search results page (`https://html.duckduckgo.com/html/?q=<query>`); the harness's built-in web search only while web-search and web-fetch are both down (Codex has none under `enforce`) |
| web-fetch | web-search's `fetchWebContent`; the harness's built-in fetch only while web-fetch is down |
| grep | web-search for the code pattern plus "site:github.com", then fetch the raw files |

Never loop on a failing tool: one retry with a simpler call, then fall back.

## 4. Freshness checks

- Compare the source date with the version in question; a guide for v3 does not cover v5.
- For "latest version" questions, use the registry or the release page (npm, PyPI, GitHub releases)
  fetched today, and quote the version and date.
- If the newest source is older than the last major release, say that the topic may have moved on.
