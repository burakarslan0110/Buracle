---
description: "Buracle path rule: Browser verification (injected when editing or writing matching files)"
condition:
  - "**/*.tsx"
  - "**/*.jsx"
  - "**/*.vue"
  - "**/*.svelte"
  - "**/*.astro"
  - "**/*.html"
  - "**/*.css"
  - "**/*.scss"
  - "**/*.razor"
  - "**/e2e/**"
  - "**/playwright/**"
  - "**/cypress/**"
  - "**/__tests__/**"
  - "**/playwright.config.*"
  - "**/cypress.config.*"
---
# Browser verification

## When
- Any change to what a user sees or does in a browser — markup, styles, client logic, routing, forms, client/server integration — is checked in a real browser before you call it done.
- A bug report about visible behavior is reproduced in the browser first, then checked again after the fix.

## Which tool
- Default: the `chrome-devtools` MCP. It navigates, takes accessibility-tree snapshots, clicks and types, captures screenshots, reads console messages and network requests, emulates viewports, CPU and network, and records performance traces.
- In omp, use its built-in browser tool instead: omp drops browser MCP servers while that tool is enabled, so `chrome-devtools` is not installed there. The procedure below is the same.
- Playwright: when the repo already has a Playwright suite (run or extend it through the repo's script), or when a check must stay repeatable in CI. Don't add browser tooling to a project unasked.
- Neither available (MCP down, no Chrome): say so, verify what you can (`curl` for server-rendered HTML, the repo's own E2E suite), and report the UI as not verified.

## Procedure
1. Reuse a running dev server or start one in the background and note its URL. Never start a second copy.
2. Open a fresh page for this task and navigate to the changed screen. Note its page id and select it before every action: agents that share one browser server share its selected page, so parallel lanes each own their own page.
3. Take a snapshot and act on elements through the references it returns. References go stale after navigation or re-render, so take a new snapshot rather than reusing old ones. When a selector keeps failing, check frames and WebViews, overlays and stale references before you switch tools. A native `alert`, `confirm` or `prompt` dialog blocks the page: answer it with the driver's dialog tool (chrome-devtools `handle_dialog`).
4. Walk the user flow end to end, including one failure or empty path (invalid input, no data).
5. Wait for concrete conditions (text, element, network response), never for a fixed time.
6. Check the console (no new errors or warnings) and the network log (no failed or unexpected 4xx/5xx requests caused by your change).
7. If layout changed, check a narrow (about 375 px) and a desktop viewport, plus the dark theme if the app has one.
8. For performance work, record a trace before and after the change and compare the metric you targeted.
9. Stop servers you started unless the user wants them running, and close the pages you opened.

## Evidence
- "The page loads" is not evidence for a feature. Report the specific behavior you exercised and what you observed: text from the snapshot, response status codes, the console state, a screenshot path.
- Prefer readable signals (snapshot text, DOM state, network responses) over judging a screenshot by eye when the outcome is subtle.

## Safety
- Use test accounts and test data. Never complete real purchases, send real emails or messages, or change production data from the browser.
- Never type credentials or personal data you were not explicitly given for this purpose.
- Keep each task in its own page or isolated browser context, and don't use the user's personal browser profile for destructive actions.
