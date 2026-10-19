import { getJson, h } from './dom.js'
import { count, kindLabel, num, regionArea, regionLabel, t } from './i18n.js'

export function createNetwork(ctx) {
  const { state, graph, tip } = ctx
  const $ = (id) => document.getElementById(id)

  function showTip(node, x, y) {
    if (node === null) { tip.hidden = true; return }
    if (node.type === 'memory') {
      tip.replaceChildren(h('span', { class: 'tip-kind', 'data-region': node.region }, kindLabel(node.kind)), h('strong', null, node.title), h('small', null, count('links', node.degree ?? 0)))
    } else {
      tip.replaceChildren(h('span', { class: `tip-kind is-${node.type}` }, t(`graph.type.${node.type}`)), h('strong', null, node.label), h('small', null, count('memories', node.weight ?? 0)))
    }
    ctx.placeTip(x, y)
  }

  function title() {
    const g = state.graph
    if (g.region < 0) return { kicker: `${t('graph.kicker')} · ${ctx.scopeName(state.scope)}`, title: t('graph.whole'), region: undefined }
    const id = ctx.regionIds()[g.region]
    return { kicker: `${t('graph.kicker')} · ${regionArea(id)}`, title: regionLabel(id), region: id }
  }

  function renderBar() {
    const g = state.graph
    if (g === null) return
    const head = title()
    $('graph-kicker').textContent = head.kicker
    $('graph-title').textContent = head.title
    const bar = $('graph-bar')
    if (head.region !== undefined) bar.dataset.region = head.region
    else delete bar.dataset.region
    const d = g.data
    const stats = $('graph-stats')
    const legend = $('graph-legend')
    if (d === null) {
      stats.textContent = t('graph.loading')
      legend.replaceChildren()
      return
    }
    const mems = d.nodes.filter((n) => n.type === 'memory')
    const parts = [count('memories', mems.length), count('links', d.edges.length)]
    if (d.truncated) parts.push(t('graph.truncated'))
    stats.textContent = mems.length === 0 ? t('graph.empty') : parts.join(' · ')
    const byType = (type) => d.nodes.filter((n) => n.type === type).length
    const regions = [...new Set(mems.map((n) => n.region))]
    legend.replaceChildren(
      ...regions.map((r) => h('li', { 'data-region': r }, h('i', { class: 'dot', 'aria-hidden': 'true' }), regionLabel(r), h('b', null, num(mems.filter((n) => n.region === r).length)))),
      ...['tag', 'concept', 'file'].filter((type) => byType(type) > 0).map((type) => h('li', { class: `is-${type}` }, h('i', { class: 'dot', 'aria-hidden': 'true' }), t(`graph.type.${type}`), h('b', null, num(byType(type))))),
    )
  }

  async function load(keep) {
    const g = state.graph
    if (g === null) return
    const seq = ++state.seq.graph
    const region = g.region >= 0 ? ctx.regionIds()[g.region] : ''
    const r = await getJson(`/api/graph?scope=${encodeURIComponent(state.scope)}&region=${encodeURIComponent(region)}`)
    if (seq !== state.seq.graph || state.graph !== g) return
    if (!r.ok) {
      $('graph-stats').textContent = r.body?.message ?? t('state.error')
      return
    }
    g.data = r.body
    graph.setData(r.body, keep)
    renderBar()
    ctx.updateNodes()
  }

  function show(i, owner = 'panel') {
    if (state.graph !== null && state.graph.region === i) {
      if (owner === 'user') state.graph.owner = 'user'
      return
    }
    state.graph = { region: i, owner, data: null }
    ctx.hideState()
    tip.hidden = true
    $('graph-bar').hidden = false
    document.body.classList.add('graph-mode')
    $('btn-graph').setAttribute('aria-pressed', 'true')
    graph.clear()
    renderBar()
    ctx.layout()
    graph.start()
    setTimeout(() => { if (state.graph !== null) ctx.brainOn(false) }, ctx.reducedMotion ? 0 : 450)
    void load(false)
  }

  function hide() {
    if (state.graph === null) return
    state.graph = null
    state.seq.graph++
    tip.hidden = true
    $('graph-bar').hidden = true
    document.body.classList.remove('graph-mode')
    $('btn-graph').setAttribute('aria-pressed', 'false')
    graph.stop()
    graph.clear()
    if (!document.hidden) ctx.brainOn(true)
    if (state.brain !== null && state.brain.items.length === 0) ctx.showEmpty()
    ctx.layout()
  }

  function toggle() {
    if (state.graph !== null && state.graph.region < 0) hide()
    else show(-1, 'user')
  }

  $('graph-back').addEventListener('click', () => {
    if (state.panel !== null && state.graph?.owner === 'panel') ctx.closePanel()
    else hide()
  })
  $('graph-in').addEventListener('click', () => graph.zoomBy(1.3))
  $('graph-out').addEventListener('click', () => graph.zoomBy(1 / 1.3))
  $('graph-fit').addEventListener('click', () => graph.fit())
  $('btn-graph').addEventListener('click', () => toggle())

  return { showTip, renderBar, load, show, hide, toggle }
}
