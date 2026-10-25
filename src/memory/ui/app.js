import { buildBrain, BRAINSTEM } from './brain.js'
import { buildPersonBrain } from './brain-person.js'
import { debounce, getJson, h, holdPlace, icon } from './dom.js'
import { createGraph } from './graph.js'
import { createHud, NARROW } from './hud.js'
import { LOGO, pixelArt } from './logo.js'
import { count, lang, num, regionLabel, relTime, t } from './i18n.js'
import { createHealth, errorBlock, healthView, settingsView } from './manage.js'
import { createNetwork } from './network.js'
import { detailView, regionView, searchView } from './panel.js'
import { wirePointer } from './pointer.js'
import { createRenderer } from './render.js'
import { createTheme } from './theme.js'
import { extensionsView } from './extensions.js'
import { createInbox, inboxView } from './inbox.js'
import { loadWork, WORK_TABS, workView } from './work.js'

const $ = (id) => document.getElementById(id)
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches
const STORE_KEY = 'buracle.brain.scope'
const PANEL_WIDTH = 440
const WIDE = new Set(['work'])

const state = {
  overview: null,
  scope: null,
  brain: null,
  items: new Map(),
  panel: null,
  stack: [],
  filter: 'all',
  q: '',
  hits: null,
  hover: -1,
  hoverMem: null,
  es: null,
  graph: null,
  note: null,
  seq: { brain: 0, search: 0, panel: 0, graph: 0 },
  booted: false,
}

function applyWords() {
  document.documentElement.lang = lang
  document.title = t('app.title')
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n)
  for (const el of document.querySelectorAll('[data-i18n-ph]')) el.setAttribute('placeholder', t(el.dataset.i18nPh))
  for (const el of document.querySelectorAll('[data-i18n-label]')) el.setAttribute('aria-label', t(el.dataset.i18nLabel))
  for (const el of document.querySelectorAll('[data-i18n-title]')) el.setAttribute('title', t(el.dataset.i18nTitle))
  $('hint').textContent = `${t('hint.keys')} · ${t('hint.drag')}`
  $('brand-layer').textContent = state.scope === 'person' ? ` · ${t('brand.person')}` : ''
}

applyWords()
$('brand-logo').append(pixelArt(LOGO, 'brand-art', 'brand-art-fill'))
$('search-icon').append(icon('search', 'icon'))
$('btn-search').append(icon('search'))
$('btn-health').prepend(icon('pulse'))
$('btn-settings').append(icon('gear'))
$('btn-graph').append(icon('graph'))
$('btn-review').append(icon('file'))
$('btn-work').append(icon('chart'))
$('btn-inbox').prepend(icon('bell'))
$('panel-back').append(icon('back'))
$('panel-close').append(icon('close'))
$('graph-back-icon').append(icon('back', 'icon xs'))
$('graph-in').append(icon('plus'))
$('graph-out').append(icon('minus'))
$('graph-fit').append(icon('fit'))

const canvas = $('brain')
const narrowAtStart = innerWidth < NARROW
const lowMemory = typeof navigator.deviceMemory === 'number' && navigator.deviceMemory <= 4
const PARTICLES = narrowAtStart || lowMemory ? 24000 : 44000
const brains = { project: buildBrain({ count: PARTICLES, seed: 0xb7a1 }) }
let variant = 'project'
const regionIds = () => brains[variant].ids
const regionIndex = (id) => (id === undefined ? -1 : regionIds().indexOf(id))
let hud = null
const renderer = createRenderer(canvas, brains.project, { reducedMotion, onFrame: (view) => hud?.update(view, freeArea()) })
hud = createHud({
  svgEl: $('hud'),
  labelsEl: $('labels'),
  legendEl: $('legend'),
  onOpen: (i, el) => openPanel('region', i, el),
  onHover: (i) => setHover(i),
})
document.body.dataset.renderer = renderer.kind
hud.setLayout(brains.project)

let swapTimer = 0
let settleTimer = 0

function setVariant(v) {
  if (v === variant) return
  variant = v
  brains[v] ??= v === 'person' ? buildPersonBrain({ count: PARTICLES }) : buildBrain({ count: PARTICLES, seed: 0xb7a1 })
  hud.setLayout(brains[v])
  document.body.dataset.layer = v
  const swap = () => { renderer.setBrain(brains[v]); layout(true) }
  clearTimeout(swapTimer)
  clearTimeout(settleTimer)
  const cls = document.body.classList
  cls.remove('brain-enter', 'brain-settle')
  if (reducedMotion) { swap(); return }
  cls.add('brain-leave')
  swapTimer = setTimeout(() => {
    swap()
    cls.replace('brain-leave', 'brain-enter')
    requestAnimationFrame(() => requestAnimationFrame(() => {
      cls.replace('brain-enter', 'brain-settle')
      settleTimer = setTimeout(() => cls.remove('brain-settle'), 1000)
    }))
  }, 320)
}

const graphCanvas = $('graph')
const graph = createGraph(graphCanvas, {
  reducedMotion,
  onOpen: (id) => openPanel('detail', id, graphCanvas),
  onHover: (node, x, y) => network.showTip(node, x, y),
})

const theme = createTheme($('btn-theme'), (name) => { renderer.setTheme(name); graph.setTheme(name) })

function panelDocked() {
  return state.panel !== null && innerWidth >= 1100 && !WIDE.has(state.panel.view)
}

function freeArea() {
  const top = state.graph !== null ? $('graph-bar').getBoundingClientRect().bottom : $('topbar').getBoundingClientRect().bottom
  const narrow = innerWidth < NARROW
  let bottom = narrow && state.graph === null ? $('legend').getBoundingClientRect().top : $('readout').getBoundingClientRect().top
  if (narrow && state.graph !== null && state.panel !== null) bottom = Math.min(bottom, innerHeight - $('panel').offsetHeight)
  return { left: 0, right: panelDocked() ? innerWidth - PANEL_WIDTH - 16 : innerWidth, top, bottom }
}

let laidOut = false
function layout(jump = false) {
  renderer.resize()
  hud.resize(innerWidth, innerHeight)
  graph.resize()
  const a = freeArea()
  graph.setArea(a)
  const w = a.right - a.left
  const hh = a.bottom - a.top
  const narrow = innerWidth < NARROW
  const b = brains[variant].bounds
  const spanX = b.maxX - b.minX
  const spanY = b.maxY - b.minY
  const s = narrow ? Math.min((w * 0.94) / spanX, (hh * 0.92) / spanY) : Math.min((w * 0.5) / spanX, (hh * 0.84) / spanY)
  const cx = a.left + w / 2 - ((b.minX + b.maxX) / 2) * s
  const cy = a.top + hh / 2 + ((b.minY + b.maxY) / 2) * s
  renderer.layout(cx, cy, s, !laidOut || jump)
  laidOut = true
}

new ResizeObserver(debounce(() => layout(), 60)).observe(document.body)
layout()
renderer.start()

function focusedRegion() {
  if (state.hover >= 0) return state.hover
  const p = state.panel
  if (p === null) return -1
  if (p.view === 'region') return p.arg
  if (p.view === 'detail' && p.region !== undefined) return regionIndex(p.region)
  return -1
}

function updateEmphasis() {
  const e = new Array(8).fill(1)
  if (state.hits !== null) {
    const regs = new Set(state.hits.map((m) => m.region))
    for (let i = 0; i < 8; i++) e[i] = regs.has(regionIds()[i]) ? 1.25 : 0.38
  }
  const f = focusedRegion()
  if (f >= 0) for (let i = 0; i < 8; i++) e[i] = i === f ? 1.45 : Math.min(e[i], 0.42)
  renderer.setEmphasis(e)
  hud.setFocus(f)
}

function updateNodes() {
  const lv = new Map()
  if (state.hits !== null) for (const m of state.hits) lv.set(m.id, 1.5)
  const p = state.panel
  if (p !== null && p.view === 'detail' && p.scope === state.scope) lv.set(p.arg, 1.7)
  if (state.hoverMem !== null) lv.set(state.hoverMem, 1.9)
  if (lv.size === 0) renderer.setNodeLevels(null)
  else renderer.setNodeLevels(lv, state.hits !== null ? 0.1 : 0.32)
  graph.mark(lv.size > 0 ? new Set(lv.keys()) : null)
}

function setHover(i) {
  if (state.hover === i) return
  state.hover = i
  updateEmphasis()
}

let migrationTimer = 0

function showState(kind, info = {}) {
  clearTimeout(migrationTimer)
  const el = $('state')
  const splash = kind === 'loading' && !state.booted
  if (splash && el.dataset.kind === 'splash' && !el.hidden) return
  el.dataset.kind = splash ? 'splash' : kind
  if (kind === 'loading') {
    const line = h('p', { class: 'state-line' }, h('i', { class: 'scan', 'aria-hidden': 'true' }), t('state.loading'))
    el.replaceChildren(splash ? h('div', { class: 'splash' }, pixelArt(LOGO, 'splash-art', 'splash-art-fill'), line) : line)
  } else if (kind === 'empty') el.replaceChildren(h('p', { class: 'state-title' }, t('state.empty')), h('p', { class: 'state-lead' }, t('state.emptyLead')))
  else if (kind === 'cortex') {
    const code = h('code', null, info.fix ?? 'buracle install')
    const reload = h('button', { type: 'button', class: 'btn' }, t('btn.reload'))
    reload.addEventListener('click', () => location.reload())
    el.replaceChildren(h('div', { class: 'card', role: 'alert' }, h('p', { class: 'state-title' }, icon('alert', 'icon'), t('state.cortexMissing')), h('p', { class: 'state-lead' }, t('state.cortexLead')), h('pre', null, code), reload))
  } else if (kind === 'migrating' || kind === 'migration_failed') {
    const failed = kind === 'migration_failed'
    const retry = h('button', { type: 'button', class: 'btn' }, t('btn.retry'))
    retry.addEventListener('click', () => { void loadAll() })
    if (!failed) migrationTimer = setTimeout(() => { void loadAll() }, 3000)
    el.replaceChildren(h('div', { class: 'card', role: failed ? 'alert' : 'status' },
      h('p', { class: 'state-title' }, icon(failed ? 'alert' : 'loop', 'icon'), t(failed ? 'state.migrationFailed' : 'state.migrating')),
      h('p', { class: 'state-lead' }, t(failed ? 'state.migrationFailedLead' : 'state.migratingLead')),
      h('pre', null, h('code', null, info.fix ?? (failed ? 'buracle mem migrate' : 'buracle mem migrate --status'))),
      failed && info.message ? h('p', { class: 'state-lead' }, t('state.migrationWhy', { message: info.message })) : null,
      failed ? h('p', { class: 'state-lead' }, t('state.migrationRollback')) : null,
      failed ? h('pre', null, h('code', null, 'buracle mem migrate --rollback')) : null,
      retry))
  } else {
    const retry = h('button', { type: 'button', class: 'btn' }, t('btn.retry'))
    retry.addEventListener('click', () => { void loadAll() })
    el.replaceChildren(h('div', { class: 'card', role: 'alert' }, h('p', { class: 'state-title' }, icon('alert', 'icon'), kind === 'unknown' ? t('state.unknown') : t('state.error')), info.message ? h('p', { class: 'state-lead' }, info.message) : null, retry))
  }
  el.hidden = false
}

function hideState() {
  $('state').hidden = true
}

function apiError(r) {
  if (state.es === null) setLive('offline')
  if (r.status === 503 && r.body?.error === 'cortexdb_missing') showState('cortex', { fix: r.body.fix })
  else if (r.status === 503 && (r.body?.error === 'migrating' || r.body?.error === 'migration_failed')) showState(r.body.error, { fix: r.body.fix, message: r.body.message })
  else showState(r.status === 404 ? 'unknown' : 'error', { message: r.body?.message ?? (r.status === 0 ? t('state.noServer') : `HTTP ${r.status}`) })
}

function levelsFor(regions) {
  const max = Math.max(1, ...regions.map((r) => r.count))
  const out = regions.map((r) => {
    if (r.count === 0) return { density: 0.55, bright: 0.4 }
    const k = Math.log1p(r.count) / Math.log1p(max)
    return { density: 0.62 + 0.38 * k, bright: 0.58 + 0.55 * k }
  })
  out[BRAINSTEM] = { density: 0.9, bright: 0.6 }
  return out
}

const loadingLevels = Array.from({ length: 8 }, () => ({ density: 0.32, bright: 0.36 }))

function scopeName(scope) {
  if (scope === 'person') return t('scope.person')
  return scope.replace(/^project:/, '')
}

function fillScopes() {
  const sel = $('scope')
  const o = state.overview
  if (o === null) return
  const opt = (value, label, n, out) => h('option', { value, ...(out ? { title: t('scope.excludedBy', { why: out }) } : {}) }, `${n === null ? label : `${label} · ${n === 0 ? t('scope.empty') : num(n)}`}${out ? ` · ${t('scope.excluded')}` : ''}`)
  const groups = []
  if (o.projects.length > 0) groups.push(h('optgroup', { label: t('scope.projects') }, o.projects.map((p) => opt(p.scope, p.name ?? p.slug, p.count, p.excluded))))
  groups.push(h('optgroup', { label: t('scope.personGroup') }, opt('person', t('scope.person'), o.person.count)))
  sel.replaceChildren(...groups)
  sel.disabled = false
  if (state.scope !== null) sel.value = state.scope
}

function pickScope() {
  const o = state.overview
  const valid = new Set(['person', ...o.projects.map((p) => p.scope)])
  let want = null
  try { want = new URL(location.href).searchParams.get('scope') } catch {  }
  if (want !== null && valid.has(want)) return want
  try {
    const saved = localStorage.getItem(STORE_KEY)
    if (saved !== null && valid.has(saved)) return saved
  } catch {  }
  const busy = o.projects.find((p) => (p.count ?? 0) > 0)
  return busy !== undefined ? busy.scope : 'person'
}

async function loadOverview() {
  const r = await getJson('/api/overview')
  if (!r.ok) { apiError(r); return false }
  state.overview = r.body
  fillScopes()
  return true
}

async function loadAll() {
  showState('loading')
  if (!(await loadOverview())) return
  if (state.overview.store.installed === false) {
    setLive('offline')
    showState('cortex', { fix: state.overview.store.fix })
    return
  }
  // While Buracle 0.5's files are being folded into the new brain file (or the move failed), say so instead of showing an empty brain.
  const move = state.overview.migration
  if (move?.state === 'running' || move?.state === 'failed') {
    setLive('offline')
    showState(move.state === 'running' ? 'migrating' : 'migration_failed', { fix: move.fix, message: move.error })
    return
  }
  setScope(pickScope())
}

function setParam(key, value) {
  try {
    const u = new URL(location.href)
    u.searchParams.set(key, value)
    history.replaceState(null, '', u)
  } catch {  }
}

function setScope(scope) {
  state.scope = scope
  $('scope').value = scope
  setParam('scope', scope)
  try { localStorage.setItem(STORE_KEY, scope) } catch {  }
  state.brain = null
  state.items = new Map()
  clearSearch(false)
  network.hide()
  if (state.panel !== null) closePanel(false)
  setVariant(scope === 'person' ? 'person' : 'project')
  applyWords()
  renderer.setRegions(loadingLevels)
  renderer.setNodes([])
  void loadBrain(false)
  health.reset()
  void health.refresh()
  connectEvents()
}

function restLevel(m) {
  if (m.kind === 'preference' || m.origin === 'explicit') return 0.85
  if (m.origin === 'inferred' && typeof m.confidence === 'number' && m.confidence < 0.5) return 0.3
  return 0.5
}

async function loadBrain(quiet) {
  const seq = ++state.seq.brain
  if (!quiet) showState('loading')
  const r = await getJson(`/api/brain?scope=${encodeURIComponent(state.scope)}`)
  if (seq !== state.seq.brain) return
  if (!r.ok) { apiError(r); return }
  const b = r.body
  state.brain = b
  state.booted = true
  state.items = new Map(b.items.map((m) => [m.id, m]))
  if (b.items.length === 0 && state.graph === null) showState('empty')
  else hideState()
  renderer.setRegions(levelsFor(b.regions))
  renderer.setNodes(b.items.map((m) => ({ id: m.id, regionIndex: Math.max(0, regionIndex(m.region)), base: restLevel(m) })))
  hud.setRegions(b.regions)
  updateReadout()
  const p = state.panel
  if (p !== null && p.view === 'region') renderPanel()
  if (state.q !== '') void runSearch(true)
  if (state.graph !== null && quiet) void network.load(true)
  updateEmphasis()
  updateNodes()
}

function updateReadout() {
  const b = state.brain
  const parts = [h('b', null, scopeName(state.scope ?? ''))]
  if (b !== null) {
    parts.push(h('span', null, count('memories', b.items.length)))
    if (b.lastActivity) parts.push(h('span', null, t('stats.last', { t: relTime(b.lastActivity) })))
  }
  $('stats').replaceChildren(...parts.flatMap((x, i) => (i === 0 ? [x] : [h('i', { class: 'sep', 'aria-hidden': 'true' }, '·'), x])))
}

let announceAt = 0
const refreshSoon = debounce(() => {
  void loadBrain(true)
  void loadOverview()
  if (health.stale(30000)) void health.refresh()
}, 700)

function setLive(s) {
  $('live').dataset.state = s
  $('live-text').textContent = t(`live.${s}`)
}

function connectEvents() {
  state.es?.close()
  if (typeof EventSource !== 'function') { setLive('offline'); return }
  setLive('connecting')
  const es = new EventSource(`/api/events?scope=${encodeURIComponent(state.scope)}`)
  state.es = es
  es.addEventListener('open', () => setLive('live'))
  es.addEventListener('error', () => setLive(es.readyState === EventSource.CLOSED ? 'offline' : 'connecting'))
  es.addEventListener('brain', (ev) => {
    let e
    try { e = JSON.parse(ev.data) } catch { return }
    onEvent(e)
  })
}

function onEvent(e) {
  const ri = regionIndex(e.region ?? (e.id !== undefined ? state.items.get(e.id)?.region : undefined))
  const kind = e.op === 'recall' ? 'recall' : e.op === 'retire' || e.op === 'delete' ? 'fade' : 'write'
  renderer.pulse(ri, kind)
  if (ri >= 0) hud.pulse(ri)
  if (e.op === 'recall' && Array.isArray(e.ids)) {
    renderer.flashNodes(e.ids)
    for (const id of e.ids) graph.fire(id)
  }
  if (kind === 'write' && e.id !== undefined) {
    setTimeout(() => renderer.flashNodes([e.id]), 900)
    setTimeout(() => graph.fire(e.id), 1200)
  }
  const now = Date.now()
  if (now - announceAt > 4000) {
    announceAt = now
    const what = t('announce.event', { region: ri >= 0 ? regionLabel(regionIds()[ri]) : t('app.title'), op: t(`op.${e.op}`) })
    $('announce').textContent = what
  }
  refreshSoon()
}

const tip = $('tip')

function placeTip(x, y) {
  tip.hidden = false
  const w = tip.offsetWidth
  const left = Math.min(innerWidth - w - 12, x + 14)
  tip.style.transform = `translate3d(${Math.max(8, left)}px, ${Math.max(8, y - 44)}px, 0)`
}

const network = createNetwork({
  state, graph, tip, placeTip, scopeName, reducedMotion, regionIds,
  layout: () => layout(),
  updateNodes: () => updateNodes(),
  brainOn: (on) => (on ? renderer.start() : renderer.stop()),
  showEmpty: () => showState('empty'),
  hideState: () => hideState(),
  closePanel: () => closePanel(),
})

const panelCtx = {
  openMemory: (id, scope) => openPanel('detail', id, document.activeElement, scope),
  hoverMemory: (id) => { state.hoverMem = id; updateNodes() },
  setFilter: (f) => { state.filter = f },
}

function announce(text) {
  announceAt = Date.now()
  $('announce').textContent = text
}

function afterWrite() {
  void loadBrain(true)
  void loadOverview()
  void health.refresh()
}

const health = createHealth({
  scope: () => state.scope,
})

async function projectRemoved() {
  state.note = null
  closePanel(false)
  if (!(await loadOverview())) return
  setScope(pickScope())
  $('scope').focus()
}

const manageCtx = {
  scope: () => state.scope,
  get note() { return state.note },
  announce,
  afterWrite,
  open: (view, arg = null) => openPanel(view, arg, document.activeElement),
  refresh: (note) => { state.note = note; void renderPanel(false, true) },
  saved: () => { void health.refresh() },
  projectRemoved: () => { void projectRemoved() },
}

function memoryCtx(scope) {
  return {
    ...panelCtx,
    memoryScope: scope,
    announce,
    memoryChanged: (op) => {
      afterWrite()
      if (op === 'update') void renderPanel(true, true)
      else if (op !== 'delete') void renderPanel(false, true)
      else if (!goBack()) closePanel()
    },
  }
}

function openPanel(view, arg, opener, scope) {
  const prev = state.panel
  if (view === 'health' && prev?.view !== 'health') state.note = null
  if (view === 'detail' && prev !== null && prev.view !== 'detail') state.stack = [prev]
  else if (view === 'detail' && prev !== null && (prev.arg !== arg || prev.scope !== (scope ?? state.scope))) state.stack = [...state.stack, prev].slice(-12)
  else if (view !== 'detail') state.stack = []
  if (view === 'region' && (prev === null || prev.view !== 'region' || prev.arg !== arg)) state.filter = 'all'
  state.panel = { view, arg, scope: scope ?? state.scope, opener: prev?.opener ?? opener ?? document.activeElement }
  const el = $('panel')
  el.hidden = false
  requestAnimationFrame(() => el.classList.add('open'))
  document.body.classList.add('panel-open')
  if (view === 'region') network.show(arg)
  renderPanel(view !== 'search')
  layout()
}

function closePanel(restoreFocus = true) {
  const p = state.panel
  if (p === null) return
  state.panel = null
  state.stack = []
  const el = $('panel')
  el.classList.remove('open')
  el.hidden = true
  document.body.classList.remove('panel-open')
  if (p.view === 'search') clearSearch(true)
  if (state.graph?.owner === 'panel') network.hide()
  updateEmphasis()
  updateNodes()
  layout()
  if (restoreFocus && p.opener instanceof HTMLElement && document.contains(p.opener)) p.opener.focus()
}

function panelHead(head) {
  $('panel-kicker').textContent = head.kicker ?? ''
  $('panel-title').textContent = head.title ?? ''
  if (head.region !== undefined) $('panel').dataset.region = head.region
  else delete $('panel').dataset.region
  $('panel-back').hidden = state.stack.length === 0
}

async function renderPanel(focus = false, quiet = false) {
  const p = state.panel
  if (p === null) return
  const seq = ++state.seq.panel
  const body = $('panel-body')
  $('panel').classList.toggle('wide', WIDE.has(p.view))
  const now = Date.now()
  const place = quiet ? holdPlace(body) : null
  const done = (head) => {
    if (seq !== state.seq.panel) return
    panelHead(head)
    if (focus) $('panel-title').focus({ preventScroll: true })
    place?.()
    updateEmphasis()
    updateNodes()
  }
  const loading = (title) => {
    if (quiet) return
    panelHead({ title })
    body.replaceChildren(h('p', { class: 'empty' }, t('detail.loading')))
  }
  if (p.view === 'region') {
    const b = state.brain
    const region = b?.regions[p.arg] ?? { id: regionIds()[p.arg], count: 0, groups: 0, topTags: [] }
    done(regionView(body, region, b?.items ?? [], panelCtx, now, state.filter))
  } else if (p.view === 'search') {
    done(searchView(body, state.q, state.hits ?? [], panelCtx, now))
  } else if (p.view === 'detail') {
    const brief = p.scope === state.scope ? state.items.get(p.arg) : undefined
    loading(brief?.title ?? '')
    const r = await getJson(`/api/memory?scope=${encodeURIComponent(p.scope)}&id=${encodeURIComponent(p.arg)}`)
    if (seq !== state.seq.panel) return
    if (!r.ok) {
      body.replaceChildren(h('p', { class: 'empty' }, r.status === 404 ? t('detail.missing') : r.body?.message ?? t('state.error')))
      done({ title: brief?.title ?? p.arg })
      return
    }
    p.region = r.body.region
    done(detailView(body, r.body, memoryCtx(p.scope)))
  } else if (p.view === 'health') {
    loading(t('health.title'))
    const r = await health.refresh()
    if (seq !== state.seq.panel) return
    if (!r.ok) { body.replaceChildren(errorBlock(r)); done({ title: t('health.title') }); return }
    done(healthView(body, r.body, manageCtx, now))
  } else if (p.view === 'settings') {
    loading(t('settings.title'))
    const r = await getJson('/api/settings')
    if (seq !== state.seq.panel) return
    if (!r.ok) { body.replaceChildren(errorBlock(r)); done({ title: t('settings.title') }); return }
    done(settingsView(body, r.body, manageCtx))
  } else if (p.view === 'work') {
    const tab = WORK_TABS.includes(p.arg) ? p.arg : 'sessions'
    loading(t(`work.tab.${tab}`))
    const r = await loadWork(tab, state.scope)
    if (seq !== state.seq.panel) return
    if (!r.ok) { body.replaceChildren(errorBlock(r)); done({ title: t(`work.tab.${tab}`) }); return }
    done(workView(body, r.body, { ...panelCtx, ...manageCtx, scope: () => state.scope }, now, tab, extensionsView))
  } else if (p.view === 'inbox') {
    loading(t('inbox.title'))
    const r = await inbox.refresh()
    if (seq !== state.seq.panel) return
    if (!r.ok) { body.replaceChildren(errorBlock(r)); done({ title: t('inbox.title') }); return }
    done(inboxView(body, r.body, { ...manageCtx, inbox, openPlan: (doc) => { location.href = `/review?doc=${encodeURIComponent(doc)}` } }, now))
  }
}

function goBack() {
  const prev = state.stack.pop()
  if (prev === undefined) return false
  state.panel = { ...prev, opener: state.panel?.opener ?? prev.opener }
  renderPanel(true)
  return true
}

$('panel-close').addEventListener('click', () => closePanel())
$('panel-back').addEventListener('click', () => { goBack() })
$('btn-health').addEventListener('click', (e) => openPanel('health', null, e.currentTarget))
$('btn-settings').addEventListener('click', (e) => openPanel('settings', null, e.currentTarget))
$('btn-work').addEventListener('click', (e) => openPanel('work', 'sessions', e.currentTarget))
$('btn-inbox').addEventListener('click', (e) => openPanel('inbox', null, e.currentTarget))
$('scope').addEventListener('change', (e) => setScope(e.currentTarget.value))

const input = $('q')
const searchBox = $('search-box')
let closingSearch = false

function openSearch() {
  searchBox.classList.add('open')
  $('btn-search').setAttribute('aria-expanded', 'true')
  input.focus()
  input.select()
}

function closeSearch() {
  if (closingSearch) return
  closingSearch = true
  if (input.value !== '') { input.value = ''; clearSearch(true) }
  searchBox.classList.remove('open')
  $('btn-search').setAttribute('aria-expanded', 'false')
  input.blur()
  closingSearch = false
}

$('btn-search').addEventListener('mousedown', (e) => e.preventDefault())
$('btn-search').addEventListener('click', () => (searchBox.classList.contains('open') ? closeSearch() : openSearch()))
input.addEventListener('blur', () => { if (input.value.trim() === '') closeSearch() })

async function runSearch(quiet = false) {
  const q = input.value.trim()
  if (q === '') { clearSearch(true); return }
  searchBox.classList.add('open')
  $('btn-search').setAttribute('aria-expanded', 'true')
  const seq = ++state.seq.search
  const r = await getJson(`/api/search?scope=${encodeURIComponent(state.scope)}&q=${encodeURIComponent(q)}`)
  if (seq !== state.seq.search || !r.ok) return
  state.q = q
  state.hits = r.body.items
  updateEmphasis()
  updateNodes()
  const p = state.panel
  if (p !== null && p.view === 'detail') {
    if (state.stack[0]?.view === 'search') state.stack = [{ view: 'search', arg: q, scope: state.scope }]
  } else if (p !== null && p.view === 'search') renderPanel()
  else if (!quiet) openPanel('search', q, input)
}

function clearSearch(render) {
  state.seq.search++
  state.q = ''
  state.hits = null
  if (input.value !== '' && !render) input.value = ''
  if (render && state.panel?.view === 'search') {
    state.panel = null
    $('panel').classList.remove('open')
    $('panel').hidden = true
    document.body.classList.remove('panel-open')
    layout()
  }
  updateEmphasis()
  updateNodes()
}

const searchSoon = debounce(() => { void runSearch() }, 220)
input.addEventListener('input', () => searchSoon())
input.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.stopPropagation()
    if (input.value !== '') { input.value = ''; clearSearch(true) } else closeSearch()
  } else if (e.key === 'ArrowDown' || e.key === 'Enter') {
    const first = $('panel-body').querySelector('.mem')
    if (first !== null) { e.preventDefault(); first.focus() }
  }
})

wirePointer(canvas, renderer, { openRegion: (r) => openPanel('region', r, canvas), hover: setHover })

document.addEventListener('keydown', (e) => {
  const typing = e.target instanceof Element && e.target.closest('input, select, textarea, [contenteditable="true"]') !== null
  if (e.key === 'Escape') {
    if (state.panel !== null) closePanel()
    else if (state.graph !== null) network.hide()
    return
  }
  if (typing || e.metaKey || e.ctrlKey || e.altKey) return
  if (e.key === '/') { e.preventDefault(); openSearch() }
  else if (e.key === 'g' || e.key === 'G') network.toggle()
  else if (e.key === 't' || e.key === 'T') theme.toggle()
  else if (e.key === 'h' || e.key === 'H') openPanel('health', null, document.activeElement)
  else if (e.key === 's' || e.key === 'S') openPanel('settings', null, document.activeElement)
  else if (e.key === 'w' || e.key === 'W') openPanel('work', 'sessions', document.activeElement)
  else if (e.key === 'n' || e.key === 'N') openPanel('inbox', null, document.activeElement)
  else if (/^[1-7]$/.test(e.key)) openPanel('region', Number(e.key) - 1, document.activeElement)
})

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    renderer.stop()
    graph.stop()
  } else if (state.graph !== null) graph.start()
  else renderer.start()
})

const inbox = createInbox({ arrived: (n) => announce(t('inbox.arrived', { n: num(n) })) })
void inbox.refresh()
inbox.start()

void loadAll()
