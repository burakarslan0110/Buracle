import { h, svg } from './dom.js'
import { count, listJoin, regionArea, regionLabel, tagText } from './i18n.js'
import { project } from './render.js'

export const NARROW = 760

export function createHud({ svgEl, labelsEl, legendEl, onOpen, onHover }) {
  const leaders = svg('g', { class: 'hud-leaders' })
  svgEl.append(leaders)
  let lines = []
  let labels = []
  let chips = []
  let layout = null

  function setLayout(brain) {
    if (layout === brain) return
    layout = brain
    leaders.replaceChildren()
    labelsEl.replaceChildren()
    legendEl.replaceChildren()
    lines = brain.ids.map((id) => {
      const l = svg('polyline', { class: 'leader', 'data-region': id, points: '' })
      leaders.append(l)
      return l
    })
    labels = brain.ids.map((id, i) => {
      const marker = h('span', { class: 'marker', 'data-region': id, 'aria-hidden': 'true' }, h('i'))
      marker.addEventListener('click', () => onOpen(i, marker))
      marker.addEventListener('pointerenter', () => onHover(i))
      marker.addEventListener('pointerleave', () => onHover(-1))
      const title = h('strong', { class: 'rl-title' }, regionLabel(id))
      const sub = h('small', { class: 'rl-sub' })
      const box = h('button', { type: 'button', class: 'rlabel', 'data-region': id }, title, sub)
      box.addEventListener('click', () => onOpen(i, box))
      box.addEventListener('pointerenter', () => onHover(i))
      box.addEventListener('pointerleave', () => onHover(-1))
      box.addEventListener('focus', () => onHover(i))
      box.addEventListener('blur', () => onHover(-1))
      const pinCount = h('b')
      const pin = h('button', { type: 'button', class: 'pin', 'data-region': id, tabindex: '-1', 'aria-hidden': 'true' }, h('i'), pinCount)
      pin.addEventListener('click', () => onOpen(i, pin))
      for (const el of [marker, box, pin]) el.style.setProperty('--i', String(i))
      labelsEl.append(marker, box, pin)
      return { id, marker, box, title, sub, pin, pinCount, w: 0, h: 0 }
    })
    chips = brain.ids.map((id, i) => {
      const n = h('b')
      const name = h('span', { text: regionLabel(id) })
      const chip = h('button', { type: 'button', class: 'chip', 'data-region': id }, h('i'), name, n)
      chip.addEventListener('click', () => onOpen(i, chip))
      legendEl.append(chip)
      return { chip, n, name }
    })
    dimmed = false
  }

  let narrow = false
  let width = 0
  let height = 0
  let dimmed = false

  function setRegions(regions) {
    regions.forEach((r, i) => {
      const lb = labels[i]
      if (lb === undefined) return
      lb.title.textContent = regionLabel(r.id)
      chips[i].name.textContent = regionLabel(r.id)
      const parts = [count('memories', r.count)]
      if (Array.isArray(r.categories)) {
        if (r.explicit > 0) parts.push(count('explicit', r.explicit))
        if (r.inferred > 0) parts.push(count('inferred', r.inferred))
      } else parts.push(count('groups', r.groups))
      if (r.topTags.length > 0) parts.push(listJoin(r.topTags.slice(0, 2).map(tagText)))
      lb.sub.textContent = parts.join(' · ')
      const name = `${regionLabel(r.id)}, ${regionArea(r.id)}: ${parts.join(', ')}`
      lb.box.setAttribute('aria-label', name)
      lb.pinCount.textContent = String(r.count)
      for (const el of [lb.box, lb.marker, lb.pin]) el.classList.toggle('is-empty', r.count === 0)
      chips[i].n.textContent = String(r.count)
      chips[i].chip.setAttribute('aria-label', name)
      chips[i].chip.classList.toggle('is-empty', r.count === 0)
      lb.w = 0
    })
  }

  function resize(w, hh) {
    width = w
    height = hh
    narrow = w < NARROW
    svgEl.setAttribute('viewBox', `0 0 ${w} ${hh}`)
    svgEl.setAttribute('width', String(w))
    svgEl.setAttribute('height', String(hh))
    labelsEl.classList.toggle('narrow', narrow)
    for (const lb of labels) lb.w = 0
  }

  function update(view, area) {
    const s = view.scale * view.breath
    const cols = { left: [], right: [] }
    labels.forEach((lb, i) => {
      const a = layout.anchors[i]
      const [mx, my] = project(view, a[0], a[1], a[2])
      lb.marker.style.transform = `translate3d(${mx.toFixed(1)}px, ${my.toFixed(1)}px, 0)`
      lb.pin.style.transform = `translate3d(${mx.toFixed(1)}px, ${my.toFixed(1)}px, 0)`
      if (narrow) {
        lines[i].setAttribute('points', '')
        return
      }
      if (lb.w === 0) {
        lb.box.style.width = ''
        lb.w = lb.box.offsetWidth
        lb.h = lb.box.offsetHeight
      }
      cols[layout.place[i].side].push({ lb, i, mx, my, y: my })
    })
    if (narrow) return
    const GAP = 10
    const brainLeft = view.cx + layout.bounds.minX * s
    const brainRight = view.cx + layout.bounds.maxX * s
    for (const side of ['left', 'right']) {
      const col = cols[side].sort((a, b) => a.my - b.my || a.i - b.i)
      if (col.length === 0) continue
      const w = Math.max(...col.map(q => q.lb.w))
      let edge = side === 'left' ? brainLeft - 32 : brainRight + 32
      edge = side === 'left' ? Math.max(area.left + 12 + w, edge) : Math.min(area.right - 12 - w, edge)
      for (let k = 1; k < col.length; k++) {
        const prev = col[k - 1]
        const min = prev.y + (prev.lb.h + col[k].lb.h) / 2 + GAP
        if (col[k].y < min) col[k].y = min
      }
      const last = col[col.length - 1]
      if (last.y + last.lb.h / 2 > area.bottom - 8) last.y = area.bottom - 8 - last.lb.h / 2
      for (let k = col.length - 2; k >= 0; k--) {
        const next = col[k + 1]
        const max = next.y - (next.lb.h + col[k].lb.h) / 2 - GAP
        if (col[k].y > max) col[k].y = max
      }
      const first = col[0]
      if (first.y - first.lb.h / 2 < area.top + 8) {
        const shift = area.top + 8 - (first.y - first.lb.h / 2)
        for (const q of col) q.y += shift
      }
      const x = side === 'left' ? edge - w : edge
      for (const q of col) {
        const { lb } = q
        if (lb.box.style.width !== `${w}px`) lb.box.style.width = `${w}px`
        const y = q.y - lb.h / 2
        lb.box.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`
        const ex = side === 'left' ? edge + 14 : edge - 14
        lines[q.i].setAttribute('points', `${q.mx.toFixed(1)},${q.my.toFixed(1)} ${ex.toFixed(1)},${q.y.toFixed(1)} ${edge.toFixed(1)},${q.y.toFixed(1)}`)
      }
    }
  }

  function setFocus(i) {
    labels.forEach((lb, k) => {
      const on = k === i
      for (const el of [lb.box, lb.marker, lb.pin]) {
        el.classList.toggle('focus', on)
        el.classList.toggle('dim', i >= 0 && !on)
      }
      lines[k].classList.toggle('focus', on)
      lines[k].classList.toggle('dim', i >= 0 && !on)
    })
    dimmed = i >= 0
  }

  function pulse(i) {
    const lb = labels[i]
    if (lb === undefined) return
    for (const el of [lb.marker, lb.pin]) {
      el.classList.remove('pulse')
      void el.offsetWidth
      el.classList.add('pulse')
    }
  }

  function relabel() {
    labels.forEach((lb, i) => {
      lb.title.textContent = regionLabel(lb.id)
      chips[i].name.textContent = regionLabel(lb.id)
      lb.w = 0
    })
  }

  return {
    resize,
    update,
    setRegions,
    relabel,
    setLayout,
    setFocus,
    pulse,
    get narrow() { return narrow },
    get size() { return [width, height, dimmed] },
  }
}
