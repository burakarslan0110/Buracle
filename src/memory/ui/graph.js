import { hash32 } from './dom.js'

const TAU = Math.PI * 2
const MAX_SIGNALS = 48

function cssColor(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  const m = /^#([0-9a-f]{6})$/i.exec(v)
  const hex = m ? m[1] : fallback
  return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)]
}

const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a.toFixed(3)})`
const clamp = (x, a, b) => Math.max(a, Math.min(b, x))
const ease = (t) => 1 - (1 - t) ** 3

const THEMES = {
  dark: { ink: [231, 237, 245], pill: 'rgba(10,12,19,0.86)', pillLine: 'rgba(148,163,184,0.26)', text: 'rgba(231,237,245,1)', text2: 'rgba(200,210,224,0.92)' },
  light: { ink: [17, 24, 39], pill: 'rgba(255,255,255,0.92)', pillLine: 'rgba(71,85,105,0.3)', text: 'rgba(17,24,39,1)', text2: 'rgba(63,72,86,0.95)' },
}

export function createGraph(canvas, opts = {}) {
  const reduced = opts.reducedMotion === true
  const ctx = canvas.getContext('2d')
  let light = false
  let theme = THEMES.dark
  const palette = {
    region: {},
    tag: [0, 0, 0],
    file: [0, 0, 0],
    concept: [0, 0, 0],
    warn: [0, 0, 0],
    ink: theme.ink,
  }
  function readPalette() {
    palette.region = {}
    palette.tag = cssColor('--g-tag', light ? '7c3aed' : 'c4b5fd')
    palette.file = cssColor('--g-file', light ? '2563eb' : '93c5fd')
    palette.concept = cssColor('--g-concept', light ? '0f766e' : '5eead4')
    palette.warn = cssColor('--warn', light ? 'b45309' : 'fbbf24')
    palette.ink = theme.ink
  }
  readPalette()
  const sprites = new Map()
  let nodes = []
  let links = []
  let byId = new Map()
  let signals = []
  let alpha = 0
  let alphaTarget = 0
  const alphaDecay = 1 - Math.pow(0.001, 1 / 300)
  let width = 1
  let height = 1
  let dpr = 1
  let area = { left: 0, right: 1, top: 0, bottom: 1 }
  const cam = { x: 0, y: 0, k: 1 }
  const camTarget = { x: 0, y: 0, k: 1 }
  let autoFit = true
  let hover = null
  let marked = null
  let pinned = null
  let running = false
  let raf = 0
  let last = 0
  let time = 0
  let dirty = true
  let opened = 0
  let pointer = null
  let zoomTo = null

  function colorOf(n) {
    if (n.type === 'memory') return (palette.region[n.region] ??= cssColor(`--r-${n.region}`, 'e7edf5'))
    return palette[n.type] ?? palette.ink
  }

  function setData(data, keep = false) {
    const old = keep ? new Map(nodes.map((n) => [n.id, n])) : new Map()
    const now = performance.now()
    opened = keep ? opened : now
    const order = [...data.nodes].sort((a, b) => Number(b.type === 'memory' && b.focus) - Number(a.type === 'memory' && a.focus) || (b.degree ?? 0) - (a.degree ?? 0))
    const rank = new Map(order.map((n, i) => [n.id, i]))
    const stagger = reduced ? 0 : Math.min(1100, 26 * order.length) / Math.max(1, order.length)
    nodes = data.nodes.map((d) => {
      const prev = old.get(d.id)
      const hsh = hash32(d.id)
      const mem = d.type === 'memory'
      const r = mem ? 3.6 + 1.15 * clamp(d.importance ?? 3, 1, 5) + Math.min(3, Math.log1p(d.recallCount ?? 0)) : 3 + Math.min(9, 2.1 * Math.sqrt(d.weight ?? 1))
      const a = ((hsh % 3600) / 3600) * TAU
      const rr = 8 + ((hsh >>> 12) % 50)
      return {
        ...d,
        r: mem && d.focus === false ? r * 0.72 : r,
        rgb: null,
        x: prev ? prev.x : Math.cos(a) * rr,
        y: prev ? prev.y : Math.sin(a) * rr,
        vx: 0,
        vy: 0,
        fx: null,
        fy: null,
        born: prev ? prev.born : now + (rank.get(d.id) ?? 0) * stagger,
        phase: (hsh % 1000) / 1000,
        fire: 0,
        charge: mem ? -95 : -70 - Math.min(110, 12 * (d.weight ?? 1)),
      }
    })
    for (const n of nodes) n.rgb = colorOf(n)
    byId = new Map(nodes.map((n, i) => [n.id, i]))
    const deg = new Map()
    for (const e of data.edges) {
      deg.set(e.source, (deg.get(e.source) ?? 0) + 1)
      deg.set(e.target, (deg.get(e.target) ?? 0) + 1)
    }
    links = []
    for (const e of data.edges) {
      const s = byId.get(e.source)
      const tt = byId.get(e.target)
      if (s === undefined || tt === undefined || s === tt) continue
      const a = nodes[s]
      const b = nodes[tt]
      const memLink = a.type === 'memory' && b.type === 'memory'
      const da = deg.get(e.source) ?? 1
      const db = deg.get(e.target) ?? 1
      links.push({
        s, t: tt, kind: e.kind, weight: e.weight ?? 1,
        dist: memLink ? (e.kind === 'similar' ? 86 : 64) : 34 + a.r + b.r,
        strength: (memLink ? 0.7 : 0.9) / Math.min(da, db),
        bias: da / (da + db),
      })
    }
    if (keep) {
      for (const l of links) {
        const a = nodes[l.s]
        const b = nodes[l.t]
        if (!old.has(a.id) && old.has(b.id)) { a.x = b.x + 6; a.y = b.y + 6 }
        if (!old.has(b.id) && old.has(a.id)) { b.x = a.x + 6; b.y = a.y + 6 }
      }
    }
    signals = []
    hover = null
    pinned = null
    alpha = keep ? Math.max(alpha, 0.35) : 1
    if (!keep) autoFit = true
    if (reduced) {
      for (let i = 0; i < 320 && alpha > 0.002; i++) tick()
      fitNow()
    }
    wake()
  }

  function tick() {
    alpha += (alphaTarget - alpha) * alphaDecay
    const n = nodes.length
    for (const l of links) {
      const a = nodes[l.s]
      const b = nodes[l.t]
      let dx = b.x + b.vx - a.x - a.vx
      let dy = b.y + b.vy - a.y - a.vy
      const d = Math.hypot(dx, dy) || 1e-3
      const k = ((d - l.dist) / d) * alpha * l.strength
      dx *= k
      dy *= k
      b.vx -= dx * l.bias
      b.vy -= dy * l.bias
      a.vx += dx * (1 - l.bias)
      a.vy += dy * (1 - l.bias)
    }
    for (let i = 0; i < n; i++) {
      const a = nodes[i]
      for (let j = i + 1; j < n; j++) {
        const b = nodes[j]
        const dx = b.x - a.x
        const dy = b.y - a.y
        let d2 = dx * dx + dy * dy
        if (d2 > 160000) continue
        if (d2 < 1) d2 = 1
        a.vx += (dx * b.charge * alpha) / d2
        a.vy += (dy * b.charge * alpha) / d2
        b.vx -= (dx * a.charge * alpha) / d2
        b.vy -= (dy * a.charge * alpha) / d2
        const min = a.r + b.r + 3
        if (d2 < min * min) {
          const d = Math.sqrt(d2)
          const push = ((min - d) / d) * 0.35
          a.vx -= dx * push
          a.vy -= dy * push
          b.vx += dx * push
          b.vy += dy * push
        }
      }
    }
    for (const a of nodes) {
      a.vx += -a.x * 0.035 * alpha
      a.vy += -a.y * 0.035 * alpha
      if (a.fx !== null) {
        a.x = a.fx
        a.y = a.fy
        a.vx = 0
        a.vy = 0
        continue
      }
      a.vx *= 0.58
      a.vy *= 0.58
      a.x += a.vx
      a.y += a.vy
    }
  }

  function center() {
    return [(area.left + area.right) / 2, (area.top + area.bottom) / 2]
  }

  function bounds() {
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    for (const n of nodes) {
      x0 = Math.min(x0, n.x - n.r)
      y0 = Math.min(y0, n.y - n.r)
      x1 = Math.max(x1, n.x + n.r)
      y1 = Math.max(y1, n.y + n.r)
    }
    return nodes.length > 0 ? { x0, y0, x1, y1 } : { x0: -50, y0: -50, x1: 50, y1: 50 }
  }

  function fitTarget() {
    const b = bounds()
    const w = Math.max(80, area.right - area.left - 80)
    const hh = Math.max(80, area.bottom - area.top - 80)
    camTarget.k = clamp(Math.min(w / (b.x1 - b.x0 + 40), hh / (b.y1 - b.y0 + 60)), 0.3, 2.4)
    camTarget.x = (b.x0 + b.x1) / 2
    camTarget.y = (b.y0 + b.y1) / 2
  }

  function fitNow() {
    fitTarget()
    cam.x = camTarget.x
    cam.y = camTarget.y
    cam.k = camTarget.k
  }

  function toScreen(x, y) {
    const [cx, cy] = center()
    return [cx + (x - cam.x) * cam.k, cy + (y - cam.y) * cam.k]
  }

  function toWorld(sx, sy) {
    const [cx, cy] = center()
    return [cam.x + (sx - cx) / cam.k, cam.y + (sy - cy) / cam.k]
  }

  function sprite(c) {
    const key = c.join(',')
    let s = sprites.get(key)
    if (s === undefined) {
      s = document.createElement('canvas')
      s.width = 64
      s.height = 64
      const g = s.getContext('2d')
      const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32)
      grad.addColorStop(0, rgba(c, 0.95))
      grad.addColorStop(0.22, rgba(c, 0.42))
      grad.addColorStop(0.5, rgba(c, 0.1))
      grad.addColorStop(1, rgba(c, 0))
      g.fillStyle = grad
      g.fillRect(0, 0, 64, 64)
      sprites.set(key, s)
    }
    return s
  }

  function appear(n, now) {
    return reduced ? 1 : ease(clamp((now - n.born) / 520, 0, 1))
  }

  function neighbours(i) {
    const out = new Set([i])
    for (const l of links) {
      if (l.s === i) out.add(l.t)
      else if (l.t === i) out.add(l.s)
    }
    return out
  }

  function draw(now) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, width, height)
    if (nodes.length === 0) return
    const k = cam.k
    const focus = hover !== null ? neighbours(hover) : pinned !== null ? neighbours(pinned) : null
    const pos = nodes.map((n) => {
      const sway = reduced ? 0 : 1.4
      return toScreen(n.x + Math.sin(time * 0.6 + n.phase * TAU) * sway, n.y + Math.cos(time * 0.47 + n.phase * 9.1) * sway)
    })
    const shown = nodes.map((n) => appear(n, now))
    const dimOf = (i) => {
      if (focus !== null) return focus.has(i) ? 1 : 0.16
      if (marked !== null) return marked.has(nodes[i].id) ? 1 : 0.32
      return 1
    }

    ctx.lineCap = 'round'
    for (const l of links) {
      const g = Math.min(shown[l.s], shown[l.t])
      if (g <= 0) continue
      const [ax, ay] = pos[l.s]
      const [bx, by] = pos[l.t]
      const a = nodes[l.s]
      const b = nodes[l.t]
      const lit = focus !== null && focus.has(l.s) && focus.has(l.t) && (l.s === (hover ?? pinned) || l.t === (hover ?? pinned))
      const memLink = a.type === 'memory' && b.type === 'memory'
      const base = memLink ? (l.kind === 'similar' ? 0.22 : 0.34) : 0.18
      const al = lit ? 0.78 : base * Math.min(dimOf(l.s), dimOf(l.t))
      const c = memLink ? a.rgb : b.type === 'memory' ? a.rgb : b.rgb
      ctx.strokeStyle = rgba(c, al * g)
      ctx.lineWidth = lit ? 1.4 : memLink ? 1.1 : 0.8
      ctx.beginPath()
      ctx.moveTo(ax, ay)
      ctx.lineTo(ax + (bx - ax) * g, ay + (by - ay) * g)
      ctx.stroke()
    }

    ctx.globalCompositeOperation = light ? 'source-over' : 'lighter'
    const glowScale = light ? 0.55 : 1
    nodes.forEach((n, i) => {
      const s = shown[i]
      if (s <= 0) return
      const [x, y] = pos[i]
      const r = n.r * Math.max(0.6, Math.min(1.6, k)) * s
      const al = dimOf(i) * (n.type === 'memory' ? (n.focus === false ? 0.45 : 0.85) : 0.55) + n.fire * 0.8
      ctx.globalAlpha = clamp(al, 0, 1) * glowScale
      const size = r * (5.2 + n.fire * 4)
      ctx.drawImage(sprite(n.rgb), x - size / 2, y - size / 2, size, size)
    })
    for (const sg of signals) {
      const l = links[sg.l]
      if (l === undefined) continue
      const [ax, ay] = pos[sg.dir > 0 ? l.s : l.t]
      const [bx, by] = pos[sg.dir > 0 ? l.t : l.s]
      const p = ease(sg.p)
      const x = ax + (bx - ax) * p
      const y = ay + (by - ay) * p
      ctx.globalAlpha = Math.sin(Math.PI * sg.p) * 0.9 * glowScale
      const size = 9 + 5 * Math.min(1.5, k)
      ctx.drawImage(sprite(nodes[sg.dir > 0 ? l.s : l.t].rgb), x - size / 2, y - size / 2, size, size)
    }
    ctx.globalAlpha = 1
    ctx.globalCompositeOperation = 'source-over'

    nodes.forEach((n, i) => {
      const s = shown[i]
      if (s <= 0) return
      const [x, y] = pos[i]
      const r = n.r * Math.max(0.6, Math.min(1.6, k)) * s
      const d = dimOf(i)
      ctx.globalAlpha = d * (n.type === 'memory' && n.focus === false ? 0.6 : 1)
      ctx.fillStyle = rgba(n.rgb, 1)
      ctx.beginPath()
      ctx.arc(x, y, r * 0.62, 0, TAU)
      ctx.fill()
      if (n.type === 'memory' && n.unverified) {
        ctx.strokeStyle = rgba(palette.warn, 0.7)
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.arc(x, y, r * 0.62 + 3, 0, TAU)
        ctx.stroke()
      }
      if (n.type === 'memory' && n.pinned) {
        ctx.strokeStyle = rgba(palette.ink, 0.75)
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.arc(x, y, r * 0.62 + 5.5, 0, TAU)
        ctx.stroke()
      }
      if (n.fire > 0.02) {
        ctx.strokeStyle = rgba(n.rgb, n.fire)
        ctx.lineWidth = 1.5
        ctx.beginPath()
        ctx.arc(x, y, r + (1 - n.fire) * 26, 0, TAU)
        ctx.stroke()
      }
      if (marked !== null && marked.has(n.id)) {
        ctx.strokeStyle = rgba(palette.ink, 0.9)
        ctx.lineWidth = 1.5
        ctx.beginPath()
        ctx.arc(x, y, r * 0.62 + 4.5, 0, TAU)
        ctx.stroke()
      }
    })
    ctx.globalAlpha = 1
    drawLabels(pos, shown, focus)
  }

  function drawLabels(pos, shown, focus) {
    const want = []
    const hubs = nodes.map((_, i) => i).filter((i) => nodes[i].type !== 'memory').sort((a, b) => (nodes[b].degree ?? 0) - (nodes[a].degree ?? 0))
    const top = new Set(hubs.slice(0, Math.max(6, Math.min(16, Math.round(cam.k * 10)))).filter((i) => (nodes[i].degree ?? 0) >= 2))
    const at = hover ?? pinned
    nodes.forEach((n, i) => {
      if (shown[i] < 0.9) return
      let pri = -1
      if (i === at) pri = 3
      else if (focus !== null && focus.has(i)) pri = 2
      else if (focus === null && top.has(i)) pri = 1
      else if (focus === null && marked !== null && marked.has(n.id)) pri = 1.5
      if (pri >= 0) want.push({ i, pri })
    })
    want.sort((a, b) => b.pri - a.pri)
    ctx.font = '500 11.5px system-ui, -apple-system, "Segoe UI", sans-serif'
    ctx.textBaseline = 'middle'
    const placed = []
    for (const { i, pri } of want) {
      const n = nodes[i]
      let text = n.type === 'memory' ? n.title : n.label
      if (text.length > 42) text = `${text.slice(0, 40)}...`
      const w = ctx.measureText(text).width + 14
      const hh = 20
      const [x, y] = pos[i]
      const r = n.r * Math.max(0.6, Math.min(1.6, cam.k))
      const box = { x: x - w / 2, y: y - r - hh - 4, w, h: hh }
      if (box.y < area.top + 4) box.y = y + r + 4
      if (placed.some((p) => box.x < p.x + p.w + 4 && box.x + box.w + 4 > p.x && box.y < p.y + p.h + 2 && box.y + box.h + 2 > p.y)) continue
      placed.push(box)
      ctx.globalAlpha = pri >= 2 ? 1 : 0.88
      ctx.fillStyle = theme.pill
      ctx.strokeStyle = pri >= 3 ? rgba(n.rgb, 0.7) : theme.pillLine
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.roundRect(box.x, box.y, box.w, box.h, 6)
      ctx.fill()
      ctx.stroke()
      ctx.fillStyle = pri >= 2 ? theme.text : theme.text2
      ctx.fillText(text, box.x + 7, box.y + hh / 2 + 0.5)
    }
    ctx.globalAlpha = 1
  }

  function step(dt, now) {
    let changing = false
    if (alpha > 0.002 || alphaTarget > 0) {
      tick()
      if (alpha > 0.5 && !reduced) tick()
      changing = true
    }
    if (!reduced) {
      time += dt
      if (links.length > 0 && signals.length < MAX_SIGNALS && now - opened > 700 && Math.random() < Math.min(0.5, links.length / 90)) {
        signals.push({ l: Math.floor(Math.random() * links.length), p: 0, dir: Math.random() < 0.5 ? 1 : -1, speed: 0.4 + Math.random() * 0.5 })
      }
      for (const sg of signals) sg.p += dt * sg.speed
      signals = signals.filter((sg) => sg.p < 1)
      changing = true
    }
    for (const n of nodes) {
      if (n.fire > 0) { n.fire = Math.max(0, n.fire - dt * 0.7); changing = true }
    }
    if (autoFit) {
      fitTarget()
      const f = reduced ? 1 : 1 - Math.exp(-dt * 3)
      cam.x += (camTarget.x - cam.x) * f
      cam.y += (camTarget.y - cam.y) * f
      cam.k += (camTarget.k - cam.k) * f
      if (Math.abs(camTarget.k - cam.k) > 1e-3) changing = true
    } else if (zoomTo !== null) {
      const f = reduced ? 1 : 1 - Math.exp(-dt * 8)
      cam.k += (zoomTo - cam.k) * f
      if (Math.abs(zoomTo - cam.k) < 1e-3) zoomTo = null
      changing = true
    }
    return changing
  }

  function frame(now) {
    raf = 0
    if (!running) return
    const dt = last === 0 ? 0.016 : Math.min(0.1, (now - last) / 1000)
    last = now
    const changing = step(dt, now)
    if (changing || dirty || now - opened < 2000) {
      dirty = false
      draw(now)
    }
    if (!reduced || changing || now - opened < 2000) raf = requestAnimationFrame(frame)
  }

  function wake() {
    dirty = true
    if (running && raf === 0) {
      last = 0
      raf = requestAnimationFrame(frame)
    }
  }

  function pick(sx, sy) {
    let best = null
    let bestD = Infinity
    nodes.forEach((n, i) => {
      const [x, y] = toScreen(n.x, n.y)
      const r = n.r * Math.max(0.6, Math.min(1.6, cam.k)) * 0.62 + 7
      const d = (x - sx) ** 2 + (y - sy) ** 2
      if (d < r * r && d < bestD) { best = i; bestD = d }
    })
    return best
  }

  function local(e) {
    const b = canvas.getBoundingClientRect()
    return [e.clientX - b.left, e.clientY - b.top]
  }

  canvas.addEventListener('pointerdown', (e) => {
    const [sx, sy] = local(e)
    const i = pick(sx, sy)
    pointer = { id: e.pointerId, sx, sy, node: i, moved: false }
    canvas.setPointerCapture(e.pointerId)
    if (i !== null) {
      const n = nodes[i]
      n.fx = n.x
      n.fy = n.y
    }
  })

  canvas.addEventListener('pointermove', (e) => {
    const [sx, sy] = local(e)
    if (pointer !== null && pointer.id === e.pointerId) {
      const dx = sx - pointer.sx
      const dy = sy - pointer.sy
      if (!pointer.moved && Math.abs(dx) + Math.abs(dy) < 5) return
      pointer.moved = true
      if (pointer.node !== null) {
        const n = nodes[pointer.node]
        const [wx, wy] = toWorld(sx, sy)
        n.fx = wx
        n.fy = wy
        alphaTarget = 0.25
        if (alpha < 0.25) alpha = 0.25
      } else {
        autoFit = false
        cam.x -= dx / cam.k
        cam.y -= dy / cam.k
        pointer.sx = sx
        pointer.sy = sy
      }
      opts.onHover?.(null)
      wake()
      return
    }
    const i = pick(sx, sy)
    if (i !== hover) {
      hover = i
      wake()
    }
    canvas.style.cursor = i !== null ? 'pointer' : 'grab'
    opts.onHover?.(i !== null ? nodes[i] : null, e.clientX, e.clientY)
  })

  const release = (e, click) => {
    const p = pointer
    pointer = null
    if (p === null) return
    if (p.node !== null) {
      const n = nodes[p.node]
      n.fx = null
      n.fy = null
      alphaTarget = 0
    }
    if (click && !p.moved) {
      if (p.node === null) {
        pinned = null
      } else {
        const n = nodes[p.node]
        if (n.type === 'memory') opts.onOpen?.(n.id)
        else pinned = pinned === p.node ? null : p.node
      }
    }
    wake()
    if (e !== null && canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId)
  }
  canvas.addEventListener('pointerup', (e) => release(e, true))
  canvas.addEventListener('pointercancel', (e) => release(e, false))
  canvas.addEventListener('pointerleave', () => {
    if (pointer !== null) return
    if (hover !== null) { hover = null; wake() }
    opts.onHover?.(null)
  })
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault()
    const [sx, sy] = local(e)
    const [wx, wy] = toWorld(sx, sy)
    autoFit = false
    zoomTo = null
    cam.k = clamp(cam.k * Math.exp(-e.deltaY * 0.0016), 0.25, 4)
    const [nx, ny] = toWorld(sx, sy)
    cam.x += wx - nx
    cam.y += wy - ny
    wake()
  }, { passive: false })
  canvas.addEventListener('dblclick', () => fit())

  function fit() {
    autoFit = true
    zoomTo = null
    if (reduced) fitNow()
    wake()
  }

  return {
    setArea(a) {
      area = a
      wake()
    },
    resize() {
      dpr = Math.min(2, window.devicePixelRatio || 1)
      width = canvas.clientWidth
      height = canvas.clientHeight
      canvas.width = Math.max(1, Math.round(width * dpr))
      canvas.height = Math.max(1, Math.round(height * dpr))
      if (reduced && autoFit) fitNow()
      wake()
    },
    setData,
    clear() {
      nodes = []
      links = []
      byId = new Map()
      signals = []
      hover = null
      pinned = null
      marked = null
      wake()
    },
    setTheme(name) {
      light = name === 'light'
      theme = light ? THEMES.light : THEMES.dark
      readPalette()
      sprites.clear()
      for (const n of nodes) n.rgb = colorOf(n)
      wake()
    },
    mark(ids) {
      marked = ids !== null && ids.size > 0 ? ids : null
      wake()
    },
    fire(id) {
      const i = byId.get(id)
      if (i === undefined) return
      nodes[i].fire = 1
      if (!reduced) {
        links.forEach((l, li) => {
          if (l.s === i) signals.push({ l: li, p: 0, dir: 1, speed: 0.9 })
          else if (l.t === i) signals.push({ l: li, p: 0, dir: -1, speed: 0.9 })
        })
      }
      wake()
    },
    zoomBy(f) {
      autoFit = false
      zoomTo = clamp((zoomTo ?? cam.k) * f, 0.25, 4)
      if (reduced) { cam.k = zoomTo; zoomTo = null }
      wake()
    },
    fit,
    start() {
      if (running) return
      running = true
      wake()
    },
    stop() {
      running = false
      if (raf !== 0) cancelAnimationFrame(raf)
      raf = 0
    },
    get size() { return nodes.length },
  }
}
