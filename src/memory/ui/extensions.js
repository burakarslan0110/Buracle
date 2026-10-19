import { fill, h, icon } from './dom.js'
import { num, t } from './i18n.js'
import { HARNESSES, harnessLabel, harnessName } from './work.js'

const view = { q: '' }

function reachCell(id, state) {
  const s = state === 'ok' || state === 'missing' ? state : 'off'
  return h('td', { class: 'num' }, h('span', { class: `reach is-${s}`, title: `${harnessName(id)}: ${t(`ext.reach.${s}`)}` },
    s === 'ok' ? icon('check', 'icon xs') : s === 'missing' ? icon('alert', 'icon xs') : null,
    h('span', null, t(`ext.reach.${s}`))))
}

function head(first) {
  return h('thead', null, h('tr', null, h('th', { scope: 'col' }, first), HARNESSES.map(id => h('th', { scope: 'col', class: 'num' }, harnessLabel(id)))))
}

function matches(item, q) {
  if (q === '') return true
  return [item.id, item.description, item.title, item.source, ...(item.paths ?? [])].some(x => typeof x === 'string' && x.toLowerCase().includes(q))
}

function lintBadge(l) {
  if (!l) return null
  if (l.errors > 0) return h('span', { class: 'badge alert', title: l.first ?? '' }, t('ext.lintErrors', { n: num(l.errors) }))
  if (l.warnings > 0) return h('span', { class: 'badge warn', title: l.first ?? '' }, t('ext.lintWarnings', { n: num(l.warnings) }))
  return h('span', { class: 'badge muted' }, t('ext.lintClean'))
}

function sourceLabel(s) {
  if (s.source === 'installed') return t('ext.source.installed')
  if (s.kind === 'project') return t('ext.source.project')
  if (s.kind === 'claude-only') return t('ext.source.claudeOnly')
  if (s.kind === 'unmanaged') return t('ext.source.unmanaged')
  if (s.kind === 'canonical') return t('ext.source.buracle')
  return t('ext.source.yours', { name: String(s.source) })
}

function skillRows(skills) {
  return skills.map(s => h('tr', null,
    h('td', null, h('strong', null, s.id),
      s.description ? h('span', { class: 'sub clamp', title: s.description }, s.description) : null,
      h('span', { class: 'badges' },
        h('span', { class: 'badge muted' }, sourceLabel(s)),
        s.invocation === 'explicit' ? h('span', { class: 'badge muted' }, t('ext.explicit')) : null,
        lintBadge(s.lint),
        s.edited ? h('span', { class: 'badge warn' }, t('ext.edited')) : null,
        s.duplicate ? h('span', { class: 'badge warn' }, t('ext.duplicate')) : null,
        s.error ? h('span', { class: 'badge alert' }, s.error) : null)),
    HARNESSES.map(id => reachCell(id, s.where?.[id]))))
}

function table(first, rows) {
  return h('div', { class: 'table-wrap' }, h('table', { class: 'grid-table' }, head(first), h('tbody', null, rows)))
}

function sec(title, lead, ...children) {
  return h('section', { class: 'sec' }, h('h3', null, title), lead ? h('p', { class: 'set-lead' }, lead) : null, ...children)
}

export function extensionsView(body, data, ctx, tabs) {
  const off = HARNESSES.filter(id => data.harnesses?.[id] === false)
  const results = h('div')
  const render = () => {
    const q = view.q.trim().toLowerCase()
    const skills = (data.skills ?? []).filter(s => matches(s, q))
    const agents = (data.agents ?? []).filter(a => matches(a, q))
    const rules = (data.rules ?? []).filter(r => matches(r, q))
    const missing = [...(data.skills ?? []), ...(data.agents ?? []), ...(data.rules ?? [])].filter(x => HARNESSES.some(id => x.where?.[id] === 'missing')).length
    fill(results,
      missing > 0 ? h('p', { class: 'warn-text' }, icon('alert', 'icon xs'), ' ', t('ext.missingLine', { n: num(missing) }), ' ', h('code', null, 'buracle install'), ' · ', h('code', null, 'buracle doctor')) : null,
      sec(t('ext.skills', { n: num(skills.length) }), t('ext.skillsLead'), skills.length > 0 ? table(t('ext.col.skill'), skillRows(skills)) : h('p', { class: 'empty' }, t('ext.none'))),
      sec(t('ext.agents', { n: num(agents.length) }), t('ext.agentsLead'), agents.length > 0
        ? table(t('ext.col.agent'), agents.map(a => h('tr', null, h('td', null, h('strong', null, a.id), a.description ? h('span', { class: 'sub clamp', title: a.description }, a.description) : null), HARNESSES.map(id => reachCell(id, a.where?.[id])))))
        : h('p', { class: 'empty' }, t('ext.none'))),
      sec(t('ext.rules', { n: num(rules.length) }), t('ext.rulesLead'), rules.length > 0
        ? table(t('ext.col.rule'), rules.map(r => h('tr', null, h('td', null, h('strong', null, r.title ?? r.id),
          h('span', { class: 'sub' }, r.scope === 'always' ? t('ext.always') : t('ext.paths', { globs: (r.paths ?? []).slice(0, 6).join(', ') + ((r.paths ?? []).length > 6 ? ', ...' : '') }))),
          HARNESSES.map(id => reachCell(id, r.where?.[id])))))
        : h('p', { class: 'empty' }, t('ext.none'))))
  }
  const search = h('input', { type: 'search', class: 'inp', 'data-key': 'ext-q', placeholder: t('ext.search'), 'aria-label': t('ext.search'), value: view.q, maxlength: '80' })
  search.addEventListener('input', () => { view.q = search.value; render() })
  fill(body,
    tabs,
    h('p', { class: 'set-lead' }, t('ext.lead')),
    off.length > 0 ? h('p', { class: 'meta' }, t('ext.offLine', { list: off.map(harnessName).join(', ') })) : null,
    h('div', { class: 'toolbar' }, search),
    results)
  render()
  return { kicker: t('work.kicker'), title: t('work.tab.extensions') }
}
