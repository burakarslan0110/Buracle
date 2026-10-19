import { getJson, h, icon } from './dom.js'
import { lang, num, relTime, t } from './i18n.js'
import { LOGO, pixelArt } from './logo.js'
import { errorText, getJsonWithToken } from './manage.js'
import { blockAt, markQuote, renderDoc, selectionIn } from './review-doc.js'
import { changesHead, codeWhere, renderChanges } from './review-diff.js'
import { addNote, composer, notesList } from './review-notes.js'
import { createTheme } from './theme.js'

const $ = (id) => document.getElementById(id)
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches
const POLL_MS = 15000

const state = { listing: null, tab: 'docs', view: null, data: null, seq: 0, sig: '' }

function applyWords() {
  document.documentElement.lang = lang
  document.title = t('review.title')
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n)
  for (const el of document.querySelectorAll('[data-i18n-label]')) el.setAttribute('aria-label', t(el.dataset.i18nLabel))
  for (const el of document.querySelectorAll('[data-i18n-title]')) el.setAttribute('title', t(el.dataset.i18nTitle))
}

applyWords()
$('brand-logo').append(pixelArt(LOGO, 'brand-art', 'brand-art-fill'))
$('to-brain-icon').append(icon('back', 'icon xs'))
$('btn-refresh').append(icon('loop'))
createTheme($('btn-theme'), () => {})

function announce(text) {
  $('announce').textContent = text
}

function param(key) {
  try { return new URL(location.href).searchParams.get(key) } catch { return null }
}

function setParams(view) {
  try {
    const u = new URL(location.href)
    u.searchParams.delete('doc')
    u.searchParams.delete('checkout')
    if (view !== null) u.searchParams.set(view.kind === 'doc' ? 'doc' : 'checkout', view.id)
    history.replaceState(null, '', u)
  } catch {  }
}

function docKind(d) {
  if (d.dir === 'prd') return t('review.kindPrd')
  if (d.dir === 'builds' || d.type === 'Build') return t('review.kindBuild')
  if (d.type === 'Bugfix') return t('review.kindBugfix')
  return t('review.kindPlan')
}

function waiting(d) {
  if (d.session !== undefined) return d.session.paused && d.session.phase === 'plan' && d.approved !== true
  return d.asked !== undefined && d.approved !== true
}

function docBadges(d) {
  const out = [h('span', { class: 'badge' }, docKind(d))]
  if (waiting(d)) out.push(h('span', { class: 'badge warn' }, t('review.waiting')))
  else if (d.status !== undefined) out.push(h('span', { class: 'badge muted' }, d.status))
  if (d.open > 0) out.push(h('span', { class: 'badge accent' }, t(d.open === 1 ? 'review.openOne' : 'review.openMany', { n: num(d.open) })))
  return out
}

function sideItem(label, sub, badges, selected, onPick) {
  const b = h('button', { type: 'button', class: 'side-item', 'aria-current': selected ? 'true' : null },
    h('span', { class: 'side-title' }, label),
    sub ? h('span', { class: 'side-sub' }, sub) : null,
    badges.length > 0 ? h('span', { class: 'badges' }, badges) : null)
  b.addEventListener('click', onPick)
  return h('li', null, b)
}

function renderSide() {
  const l = state.listing
  const docs = $('list-docs')
  const changes = $('list-changes')
  if (l === null) return
  const repos = l.repos ?? []
  const docGroups = repos.filter((r) => r.docs.length > 0).map((r) => h('section', { class: 'side-group' },
    h('h2', null, r.name),
    h('ul', null, r.docs.map((d) => sideItem(d.title, d.rel, docBadges(d), state.view?.kind === 'doc' && state.view.id === d.id, () => openView({ kind: 'doc', id: d.id }, true))))))
  docs.replaceChildren(...(docGroups.length > 0 ? docGroups : [h('p', { class: 'empty' }, t('review.noDocs'))]))
  const coGroups = repos.filter((r) => r.checkouts.length > 0).map((r) => h('section', { class: 'side-group' },
    h('h2', null, r.name),
    h('ul', null, r.checkouts.map((c) => sideItem(c.branch ?? t('review.detached'), c.shown ?? c.path,
      [h('span', { class: 'badge' }, c.main ? t('review.mainCheckout') : t('review.worktree')), ...(c.open > 0 ? [h('span', { class: 'badge accent' }, t(c.open === 1 ? 'review.openOne' : 'review.openMany', { n: num(c.open) }))] : [])],
      state.view?.kind === 'changes' && state.view.id === c.id, () => openView({ kind: 'changes', id: c.id }, true))))))
  changes.replaceChildren(...(coGroups.length > 0 ? coGroups : [h('p', { class: 'empty' }, t('review.noCheckouts'))]))
}

function setTab(tab, focus = false) {
  state.tab = tab
  for (const [name, list] of [['docs', 'list-docs'], ['changes', 'list-changes']]) {
    const btn = $(`tab-${name}`)
    btn.setAttribute('aria-selected', String(tab === name))
    btn.tabIndex = tab === name ? 0 : -1
    $(list).hidden = tab !== name
  }
  if (focus) $(`tab-${tab}`).focus()
}

$('tab-docs').addEventListener('click', () => setTab('docs'))
$('tab-changes').addEventListener('click', () => setTab('changes'))
$('tabs').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); setTab(state.tab === 'docs' ? 'changes' : 'docs', true) }
})

function emptyMain() {
  $('main').replaceChildren(h('div', { class: 'review-empty' },
    h('h2', null, t('review.emptyTitle')),
    h('p', null, t('review.emptyLead')),
    h('ul', null, h('li', null, t('review.emptyPlans')), h('li', null, t('review.emptyChanges')), h('li', null, t('review.emptyAgent')))))
}

function errorMain(r) {
  const retry = h('button', { type: 'button', class: 'btn sm' }, t('btn.retry'))
  retry.addEventListener('click', () => { void reload() })
  $('main').replaceChildren(h('div', { class: 'review-empty', role: 'alert' }, h('h2', null, icon('alert', 'icon'), t('state.error')), h('p', null, errorText(r)), retry))
}

async function loadListing() {
  const r = await getJson('/api/review/docs')
  if (!r.ok) return r
  state.listing = r.body
  renderSide()
  return r
}

function viewSig(view) {
  const l = state.listing
  if (l === null || view === null) return ''
  for (const repo of l.repos ?? []) {
    if (view.kind === 'doc') { const d = repo.docs.find((x) => x.id === view.id); if (d) return `${d.modified}|${d.open}|${d.done}` }
    else { const c = repo.checkouts.find((x) => x.id === view.id); if (c) return `${c.open}` }
  }
  return ''
}

let popover = null
let addBtn = null

function closePopover() {
  popover?.remove()
  popover = null
  addBtn?.remove()
  addBtn = null
}

function notesRail(notes, ctx, title) {
  return h('aside', { class: 'notes-rail', 'aria-labelledby': 'rail-title' },
    h('h3', { id: 'rail-title' }, title),
    notesList(notes, ctx))
}

function flash(el) {
  if (el === null || el === undefined) return
  el.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'center' })
  el.classList.remove('flash')
  void el.offsetWidth
  el.classList.add('flash')
}

function afterChange(body, message) {
  announce(message)
  closePopover()
  void reload(true, true)
}

function docView(d) {
  const target = { doc: d.id }
  const head = h('div', { class: 'doc-head' },
    h('p', { class: 'kicker' }, docKind(d)),
    h('h2', { tabindex: '-1', id: 'view-title' }, d.title),
    h('p', { class: 'doc-path' }, h('code', null, d.rel)),
    h('p', { class: 'badges' }, docBadges(d), h('span', { class: 'meta-inline' }, t('review.modified', { t: relTime(d.modified) }))),
    waiting(d) ? h('p', { class: 'warn-line' }, icon('clock', 'icon xs'), h('span', null, t('review.waitingLead'))) : null,
    h('p', { class: 'hint-line' }, t('review.docHint')),
    d.changes ? (() => { const b = h('button', { type: 'button', class: 'link' }, t('review.seeChanges')); b.addEventListener('click', () => { setTab('changes'); openView({ kind: 'changes', id: d.changes }, true) }); return b })() : null)
  const doc = renderDoc(d.text)
  const marks = new Map()
  const notes = d.notes ?? []
  for (const n of [...notes].sort((a, b) => Number(a.done !== undefined) - Number(b.done !== undefined))) {
    const attrs = { class: `note-mark${n.done !== undefined ? ' done' : ''}`, 'data-note': n.id, title: n.text }
    let got = []
    const blk = blockAt(doc, n.line)
    if (blk !== null) got = markQuote(blk, n.quote, attrs)
    if (got.length === 0) got = markQuote(doc, n.quote, attrs)
    if (got.length > 0) marks.set(n.id, got[0])
  }
  const cardCtx = {
    target,
    where: (n) => (marks.has(n.id) ? (n.line !== undefined ? t('review.atLine', { n: n.line }) : t('review.inDoc')) : t('review.passageGone')),
    changed: afterChange,
    focus: (n) => flash(marks.get(n.id)),
    emptyText: t('review.noNotesDoc'),
  }
  const scroller = h('div', { class: 'doc-scroll' }, head, doc)
  const rail = notesRail(notes, cardCtx, t('review.notesTitle'))
  doc.addEventListener('click', (e) => {
    const m = e.target instanceof Element ? e.target.closest('mark.note-mark') : null
    if (m === null) return
    const card = rail.querySelector(`[data-note="${m.dataset.note}"]`)
    if (card !== null) {
      card.closest('details')?.setAttribute('open', '')
      flash(card)
      card.focus({ preventScroll: true })
    }
  })
  const offer = () => {
    if (popover !== null) return
    const s = selectionIn(doc)
    addBtn?.remove()
    addBtn = null
    if (s === null) return
    const box = scroller.getBoundingClientRect()
    const b = h('button', { type: 'button', class: 'btn sm add-note' }, icon('pin', 'icon xs'), t('review.addNote'))
    b.style.top = `${s.rect.bottom - box.top + scroller.scrollTop + 6}px`
    b.style.left = `${Math.max(8, Math.min(s.rect.left - box.left, box.width - 160))}px`
    b.addEventListener('mousedown', (e) => e.preventDefault())
    b.addEventListener('click', () => {
      b.remove()
      addBtn = null
      const card = composer({
        quote: s.quote,
        where: s.line !== undefined ? t('review.atLine', { n: s.line }) : t('review.inDoc'),
        onSave: async (text) => {
          const r = await addNote(target, { kind: 'plan', quote: s.quote, ...(s.line !== undefined ? { line: s.line } : {}), text })
          if (r.ok) { window.getSelection()?.removeAllRanges(); afterChange(r.body, t('review.saved')) }
          return r
        },
        onCancel: () => { closePopover(); scroller.focus({ preventScroll: true }) },
      })
      popover = h('div', { class: 'popover' }, card)
      popover.style.top = b.style.top
      popover.style.left = `${Math.max(8, Math.min(s.rect.left - box.left, box.width - Math.min(440, box.width - 16) - 8))}px`
      scroller.append(popover)
      requestAnimationFrame(() => popover?.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'nearest' }))
    })
    addBtn = b
    scroller.append(b)
  }
  doc.addEventListener('mouseup', () => setTimeout(offer, 0))
  doc.addEventListener('keyup', (e) => { if (e.shiftKey || e.key === 'Shift') offer() })
  scroller.tabIndex = -1
  return h('div', { class: 'doc-view' }, scroller, rail)
}

function changesView(d) {
  const target = { checkout: d.checkout.id }
  const notes = d.notes ?? []
  const cardCtx = {
    target,
    where: (n) => codeWhere(n),
    changed: afterChange,
    focus: (n) => {
      const card = [...document.querySelectorAll(`.changes [data-note="${n.id}"]`)][0]
      flash(card ?? null)
    },
    emptyText: t('review.noNotesCode'),
  }
  const body = renderChanges(d, { target, notes, changed: afterChange, cardCtx, reducedMotion })
  const scroller = h('div', { class: 'doc-scroll' }, changesHead(d), body)
  const railCtx = { ...cardCtx, focus: (n) => cardCtx.focus(n) }
  return h('div', { class: 'doc-view' }, scroller, notesRail(notes, railCtx, t('review.notesTitle')))
}

async function openView(view, user = false, quiet = false) {
  const seq = ++state.seq
  closePopover()
  state.view = view
  setParams(view)
  renderSide()
  if (view === null) { state.data = null; emptyMain(); return }
  const main = $('main')
  const keep = quiet ? main.querySelector('.doc-scroll')?.scrollTop ?? 0 : 0
  if (!quiet) main.replaceChildren(h('p', { class: 'empty loading' }, t('detail.loading')))
  const url = view.kind === 'doc' ? `/api/review/doc?id=${encodeURIComponent(view.id)}` : `/api/review/changes?checkout=${encodeURIComponent(view.id)}`
  const r = await getJsonWithToken(url)
  if (seq !== state.seq) return
  if (!r.ok) { errorMain(r); return }
  state.data = r.body
  state.sig = viewSig(view)
  main.replaceChildren(view.kind === 'doc' ? docView(r.body) : changesView(r.body))
  if (quiet) { const s = main.querySelector('.doc-scroll'); if (s) s.scrollTop = keep }
  if (user) $('view-title')?.focus({ preventScroll: true })
}

function busy() {
  const a = document.activeElement
  return popover !== null || (a instanceof HTMLTextAreaElement && $('main').contains(a)) || $('main').querySelector('.confirm') !== null
}

async function reload(quiet = false, force = false) {
  const r = await loadListing()
  if (!r.ok) { if (!quiet) errorMain(r); return }
  if (state.view !== null && (force || ((!quiet || viewSig(state.view) !== state.sig) && !busy()))) await openView(state.view, false, true)
}

$('btn-refresh').addEventListener('click', () => { void reload().then(() => announce(t('review.refreshed'))) })

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && popover !== null) { closePopover() }
})

function firstWaiting() {
  for (const repo of state.listing?.repos ?? []) for (const d of repo.docs) if (waiting(d) || d.open > 0) return d.id
  return null
}

async function boot() {
  const r = await loadListing()
  if (!r.ok) { errorMain(r); return }
  const doc = param('doc')
  const checkout = param('checkout')
  if (checkout !== null) { setTab('changes'); await openView({ kind: 'changes', id: checkout }) }
  else if (doc !== null) await openView({ kind: 'doc', id: doc })
  else {
    const w = firstWaiting()
    if (w !== null) await openView({ kind: 'doc', id: w })
    else emptyMain()
  }
}

setInterval(() => { if (!document.hidden) void reload(true) }, POLL_MS)
window.addEventListener('focus', () => { void reload(true) })

void boot()
