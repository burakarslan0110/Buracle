// The example brain on the landing page: a brain seen from above, the project brain on the left and the person brain
// on the right. Folds for texture, neurons scattered inside each half, the example memories placed far apart and short
// links between neighbours, a few of them across the middle. Pure and seeded: the same memories draw the same brain on
// every build. home.js lights the memories one after another and shows the selected one in the card beside it.

import { escapeHtml } from './layout'
import type { BrainMemory } from './types'

export const BRAIN_W = 640
export const BRAIN_H = 520
const CX = BRAIN_W / 2
const CY = BRAIN_H / 2
/** Half the width of the gap between the halves, a half's width and half the brain's length. */
const GAP = 7
const HW = 236
const HH = 224

export type Side = 'project' | 'person'
export interface BrainNode { x: number, y: number, side: Side, mem?: string, delay: number }
export interface BrainModel { nodes: BrainNode[], links: Array<[number, number]>, shells: [string, string], folds: string[] }

type Pt = [number, number]

/** mulberry32: a small seeded generator, so the neurons sit in the same places on every build. */
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6D2B79F5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const r1 = (v: number): number => Math.round(v * 10) / 10
/** `dir` is -1 for the left half (the project brain) and 1 for the right half (the person brain). */
const dirOf = (side: Side): -1 | 1 => (side === 'project' ? -1 : 1)

/** A half's outline: front (top) to back along the outer side, wider toward the back, then up along the middle. */
function outline(dir: -1 | 1): Pt[] {
  const pts: Pt[] = []
  const n = 120
  for (let i = 0; i <= n; i++) {
    const t = -Math.PI / 2 + (Math.PI * i) / n
    const widen = 0.9 + 0.1 * Math.sin(t)
    const bump = 1 + 0.02 * Math.sin(11 * t + 0.6) + 0.01 * Math.sin(23 * t + 1.7)
    pts.push([CX + dir * (GAP + HW * Math.cos(t) * widen * bump), CY + HH * Math.sin(t)])
  }
  for (let i = 1; i < 20; i++) {
    const y = HH - (2 * HH * i) / 20
    pts.push([CX + dir * (GAP + 2.5 * Math.sin(i * 1.4)), CY + y])
  }
  return pts
}

/** A smooth path through the points (Catmull-Rom as cubic Béziers). */
function smooth(pts: Pt[], closed: boolean): string {
  const n = pts.length
  const at = (i: number): Pt => (closed ? pts[(i + n) % n] : pts[Math.max(0, Math.min(n - 1, i))]) as Pt
  let d = `M${r1(at(0)[0])} ${r1(at(0)[1])}`
  const last = closed ? n : n - 1
  for (let i = 0; i < last; i++) {
    const [p0, p1, p2, p3] = [at(i - 1), at(i), at(i + 1), at(i + 2)]
    const c1: Pt = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6]
    const c2: Pt = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6]
    d += `C${r1(c1[0])} ${r1(c1[1])} ${r1(c2[0])} ${r1(c2[1])} ${r1(p2[0])} ${r1(p2[1])}`
  }
  return closed ? `${d}Z` : d
}

/** The folds of one half: broken contour lines inside the outline and one deep fold across it. */
function folds(dir: -1 | 1): string[] {
  const out: string[] = []
  const contour = (scale: number, from: number, to: number, phase: number): void => {
    const pts: Pt[] = []
    for (let i = 0; i <= 28; i++) {
      const t = from + ((to - from) * i) / 28
      const widen = 0.9 + 0.1 * Math.sin(t)
      const wave = 1 + 0.07 * Math.sin(9 * t + phase)
      pts.push([CX + dir * (GAP + 16 + (HW - 16) * Math.cos(t) * widen * scale * wave), CY + HH * 0.97 * scale * Math.sin(t)])
    }
    out.push(smooth(pts, false))
  }
  const rad = Math.PI / 180
  contour(0.82, -78 * rad, -12 * rad, 0.3)
  contour(0.82, 4 * rad, 74 * rad, 1.9)
  contour(0.6, -70 * rad, -4 * rad, 2.6)
  contour(0.6, 14 * rad, 68 * rad, 0.8)
  contour(0.38, -60 * rad, 50 * rad, 1.2)
  // The deep fold across the half, a little in front of the middle.
  const across: Pt[] = []
  for (let i = 0; i <= 16; i++) {
    const k = i / 16
    across.push([CX + dir * (GAP + 22 + k * (HW * 0.7)), CY - 34 - 46 * k + 9 * Math.sin(k * 9)])
  }
  out.push(smooth(across, false))
  return out
}

function inside(p: Pt, poly: Pt[]): boolean {
  let hit = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i] as Pt
    const [xj, yj] = poly[j] as Pt
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) hit = !hit
  }
  return hit
}

function edgeDistance(p: Pt, poly: Pt[]): number {
  let best = Infinity
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [ax, ay] = poly[j] as Pt
    const [bx, by] = poly[i] as Pt
    const dx = bx - ax
    const dy = by - ay
    const k = Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / (dx * dx + dy * dy || 1)))
    best = Math.min(best, Math.hypot(p[0] - (ax + k * dx), p[1] - (ay + k * dy)))
  }
  return best
}

const dist = (a: { x: number, y: number }, b: { x: number, y: number }): number => Math.hypot(a.x - b.x, a.y - b.y)

/** Lays the brain out: about 30 neurons a half, the memories of each layer on the neurons farthest apart. */
export function layoutBrain(memories: readonly BrainMemory[]): BrainModel {
  const random = rng(0xB12A1)
  const nodes: BrainNode[] = []
  const shells: string[] = []
  for (const side of ['project', 'person'] as const) {
    const dir = dirOf(side)
    const poly = outline(dir)
    shells.push(smooth(poly, true))
    const mine: BrainNode[] = []
    for (let tries = 0; tries < 4000 && mine.length < 30; tries++) {
      const p: Pt = [CX + dir * (GAP + random() * HW), CY - HH + random() * 2 * HH]
      if (!inside(p, poly) || edgeDistance(p, poly) < 18) continue
      const node: BrainNode = { x: r1(p[0]), y: r1(p[1]), side, delay: r1(random() * 7) }
      if (mine.some(m => dist(m, node) < 34)) continue
      mine.push(node)
    }
    // The memories go on the neurons farthest apart, starting near the middle of the half.
    const mems = memories.filter(m => m.layer === side)
    const centre = { x: CX + dir * (GAP + HW * 0.46), y: CY }
    const chosen: BrainNode[] = []
    for (const m of mems) {
      const free = mine.filter(n => n.mem === undefined)
      const pick = chosen.length === 0
        ? free.reduce((a, b) => (dist(a, centre) <= dist(b, centre) ? a : b))
        : free.reduce((a, b) => (Math.min(...chosen.map(c => dist(a, c))) >= Math.min(...chosen.map(c => dist(b, c))) ? a : b))
      pick.mem = m.id
      chosen.push(pick)
    }
    nodes.push(...mine)
  }
  // Each neuron links to its two nearest neighbours in the same half, a memory to three.
  const seen = new Set<string>()
  const links: Array<[number, number]> = []
  const add = (a: number, b: number): void => {
    const key = a < b ? `${a}-${b}` : `${b}-${a}`
    if (a === b || seen.has(key)) return
    seen.add(key)
    links.push(a < b ? [a, b] : [b, a])
  }
  nodes.forEach((n, i) => {
    const near = nodes.map((m, j) => ({ j, d: m.side === n.side && j !== i ? dist(n, m) : Infinity })).sort((a, b) => a.d - b.d)
    for (const { j } of near.slice(0, n.mem !== undefined ? 3 : 2)) add(i, j)
  })
  // Three links across the middle: what the person brain holds reaches every project.
  for (const [top, bottom] of [[-150, -40], [-40, 70], [70, 180]] as const) {
    const band = (side: Side): number[] => nodes.map((n, i) => ({ n, i })).filter(({ n }) => n.side === side && n.y >= CY + top && n.y < CY + bottom).map(({ i }) => i)
    const left = band('project').sort((a, b) => (nodes[b] as BrainNode).x - (nodes[a] as BrainNode).x)[0]
    const right = band('person').sort((a, b) => (nodes[a] as BrainNode).x - (nodes[b] as BrainNode).x)[0]
    if (left !== undefined && right !== undefined) add(left, right)
  }
  return { nodes, links, shells: shells as [string, string], folds: [...folds(-1), ...folds(1)] }
}

/** The brain as inline SVG: the shells, the folds, the links, the neurons and one focusable button per memory. */
export function brainSvg(model: BrainModel, memories: readonly BrainMemory[], titleId: string): string {
  const byId = new Map(memories.map(m => [m.id, m]))
  const links = model.links.map(([a, b], k) => {
    const p = model.nodes[a] as BrainNode
    const q = model.nodes[b] as BrainNode
    const mems = [p.mem, q.mem].filter((x): x is string => x !== undefined)
    // One link in seven carries a slow signal, so the brain looks awake without the page asking for attention.
    const live = k % 7 === 3 ? ` class="bl bl-live" style="--d:${r1((k * 0.37) % 5)}s"` : ' class="bl"'
    return `<line${live} x1="${p.x}" y1="${p.y}" x2="${q.x}" y2="${q.y}"${mems.length > 0 ? ` data-mems="${mems.join(' ')}"` : ''}/>`
  }).join('')
  const neurons = model.nodes.filter(n => n.mem === undefined).map(n => `<circle class="bn" cx="${n.x}" cy="${n.y}" r="2.6" style="--d:${n.delay}s"/>`).join('')
  let first = true
  const mems = model.nodes.filter(n => n.mem !== undefined).map(n => {
    const m = byId.get(n.mem as string) as BrainMemory
    const tab = first ? '0' : '-1'
    first = false
    return `<g class="bm" data-mem="${escapeHtml(m.id)}" data-side="${n.side}" role="button" tabindex="${tab}" aria-label="${escapeHtml(`${m.kind}: ${m.title}`)}"><circle class="bm-ring" cx="${n.x}" cy="${n.y}" r="17"/><circle class="bm-dot" cx="${n.x}" cy="${n.y}" r="7"/></g>`
  }).join('')
  return `<svg class="brain-svg" viewBox="0 0 ${BRAIN_W} ${BRAIN_H}" role="group" aria-labelledby="${titleId}" focusable="false">
            <defs><radialGradient id="brain-glow" cx="50%" cy="50%" r="50%"><stop offset="0" class="bg-in"/><stop offset="1" class="bg-out"/></radialGradient><clipPath id="brain-clip"><path d="${model.shells[0]}"/><path d="${model.shells[1]}"/></clipPath></defs>
            <ellipse class="brain-halo" cx="${CX}" cy="${CY}" rx="${HW + 70}" ry="${HH + 40}" fill="url(#brain-glow)"/>
            <path class="brain-shell" data-side="project" d="${model.shells[0]}"/><path class="brain-shell" data-side="person" d="${model.shells[1]}"/>
            <g class="brain-folds" aria-hidden="true" clip-path="url(#brain-clip)">${model.folds.map(d => `<path d="${d}"/>`).join('')}</g>
            <g class="brain-links" aria-hidden="true">${links}</g>
            <g class="brain-neurons" aria-hidden="true">${neurons}</g>
            <g class="brain-mems">${mems}</g>
          </svg>`
}
