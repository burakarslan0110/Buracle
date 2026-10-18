import { h } from './dom.js'
import { t } from './i18n.js'

const HEAD_RE = /^(#{1,6})\s+(.*?)\s*#*\s*$/
const LIST_RE = /^(\s*)([-*+]|\d{1,4}[.)])\s+(.*)$/
const FENCE_RE = /^\s*(```+|~~~+)\s*([\w+-]*)/
const RULE_RE = /^\s*(?:[-*_]\s*){3,}$/
const TABLE_SEP_RE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/

function safeHref(url) {
  return /^https?:\/\//i.test(url) ? url : null
}

export function inline(text) {
  const out = []
  const re = /`([^`\n]+)`|\*\*([^*\n]+)\*\*|__([^_\n]+)__|\*([^*\n]+)\*|(?<![\w])_([^_\n]+)_(?![\w])|\[([^\]\n]+)\]\(([^)\s]+)\)/g
  let last = 0
  let m
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index))
    if (m[1] !== undefined) out.push(h('code', null, m[1]))
    else if (m[2] !== undefined || m[3] !== undefined) out.push(h('strong', null, inline(m[2] ?? m[3])))
    else if (m[4] !== undefined || m[5] !== undefined) out.push(h('em', null, inline(m[4] ?? m[5])))
    else {
      const href = safeHref(m[7])
      out.push(href !== null ? h('a', { href, rel: 'noopener noreferrer', target: '_blank' }, m[6]) : h('span', { class: 'md-link' }, m[6]))
    }
    last = re.lastIndex
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

function joined(parent, children, sep = '\n') {
  children.forEach((c, i) => {
    if (i > 0) parent.append(document.createTextNode(sep))
    parent.append(c)
  })
  return parent
}

function block(tag, line, end, attrs, ...children) {
  return h(tag, { ...(attrs ?? {}), 'data-line': line, 'data-end': end }, ...children)
}

function cells(row) {
  const s = row.trim().replace(/^\|/, '').replace(/\|$/, '')
  const out = []
  let cur = ''
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (ch === '\\' && s[i + 1] === '|') { cur += '|'; i++; continue }
    if (ch === '|') { out.push(cur.trim()); cur = ''; continue }
    cur += ch
  }
  out.push(cur.trim())
  return out
}

function frontmatter(lines) {
  if ((lines[0] ?? '').trim() !== '---') return null
  for (let i = 1; i < Math.min(lines.length, 80); i++) {
    if ((lines[i] ?? '').trim() === '---') {
      const rows = lines.slice(1, i).map((l) => /^([\w.-]+):\s*(.*)$/.exec(l)).filter(Boolean)
      return { end: i + 1, rows: rows.map((m) => [m[1], m[2].replace(/^["']|["']$/g, '')]) }
    }
  }
  return null
}

function listItem(text) {
  const task = /^\[([ xX])\]\s+(.*)$/.exec(text)
  if (task === null) return { done: null, text }
  return { done: task[1] !== ' ', text: task[2] }
}

function renderList(lines, i, baseIndent) {
  const first = LIST_RE.exec(lines[i])
  const ordered = /\d/.test(first[2])
  const start = i
  const items = []
  while (i < lines.length) {
    const m = LIST_RE.exec(lines[i] ?? '')
    if (m === null || m[1].length < baseIndent) break
    if (m[1].length > baseIndent) {
      const nested = renderList(lines, i, m[1].length)
      const last = items[items.length - 1]
      if (last !== undefined) last.el.append(document.createTextNode('\n'), nested.el)
      i = nested.next
      continue
    }
    const line = i + 1
    const parts = [m[3]]
    i++
    while (i < lines.length) {
      const next = lines[i] ?? ''
      if (next.trim() === '' || LIST_RE.test(next) || HEAD_RE.test(next) || FENCE_RE.test(next) || /^\s*\|/.test(next)) break
      if (!/^\s{2,}/.test(next)) break
      parts.push(next.trim())
      i++
    }
    const it = listItem(parts.join(' '))
    const li = block('li', line, i, it.done !== null ? { class: it.done ? 'task done' : 'task' } : null)
    if (it.done !== null) li.append(h('span', { class: 'task-box', role: 'img', 'aria-label': t(it.done ? 'review.taskDone' : 'review.taskOpen') }))
    li.append(...inline(it.text))
    items.push({ el: li })
    while (i < lines.length && (lines[i] ?? '').trim() === '' && (LIST_RE.exec(lines[i + 1] ?? '')?.[1].length ?? -1) >= baseIndent) i++
  }
  const list = block(ordered ? 'ol' : 'ul', start + 1, i)
  joined(list, items.map((x) => x.el))
  return { el: list, next: i }
}

export function renderDoc(text) {
  const root = h('div', { class: 'doc md-doc' })
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n')
  const blocks = []
  let i = 0
  const fm = frontmatter(lines)
  if (fm !== null) {
    const dl = block('dl', 1, fm.end, { class: 'fm' })
    for (const [k, v] of fm.rows) dl.append(h('dt', null, k), document.createTextNode(' '), h('dd', null, v), document.createTextNode('\n'))
    blocks.push(dl)
    i = fm.end
  }
  while (i < lines.length) {
    const line = lines[i] ?? ''
    if (line.trim() === '') { i++; continue }
    if (/^\s*<!--/.test(line)) {
      while (i < lines.length && !(lines[i] ?? '').includes('-->')) i++
      i++
      continue
    }
    const fence = FENCE_RE.exec(line)
    if (fence !== null) {
      const mark = fence[1]
      const start = i
      const body = []
      i++
      while (i < lines.length && !(lines[i] ?? '').trim().startsWith(mark)) body.push(lines[i++])
      i++
      const pre = block('pre', start + 1, i, fence[2] ? { 'data-lang': fence[2] } : null, h('code', null, body.join('\n')))
      blocks.push(pre)
      continue
    }
    const head = HEAD_RE.exec(line)
    if (head !== null) {
      blocks.push(block(`h${Math.min(6, head[1].length + 1)}`, i + 1, i + 1, null, ...inline(head[2])))
      i++
      continue
    }
    if (RULE_RE.test(line)) { blocks.push(block('hr', i + 1, i + 1)); i++; continue }
    if (/^\s*\|/.test(line) && TABLE_SEP_RE.test(lines[i + 1] ?? '')) {
      const start = i
      const header = cells(line)
      i += 2
      const rows = []
      while (i < lines.length && /^\s*\|/.test(lines[i] ?? '')) rows.push({ line: i + 1, cells: cells(lines[i++]) })
      const thead = h('thead', null, joined(h('tr'), header.map((c) => h('th', null, ...inline(c))), ' '))
      const tbody = h('tbody')
      joined(tbody, rows.map((r) => joined(h('tr', { 'data-line': r.line }), r.cells.map((c) => h('td', null, ...inline(c))), ' ')))
      blocks.push(block('div', start + 1, i, { class: 'table-wrap' }, h('table', null, thead, document.createTextNode('\n'), tbody)))
      continue
    }
    if (LIST_RE.test(line)) {
      const r = renderList(lines, i, LIST_RE.exec(line)[1].length)
      blocks.push(r.el)
      i = r.next
      continue
    }
    if (/^\s*>/.test(line)) {
      const start = i
      const quote = []
      while (i < lines.length && /^\s*>/.test(lines[i] ?? '')) quote.push((lines[i++] ?? '').replace(/^\s*>\s?/, ''))
      blocks.push(block('blockquote', start + 1, i, null, ...inline(quote.join(' '))))
      continue
    }
    const start = i
    const para = []
    while (i < lines.length) {
      const l = lines[i] ?? ''
      if (l.trim() === '' || LIST_RE.test(l) || HEAD_RE.test(l) || FENCE_RE.test(l) || /^\s*>/.test(l) || (/^\s*\|/.test(l) && TABLE_SEP_RE.test(lines[i + 1] ?? '')) || /^\s*<!--/.test(l)) break
      para.push(l.trim())
      i++
    }
    blocks.push(block('p', start + 1, i, null, ...inline(para.join(' '))))
  }
  joined(root, blocks)
  return root
}

function textIndex(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const nodes = []
  let text = ''
  while (walker.nextNode()) {
    const n = walker.currentNode
    if (n.parentElement?.closest('.sr-only')) continue
    nodes.push({ n, start: text.length })
    text += n.data
  }
  let norm = ''
  const map = []
  let space = true
  for (let k = 0; k < text.length; k++) {
    const ch = text[k]
    if (/\s/.test(ch)) {
      if (space) continue
      norm += ' '
      map.push(k)
      space = true
    } else {
      norm += ch
      map.push(k)
      space = false
    }
  }
  return { nodes, norm, map }
}

export function normQuote(q) {
  return String(q ?? '').replace(/\s+/g, ' ').trim()
}

export function markQuote(root, quote, attrs) {
  const q = normQuote(quote)
  if (q === '') return []
  const idx = textIndex(root)
  const at = idx.norm.indexOf(q)
  if (at < 0) return []
  const from = idx.map[at]
  const to = idx.map[at + q.length - 1] + 1
  const segs = []
  for (const { n, start } of idx.nodes) {
    const end = start + n.data.length
    if (end <= from || start >= to) continue
    const a = Math.max(from, start) - start
    const b = Math.min(to, end) - start
    if (n.data.slice(a, b).trim() === '') continue
    segs.push({ n, a, b })
  }
  const marks = []
  for (const { n, a, b } of segs) {
    const range = document.createRange()
    range.setStart(n, a)
    range.setEnd(n, b)
    const mark = h('mark', attrs)
    try { range.surroundContents(mark); marks.push(mark) } catch {  }
  }
  return marks
}

export function blockAt(root, line) {
  if (typeof line !== 'number') return null
  let best = null
  for (const el of root.querySelectorAll('[data-line]')) {
    const a = Number(el.dataset.line)
    const b = Number(el.dataset.end ?? a)
    if (a <= line && line <= Math.max(a, b)) best = el
  }
  return best
}

export function selectionIn(root) {
  const sel = window.getSelection()
  if (sel === null || sel.rangeCount === 0 || sel.isCollapsed) return null
  const range = sel.getRangeAt(0)
  if (!root.contains(range.commonAncestorContainer)) return null
  const quote = normQuote(sel.toString())
  if (quote === '') return null
  const startEl = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement
  const blockEl = startEl?.closest('[data-line]')
  const line = blockEl !== null && blockEl !== undefined ? Number(blockEl.dataset.line) : undefined
  const rect = range.getBoundingClientRect()
  return { quote: quote.slice(0, 1200), line: Number.isFinite(line) ? line : undefined, rect }
}
