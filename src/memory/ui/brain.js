export const REGION_IDS = ['plans', 'knowledge', 'discoveries', 'self', 'skills', 'warnings', 'episodes']
export const BRAINSTEM = 7

export const REGION_RGB = [
  [0.64, 0.44, 1.0],
  [0.16, 0.86, 0.94],
  [0.32, 0.52, 1.0],
  [1.0, 0.56, 0.2],
  [0.58, 0.92, 0.32],
  [1.0, 0.3, 0.52],
  [1.0, 0.84, 0.3],
  [0.9, 0.68, 0.3],
]

export const ANCHORS = [
  [-0.56, 0.3, 0.42],
  [0.12, 0.5, 0.38],
  [0.76, 0.1, 0.26],
  [-0.1, -0.41, 0.24],
  [0.56, -0.49, 0.22],
  [-0.4, -0.3, 0.06],
  [0.06, -0.27, 0.06],
]

export const PLACE = [
  { side: 'left' },
  { side: 'right' },
  { side: 'right' },
  { side: 'left' },
  { side: 'right' },
  { side: 'left' },
  { side: 'right' },
]

export const BOUNDS = { minX: -0.98, maxX: 0.99, minY: -1.0, maxY: 0.74 }

export const STRIDE = 12

export function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const GX = [1, -1, 1, -1, 1.41, -1.41, 0, 0]
const GY = [1, 1, -1, -1, 0, 0, 1.41, -1.41]

export function perlin(rand) {
  const p = new Uint8Array(512)
  const base = Array.from({ length: 256 }, (_, i) => i)
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    const tmp = base[i]
    base[i] = base[j]
    base[j] = tmp
  }
  for (let i = 0; i < 512; i++) p[i] = base[i & 255]
  const fade = t => t * t * t * (t * (t * 6 - 15) + 10)
  const g = (hsh, x, y) => GX[hsh & 7] * x + GY[hsh & 7] * y
  return (x, y) => {
    const fx = Math.floor(x)
    const fy = Math.floor(y)
    const X = fx & 255
    const Y = fy & 255
    x -= fx
    y -= fy
    const u = fade(x)
    const v = fade(y)
    const aa = p[p[X] + Y]
    const ab = p[p[X] + Y + 1]
    const ba = p[p[X + 1] + Y]
    const bb = p[p[X + 1] + Y + 1]
    const x1 = g(aa, x, y) + u * (g(ba, x - 1, y) - g(aa, x, y))
    const x2 = g(ab, x, y - 1) + u * (g(bb, x - 1, y - 1) - g(ab, x, y - 1))
    return x1 + v * (x2 - x1)
  }
}

export function ell(x, y, cx, cy, rx, ry) {
  const dx = (x - cx) / rx
  const dy = (y - cy) / ry
  return (Math.sqrt(dx * dx + dy * dy) - 1) * Math.min(rx, ry)
}

export function smin(a, b, k) {
  const hh = Math.max(k - Math.abs(a - b), 0) / k
  return Math.min(a, b) - hh * hh * k * 0.25
}

export function smax(a, b, k) { return -smin(-a, -b, k) }

const CEREBELLUM = { cx: 0.54, cy: -0.47, rx: 0.3, ry: 0.19 }

function cerebellumSdf(x, y) { return ell(x, y, CEREBELLUM.cx, CEREBELLUM.cy, CEREBELLUM.rx, CEREBELLUM.ry) }

function cerebrumSdf(x, y) {
  let d = ell(x, y, 0.02, 0.12, 0.9, 0.6)
  d = smin(d, ell(x, y, -0.5, 0.06, 0.46, 0.46), 0.12)
  d = smin(d, ell(x, y, 0.62, 0.02, 0.36, 0.44), 0.12)
  d = smin(d, ell(x, y, -0.08, -0.3, 0.52, 0.23), 0.1)
  d = smax(d, -ell(x, y, -0.71, -0.38, 0.14, 0.065), 0.05)
  d = smax(d, -(cerebellumSdf(x, y) - 0.035), 0.04)
  return d
}

const STEM = [[0.12, -0.2], [0.17, -0.45], [0.2, -0.64], [0.235, -0.99]]

function stemRadius(t) {
  const pons = Math.exp(-(((t - 0.42) / 0.16) ** 2))
  return 0.064 + 0.036 * pons - 0.012 * t
}

export function nearest(line, x, y) {
  let best = { d: Infinity, t: 0, tx: 1, ty: 0 }
  let total = 0
  const lens = []
  for (let i = 0; i < line.length - 1; i++) {
    const l = Math.hypot(line[i + 1][0] - line[i][0], line[i + 1][1] - line[i][1])
    lens.push(l)
    total += l
  }
  let acc = 0
  for (let i = 0; i < line.length - 1; i++) {
    const [ax, ay] = line[i]
    const [bx, by] = line[i + 1]
    const vx = bx - ax
    const vy = by - ay
    const l2 = vx * vx + vy * vy
    const s = Math.max(0, Math.min(1, ((x - ax) * vx + (y - ay) * vy) / l2))
    const d = Math.hypot(x - (ax + s * vx), y - (ay + s * vy))
    if (d < best.d) {
      const l = Math.sqrt(l2)
      best = { d, t: (acc + s * lens[i]) / total, tx: vx / l, ty: vy / l }
    }
    acc += lens[i]
  }
  return best
}

function brainstemAt(x, y) {
  const n = nearest(STEM, x, y)
  return { d: n.d - stemRadius(n.t), t: n.t, o: n.d / stemRadius(n.t), tx: n.tx, ty: n.ty }
}

const SYLVIAN = [[-0.67, -0.31], [-0.42, -0.22], [-0.12, -0.15], [0.16, -0.08], [0.34, 0.04], [0.43, 0.15]]
const CENTRAL = [[0.07, 0.71], [0.02, 0.52], [-0.05, 0.36], [-0.07, 0.18], [-0.12, 0.02], [-0.14, -0.13]]
const PARIETO_OCCIPITAL = [[0.5, 0.56], [0.57, 0.42], [0.62, 0.3]]
const HIPPOCAMPUS = [[-0.31, -0.335], [-0.16, -0.335], [0.0, -0.3], [0.14, -0.24], [0.24, -0.14], [0.28, -0.03]]
const AMYGDALA = { cx: -0.4, cy: -0.3, rx: 0.078, ry: 0.056 }

export function interp(line, v, axis) {
  const o = 1 - axis
  if (v <= line[0][axis]) return line[0][o]
  for (let i = 0; i < line.length - 1; i++) {
    const a = line[i]
    const b = line[i + 1]
    if ((v - a[axis]) * (v - b[axis]) <= 0) {
      const s = (v - a[axis]) / (b[axis] - a[axis] || 1)
      return a[o] + s * (b[o] - a[o])
    }
  }
  return line[line.length - 1][o]
}

const centralX = y => (y < -0.13 ? -0.14 : interp([...CENTRAL].reverse(), y, 1))
const poX = y => (y > 0.3 ? interp([...PARIETO_OCCIPITAL].reverse(), y, 1) : 0.62 + (0.3 - y) * 0.16)

function hippocampusHalfWidth(t) { return 0.05 - 0.026 * t }

function lobeAt(x, y) {
  if (x < 0.43 && y < interp(SYLVIAN, x, 0)) return 3
  if (x >= 0.43 && x < 0.7 && y < 0.02 - (x - 0.43) * 1.1) return 3
  if (x < centralX(y)) return 0
  if (x > poX(y)) return 2
  return 1
}

function inAmygdala(x, y, grow = 1) {
  return ell(x, y, AMYGDALA.cx, AMYGDALA.cy, AMYGDALA.rx * grow, AMYGDALA.ry * grow) < 0
}

function nearHippocampus(x, y, grow = 1) {
  const n = nearest(HIPPOCAMPUS, x, y)
  return n.d < hippocampusHalfWidth(n.t) * grow
}

export function regionAt(x, y) {
  if (inAmygdala(x, y, 1.15)) return 5
  if (nearHippocampus(x, y, 1.2)) return 6
  if (cerebellumSdf(x, y) < 0.01) return 4
  if (cerebrumSdf(x, y) < 0.015) return lobeAt(x, y)
  return -1
}

const DRIFT = [
  [-0.55, 0.42, [0.6, 0.4, 1.0]],
  [-0.84, -0.06, [0.98, 0.34, 0.86]],
  [-0.45, -0.05, [0.82, 0.4, 0.98]],
  [0.02, 0.64, [0.24, 0.84, 0.98]],
  [0.38, 0.46, [0.16, 0.8, 0.76]],
  [0.82, 0.12, [0.3, 0.5, 1.0]],
  [0.74, -0.1, [0.42, 0.44, 1.0]],
  [0.46, -0.3, [1.0, 0.64, 0.24]],
  [-0.24, -0.42, [1.0, 0.52, 0.16]],
  [0.2, -0.3, [1.0, 0.74, 0.26]],
]

function driftColor(x, y) {
  let r = 0
  let g = 0
  let b = 0
  let w = 0
  for (const [ax, ay, c] of DRIFT) {
    const k = Math.exp(-((x - ax) ** 2 + (y - ay) ** 2) / 0.07)
    r += c[0] * k
    g += c[1] * k
    b += c[2] * k
    w += k
  }
  return w > 0 ? [r / w, g / w, b / w] : [0.6, 0.6, 0.9]
}

export function mix(a, b, s) { return [a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s, a[2] + (b[2] - a[2]) * s] }

export function buildBrain({ count = 40000, seed = 0xb7a1 } = {}) {
  const rand = mulberry32(seed)
  const noise = perlin(rand)
  const fbm = (x, y) => noise(x, y) + 0.5 * noise(x * 2.03, y * 2.03) + 0.25 * noise(x * 4.1, y * 4.1)
  const field = (x, y, temporal) => {
    const wx = fbm(x * 1.6 + 3.1, y * 1.6 - 1.7)
    const wy = fbm(x * 1.6 - 4.3, y * 1.6 + 2.9)
    return temporal ? fbm(x * 1.3 + wx * 0.5 + 7.7, y * 4.6 + wy * 0.6) : fbm(x * 2.5 + wx * 0.9, y * 2.7 + wy * 0.9)
  }
  const FOLDS = 2.4
  const data = new Float32Array(count * STRIDE)
  const byRegion = REGION_IDS.map(() => [])
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
    if (region < 7 && z > 0.06) byRegion[region].push(n)
    n++
    return true
  }

  const deepShare = 0.08
  const surfaceTarget = Math.floor(count * (1 - deepShare))
  const { minX, maxX, minY, maxY } = BOUNDS
  let guard = 0
  while (n < surfaceTarget && guard++ < count * 40) {
    const x = minX + rand() * (maxX - minX)
    const y = minY + rand() * (maxY - minY)
    const dc = cerebrumSdf(x, y)
    if (dc < 0) {
      const sylv = nearest(SYLVIAN, x, y).d
      const cent = nearest(CENTRAL, x, y).d
      const po = nearest(PARIETO_OCCIPITAL, x, y).d
      if (sylv < 0.017 || cent < 0.011 || po < 0.01) continue
      const lobe = lobeAt(x, y)
      const temporal = lobe === 3
      const f = field(x, y, temporal)
      const band = Math.abs(2 * ((((f * FOLDS) % 1) + 1) % 1) - 1)
      const rim = dc > -0.028
      const keep = rim ? 0.92 : 1 - 0.94 * smooth(0.74, 0.9, band)
      if (rand() > keep) continue
      const e = 0.002
      const gx = field(x + e, y, temporal) - field(x - e, y, temporal)
      const gy = field(x, y + e, temporal) - field(x, y - e, temporal)
      let angle = Math.atan2(gx, -gy) + (rand() - 0.5) * 0.5
      if (rim) {
        const ox = cerebrumSdf(x + e, y) - cerebrumSdf(x - e, y)
        const oy = cerebrumSdf(x, y + e) - cerebrumSdf(x, y - e)
        angle = Math.atan2(ox, -oy) + (rand() - 0.5) * 0.3
      }
      let bright = 0.5 + 0.5 * (1 - band) + (rim ? 0.35 : 0)
      if (Math.min(sylv, cent, po) < 0.034) bright += 0.22
      if (inAmygdala(x, y, 1.35) || nearHippocampus(x, y, 1.35)) bright *= 0.38
      const dome = Math.sqrt(Math.min(1, -dc / 0.3))
      let z = 0.5 * dome + 0.02 * (1 - band)
      if (rand() < 0.12) { z *= 0.2 + rand() * 0.7; bright *= 0.45 }
      const color = mix(driftColor(x, y), REGION_RGB[lobe], 0.45)
      push(x, y, z, color, angle, lobe, bright, 3.3 + rand() * 1.0)
      continue
    }
    const db = cerebellumSdf(x, y)
    if (db < 0 && dc > 0.012) {
      const u = (x - CEREBELLUM.cx) / CEREBELLUM.rx
      const v = (y - CEREBELLUM.cy) / CEREBELLUM.ry
      const r = Math.sqrt(u * u + v * v)
      const phi = Math.atan2(v, u)
      const s = Math.sin(r * 36 + fbm(x * 7, y * 7) * 2.4)
      const rim = db > -0.02
      if (!rim && rand() > 0.12 + 0.88 * smooth(-0.35, 0.4, s)) continue
      const angle = Math.atan2(Math.cos(phi) * CEREBELLUM.ry, -Math.sin(phi) * CEREBELLUM.rx) + (rand() - 0.5) * 0.35
      const z = 0.3 * Math.sqrt(Math.max(0, 1 - r * r))
      const color = mix(REGION_RGB[4], [0.3, 0.86, 0.62], 0.35 * (1 - r))
      push(x, y, z, color, angle, 4, 0.6 + 0.35 * Math.max(0, s) + (rim ? 0.3 : 0), 3.0 + rand() * 0.8)
      continue
    }
    const st = brainstemAt(x, y)
    if (st.d < 0 && dc > 0.016 && db > 0.02) {
      const lane = 0.5 + 0.5 * Math.cos(st.o * Math.PI * 5)
      if (rand() > 0.3 + 0.7 * lane) continue
      const pons = st.t > 0.3 && st.t < 0.56 && rand() < 0.55
      const angle = pons ? Math.atan2(-st.tx, st.ty) + (rand() - 0.5) * 0.3 : Math.atan2(st.ty, st.tx) + (rand() - 0.5) * 0.25
      const color = mix(REGION_RGB[7], [1.0, 0.82, 0.45], rand() * 0.5)
      push(x, y, 0.08 * Math.sqrt(Math.max(0, 1 - st.o * st.o)), color, angle, BRAINSTEM, 0.7 + 0.35 * lane, 3.2 + rand() * 0.6)
    }
  }

  const hippocampusEnd = n + Math.floor((count - n) * 0.7)
  guard = 0
  while (n < hippocampusEnd && guard++ < count * 10) {
    const t = rand()
    const pt = along(HIPPOCAMPUS, t)
    const w = hippocampusHalfWidth(t)
    const off = Math.max(-1, Math.min(1, gauss() * 0.45)) * w
    if (rand() > 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(t * 44))) continue
    const x = pt.x - pt.ty * off
    const y = pt.y + pt.tx * off
    const angle = Math.atan2(pt.tx, -pt.ty) + (rand() - 0.5) * 0.4
    const color = mix(REGION_RGB[6], [1.0, 0.95, 0.65], 0.4 * (1 - Math.abs(off) / w))
    push(x, y, (rand() - 0.5) * 0.16, color, angle, 6, 0.42 + 0.3 * (1 - Math.abs(off) / w), 2.8 + rand() * 0.7)
  }
  while (n < count) {
    const a = rand() * Math.PI * 2
    const r = Math.sqrt(rand()) * 0.95
    const x = AMYGDALA.cx + Math.cos(a) * r * AMYGDALA.rx
    const y = AMYGDALA.cy + Math.sin(a) * r * AMYGDALA.ry
    const color = mix(REGION_RGB[5], [1.0, 0.62, 0.78], 0.5 * (1 - r))
    if (!push(x, y, (rand() - 0.5) * 0.14, color, 0, 5, 0.4 + 0.35 * (1 - r), -(2.0 + rand() * 0.8))) break
  }
  for (let i = 0; i < n; i++) {
    const reg = data[i * STRIDE + 7]
    if (reg === 5 || reg === 6) byRegion[reg].push(i)
  }
  return { data, count: n, byRegion, design: 'project', ids: REGION_IDS, anchors: ANCHORS, rgb: REGION_RGB, place: PLACE, bounds: BOUNDS, regionAt }
}

export function smooth(a, b, x) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

export function along(line, t) {
  const lens = []
  let total = 0
  for (let i = 0; i < line.length - 1; i++) {
    const l = Math.hypot(line[i + 1][0] - line[i][0], line[i + 1][1] - line[i][1])
    lens.push(l)
    total += l
  }
  let at = t * total
  for (let i = 0; i < lens.length; i++) {
    if (at <= lens[i] || i === lens.length - 1) {
      const s = Math.min(1, at / lens[i])
      const [ax, ay] = line[i]
      const [bx, by] = line[i + 1]
      return { x: ax + (bx - ax) * s, y: ay + (by - ay) * s, tx: (bx - ax) / lens[i], ty: (by - ay) / lens[i] }
    }
    at -= lens[i]
  }
  return { x: line[0][0], y: line[0][1], tx: 1, ty: 0 }
}
