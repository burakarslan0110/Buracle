import { fill, getJson, h, svg } from './dom.js'
import { count, fmtDate, listJoin, num, relTime, t } from './i18n.js'

export const HARNESSES = ['claude', 'codex', 'opencode', 'omp']
export const WORK_TABS = ['sessions', 'usage', 'extensions']

const view = { harness: 'all', mine: true, runners: false, sort: 'date', limit: 50, open: new Set(), table: false }
const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 })
const dayFmt = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' })
const monthFmt = new Intl.DateTimeFormat('en', { month: 'short', year: 'numeric' })

export function harnessName(id) {
  const s = t(`harness.${id}`)
  return s === `harness.${id}` ? String(id) : s
}

export function harnessLabel(id) {
  return h('span', { class: 'hname', 'data-harness': id }, h('i', { class: 'hdot', 'aria-hidden': 'true' }), harnessName(id))
}

export function usd(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '-'
  if (n > 0 && n < 0.01) return '≈<$0.01'
  return `≈$${n >= 100 ? Math.round(n).toLocaleString('en') : n.toFixed(2)}`
}

export function tokens(n) {
  return typeof n === 'number' ? t('work.tokens', { n: compact.format(n) }) : '-'
}

function localDay(day) {
  const [y, m, d] = String(day).split('-').map(Number)
  return new Date(y, m - 1, d, 12)
}

function duration(a, b) {
  const ms = Date.parse(b ?? '') - Date.parse(a ?? '')
  if (!Number.isFinite(ms) || ms < 0) return ''
  const m = Math.round(ms / 60000)
  return m < 60 ? t('work.minutes', { n: num(m) }) : t('work.hours', { h: num(Math.floor(m / 60)), m: String(m % 60).padStart(2, '0') })
}

function tabs(active, ctx) {
  return h('div', { class: 'tabs', role: 'group', 'aria-label': t('work.tabs') }, WORK_TABS.map(id => {
    const b = h('button', { type: 'button', class: 'filter', 'data-key': `tab-${id}`, 'aria-pressed': String(id === active) }, t(`work.tab.${id}`))
    b.addEventListener('click', () => { if (id !== active) ctx.open('work', id) })
    return b
  }))
}

export function workUrl(tab, scope) {
  if (tab === 'usage') return '/api/usage'
  if (tab === 'extensions') return `/api/extensions?scope=${encodeURIComponent(scope ?? 'person')}`
  return '/api/sessions'
}

function yieldLine(y) {
  if (!y || typeof y.sessions !== 'number') return null
  const parts = [t('work.yield.sessions', { n: num(y.sessions), days: num(y.days ?? 30) })]
  if (y.counted > 0) parts.push(t('work.yield.landed', { n: num(y.landed ?? 0), of: num(y.counted), commits: num(y.commits ?? 0) }))
  if (typeof y.perCommit === 'number') parts.push(t('work.yield.perCommit', { usd: usd(y.perCommit), sessions: count('endedSessions', y.priced ?? 0) }))
  return h('p', { class: 'meta' }, parts.join(' · '))
}

const SORTS = {
  date: (a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt),
  cost: (a, b) => (b.usd ?? -1) - (a.usd ?? -1),
  prompts: (a, b) => (b.prompts ?? -1) - (a.prompts ?? -1),
  tools: (a, b) => (b.tools ?? -1) - (a.tools ?? -1),
  commits: (a, b) => (b.commits ?? -1) - (a.commits ?? -1),
}

function sessionTitle(r) {
  if (r.project) return r.projectName ?? r.project
  if (r.excluded) return t('work.excluded')
  return r.folder ?? t('work.noFolder')
}

function detailRow(r, ctx, cols) {
  const rows = [
    [t('work.field.harness'), harnessName(r.harness)],
    [t('work.field.session'), h('code', null, r.sid)],
    r.branch ? [t('work.field.branch'), h('code', null, r.branch)] : null,
    r.folder ? [t('work.field.folder'), h('code', null, r.folder)] : null,
    r.model ? [t('work.field.model'), r.model] : null,
    typeof r.turns === 'number' ? [t('work.field.turns'), num(r.turns)] : null,
    typeof r.commands === 'number' ? [t('work.field.commands'), num(r.commands)] : null,
    typeof r.tests === 'number' ? [t('work.field.tests'), t('work.testsLine', { n: num(r.tests), failed: num(r.testFailures ?? 0) })] : null,
    typeof r.filesChanged === 'number' ? [t('work.field.diff'), t('work.diffLine', { files: num(r.filesChanged), ins: num(r.insertions ?? 0), del: num(r.deletions ?? 0) })] : null,
    typeof r.tokens === 'number' ? [t('work.field.tokens'), tokens(r.tokens)] : null,
    r.costFrom ? [t('work.field.cost'), `${usd(r.usd)} · ${t(`work.costFrom.${r.costFrom}`)}`] : null,
  ].filter(Boolean)
  const open = r.memoryId && r.project ? h('button', { type: 'button', class: 'link', 'data-key': `mem-${r.sid}` }, t('work.openMemory')) : null
  open?.addEventListener('click', () => ctx.openMemory(r.memoryId, `project:${r.project}`))
  return h('tr', { class: 'detail' }, h('td', { colspan: String(cols) },
    h('div', { class: 'detail-grid' },
      h('dl', { class: 'props' }, rows.flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v)])),
      h('div', null,
        Array.isArray(r.topTools) && r.topTools.length > 0 ? [h('p', { class: 'meta' }, t('work.topTools')), h('ul', { class: 'tool-list' }, r.topTools.map(([name, n]) => h('li', null, h('span', { class: 'tag' }, `${name} ${num(n)}`))))] : h('p', { class: 'meta' }, t(r.status === 'active' ? 'work.running' : 'work.noCounts')),
        open ? h('p', null, open) : null))))
}

function sessionsTable(list, ctx, now, rerender) {
  const head = (key, label, cls = '') => {
    if (!SORTS[key]) return h('th', { class: cls, scope: 'col' }, label)
    const b = h('button', { type: 'button', class: 'sort', 'data-key': `sort-${key}`, 'aria-pressed': String(view.sort === key) }, label, view.sort === key ? h('span', { 'aria-hidden': 'true' }, '↓') : null)
    b.addEventListener('click', () => { view.sort = key; rerender() })
    return h('th', { class: cls, scope: 'col', 'aria-sort': view.sort === key ? 'descending' : 'none' }, b)
  }
  const cols = 7
  const body = h('tbody')
  for (const r of list) {
    const name = h('button', { type: 'button', class: 'row-btn', 'aria-expanded': String(view.open.has(r.sid)), 'data-key': `row-${r.sid}` }, sessionTitle(r))
    name.addEventListener('click', () => { if (view.open.has(r.sid)) view.open.delete(r.sid); else view.open.add(r.sid); rerender() })
    const commits = typeof r.commits === 'number' ? (r.commits > 0 && typeof r.insertions === 'number' ? `${num(r.commits)} · +${num(r.insertions)} -${num(r.deletions ?? 0)}` : num(r.commits)) : '-'
    body.append(h('tr', null,
      h('td', null, name, h('span', { class: 'sub' }, harnessLabel(r.harness), r.model ? ` · ${r.model}` : '', r.runner ? ` · ${t('work.runner')}` : '')),
      h('td', null, h('time', { datetime: r.startedAt, title: fmtDate(r.startedAt) }, relTime(r.startedAt, now)), h('span', { class: 'sub' }, r.status === 'active' ? t('work.active') : duration(r.startedAt, r.endedAt))),
      h('td', { class: 'num opt' }, typeof r.prompts === 'number' ? num(r.prompts) : '-'),
      h('td', { class: 'num opt' }, typeof r.tools === 'number' ? num(r.tools) : '-'),
      h('td', { class: 'num opt' }, typeof r.files === 'number' ? num(r.files) : '-'),
      h('td', { class: 'num' }, commits),
      h('td', { class: 'num' }, r.usd !== undefined ? usd(r.usd) : typeof r.tokens === 'number' ? tokens(r.tokens) : '-')))
    if (view.open.has(r.sid)) body.append(detailRow(r, ctx, cols))
  }
  return h('div', { class: 'table-wrap' }, h('table', { class: 'grid-table' },
    h('thead', null, h('tr', null, head('none', t('work.col.session')), head('date', t('work.col.started')), head('prompts', t('work.col.prompts'), 'num opt'), head('tools', t('work.col.tools'), 'num opt'), head('files', t('work.col.files'), 'num opt'), head('commits', t('work.col.commits'), 'num'), head('cost', t('work.col.cost'), 'num'))),
    body))
}

function sessionsView(body, data, ctx, now) {
  const all = Array.isArray(data.sessions) ? data.sessions : []
  const scope = ctx.scope()
  const project = typeof scope === 'string' && scope.startsWith('project:') ? scope.slice(8) : null
  const render = () => {
    const pool = all.filter(r => (view.runners || !r.runner) && (!view.mine || project === null || r.project === project))
    const shown = pool.filter(r => view.harness === 'all' || r.harness === view.harness).sort(SORTS[view.sort] ?? SORTS.date)
    const chips = h('div', { class: 'filters', role: 'group', 'aria-label': t('work.filterHarness') }, ['all', ...HARNESSES].map(id => {
      const n = id === 'all' ? pool.length : pool.filter(r => r.harness === id).length
      const b = h('button', { type: 'button', class: 'filter', 'data-key': `h-${id}`, 'aria-pressed': String(view.harness === id) }, id === 'all' ? t('filter.all') : harnessLabel(id), h('b', null, num(n)))
      b.addEventListener('click', () => { view.harness = id; render() })
      return b
    }))
    const mine = project !== null ? h('label', { class: 'check' }, h('input', { type: 'checkbox', 'data-key': 'mine', ...(view.mine ? { checked: true } : {}) }), t('work.onlyProject', { project })) : null
    mine?.querySelector('input')?.addEventListener('change', (e) => { view.mine = e.currentTarget.checked; render() })
    const runnerCount = all.filter(r => r.runner).length
    const runners = runnerCount > 0 ? h('label', { class: 'check' }, h('input', { type: 'checkbox', 'data-key': 'runners', ...(view.runners ? { checked: true } : {}) }), t('work.showRunners', { n: num(runnerCount) })) : null
    runners?.querySelector('input')?.addEventListener('change', (e) => { view.runners = e.currentTarget.checked; render() })
    const more = shown.length > view.limit ? h('button', { type: 'button', class: 'btn sm quiet', 'data-key': 'more' }, t('work.more', { n: num(shown.length - view.limit) })) : null
    more?.addEventListener('click', () => { view.limit += 100; render() })
    fill(body,
      tabs('sessions', ctx),
      h('p', { class: 'set-lead' }, t('work.sessionsLead')),
      yieldLine(data.yield),
      h('div', { class: 'toolbar' }, chips, h('span', { class: 'grow' }), mine, runners),
      shown.length > 0 ? sessionsTable(shown.slice(0, view.limit), ctx, now, render) : h('p', { class: 'empty' }, t(all.length === 0 ? 'work.noSessions' : 'work.noMatch')),
      more ? h('div', { class: 'btn-row' }, more) : null)
  }
  render()
  return { kicker: t('work.kicker'), title: t('work.tab.sessions') }
}

function metricOf(data) {
  for (const id of HARNESSES) for (const d of Object.values(data.harnesses?.[id]?.days ?? {})) if (typeof d.usd === 'number') return 'usd'
  return 'tokens'
}

function noPrice(a) {
  return a !== undefined && a.tokens > 0 && typeof a.usd !== 'number'
}

function unpricedOf(data, field, keys) {
  const by = []
  let tok = 0
  for (const id of HARNESSES) {
    let n = 0
    for (const k of keys) {
      const a = data.harnesses?.[id]?.[field]?.[k]
      if (noPrice(a)) { n++; tok += a.tokens }
    }
    if (n > 0) by.push({ id, n })
  }
  return { by, tok }
}

function amountText(a, metric) {
  if (a === undefined) return '-'
  return metric === 'usd' ? (typeof a.usd === 'number' ? usd(a.usd) : tokens(a.tokens)) : tokens(a.tokens)
}

function sumOf(data, pick, metric) {
  let n = 0
  let seen = false
  for (const id of HARNESSES) {
    const a = pick(data.harnesses?.[id] ?? {})
    const v = metric === 'usd' ? a?.usd : a?.tokens
    if (typeof v === 'number') { n += v; seen = true }
  }
  return seen ? n : undefined
}

function tile(label, value, sub) {
  return h('div', { class: 'tile' }, h('span', { class: 'tile-label' }, label), h('span', { class: 'tile-value' }, value), sub ? h('span', { class: 'tile-sub' }, sub) : null)
}

function niceMax(v) {
  if (!(v > 0)) return 1
  const p = 10 ** Math.floor(Math.log10(v))
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p
  return 10 * p
}

function barPath(x, y, w, hgt, r) {
  const rr = Math.min(r, w / 2, hgt)
  return `M${x} ${y + hgt}V${y + rr}Q${x} ${y} ${x + rr} ${y}H${x + w - rr}Q${x + w} ${y} ${x + w} ${y + rr}V${y + hgt}Z`
}

function dailyChart(data, metric, width) {
  const days = Array.isArray(data.days) ? data.days : []
  const value = (id, day) => {
    const a = data.harnesses?.[id]?.days?.[day]
    return a === undefined ? 0 : metric === 'usd' ? (a.usd ?? 0) : a.tokens
  }
  const totals = days.map(d => HARNESSES.reduce((n, id) => n + value(id, d), 0))
  const max = niceMax(Math.max(0, ...totals))
  const W = Math.max(300, Math.floor(width))
  const H = 190
  const left = 46
  const bottom = 22
  const plotH = H - bottom - 8
  const band = (W - left) / Math.max(1, days.length)
  const bw = Math.max(4, Math.min(24, band * 0.62))
  const y = (v) => 8 + plotH - (v / max) * plotH
  const label = (v) => (metric === 'usd' ? `$${v < 10 && v % 1 !== 0 ? v.toFixed(1) : compact.format(v)}` : compact.format(v))
  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': t(metric === 'usd' ? 'work.chartLabel' : 'work.chartLabelTokens', { n: num(days.length) }) })
  for (const v of [0, max / 2, max]) {
    root.append(svg('line', { class: 'grid-line', x1: left, x2: W, y1: y(v), y2: y(v) }))
    const tx = svg('text', { class: 'axis-text', x: left - 8, y: y(v) + 4, 'text-anchor': 'end' })
    tx.textContent = label(v)
    root.append(tx)
  }
  const wrap = h('div', { class: 'chart' })
  const tip = h('div', { class: 'chart-tip', hidden: true })
  days.forEach((day, i) => {
    const x = left + i * band + (band - bw) / 2
    let base = y(0)
    const parts = HARNESSES.map(id => ({ id, v: value(id, day) })).filter(p => p.v > 0)
    parts.forEach((p, k) => {
      const hgt = (p.v / max) * plotH
      const top = base - hgt
      const drawn = Math.max(0, hgt - (k > 0 ? 2 : 0))
      if (drawn > 0.5) {
        const seg = k === parts.length - 1 ? svg('path', { class: 'seg', d: barPath(x, top, bw, drawn, 4) }) : svg('rect', { class: 'seg', x, y: top, width: bw, height: drawn })
        seg.setAttribute('data-harness', p.id)
        root.append(seg)
      }
      base = top
    })
    if (i % 5 === (days.length - 1) % 5) {
      const tx = svg('text', { class: 'axis-text', x: left + i * band + band / 2, y: H - 6, 'text-anchor': 'middle' })
      tx.textContent = String(localDay(day).getDate())
      root.append(tx)
    }
    const hit = svg('rect', { class: 'hit', x: left + i * band, y: 0, width: band, height: H - bottom })
    const unpriced = metric === 'usd' ? HARNESSES.filter(id => noPrice(data.harnesses?.[id]?.days?.[day])) : []
    hit.addEventListener('pointerenter', () => {
      const items = [
        ...parts.map(p => h('li', null, harnessLabel(p.id), h('span', null, metric === 'usd' ? usd(p.v) : tokens(p.v)))),
        ...unpriced.map(id => h('li', null, harnessLabel(id), h('span', null, t('work.noPrice', { tok: tokens(data.harnesses[id].days[day].tokens) })))),
      ]
      fill(tip, h('b', null, `${dayFmt.format(localDay(day))} · ${metric === 'usd' ? usd(totals[i]) : tokens(totals[i])}`),
        items.length > 0 ? h('ul', null, items) : h('span', null, t('work.noUse')))
      tip.hidden = false
      const px = left + i * band + band / 2
      const tx = px + 14 + 190 <= W ? px + 14 : Math.max(0, px - 14 - 190)
      tip.style.transform = `translate(${Math.round(tx)}px, 4px)`
    })
    hit.addEventListener('pointerleave', () => { tip.hidden = true })
    root.append(hit)
  })
  wrap.append(root, tip)
  return wrap
}

function dayTable(data, metric) {
  const days = [...(data.days ?? [])].reverse().filter(d => HARNESSES.some(id => data.harnesses?.[id]?.days?.[d]))
  if (days.length === 0) return h('p', { class: 'empty' }, t('work.noUsage'))
  return h('div', { class: 'table-wrap' }, h('table', { class: 'grid-table' },
    h('thead', null, h('tr', null, h('th', { scope: 'col' }, t('work.col.day')), HARNESSES.map(id => h('th', { scope: 'col', class: 'num' }, harnessLabel(id))), h('th', { scope: 'col', class: 'num' }, t('work.col.total')))),
    h('tbody', null, days.map(d => h('tr', null, h('td', null, dayFmt.format(localDay(d))),
      HARNESSES.map(id => h('td', { class: 'num' }, amountText(data.harnesses?.[id]?.days?.[d], metric))),
      h('td', { class: 'num' }, metric === 'usd' ? usd(sumOf(data, x => x.days?.[d], 'usd')) : tokens(sumOf(data, x => x.days?.[d], 'tokens'))))))))
}

function monthTable(data, metric) {
  const months = [...(data.months ?? [])].reverse()
  return h('div', { class: 'table-wrap' }, h('table', { class: 'grid-table' },
    h('thead', null, h('tr', null, h('th', { scope: 'col' }, t('work.col.month')), HARNESSES.map(id => h('th', { scope: 'col', class: 'num' }, harnessLabel(id))), h('th', { scope: 'col', class: 'num' }, t('work.col.total')))),
    h('tbody', null, months.map(m => {
      const [yy, mm] = String(m).split('-').map(Number)
      return h('tr', null, h('td', null, monthFmt.format(new Date(yy, mm - 1, 15))),
        HARNESSES.map(id => h('td', { class: 'num' }, amountText(data.harnesses?.[id]?.months?.[m], metric))),
        h('td', { class: 'num' }, metric === 'usd' ? usd(sumOf(data, x => x.months?.[m], 'usd')) : tokens(sumOf(data, x => x.months?.[m], 'tokens'))))
    }))))
}

function modelTable(data) {
  const rows = []
  for (const id of HARNESSES) for (const [model, a] of Object.entries(data.harnesses?.[id]?.models ?? {})) rows.push({ id, model, a })
  rows.sort((x, y) => (y.a.usd ?? -1) - (x.a.usd ?? -1) || y.a.tokens - x.a.tokens)
  if (rows.length === 0) return h('p', { class: 'empty' }, t('work.noUsage'))
  return h('div', { class: 'table-wrap' }, h('table', { class: 'grid-table' },
    h('thead', null, h('tr', null, h('th', { scope: 'col' }, t('work.col.model')), h('th', { scope: 'col' }, t('work.col.harness')), h('th', { scope: 'col', class: 'num' }, t('work.col.tokens')), h('th', { scope: 'col', class: 'num' }, t('work.col.cost')))),
    h('tbody', null, rows.slice(0, 16).map(r => h('tr', null, h('td', null, h('code', null, r.model)), h('td', null, harnessLabel(r.id)), h('td', { class: 'num' }, tokens(r.a.tokens)), h('td', { class: 'num' }, typeof r.a.usd === 'number' ? usd(r.a.usd) : t('work.unpriced')))))))
}

function windowsList(data, now) {
  const items = HARNESSES.map(id => {
    const x = data.harnesses?.[id] ?? {}
    if (x.enabled === false) return h('li', null, harnessLabel(id), h('span', { class: 'meta-inline' }, ` ${t('work.off')}`))
    const ws = Array.isArray(x.windows) ? x.windows : []
    const parts = ws.map(w => `${w.label} ${num(Math.round(w.pct))}%${w.resetsAt ? ` (${t('work.resets', { t: relTime(w.resetsAt, now) })})` : ''}`)
    if (typeof x.monthPct === 'number') parts.push(`${t('work.monthWindow')} ${num(Math.round(x.monthPct))}%`)
    return h('li', null, harnessLabel(id), ' ', parts.length > 0 ? parts.join(' · ') : h('span', { class: 'meta-inline' }, t('work.noWindows')))
  })
  return h('ul', { class: 'held' }, items)
}

function section(title, ...children) {
  return h('section', { class: 'sec' }, h('h3', null, title), ...children)
}

function usageView(body, data, ctx, now) {
  const metric = metricOf(data)
  const days = Array.isArray(data.days) ? data.days : []
  const today = days[days.length - 1]
  const week = days.slice(-7)
  const month = Array.isArray(data.months) ? data.months[data.months.length - 1] : undefined
  const monthTotal = sumOf(data, x => x.months?.[month], metric)
  const monthTokens = sumOf(data, x => x.months?.[month], 'tokens')
  const weekTotal = week.reduce((n, d) => n + (sumOf(data, x => x.days?.[d], metric) ?? 0), 0)
  const show = (v) => (metric === 'usd' ? usd(v ?? 0) : tokens(v ?? 0))
  const unpricedIn = (field, keys) => (metric === 'usd' ? unpricedOf(data, field, keys) : { by: [], tok: 0 })
  const leftOut = (g) => (g.tok > 0 ? t('work.tile.unpriced', { tok: tokens(g.tok) }) : null)
  const monthLeft = leftOut(unpricedIn('months', month !== undefined ? [month] : []))
  const daysLeft = unpricedIn('days', days)
  const unpricedNote = daysLeft.by.length > 0 ? h('p', { class: 'note', 'data-key': 'unpriced' }, t('work.unpricedNote', { list: listJoin(daysLeft.by.map(x => `${harnessName(x.id)} (${count('days', x.n)})`)) })) : null
  const y = data.yield ?? {}
  const notes = HARNESSES.flatMap(id => (data.harnesses?.[id]?.notes ?? []).map(n => h('li', null, harnessLabel(id), ` ${n}`)))
  const refreshing = Array.isArray(data.refreshing) && data.refreshing.length > 0 ? h('p', { class: 'note' }, t('work.refreshing', { list: data.refreshing.map(harnessName).join(', ') })) : null
  const width = (body.clientWidth || 600) - 4
  const table = h('div', { class: 'day-table', hidden: !view.table }, dayTable(data, metric))
  const toggle = h('button', { type: 'button', class: 'link', 'data-key': 'day-table', 'aria-expanded': String(view.table) }, t(view.table ? 'work.hideTable' : 'work.showTable'))
  toggle.addEventListener('click', () => {
    view.table = !view.table
    table.hidden = !view.table
    toggle.setAttribute('aria-expanded', String(view.table))
    toggle.textContent = t(view.table ? 'work.hideTable' : 'work.showTable')
  })
  fill(body,
    tabs('usage', ctx),
    h('p', { class: 'set-lead' }, t('work.usageLead')),
    refreshing,
    h('div', { class: 'tiles' },
      tile(t('work.tile.month'), show(monthTotal), metric === 'usd' ? [monthTokens !== undefined ? tokens(monthTokens) : null, monthLeft].filter(Boolean).join(' · ') || null : null),
      tile(t('work.tile.week'), show(weekTotal), leftOut(unpricedIn('days', week))),
      tile(t('work.tile.today'), show(sumOf(data, x => x.days?.[today], metric)), leftOut(unpricedIn('days', today !== undefined ? [today] : []))),
      tile(t('work.tile.perCommit'), typeof y.perCommit === 'number' ? usd(y.perCommit) : '-', y.counted > 0 ? t('work.yield.landed', { n: num(y.landed ?? 0), of: num(y.counted), commits: num(y.commits ?? 0) }) : t('work.yield.none'))),
    section(t('work.byDay', { n: num(days.length) }),
      dailyChart(data, metric, width),
      unpricedNote,
      h('ul', { class: 'legend-row' }, HARNESSES.map(id => h('li', null, harnessLabel(id), h('b', null, amountText(data.harnesses?.[id]?.months?.[month], metric))))),
      h('p', { class: 'meta' }, toggle),
      table),
    section(t('work.byMonth'), monthTable(data, metric)),
    section(t('work.byModel'), modelTable(data)),
    section(t('work.windows'), windowsList(data, now)),
    notes.length > 0 ? section(t('work.notes'), h('ul', { class: 'held' }, notes)) : null,
    h('p', { class: 'meta' }, t('work.estimate')))
  return { kicker: t('work.kicker'), title: t('work.tab.usage') }
}

export function workView(body, data, ctx, now, tab, extensions) {
  if (tab === 'usage') return usageView(body, data, ctx, now)
  if (tab === 'extensions') return extensions(body, data, ctx, tabs('extensions', ctx))
  return sessionsView(body, data, ctx, now)
}

export async function loadWork(tab, scope) {
  return getJson(workUrl(tab, scope))
}
