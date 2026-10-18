import { fill, h, icon, md } from './dom.js'
import { count, fmtDate, kindLabel, num, reasonLabel, regionArea, regionLabel, relTime, t, tagText } from './i18n.js'
import { memoryActions } from './manage.js'

const REASON_ORDER = ['contradicted', 'source-missing', 'capture', 'duplicate', 'source-changed', 'unverified', 'stale']

function badges(m) {
  const out = []
  if (m.status && m.status !== 'active') out.push(h('span', { class: 'badge muted' }, t(`badge.${m.status}`)))
  if (m.unverified) out.push(h('span', { class: 'badge warn' }, t('badge.unverified')))
  const reasons = (m.upkeep ?? []).filter(r => !(r === 'unverified' && m.unverified))
  if (reasons.length > 0) {
    out.push(h('span', { class: 'badge alert', title: reasons.map(reasonLabel).join(', ') }, reasonLabel(reasons[0]), reasons.length > 1 ? ` +${reasons.length - 1}` : ''))
  }
  if (m.pinned) out.push(h('span', { class: 'badge' }, icon('pin', 'icon xs'), t('badge.pinned')))
  if (m.recallCount) out.push(h('span', { class: 'badge muted' }, icon('eye', 'icon xs'), t('badge.recalled', { n: num(m.recallCount) })))
  return out
}

export function memoryRow(m, ctx, now) {
  const b = h('button', { type: 'button', class: 'mem', 'data-region': m.region },
    h('span', { class: 'mem-top' },
      h('span', { class: 'kind' }, h('i', { class: 'dot', 'aria-hidden': 'true' }), kindLabel(m.kind)),
      h('time', { datetime: m.updated || m.created, title: fmtDate(m.updated || m.created) }, relTime(m.updated || m.created, now))),
    h('strong', { class: 'mem-title' }, m.title),
    m.summary ? h('span', { class: 'mem-sum' }, m.summary) : null,
    h('span', { class: 'badges' }, badges(m)),
  )
  b.addEventListener('click', () => ctx.openMemory(m.id, ctx.scopeFor?.(m)))
  b.addEventListener('pointerenter', () => ctx.hoverMemory(m.id))
  b.addEventListener('pointerleave', () => ctx.hoverMemory(null))
  b.addEventListener('focus', () => ctx.hoverMemory(m.id))
  b.addEventListener('blur', () => ctx.hoverMemory(null))
  return h('li', null, b)
}

function memoryList(items, ctx, now) {
  return h('ul', { class: 'mem-list' }, items.map(m => memoryRow(m, ctx, now)))
}

function empty(text) {
  return h('p', { class: 'empty' }, text)
}

export function regionView(body, region, items, ctx, now, filter = 'all') {
  const mine = items.filter(m => m.region === region.id)
  const sets = {
    all: mine,
    upkeep: mine.filter(m => m.upkeep && m.upkeep.length > 0),
    unverified: mine.filter(m => m.unverified),
  }
  const list = h('div', { class: 'region-list' })
  const showFilter = (f) => {
    fill(list, sets[f].length > 0 ? memoryList(sets[f], ctx, now) : empty(t(mine.length > 0 ? 'region.emptyFilter' : region.id === 'self' ? 'region.emptySelf' : 'region.empty')))
    for (const c of chips.children) c.setAttribute('aria-pressed', String(c.dataset.filter === f))
    ctx.setFilter?.(f)
  }
  const chips = h('div', { class: 'filters', role: 'group', 'aria-label': t('filter.label') },
    ['all', 'upkeep', 'unverified'].map(f => {
      const b = h('button', { type: 'button', class: 'filter', 'data-filter': f, 'aria-pressed': String(f === filter) }, t(`filter.${f}`), h('b', null, num(sets[f].length)))
      b.addEventListener('click', () => showFilter(f))
      return b
    }))
  const tags = region.topTags.length > 0 ? h('div', { class: 'tags' }, region.topTags.map(tg => h('span', { class: 'tag' }, tagText(tg)))) : null
  fill(body,
    h('p', { class: 'stats' }, `${count('memories', region.count)} · ${count('groups', region.groups)}`),
    tags,
    mine.length > 0 ? chips : null,
    list,
  )
  showFilter(sets[filter] !== undefined ? filter : 'all')
  return { kicker: regionArea(region.id), title: regionLabel(region.id), region: region.id }
}

function section(title, ...children) {
  return h('section', { class: 'sec' }, h('h3', null, title), ...children)
}

function importance(n) {
  return h('span', { class: 'importance', 'aria-label': `${n} / 5` }, [1, 2, 3, 4, 5].map(k => h('i', { class: k <= n ? 'on' : '' })))
}

const PROVENANCE = ['harness', 'model', 'session', 'branch', 'commit', 'verifiedAt', 'verifiedBy', 'verifiedCommit', 'importedFrom', 'expires', 'supersededBy', 'supersededAt', 'deprecatedAt', 'version']
const TIME_KEYS = new Set(['verifiedAt', 'expires', 'supersededAt', 'deprecatedAt'])
const CODE_KEYS = new Set(['session', 'commit', 'verifiedCommit', 'supersededBy', 'branch'])

export function detailView(body, m, ctx) {
  const rows = [
    [t('field.layer'), t(`value.${m.layer}`)],
    [t('field.status'), t(`value.${m.status}`)],
    [t('field.review'), t(`value.${m.review}`)],
    [t('field.importance'), importance(m.importance)],
    [t('field.author'), t(`value.${m.author}`)],
    [t('field.created'), fmtDate(m.created)],
    [t('field.updated'), fmtDate(m.updated)],
  ]
  if (m.recallCount) rows.push([t('field.recalls'), t('value.times', { n: num(m.recallCount) })])
  if (m.lastRecalledAt) rows.push([t('field.lastRecalledAt'), fmtDate(m.lastRecalledAt)])
  for (const k of PROVENANCE) {
    const v = m.provenance?.[k]
    if (v === undefined || v === '') continue
    rows.push([t(`field.${k}`), TIME_KEYS.has(k) ? fmtDate(String(v)) : CODE_KEYS.has(k) ? h('code', null, String(v)) : String(v)])
  }
  const parts = [
    m.summary ? h('p', { class: 'lead' }, m.summary) : null,
    h('div', { class: 'badges' }, badges(m)),
  ]
  if (m.upkeep && m.upkeep.length > 0) {
    parts.push(h('section', { class: 'sec upkeep-note' },
      h('h3', null, icon('sparkle', 'icon xs'), t('detail.upkeep')),
      h('ul', { class: 'reasons' }, m.upkeep.map(r => h('li', null, reasonLabel(r)))),
      m.upkeepAction ? h('p', { class: 'action' }, h('span', null, t('upkeep.action')), h('code', null, m.upkeepAction)) : null,
      m.twin ? h('p', null, `${t('upkeep.twin')}: `, linkButton(m.twin, ctx)) : null,
      m.files && m.files.length > 0 ? h('p', null, `${t('upkeep.files')}: `, m.files.map(f => h('code', null, f))) : null,
      m.upkeepNote ? h('p', null, `${t('upkeep.note')}: `, h('q', null, m.upkeepNote)) : null,
    ))
  }
  parts.push(section(t('detail.body'), m.body ? h('div', { class: 'md' }, md(m.body)) : empty(t('detail.noBody'))))
  if (m.tags.length > 0) parts.push(section(t('detail.tags'), h('div', { class: 'tags' }, m.tags.map(tg => h('span', { class: 'tag' }, tg)))))
  if (m.sources.length > 0) parts.push(section(t('detail.sources'), h('ul', { class: 'sources' }, m.sources.map(s => h('li', null, icon('file', 'icon xs'), h('code', null, s))))))
  parts.push(section(t('detail.provenance'), h('dl', { class: 'props' }, rows.flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v)]))))
  if (m.history.length > 0) {
    parts.push(section(t('detail.history'), h('ol', { class: 'history' }, [...m.history].reverse().map(e =>
      h('li', null, h('time', { datetime: e.at }, fmtDate(e.at)), h('span', { class: 'by' }, e.by), h('span', null, e.what))))))
  }
  parts.push(memoryActions(m, ctx))
  fill(body, ...parts.filter(Boolean))
  return { kicker: `${kindLabel(m.kind)} · ${regionLabel(m.region)}`, title: m.title, region: m.region }
}

function linkButton(id, ctx) {
  const b = h('button', { type: 'button', class: 'link' }, h('code', null, id))
  b.addEventListener('click', () => ctx.openMemory(id))
  return b
}

export function upkeepView(body, data, ctx, now) {
  const head = h('p', { class: 'lead' }, t('upkeep.lead'))
  const when = [data.at ? t('upkeep.checked', { t: relTime(data.at, now) }) : '', data.gitAt ? t('upkeep.git', { t: relTime(data.gitAt, now) }) : ''].filter(Boolean).join(' · ')
  if (data.items.length === 0) {
    fill(body, head, h('p', { class: 'clean' }, icon('check', 'icon'), t('upkeep.empty')), when ? h('p', { class: 'meta' }, when) : null)
  } else {
    const groups = REASON_ORDER.map(r => ({ r, items: data.items.filter(u => u.reasons[0] === r) })).filter(g => g.items.length > 0)
    fill(body, head, when ? h('p', { class: 'meta' }, when) : '',
      ...groups.map(g => section(`${reasonLabel(g.r)} · ${num(g.items.length)}`, h('ul', { class: 'mem-list' }, g.items.map(u => {
        const b = h('button', { type: 'button', class: 'mem', 'data-region': u.region },
          h('span', { class: 'mem-top' }, h('span', { class: 'kind' }, h('i', { class: 'dot', 'aria-hidden': 'true' }), kindLabel(u.kind)), h('span', { class: 'reasons-inline' }, u.reasons.map(reasonLabel).join(' · '))),
          h('strong', { class: 'mem-title' }, u.title),
          u.note ? h('span', { class: 'mem-sum' }, `${t('upkeep.note')}: `, h('q', null, u.note)) : null,
          h('code', { class: 'action' }, u.action))
        b.addEventListener('click', () => ctx.openMemory(u.id))
        b.addEventListener('pointerenter', () => ctx.hoverMemory(u.id))
        b.addEventListener('pointerleave', () => ctx.hoverMemory(null))
        return h('li', null, b)
      })))))
  }
  return { kicker: count('items', data.items.length), title: t('upkeep.title') }
}

export function profileView(body, data, ctx, now) {
  const parts = [h('p', { class: 'lead' }, t('profile.lead'))]
  if (data.lines.length === 0 && data.facts.length === 0 && data.preferences.length === 0) parts.push(empty(t('profile.empty')))
  if (data.lines.length > 0) parts.push(section(t('profile.lines'), h('ul', { class: 'lines' }, data.lines.map(l => h('li', null, l)))))
  const learned = data.facts.filter(f => !f.hypothesis)
  const hyp = data.facts.filter(f => f.hypothesis)
  const factList = (list) => h('ul', { class: 'facts' }, list.map(f => h('li', null,
    h('span', null, f.title),
    h('span', { class: 'fact-meta', lang: 'en' }, [f.category, f.confidence, f.stated ? t('profile.stated') : f.inferred ? t('profile.inferred') : ''].filter(Boolean).join(' · ')))))
  if (learned.length > data.lines.length) parts.push(section(t('profile.facts'), factList(learned)))
  if (hyp.length > 0) parts.push(section(t('profile.hypotheses'), factList(hyp)))
  if (data.preferences.length > 0) parts.push(section(t('profile.preferences'), memoryList(data.preferences, { ...ctx, scopeFor: () => 'person' }, now)))
  fill(body, ...parts)
  return { kicker: t('scope.person'), title: t('profile.title'), region: 'self' }
}

const GUARD_ORDER = ['allowlist', 'shown-only', 'no-delete', 'no-verify', 'claims-locked', 'generated-locked', 'redacted', 'budget', 'lock-and-version', 'undo', 'local-only']

export function reflectView(body, data, ctx, now) {
  const c = data.config ?? {}
  const picks = Array.isArray(c.harnesses) ? c.harnesses : []
  const held = Array.isArray(c.held) ? c.held : []
  const first = picks[0]
  const model = first !== undefined
    ? t('reflect.viaHarness', { harness: String(first.harness ?? '?'), model: typeof first.model === 'string' && first.model !== '' ? first.model : t('model.defaultModel') })
    : h('span', { class: 'warn-text' }, t(held.length > 0 ? 'health.allHeld' : 'model.noneKnown'))
  const facts = [
    [t('reflect.model'), model],
    [t('reflect.data'), t('reflect.local')],
    [t('reflect.budget'), t('reflect.budgetLine', { n: num(c.runsToday ?? 0), ops: num(c.maxOpsPerRun ?? 0), q: num(c.maxSubQueries ?? 0), min: num(c.relateEveryMin ?? 0) })],
  ]
  const guards = GUARD_ORDER.filter(g => (data.guards ?? []).includes(g))
  const runs = Array.isArray(data.runs) ? data.runs : []
  const target = (o) => (o.op === 'file' && typeof o.to === 'string' && o.to.includes('-') ? o.to : o.id)
  const opName = (op) => (t(`rop.${op}`) === `rop.${op}` ? h('code', null, String(op)) : t(`rop.${op}`))
  const opLine = (o) => h('li', null,
    h('span', { class: 'op' }, opName(o.op)),
    target(o) ? linkButton(target(o), ctx) : null,
    o.reason ? h('span', { class: 'why' }, t(`rreason.${o.reason}`)) : o.why ? h('span', { class: 'why' }, o.why) : null)
  const runCard = (r) => {
    const applied = Array.isArray(r.applied) ? r.applied : []
    const planned = Array.isArray(r.planned) ? r.planned : []
    const rejected = Array.isArray(r.rejected) ? r.rejected : []
    const head = h('summary', null,
      h('span', { class: 'run-top' },
        h('time', { datetime: r.at, title: fmtDate(r.at) }, relTime(r.at, now)),
        h('span', null, [t(`reflect.trigger.${r.trigger}`), r.harness, r.model].filter(Boolean).join(' · ')),
        r.undone ? h('span', { class: 'badge muted' }, t('reflect.undone')) : null,
        r.dryRun ? h('span', { class: 'badge muted' }, t('reflect.dryRun')) : null),
      h('span', { class: 'run-sum' }, r.skipped ? t('reflect.skipped', { why: t(`rskip.${r.skipped}`) }) : t('reflect.summary', { q: num(r.subQueries ?? 0), a: num(r.dryRun ? planned.length : applied.length), r: num(rejected.length) })),
      r.skipped && r.detail ? h('span', { class: 'run-detail', lang: 'en' }, r.detail) : null)
    return h('li', null, h('details', { class: 'run' }, head,
      applied.length > 0 ? h('div', { class: 'run-part' }, h('h4', null, t('reflect.applied')), h('ul', { class: 'ops' }, applied.map(opLine))) : null,
      planned.length > 0 ? h('div', { class: 'run-part' }, h('h4', null, t('reflect.planned')), h('ul', { class: 'ops' }, planned.map(opLine))) : null,
      rejected.length > 0 ? h('div', { class: 'run-part' }, h('h4', null, t('reflect.rejected')), h('ul', { class: 'ops rejected' }, rejected.map(opLine))) : null,
      r.undo && !r.undone ? h('p', { class: 'action' }, h('span', null, t('reflect.undo')), h('code', null, r.undo)) : null))
  }
  fill(body,
    h('p', { class: 'lead' }, t('reflect.lead')),
    section(t('reflect.state'), h('dl', { class: 'props' }, facts.flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v)]))),
    guards.length > 0 ? section(t('reflect.guards'), h('ul', { class: 'guards' }, guards.map(g => h('li', null, icon('check', 'icon xs'), h('span', null, t(`guard.${g}`)))))) : null,
    section(t('reflect.runs'), runs.length > 0 ? h('ul', { class: 'runs' }, runs.map(runCard)) : empty(t('reflect.none'))),
    section(t('reflect.commands'), h('ul', { class: 'cmds' },
      h('li', null, h('code', null, 'buracle mem reflect --dry-run'), h('span', null, t('reflect.cmd.dry'))),
      h('li', null, h('code', null, 'buracle mem reflect --list'), h('span', null, t('reflect.cmd.list'))))),
  )
  return { kicker: t('reflect.auto'), title: t('reflect.title') }
}

export function searchView(body, q, items, ctx, now) {
  fill(body,
    items.length > 0 ? h('p', { class: 'meta' }, t('search.hint')) : empty(t('search.none', { q })),
    items.length > 0 ? memoryList(items, ctx, now) : null,
  )
  return { kicker: t('search.results', { n: count('results', items.length), q }), title: t('search.title') }
}

