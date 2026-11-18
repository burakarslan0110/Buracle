// A docs page: the sidebar of every page in the language, the rendered Markdown with its title and description,
// "On this page" from the h2 and h3 headings, an edit link and the previous and next page by `order`.

import { escapeHtml, page } from './layout'
import type { DocPage, PageContext } from './types'

const pathOf = (p: DocPage): string => `${p.lang === 'en' ? '' : `/${p.lang}`}/${p.slug}/`

function pageList(current: DocPage, pages: readonly DocPage[]): string {
  return `<ul>${pages.map(p => `<li><a href="${pathOf(p)}"${p.slug === current.slug ? ' aria-current="page"' : ''}>${escapeHtml(p.title)}</a></li>`).join('')}</ul>`
}

function toc(ctx: PageContext, doc: DocPage): string {
  if (doc.headings.length === 0) return ''
  return `<nav class="toc" aria-labelledby="toc-title">
      <p class="toc-title" id="toc-title">${escapeHtml(ctx.ui.docs.onThisPage)}</p>
      <ul>${doc.headings.map(h => `<li class="toc-${h.level}"><a href="#${escapeHtml(h.id)}">${escapeHtml(h.text)}</a></li>`).join('')}</ul>
    </nav>`
}

function pager(ctx: PageContext, around: { prev?: DocPage, next?: DocPage }): string {
  const link = (p: DocPage, rel: 'prev' | 'next'): string =>
    `<a class="pager-${rel}" rel="${rel}" href="${pathOf(p)}"><span class="pager-dir">${escapeHtml(rel === 'prev' ? ctx.ui.docs.prev : ctx.ui.docs.next)}</span><span class="pager-title">${escapeHtml(p.title)}</span></a>`
  return `<nav class="pager" aria-label="${escapeHtml(ctx.ui.docs.pager)}">${around.prev ? link(around.prev, 'prev') : '<span></span>'}${around.next ? link(around.next, 'next') : ''}</nav>`
}

export function docsPage(ctx: PageContext, doc: DocPage, pages: readonly DocPage[], around: { prev?: DocPage, next?: DocPage }, editUrl: string): string {
  const ui = ctx.ui
  return page(ctx, 'docs', `<div class="wrap docs">
  <details class="side-menu">
    <summary>${escapeHtml(ui.docs.menu)}</summary>
    <nav aria-label="${escapeHtml(ui.docs.label)}">${pageList(doc, pages)}</nav>
  </details>
  <nav class="sidebar" aria-label="${escapeHtml(ui.docs.label)}">${pageList(doc, pages)}</nav>
  <main id="main" class="doc">
    <article class="doc-body">
      <header class="doc-head">
        <h1>${escapeHtml(doc.title)}</h1>
        <p class="doc-lede">${escapeHtml(doc.description)}</p>
      </header>
      <div class="prose">
${doc.html}
      </div>
      <p class="edit"><a href="${escapeHtml(editUrl)}">${escapeHtml(ui.docs.edit)}</a></p>
      ${pager(ctx, around)}
    </article>
    ${toc(ctx, doc)}
  </main>
</div>`)
}
