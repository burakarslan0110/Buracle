// 404.html: GitHub Pages serves it for any missing path, in either language, so it speaks both. Every URL in it is
// root-relative, because it can be served at any depth.

import { escapeHtml, wordmark } from './layout'
import type { UiData } from './types'

function block(ui: UiData, docs: string, home: string, heading: 'h1' | 'h2'): string {
  const n = ui.notFound
  return `<section class="nf-block" lang="${ui.lang}">
      <${heading}>${escapeHtml(n.title)}</${heading}>
      <p>${escapeHtml(n.body)}</p>
      <ul class="nf-links"><li><a href="${home}">${escapeHtml(n.home)}</a></li><li><a href="${docs}">${escapeHtml(n.docs)}</a></li></ul>
    </section>`
}

export function notFoundPage(en: UiData, tr: UiData, docs: { en: string, tr: string }): string {
  return `<!doctype html>
<html lang="en" data-page="404">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(en.notFound.title)} | ${escapeHtml(en.siteName)}</title>
<meta name="robots" content="noindex">
<meta name="color-scheme" content="dark light">
<link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/assets/site.css">
<script>(function(){var d=document.documentElement;d.classList.add('js');try{var t=localStorage.getItem('buracle-theme');if(t==='light'||t==='dark')d.setAttribute('data-theme',t)}catch(e){}})()</script>
</head>
<body>
<header class="top">
  <div class="wrap top-in">
    <a class="brand" href="/">${wordmark('wm-top', 138)}</a>
  </div>
</header>
<main id="main" class="nf">
  <div class="wrap nf-in">
    ${block(en, docs.en, '/', 'h1')}
    ${block(tr, docs.tr, '/tr/', 'h2')}
  </div>
</main>
</body>
</html>
`
}
