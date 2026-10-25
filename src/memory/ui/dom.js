const SVG_NS = 'http://www.w3.org/2000/svg'

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag)
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue
      if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v)
      else if (k === 'class') el.className = v
      else if (k === 'text') el.textContent = String(v)
      else el.setAttribute(k, v === true ? '' : String(v))
    }
  }
  append(el, children)
  return el
}

function append(el, children) {
  for (const c of children) {
    if (c === undefined || c === null || c === false) continue
    if (Array.isArray(c)) append(el, c)
    else el.append(c instanceof Node ? c : document.createTextNode(String(c)))
  }
}

export function fill(el, ...children) {
  el.replaceChildren()
  append(el, children)
  return el
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild)
  return el
}

export function holdPlace(el) {
  const top = el.scrollTop
  const a = document.activeElement
  const key = a instanceof HTMLElement && el.contains(a) ? a.dataset.key : undefined
  return () => {
    el.scrollTop = top
    if (key !== undefined) el.querySelector(`[data-key="${key}"]`)?.focus({ preventScroll: true })
  }
}

const ICONS = {
  search: ['M11 18a7 7 0 1 1 0-14 7 7 0 0 1 0 14z', 'M20.5 20.5 16 16'],
  close: ['M18 6 6 18', 'M6 6l12 12'],
  back: ['M19 12H5', 'M11 18l-6-6 6-6'],
  user: ['M19 20a7 7 0 0 0-14 0', 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z'],
  sparkle: ['M11 3l1.6 4.9L17.5 9.5l-4.9 1.6L11 16l-1.6-4.9L4.5 9.5l4.9-1.6z', 'M18.5 14.5l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z'],
  pin: ['M12 16v5', 'M8.5 3.5h7l-1 5.5 3 3V14h-11v-2l3-3z'],
  eye: ['M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z', 'M12 14.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z'],
  alert: ['M12 4 2.8 19.5h18.4z', 'M12 10v4', 'M12 17h.01'],
  check: ['M5 12.5l4.5 4.5L19 7.5'],
  file: ['M14 3.5H7a1.5 1.5 0 0 0-1.5 1.5v14A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V8z', 'M14 3.5V8h4.5'],
  clock: ['M12 20.5a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17z', 'M12 7.5V12l3 2'],
  graph: ['M6 8.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z', 'M18 11a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z', 'M10 20.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z', 'M8.3 7l7.4 1.6', 'M6.9 8.4l2.3 7.2', 'M16.4 10.6l-4.9 5.6'],
  loop: ['M19.5 12a7.5 7.5 0 1 1-2.2-5.3', 'M19.5 4.5v4h-4', 'M12 9v3l2 1.5'],
  plus: ['M12 5.5v13', 'M5.5 12h13'],
  minus: ['M5.5 12h13'],
  fit: ['M4.5 9V4.5H9', 'M19.5 9V4.5H15', 'M4.5 15v4.5H9', 'M19.5 15v4.5H15'],
  shield: ['M12 3.5l7 2.8v5.2c0 4.4-3 7.6-7 9-4-1.4-7-4.6-7-9V6.3z', 'M9 12l2.2 2.2L15.5 10'],
  pulse: ['M3 12h4l2.5-6 5 12 2.5-6h4'],
  chart: ['M4 20h16', 'M7 16.5v-5', 'M12 16.5V6.5', 'M17 16.5v-8'],
  bell: ['M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15z', 'M10 21a2 2 0 0 0 4 0'],
  gear: [
    'M19.23 13.04L21.36 14.12L20.12 17.12L17.84 16.38A7.3 7.3 0 0 1 16.38 17.84L17.12 20.12L14.12 21.36L13.04 19.23A7.3 7.3 0 0 1 10.96 19.23L9.88 21.36L6.88 20.12L7.62 17.84A7.3 7.3 0 0 1 6.16 16.38L3.88 17.12L2.64 14.12L4.77 13.04A7.3 7.3 0 0 1 4.77 10.96L2.64 9.88L3.88 6.88L6.16 7.62A7.3 7.3 0 0 1 7.62 6.16L6.88 3.88L9.88 2.64L10.96 4.77A7.3 7.3 0 0 1 13.04 4.77L14.12 2.64L17.12 3.88L16.38 6.16A7.3 7.3 0 0 1 17.84 7.62L20.12 6.88L21.36 9.88L19.23 10.96A7.3 7.3 0 0 1 19.23 13.04z',
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  ],
  pen: ['M4.5 19.5l1-4.2L16.4 4.4a1.9 1.9 0 0 1 2.7 0l.5.5a1.9 1.9 0 0 1 0 2.7L8.7 18.5z', 'M14.5 6.3l3.2 3.2'],
  trash: ['M4.5 7h15', 'M9.5 7V4.5h5V7', 'M6.5 7l1 12.5h9l1-12.5', 'M10 11v5', 'M14 11v5'],
  sun: ['M12 16.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9z', 'M12 2.5v2.2', 'M12 19.3v2.2', 'M4.3 4.3l1.6 1.6', 'M18.1 18.1l1.6 1.6', 'M2.5 12h2.2', 'M19.3 12h2.2', 'M4.3 19.7l1.6-1.6', 'M18.1 5.9l1.6-1.6'],
  moon: ['M19.5 14.6A8 8 0 0 1 9.4 4.5a8 8 0 1 0 10.1 10.1z'],
}

export function icon(name, cls = 'icon') {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('class', cls)
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('focusable', 'false')
  for (const d of ICONS[name] ?? []) {
    const p = document.createElementNS(SVG_NS, 'path')
    p.setAttribute('d', d)
    svg.append(p)
  }
  return svg
}

export function svg(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag)
  for (const [k, v] of Object.entries(attrs ?? {})) el.setAttribute(k, String(v))
  return el
}

function inline(text) {
  const out = []
  const re = /`([^`\n]+)`|\*\*([^*\n]+)\*\*/g
  let last = 0
  let m
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index))
    out.push(m[1] !== undefined ? h('code', null, m[1]) : h('strong', null, m[2]))
    last = re.lastIndex
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

const LIST_RE = /^\s*(?:[-*+]|\d{1,3}[.)])\s+(.*)$/
const HEAD_RE = /^(#{1,6})\s+(.*)$/

export function md(text) {
  const frag = document.createDocumentFragment()
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n')
  let i = 0
  while (i < lines.length) {
    const line = lines[i] ?? ''
    if (line.trim() === '') { i++; continue }
    if (/^\s*```/.test(line)) {
      const body = []
      i++
      while (i < lines.length && !/^\s*```/.test(lines[i] ?? '')) body.push(lines[i++])
      i++
      frag.append(h('pre', null, h('code', null, body.join('\n'))))
      continue
    }
    if (/^<!--.*-->\s*$/.test(line.trim())) { i++; continue }
    const head = HEAD_RE.exec(line)
    if (head) {
      frag.append(h(head[1].length <= 2 ? 'h4' : 'h5', null, inline(head[2])))
      i++
      continue
    }
    if (LIST_RE.test(line)) {
      const ordered = /^\s*\d/.test(line)
      const list = h(ordered ? 'ol' : 'ul')
      while (i < lines.length && LIST_RE.test(lines[i] ?? '')) {
        list.append(h('li', null, inline(LIST_RE.exec(lines[i])[1])))
        i++
      }
      frag.append(list)
      continue
    }
    if (/^\s*>/.test(line)) {
      const quote = []
      while (i < lines.length && /^\s*>/.test(lines[i] ?? '')) quote.push((lines[i++] ?? '').replace(/^\s*>\s?/, ''))
      frag.append(h('blockquote', null, inline(quote.join(' '))))
      continue
    }
    const para = []
    while (i < lines.length && (lines[i] ?? '').trim() !== '' && !LIST_RE.test(lines[i]) && !HEAD_RE.test(lines[i]) && !/^\s*(```|>)/.test(lines[i])) para.push((lines[i++] ?? '').trim())
    frag.append(h('p', null, inline(para.join(' '))))
  }
  return frag
}

export async function getJson(url, signal, headers = {}) {
  try {
    const r = await fetch(url, { headers: { accept: 'application/json', ...headers }, signal })
    let body = null
    try { body = await r.json() } catch {  }
    return { ok: r.ok, status: r.status, body }
  } catch (e) {
    if (e && e.name === 'AbortError') throw e
    return { ok: false, status: 0, body: null }
  }
}

export function debounce(fn, ms) {
  let timer = 0
  const d = (...args) => {
    clearTimeout(timer)
    timer = setTimeout(() => fn(...args), ms)
  }
  d.cancel = () => clearTimeout(timer)
  return d
}

export function hash32(s) {
  let x = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    x ^= s.charCodeAt(i)
    x = Math.imul(x, 0x01000193)
  }
  return x >>> 0
}
