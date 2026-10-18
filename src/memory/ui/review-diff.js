import { h, icon } from './dom.js'
import { num, t } from './i18n.js'
import { addNote, composer, noteCard } from './review-notes.js'

export function parsePatch(patch) {
  const rows = []
  let o = 0
  let n = 0
  for (const line of String(patch ?? '').split('\n')) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line)
    if (hunk !== null) {
      o = Number(hunk[1])
      n = Number(hunk[2])
      rows.push({ type: 'hunk', text: line })
      continue
    }
    if (line.startsWith('\\')) { rows.push({ type: 'meta', text: line.slice(1).trim() }); continue }
    const sign = line[0]
    const text = line.slice(1)
    if (sign === '+') rows.push({ type: 'add', text, new: n++ })
    else if (sign === '-') rows.push({ type: 'del', text, old: o++ })
    else if (sign === ' ') rows.push({ type: 'ctx', text, old: o++, new: n++ })
  }
  return rows
}

function statusText(f) {
  return t(`review.status.${f.status}`)
}

function hiddenText(f) {
  return t(`review.hidden.${f.hidden}`)
}

function lineNo(row, side) {
  return side === 'old' ? row.old : row.new
}

export function codeWhere(n) {
  const range = n.end !== undefined && n.end > n.start ? `${n.start}-${n.end}` : `${n.start}`
  return n.side === 'old' ? t('review.whereOld', { file: n.file, lines: range }) : t('review.whereNew', { file: n.file, lines: range })
}

function fileSection(f, index, ctx) {
  const id = `file-${index}`
  const head = h('header', { class: 'file-head' },
    h('h3', { class: 'file-path' }, f.old !== undefined ? h('span', null, h('code', null, f.old), ' → ', h('code', null, f.path)) : h('code', null, f.path)),
    h('span', { class: 'badge' }, statusText(f)),
    h('span', { class: 'file-count' }, h('span', { class: 'plus' }, `+${num(f.add)}`), ' ', h('span', { class: 'minus' }, `−${num(f.del)}`)))
  const sec = h('section', { class: 'file', id, 'aria-labelledby': `${id}-h` })
  head.querySelector('h3').id = `${id}-h`
  sec.append(head)
  const mine = ctx.notes.filter((n) => n.file === f.path)
  if (f.hidden !== undefined || f.patch === undefined) {
    sec.append(h('p', { class: 'file-hidden' }, f.hidden !== undefined ? hiddenText(f) : t('review.hidden.empty')))
    if (mine.length > 0) sec.append(h('div', { class: 'file-notes' }, mine.map((n) => noteCard(n, ctx.cardCtx))))
    return sec
  }
  const rows = parsePatch(f.patch)
  const grid = h('div', { class: 'diff', role: 'table', 'aria-label': t('review.diffLabel', { file: f.path }) })
  const rowEls = []
  let sel = null
  let open = null
  const clearSel = () => {
    for (const r of rowEls) r.el.classList.remove('sel')
    open?.remove()
    open = null
    sel = null
  }
  const showComposer = () => {
    open?.remove()
    const picked = rowEls.filter((r) => r.el.classList.contains('sel'))
    const last = picked[picked.length - 1]
    if (last === undefined) return
    const quote = picked.map((r) => r.row.text).join('\n').slice(0, 1000)
    const where = codeWhere({ file: f.path, side: sel.side, start: sel.start, end: sel.end })
    open = h('div', { class: 'row-note', role: 'row' }, h('div', { role: 'cell' }, composer({
      quote, code: true, where,
      onSave: async (text) => {
        const r = await addNote(ctx.target, { kind: 'code', file: f.path, side: sel.side, start: sel.start, end: sel.end, quote, text })
        if (r.ok) { clearSel(); ctx.changed(r.body, t('review.saved')) }
        return r
      },
      onCancel: () => clearSel(),
    })))
    last.el.after(open)
  }
  const pick = (row, side, shift) => {
    const nline = lineNo(row, side)
    if (nline === undefined) return
    if (shift && sel !== null && sel.side === side) {
      sel.start = Math.min(sel.anchor, nline)
      sel.end = Math.max(sel.anchor, nline)
    } else {
      sel = { side, anchor: nline, start: nline, end: nline }
    }
    for (const r of rowEls) {
      const v = lineNo(r.row, side)
      r.el.classList.toggle('sel', v !== undefined && v >= sel.start && v <= sel.end && (side === 'new' ? r.row.type !== 'del' : r.row.type !== 'add'))
    }
    showComposer()
  }
  for (const row of rows) {
    if (row.type === 'hunk' || row.type === 'meta') {
      grid.append(h('div', { class: `row ${row.type}`, role: 'row' }, h('span', { class: 'code', role: 'cell' }, row.text)))
      continue
    }
    const btn = (side) => {
      const v = lineNo(row, side)
      if (v === undefined) return h('span', { class: 'ln', role: 'cell' })
      const b = h('button', { type: 'button', class: 'ln', role: 'cell', 'aria-label': t(side === 'old' ? 'review.noteOnOld' : 'review.noteOnNew', { n: v }) }, String(v))
      b.addEventListener('click', (e) => pick(row, side, e.shiftKey))
      return b
    }
    const el = h('div', { class: `row ${row.type}`, role: 'row' }, btn('old'), btn('new'), h('span', { class: 'code', role: 'cell' }, h('span', { class: 'sign', 'aria-hidden': 'true' }, row.type === 'add' ? '+' : row.type === 'del' ? '-' : ' '), row.text))
    rowEls.push({ row, el })
    grid.append(el)
  }
  const placed = new Set()
  for (const n of mine) {
    const at = [...rowEls].reverse().find((r) => lineNo(r.row, n.side ?? 'new') === n.end && (n.side === 'old' ? r.row.type !== 'add' : r.row.type !== 'del'))
    if (at === undefined) continue
    at.el.classList.add('noted')
    at.el.after(h('div', { class: 'row-note', role: 'row' }, h('div', { role: 'cell' }, noteCard(n, ctx.cardCtx))))
    placed.add(n.id)
  }
  const rest = mine.filter((n) => !placed.has(n.id))
  if (rest.length > 0) sec.append(h('div', { class: 'file-notes' }, h('p', { class: 'meta' }, t('review.notesMoved')), rest.map((n) => noteCard(n, ctx.cardCtx))))
  sec.append(h('div', { class: 'diff-scroll' }, grid))
  return sec
}

export function renderChanges(data, ctx) {
  const wrap = h('div', { class: 'changes' })
  const files = data.files ?? []
  const index = h('ol', { class: 'file-index' })
  files.forEach((f, i) => {
    const b = h('button', { type: 'button', class: 'file-link' }, h('code', null, f.path), h('span', { class: 'file-count' }, h('span', { class: 'plus' }, `+${num(f.add)}`), ' ', h('span', { class: 'minus' }, `−${num(f.del)}`)))
    b.addEventListener('click', () => {
      const el = document.getElementById(`file-${i}`)
      el?.scrollIntoView({ behavior: ctx.reducedMotion ? 'auto' : 'smooth', block: 'start' })
      el?.querySelector('button, [tabindex]')?.focus({ preventScroll: true })
    })
    index.append(h('li', null, b))
  })
  if (files.length === 0) wrap.append(h('p', { class: 'empty' }, data.scope?.warning ?? t('review.noChanges')))
  else wrap.append(h('nav', { class: 'file-nav', 'aria-label': t('review.filesLabel') }, h('h3', null, files.length === 1 ? t('review.filesOne') : t('review.files', { n: num(files.length) })), index))
  files.forEach((f, i) => wrap.append(fileSection(f, i, ctx)))
  return wrap
}

export function changesHead(data) {
  const s = data.scope ?? {}
  const c = data.checkout ?? {}
  const what = s.mode !== 'working-tree' ? t('review.scopeBranch', { branch: c.branch ?? s.branch ?? t('review.detached'), base: s.base ?? '' })
    : s.base_ref === 'HEAD' ? t('review.scopeUncommitted') : t('review.scopeWorking', { base: s.base ?? '' })
  return h('div', { class: 'doc-head' },
    h('p', { class: 'kicker' }, c.main ? t('review.mainCheckout') : t('review.worktree')),
    h('h2', { tabindex: '-1', id: 'view-title' }, c.branch ?? t('review.detached')),
    h('p', { class: 'doc-path' }, h('code', null, c.shown ?? c.path ?? '')),
    h('p', { class: 'lead-line' }, what),
    s.warning ? h('p', { class: 'warn-line' }, icon('alert', 'icon xs'), h('span', null, s.warning)) : null,
    h('p', { class: 'hint-line' }, t('review.changesHint')))
}
