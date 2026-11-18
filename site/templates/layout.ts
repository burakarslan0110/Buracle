// The page shell every page shares: head (meta, hreflang, Open Graph), the top bar, the footer and small HTML helpers.

import { REPO_URL, SITE_URL, type PageContext, type UiData } from './types'

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** Copy text with `inline code` in backticks, the one markup home.json may use. */
export function inline(s: string): string {
  return s.split('`').map((part, i) => (i % 2 === 1 ? `<code>${escapeHtml(part)}</code>` : escapeHtml(part))).join('')
}

/** The copy button every code block and every install command carry: hidden until site.js wires it. */
export function copyButton(ui: UiData, command?: string): string {
  const data = command !== undefined ? ` data-copy="${escapeHtml(command)}" aria-label="${escapeHtml(ui.copyLabel)}"` : ''
  return `<button class="copy" type="button" data-copy-button${data} hidden><svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="9" y="9" width="11" height="11" rx="1"/><path d="M5 15V5a1 1 0 0 1 1-1h10"/></svg><span data-copy-label>${escapeHtml(ui.copy)}</span></button>`
}

/** A shell command on one line with its copy button. */
export function commandBlock(ui: UiData, command: string, labelledBy?: string): string {
  const label = labelledBy !== undefined ? ` aria-labelledby="${labelledBy}"` : ''
  return `<div class="cmd"><pre tabindex="0"${label}><code><span class="cmd-prompt" aria-hidden="true">$ </span>${escapeHtml(command)}</code></pre>${copyButton(ui, command)}</div>`
}

export function wordmark(cls: string, width: number): string {
  const height = Math.round((width * 12) / 92)
  return `<img class="wm wm-dark ${cls}" src="/assets/buracle-dark.svg" alt="Buracle Stack" width="${width}" height="${height}">`
    + `<img class="wm wm-light ${cls}" src="/assets/buracle-light.svg" alt="Buracle Stack" width="${width}" height="${height}">`
}

// `m-enter` marks the hero's entrance for the first 700 ms (the CSS entrance runs with or without it).
const THEME_INIT = "(function(){var d=document.documentElement;d.classList.add('js','m-enter');setTimeout(function(){d.classList.add('m-enter-done')},700);try{var t=localStorage.getItem('buracle-theme');if(t==='light'||t==='dark')d.setAttribute('data-theme',t)}catch(e){}})()"

const SUN = '<svg class="icon i-sun" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>'
const MOON = '<svg class="icon i-moon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M19.5 14.6A8 8 0 0 1 9.4 4.5a8 8 0 1 0 10.1 10.1z"/></svg>'

function head(ctx: PageContext, kind: 'home' | 'docs'): string {
  const en = ctx.lang === 'en' ? ctx.path : ctx.twinPath
  const tr = ctx.lang === 'tr' ? ctx.path : ctx.twinPath
  return [
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(ctx.title)}</title>`,
    `<meta name="description" content="${escapeHtml(ctx.description)}">`,
    `<link rel="canonical" href="${SITE_URL}${ctx.path}">`,
    `<link rel="alternate" hreflang="en" href="${SITE_URL}${en}">`,
    `<link rel="alternate" hreflang="tr" href="${SITE_URL}${tr}">`,
    `<link rel="alternate" hreflang="x-default" href="${SITE_URL}${en}">`,
    `<meta property="og:type" content="${ctx.type}">`,
    `<meta property="og:site_name" content="${escapeHtml(ctx.ui.siteName)}">`,
    `<meta property="og:title" content="${escapeHtml(ctx.title)}">`,
    `<meta property="og:description" content="${escapeHtml(ctx.description)}">`,
    `<meta property="og:url" content="${SITE_URL}${ctx.path}">`,
    `<meta property="og:image" content="${ctx.image}">`,
    `<meta property="og:locale" content="${ctx.ui.locale}">`,
    `<meta property="og:locale:alternate" content="${ctx.twinUi.locale}">`,
    '<meta name="twitter:card" content="summary_large_image">',
    '<meta name="color-scheme" content="dark light">',
    // The browser bar colour: the page background of each theme (tokens.css --bg).
    '<meta name="theme-color" content="#05060a" media="(prefers-color-scheme: dark)">',
    '<meta name="theme-color" content="#f4f5f9" media="(prefers-color-scheme: light)">',
    '<link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">',
    '<link rel="preload" href="/assets/fonts/geist-latin-wght-normal.woff2" as="font" type="font/woff2" crossorigin>',
    '<link rel="stylesheet" href="/assets/site.css">',
    // The landing page's own styles and script: the orbit, the brain, the workflow rings and the question router.
    kind === 'home' ? '<link rel="stylesheet" href="/assets/home.css">' : '',
    `<script>${THEME_INIT}</script>`,
    '<script src="/assets/site.js" defer></script>',
    kind === 'home' ? '<script src="/assets/home.js" defer></script>' : '',
  ].filter(Boolean).join('\n')
}

export function topBar(ctx: PageContext, current: 'home' | 'docs'): string {
  const ui = ctx.ui
  return `<a class="skip" href="#main">${escapeHtml(ui.skip)}</a>
<header class="top">
  <div class="wrap top-in">
    <a class="brand" href="${ctx.lang === 'en' ? '/' : `/${ctx.lang}/`}">${wordmark('wm-top', 138)}</a>
    <nav class="top-nav" aria-label="${escapeHtml(ui.nav.label)}">
      <ul>
        <li><a href="${ctx.docsPath}"${current === 'docs' ? ' aria-current="true"' : ''}>${escapeHtml(ui.nav.docs)}</a></li>
        <li class="top-gh"><a href="${REPO_URL}">${escapeHtml(ui.nav.github)}</a></li>
        <li><a href="${ctx.twinPath}" hreflang="${ctx.twinUi.lang}" lang="${ctx.twinUi.lang}" title="${escapeHtml(ui.language.hint)}">${escapeHtml(ui.language.label)}</a></li>
      </ul>
    </nav>
    <button class="theme" type="button" data-theme-toggle data-to-dark="${escapeHtml(ui.theme.toDark)}" data-to-light="${escapeHtml(ui.theme.toLight)}" aria-label="${escapeHtml(ui.theme.toLight)}" hidden>${SUN}${MOON}</button>
  </div>
</header>`
}

/** Who built Buracle Stack: the colophon at the top of the footer on every page, above the wordmark, the links and the licence line. */
const MAKER = { photo: '/assets/burak.jpg', name: 'Burak Arslan', linkedin: 'https://www.linkedin.com/in/burakarslann0110', github: 'https://github.com/burakarslan0110' }

function maker(ctx: PageContext): string {
  const ui = ctx.ui
  return `<div class="maker">
      <img class="maker-photo" src="${MAKER.photo}" alt="${escapeHtml(MAKER.name)}" width="76" height="76" loading="lazy" decoding="async">
      <p class="maker-name">${escapeHtml(ui.footer.maker)}</p>
      <p class="maker-role">${escapeHtml(ui.footer.role)}</p>
      <p class="maker-links"><a href="${MAKER.linkedin}">LinkedIn</a> <a href="${MAKER.github}">GitHub</a></p>
    </div>`
}

/** The closing statement the landing page puts at the top of its footer: one line and the install command. */
export interface Closing { title: string, command: string }

/** `band` is HTML the landing page puts between the closing statement and the links (the open source band). */
export function footer(ctx: PageContext, closing?: Closing, band = ''): string {
  const ui = ctx.ui
  const statement = closing !== undefined
    ? `<div class="foot-close">
      <h2 id="close-title">${escapeHtml(closing.title)}</h2>
      ${commandBlock(ui, closing.command, 'close-title')}
    </div>
    `
    : ''
  return `<footer class="foot">
  <div class="wrap foot-in">
    ${statement}${band}
    ${maker(ctx)}
    <a class="foot-brand" href="${ctx.lang === 'en' ? '/' : `/${ctx.lang}/`}">${wordmark('wm-foot', 184)}</a>
    <nav class="foot-nav" aria-label="${escapeHtml(ui.footer.label)}">
      <ul>
        <li><a href="${ctx.docsPath}">${escapeHtml(ui.nav.docs)}</a></li>
        <li><a href="${REPO_URL}">${escapeHtml(ui.footer.source)}</a></li>
        <li><a href="${REPO_URL}/releases">${escapeHtml(ui.footer.releases)}</a></li>
        <li><a href="${REPO_URL}/issues">${escapeHtml(ui.footer.issues)}</a></li>
        <li><a href="${ctx.twinPath}" hreflang="${ctx.twinUi.lang}" lang="${ctx.twinUi.lang}">${escapeHtml(ui.language.label)}</a></li>
      </ul>
    </nav>
    <p class="foot-legal">${escapeHtml(ui.footer.license)}</p>
  </div>
</footer>`
}

/** A whole page: `kind` selects the page styles, `body` is everything between the top bar and the footer. */
export function page(ctx: PageContext, kind: 'home' | 'docs', body: string, closing?: Closing, band = ''): string {
  const ui = ctx.ui
  return `<!doctype html>
<html lang="${ctx.lang}" data-page="${kind}" data-copy="${escapeHtml(ui.copy)}" data-copied="${escapeHtml(ui.copied)}" data-copy-failed="${escapeHtml(ui.copyFailed)}">
<head>
${head(ctx, kind)}
</head>
<body>
${topBar(ctx, kind)}
${body}
${footer(ctx, closing, band)}
<p class="sr-only" role="status" data-copy-status></p>
</body>
</html>
`
}
