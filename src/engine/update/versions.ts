export interface ParsedVersion { nums: number[]; pre?: string; post: number; raw: string }

const VERSION_RE = /^v?(\d+(?:\.\d+)*)(.*)$/i

export function parseVersionString(v: string): ParsedVersion | undefined {
  const m = VERSION_RE.exec(v.trim())
  if (!m || m[1] === undefined) return undefined
  const nums = m[1].split('.').map(n => Number(n))
  if (nums.some(n => !Number.isFinite(n))) return undefined
  let rest = (m[2] ?? '').replace(/\+.*$/, '')
  let post = 0
  const postM = /^[.-]?post(\d+)$/i.exec(rest)
  if (postM && postM[1] !== undefined) { post = Number(postM[1]); rest = '' }
  const pre = rest.replace(/^[-.]/, '')
  return pre === '' ? { nums, post, raw: v } : { nums, pre, post, raw: v }
}

function cmpIdent(a: string, b: string): number {
  const an = /^\d+$/.test(a)
  const bn = /^\d+$/.test(b)
  if (an && bn) return Math.sign(Number(a) - Number(b))
  if (an) return -1
  if (bn) return 1
  return a < b ? -1 : a > b ? 1 : 0
}

function cmpPre(a: string, b: string): number {
  const split = (s: string) => s.split(/[.-]/).flatMap(p => p.match(/\d+|[^\d]+/g) ?? [p])
  const as = split(a)
  const bs = split(b)
  for (let i = 0; i < Math.max(as.length, bs.length); i++) {
    const x = as[i]
    const y = bs[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const c = cmpIdent(x, y)
    if (c !== 0) return c
  }
  return 0
}

export function compareVersions(a: string, b: string): number {
  const pa = parseVersionString(a)
  const pb = parseVersionString(b)
  if (!pa || !pb) return pa ? 1 : pb ? -1 : a < b ? -1 : a > b ? 1 : 0
  const n = Math.max(pa.nums.length, pb.nums.length)
  for (let i = 0; i < n; i++) {
    const d = (pa.nums[i] ?? 0) - (pb.nums[i] ?? 0)
    if (d !== 0) return Math.sign(d)
  }
  if (pa.pre === undefined && pb.pre !== undefined) return 1
  if (pa.pre !== undefined && pb.pre === undefined) return -1
  if (pa.pre !== undefined && pb.pre !== undefined) {
    const c = cmpPre(pa.pre, pb.pre)
    if (c !== 0) return c
  }
  return Math.sign(pa.post - pb.post)
}

export function isStable(v: string): boolean {
  const p = parseVersionString(v)
  return p !== undefined && p.pre === undefined
}

export type Risk = 'low' | 'medium' | 'high'

export function bumpRisk(from: string | undefined, to: string): Risk {
  if (from === undefined) return 'medium'
  const a = parseVersionString(from)
  const b = parseVersionString(to)
  if (!a || !b) return 'medium'
  const [a0 = 0, a1 = 0] = a.nums
  const [b0 = 0, b1 = 0] = b.nums
  if (a0 !== b0) return 'high'
  if (a1 !== b1) return a0 === 0 ? 'high' : 'medium'
  return 'low'
}

export interface PublishedVersion { version: string; publishedAt?: string; deprecated?: boolean; yanked?: boolean }

export interface VersionPick {
  latest?: string
  candidate?: string
  candidatePublishedAt?: string
  held?: { version: string; publishedAt: string; ageDays: number }
}

const DAY_MS = 86_400_000

export function pickUpdate(current: string | undefined, versions: readonly PublishedVersion[], opts: { latestTag?: string, minAgeDays: number, nowMs: number }): VersionPick {
  const stable = versions.filter(v => isStable(v.version) && v.deprecated !== true && v.yanked !== true)
    .filter(v => opts.latestTag === undefined || compareVersions(v.version, opts.latestTag) <= 0)
    .sort((a, b) => compareVersions(a.version, b.version))
  const pick: VersionPick = {}
  const newest = stable[stable.length - 1]
  const latest = opts.latestTag ?? newest?.version
  if (latest !== undefined) pick.latest = latest
  const newer = stable.filter(v => current === undefined || compareVersions(v.version, current) > 0)
  const ageDays = (v: PublishedVersion): number | undefined => {
    if (v.publishedAt === undefined) return undefined
    const t = Date.parse(v.publishedAt)
    return Number.isNaN(t) ? undefined : (opts.nowMs - t) / DAY_MS
  }
  const ripe = newer.filter(v => { const a = ageDays(v); return a === undefined || a >= opts.minAgeDays })
  const candidate = ripe[ripe.length - 1]
  if (candidate) {
    pick.candidate = candidate.version
    if (candidate.publishedAt !== undefined) pick.candidatePublishedAt = candidate.publishedAt
  }
  const freshest = newer[newer.length - 1]
  if (freshest && freshest !== candidate && freshest.publishedAt !== undefined) {
    const a = ageDays(freshest)
    if (a !== undefined && a < opts.minAgeDays) pick.held = { version: freshest.version, publishedAt: freshest.publishedAt, ageDays: Math.max(0, Math.round(a * 10) / 10) }
  }
  return pick
}
