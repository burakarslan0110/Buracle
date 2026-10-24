import { fill, h, icon, md } from './dom.js'
import { count, fmtDate, kindLabel, num, regionArea, regionLabel, relTime, t, tagText } from './i18n.js'
import { memoryActions, memoryEditor } from './manage.js'

function confidenceText(c) {
  return typeof c === 'number' ? (Math.round(c * 100) / 100).toFixed(2) : null
}

function badges(m) {
  const out = []
  if (m.status && m.status !== 'active') out.push(h('span', { class: 'badge muted' }, t(`badge.${m.status}`)))
  if (m.unverified) out.push(h('span', { class: 'badge warn' }, t('badge.unverified')))
  if (m.origin === 'explicit') out.push(h('span', { class: 'badge' }, t('badge.explicit')))
  if (m.origin === 'inferred') {
    const c = confidenceText(m.confidence)
    out.push(h('span', { class: 'badge' }, c !== null ? t('badge.inferred', { c }) : t('badge.inferredUnsure')))
  }
  if (m.contradicts) out.push(h('span', { class: 'badge alert' }, t('badge.contradicts')))
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
    unverified: mine.filter(m => m.unverified),
  }
  const list = h('div', { class: 'region-list' })
  const showFilter = (f) => {
    fill(list, sets[f].length > 0 ? memoryList(sets[f], ctx, now) : empty(t(mine.length > 0 ? 'region.emptyFilter' : region.id === 'self' ? 'region.emptySelf' : 'region.empty')))
    for (const c of chips.children) c.setAttribute('aria-pressed', String(c.dataset.filter === f))
    ctx.setFilter?.(f)
  }
  const chips = h('div', { class: 'filters', role: 'group', 'aria-label': t('filter.label') },
    ['all', 'unverified'].map(f => {
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

const PROVENANCE = ['harness', 'model', 'session', 'branch', 'commit', 'verifiedAt', 'verifiedBy', 'verifiedCommit', 'importedFrom', 'expires', 'supersededBy', 'supersededAt', 'deprecatedAt']
const TIME_KEYS = new Set(['verifiedAt', 'expires', 'supersededAt', 'deprecatedAt'])
const CODE_KEYS = new Set(['session', 'commit', 'verifiedCommit', 'supersededBy', 'branch'])

function originText(m) {
  if (m.origin === 'explicit') return t('value.explicit')
  if (m.origin === 'inferred') return t('value.inferred')
  return t('value.originUnknown')
}

function provenanceRows(m) {
  const c = confidenceText(m.confidence)
  const rows = [
    [t('field.scope'), m.scope?.layer === 'person' ? t('scope.person') : String(m.scope?.project ?? '')],
    [t('field.origin'), m.origin === 'explicit' || m.origin === 'inferred' ? h('span', { class: 'badge' }, originText(m)) : originText(m)],
    [t('field.confidence'), c !== null ? t('value.confidence', { c }) : t('value.confidenceUnknown')],
    [t('field.status'), t(`value.${m.status}`)],
    [t('field.review'), t(`value.${m.review}`)],
    [t('field.importance'), importance(m.importance)],
    [t('field.author'), t(`value.${m.author}`)],
    [t('field.created'), fmtDate(m.created)],
    [t('field.updated'), fmtDate(m.updated)],
    [t('field.version'), String(m.version)],
  ]
  if (m.recallCount) rows.push([t('field.recalls'), t('value.times', { n: num(m.recallCount) })])
  if (m.lastRecalledAt) rows.push([t('field.lastRecalledAt'), fmtDate(m.lastRecalledAt)])
  for (const k of PROVENANCE) {
    const v = m.provenance?.[k]
    if (v === undefined || v === '') continue
    rows.push([t(`field.${k}`), TIME_KEYS.has(k) ? fmtDate(String(v)) : CODE_KEYS.has(k) ? h('code', null, String(v)) : String(v)])
  }
  return rows
}

function refItem(ref, ctx, note) {
  const known = typeof ref.title === 'string'
  const label = known ? ref.title : ref.id
  const open = known && typeof ctx.openMemory === 'function'
    ? h('button', { type: 'button', class: 'link', title: t('detail.openRef', { title: label }) }, label)
    : h('code', null, label)
  if (known && typeof ctx.openMemory === 'function') open.addEventListener('click', () => ctx.openMemory(ref.id, ctx.memoryScope))
  return h('li', null,
    known ? h('span', { class: 'ref-kind' }, kindLabel(ref.kind)) : null,
    open,
    known && ref.status && ref.status !== 'active' ? h('span', { class: 'badge muted' }, t(`badge.${ref.status}`)) : null,
    !known ? h('span', { class: 'meta-inline' }, t('detail.refMissing')) : null,
    note ? h('span', { class: 'meta-inline' }, note) : null)
}

function relationGroup(titleKey, list, ctx, note) {
  if (!Array.isArray(list) || list.length === 0) return null
  return h('div', { class: 'rel-group' }, h('h4', null, t(titleKey)), h('ul', { class: 'refs' }, list.map(x => refItem(x, ctx, note?.(x)))))
}

function relationsSection(r, ctx) {
  if (r === undefined || r === null) return null
  const about = (Array.isArray(r.about) ? r.about : []).map(a => h('div', { class: 'rel-group' },
    h('h4', null, t('detail.about'), h('span', { class: 'tag' }, a.name)),
    a.others.length > 0 ? h('ul', { class: 'refs' }, a.others.map(x => refItem(x, ctx))) : h('p', { class: 'meta' }, t('detail.aboutAlone')),
    a.total > a.others.length ? h('p', { class: 'meta' }, t('detail.aboutMore', { n: num(a.total - a.others.length) })) : null))
  const groups = [
    relationGroup('detail.supersededBy', r.supersededBy ? [r.supersededBy] : [], ctx),
    relationGroup('detail.supersedes', r.supersedes, ctx),
    relationGroup('detail.writtenBeside', r.contradicts, ctx, x => t(`detail.why.${x.why}`)),
    relationGroup('detail.contradictedBy', r.contradictedBy, ctx),
    relationGroup('detail.cites', r.cites, ctx, x => t(`detail.via.${x.via}`)),
    relationGroup('detail.citedBy', r.citedBy, ctx),
    ...about,
  ].filter(Boolean)
  return section(t('detail.relations'), groups.length > 0 ? groups : empty(t('detail.noRelations')))
}

export function detailView(body, m, ctx) {
  const canEdit = typeof ctx.memoryScope === 'string' && typeof ctx.memoryChanged === 'function'
  const edit = canEdit ? h('button', { type: 'button', class: 'btn sm quiet', 'data-key': 'edit' }, icon('pen', 'icon xs'), t('edit.open')) : null
  edit?.addEventListener('click', () => memoryEditor(body, m, ctx, () => {
    detailView(body, m, ctx)
    body.querySelector('[data-key="edit"]')?.focus()
  }))
  const parts = [
    m.summary ? h('p', { class: 'lead' }, m.summary) : null,
    h('div', { class: 'badges' }, badges(m)),
    edit !== null ? h('div', { class: 'btn-row' }, edit) : null,
  ]
  if (m.contradicts) {
    parts.push(h('section', { class: 'sec contradiction-note' },
      h('h3', null, icon('alert', 'icon xs'), t('detail.contradicts')),
      m.contradictedNote ? h('p', null, h('q', null, m.contradictedNote)) : null,
    ))
  }
  parts.push(section(t('detail.body'), m.body ? h('div', { class: 'md' }, md(m.body)) : empty(t('detail.noBody'))))
  if (m.tags.length > 0) parts.push(section(t('detail.tags'), h('div', { class: 'tags' }, m.tags.map(tg => h('span', { class: 'tag' }, tg)))))
  if (m.sources.length > 0) parts.push(section(t('detail.sources'), h('ul', { class: 'sources' }, m.sources.map(s => h('li', null, icon('file', 'icon xs'), h('code', null, s))))))
  parts.push(relationsSection(m.relations, ctx))
  parts.push(section(t('detail.provenance'), h('dl', { class: 'props' }, provenanceRows(m).flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v)]))))
  if (m.history.length > 0) {
    parts.push(section(t('detail.history'), h('ol', { class: 'history' }, [...m.history].reverse().map(e =>
      h('li', null, h('time', { datetime: e.at }, fmtDate(e.at)), h('span', { class: 'by' }, e.by), h('span', null, e.what))))))
  }
  parts.push(memoryActions(m, ctx))
  fill(body, ...parts.filter(Boolean))
  return { kicker: `${kindLabel(m.kind)} · ${regionLabel(m.region)}`, title: m.title, region: m.region }
}

export function searchView(body, q, items, ctx, now) {
  fill(body,
    items.length > 0 ? h('p', { class: 'meta' }, t('search.hint')) : empty(t('search.none', { q })),
    items.length > 0 ? memoryList(items, ctx, now) : null,
  )
  return { kicker: t('search.results', { n: count('results', items.length), q }), title: t('search.title') }
}

