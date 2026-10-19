import { STRIDE, along, ell, interp, mix, mulberry32, nearest, perlin, smax, smin, smooth } from './brain.js'

export const PERSON_REGION_IDS = ['communication', 'collaboration', 'workflow', 'engineering', 'avoid', 'lessons', 'inbox']

export const PERSON_RGB = [
  [1.0, 0.45, 0.72],
  [0.75, 0.52, 0.99],
  [0.22, 0.74, 0.97],
  [0.2, 0.83, 0.6],
  [0.97, 0.44, 0.44],
  [0.98, 0.75, 0.14],
  [0.92, 0.9, 0.98],
  [0.9, 0.8, 0.7],
]

export const PERSON_ANCHORS = [
  [-0.46, 0.5, 0.42],
  [-0.52, -0.18, 0.46],
  [-0.42, -0.62, 0.34],
  [0.46, 0.5, 0.42],
  [0.52, -0.18, 0.46],
  [0.42, -0.62, 0.34],
  [0.0, -0.04, 0.16],
]

export const PERSON_PLACE = [
  { side: 'left' },
  { side: 'left' },
  { side: 'left' },
  { side: 'right' },
  { side: 'right' },
  { side: 'right' },
  { side: 'right' },
]

export const PERSON_BOUNDS = { minX: -0.94, maxX: 0.94, minY: -0.88, maxY: 0.86 }

function hemiSdf(x, y) {
  const taper = 1 - 0.16 * Math.max(0, y)
  let d = ell(x / taper, y, 0, -0.03, 0.86, 0.85) * taper
  d = smin(d, ell(x, y, 0.5, -0.2, 0.38, 0.5), 0.14)
  d = smin(d, ell(x, y, 0.3, -0.5, 0.36, 0.36), 0.14)
  const gap = 0.03 + 0.07 * smooth(0.55, 0.92, Math.abs(y + 0.03))
  return smax(d, gap - x, 0.035)
}

const sdf = (x, y) => hemiSdf(Math.abs(x), y)

const CENTRAL = [[0.05, -0.03], [0.3, 0.03], [0.58, 0.11], [0.88, 0.2]]
const PARIETO_OCCIPITAL = [[0.05, -0.47], [0.2, -0.45], [0.36, -0.49]]

const centralY = (x) => interp(CENTRAL, x, 0)
const poY = (x) => -0.47 - 0.05 * x

const CALLOSUM = [[0, 0.3], [0, -0.36]]

function lobeAt(x, y) {
  const ax = Math.abs(x)
  const k = y > centralY(ax) ? 0 : y < poY(ax) ? 2 : 1
  return x < 0 ? k : 3 + k
}

export function personRegionAt(x, y) {
  if (Math.abs(x) < 0.045 && y < 0.32 && y > -0.38) return 6
  if (sdf(x, y) < 0.015) return lobeAt(x, y)
  return -1
}

const DRIFT = [
  [-0.5, 0.55, [1.0, 0.56, 0.7]],
  [0.5, 0.55, [1.0, 0.62, 0.5]],
  [-0.6, -0.1, [0.86, 0.58, 1.0]],
  [0.6, -0.1, [1.0, 0.52, 0.62]],
  [-0.4, -0.65, [0.7, 0.66, 1.0]],
  [0.4, -0.65, [1.0, 0.76, 0.42]],
  [0.0, 0.0, [1.0, 0.86, 0.8]],
]

function driftColor(x, y) {
  let r = 0
  let g = 0
  let b = 0
  let w = 0
  for (const [ax, ay, c] of DRIFT) {
    const k = Math.exp(-((x - ax) ** 2 + (y - ay) ** 2) / 0.09)
    r += c[0] * k
    g += c[1] * k
    b += c[2] * k
    w += k
  }
  return w > 0 ? [r / w, g / w, b / w] : [0.9, 0.7, 0.8]
}

export function buildPersonBrain({ count = 40000, seed = 0x51f3 } = {}) {
  const rand = mulberry32(seed)
  const noise = perlin(rand)
  const fbm = (x, y) => noise(x, y) + 0.5 * noise(x * 2.03, y * 2.03) + 0.25 * noise(x * 4.1, y * 4.1)
  const field = (x, y) => {
    const mx = Math.abs(x) + (x < 0 ? 5.3 : 0)
    const wx = fbm(mx * 1.6 + 3.1, y * 1.6 - 1.7)
    const wy = fbm(mx * 1.6 - 4.3, y * 1.6 + 2.9)
    return fbm(mx * 3.1 + wx * 0.9, y * 2.2 + wy * 0.9)
  }
  const FOLDS = 2.4
  const data = new Float32Array(count * STRIDE)
  const byRegion = PERSON_REGION_IDS.map(() => [])
  let n = 0
  const gauss = () => {
    let u = 0
    while (u === 0) u = rand()
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand())
  }
  const push = (x, y, z, color, angle, region, bright, size) => {
    if (n >= count) return false
    const o = n * STRIDE
    const j = () => (rand() - 0.5) * 0.08
    data[o] = x
    data[o + 1] = y
    data[o + 2] = z
    data[o + 3] = Math.min(1, Math.max(0, color[0] + j()))
    data[o + 4] = Math.min(1, Math.max(0, color[1] + j()))
    data[o + 5] = Math.min(1, Math.max(0, color[2] + j()))
    data[o + 6] = -angle
    data[o + 7] = region
    data[o + 8] = rand()
    data[o + 9] = bright
    data[o + 10] = size
    data[o + 11] = rand()
    if (region < 6 && z > 0.06) byRegion[region].push(n)
    n++
    return true
  }

  const surfaceTarget = Math.floor(count * 0.94)
  const { minX, maxX, minY, maxY } = PERSON_BOUNDS
  let guard = 0
  while (n < surfaceTarget && guard++ < count * 40) {
    const x = minX + rand() * (maxX - minX)
    const y = minY + rand() * (maxY - minY)
    const d = sdf(x, y)
    if (d >= 0) continue
    const ax = Math.abs(x)
    const cent = nearest(CENTRAL, ax, y).d
    const po = nearest(PARIETO_OCCIPITAL, ax, y).d
    if (cent < 0.012 || po < 0.01) continue
    const f = field(x, y)
    const band = Math.abs(2 * ((((f * FOLDS) % 1) + 1) % 1) - 1)
    const rim = d > -0.026
    const keep = rim ? 0.92 : 1 - 0.94 * smooth(0.74, 0.9, band)
    if (rand() > keep) continue
    const e = 0.002
    let angle = Math.atan2(field(x + e, y) - field(x - e, y), -(field(x, y + e) - field(x, y - e))) + (rand() - 0.5) * 0.5
    if (rim) angle = Math.atan2(sdf(x + e, y) - sdf(x - e, y), -(sdf(x, y + e) - sdf(x, y - e))) + (rand() - 0.5) * 0.3
    let bright = 0.5 + 0.5 * (1 - band) + (rim ? 0.35 : 0)
    if (Math.min(cent, po) < 0.03) bright += 0.2
    const dome = Math.sqrt(Math.min(1, -d / 0.32))
    let z = 0.48 * dome + 0.02 * (1 - band)
    if (rand() < 0.12) { z *= 0.2 + rand() * 0.7; bright *= 0.45 }
    const lobe = lobeAt(x, y)
    push(x, y, z, mix(driftColor(x, y), PERSON_RGB[lobe], 0.5), angle, lobe, bright, 3.2 + rand() * 1.0)
  }

  while (n < count) {
    const t = rand()
    const pt = along(CALLOSUM, t)
    const x = gauss() * 0.012
    const y = pt.y + (rand() - 0.5) * 0.02
    const edge = Math.min(t, 1 - t)
    const color = mix(PERSON_RGB[6], [1.0, 0.78, 0.7], rand() * 0.4)
    if (!push(x, y, 0.1 + rand() * 0.05, color, Math.PI / 2 + (rand() - 0.5) * 0.25, 6, 0.55 + 0.6 * smooth(0, 0.15, edge), 3.0 + rand() * 0.6)) break
  }
  for (let i = 0; i < n; i++) if (data[i * STRIDE + 7] === 6) byRegion[6].push(i)
  return { data, count: n, byRegion, design: 'person', ids: PERSON_REGION_IDS, anchors: PERSON_ANCHORS, rgb: PERSON_RGB, place: PERSON_PLACE, bounds: PERSON_BOUNDS, regionAt: personRegionAt }
}
