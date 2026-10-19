---
paths:
  - "**/*.tsx"
  - "**/*.jsx"
  - "**/*.vue"
  - "**/*.svelte"
  - "**/*.astro"
  - "**/*.html"
  - "**/*.css"
  - "**/*.scss"
  - "**/*.sass"
  - "**/*.less"
  - "**/*.razor"
  - "**/*.razor.css"
---
# Frontend

## Components and state
- Reuse the project's components, design tokens and patterns before creating new ones, and stay inside the design system already in use.
- Give each component one job; split one that mixes data fetching, state orchestration and layout.
- Keep state at the lowest common owner, derive values instead of duplicating state, and leave server data to the project's data layer (query cache, loaders, store).
- Use stable keys for list items (ids, not array indexes). No direct DOM manipulation inside framework components beyond refs for focus or measurement.
- Handle every async state: loading, empty, error and success. Prevent double submission of forms.
- Cancel or ignore stale responses (an `AbortController`, or a request id checked on arrival) so an older answer never overwrites a newer one, and never let polls overlap.

## Styling
- Use the project's styling approach (Tailwind, CSS modules, styled components, …) and its tokens for color, spacing, radius and type; no hard-coded one-off values.
- Avoid `!important` and deep selector overrides; fix specificity at its source.
- If the app has themes or a dark mode, check each of them.

## Accessibility (WCAG 2.2 AA)
- Semantic elements first: `<button>` for actions, `<a href>` for navigation, a `<label>` bound to every input, headings in order, landmarks such as `main` and `nav`.
- Everything interactive works from the keyboard, in a logical order, with a visible focus indicator. Dialogs move focus in, keep it there, return it on close, and close on Escape.
- Provide text alternatives: meaningful `alt` text, an `aria-label` on icon-only buttons, `alt=""` on decorative images.
- Text contrast is at least 4.5:1 (3:1 for large text and UI components); color is never the only signal; pointer targets are at least 24×24 px.
- Compute contrast ratios, never judge them by eye: measure text against its actual background (a button label against the button fill) on every surface and theme.
- On touch-first surfaces, follow the platform guidance: 44×44 pt on iOS, 48×48 dp on Android.
- Announce async results (form errors, toasts) with `aria-live` or focus management, and respect `prefers-reduced-motion`.
- Reach for ARIA only when no native element fits, and keep its roles and states in sync with the UI.

## Responsive layout
- Build mobile-first with flex and grid; check widths around 375, 768 and 1280 px. No horizontal scrolling, clipped text or overlapping controls.
- Reserve space for media (`width`/`height` or `aspect-ratio`) to prevent layout shift, and serve responsive images (`srcset`, modern formats).

## Performance
- Measure before optimizing; memoize only where a profile shows wasted renders.
- Lazy-load heavy routes and components, virtualize long lists, keep new dependencies small and justified, and avoid layout thrashing.
- When performance is the goal, record a chrome-devtools performance trace before and after the change (LCP, CLS, INP).

## Text and locale
- If the app has i18n, put no user-facing strings in code. Use locale-aware APIs (`Intl.*`, `toLocaleUpperCase("tr-TR")`); the Turkish dotted and dotless i break naive case conversion.

## Verify in a real browser
- A passing build or unit test does not prove the UI works. After a UI change, open the page with the chrome-devtools MCP (omp: its built-in browser): navigate, take a snapshot, use the changed controls, check the console for errors and the network log for failed requests, and try a narrow viewport. The browser-automation rule has the full procedure.
- Check component-library and framework APIs with context7 at the installed version.
