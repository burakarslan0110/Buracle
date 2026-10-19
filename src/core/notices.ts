export interface Notice {
  id: string
  since: string
  until?: string
  message: string
}

export interface NoticeCatalog { notices: Notice[] }

export const NOTICE_ID = /^[a-z0-9][a-z0-9.-]{0,63}$/
export const NOTICE_MESSAGE_MAX = 400
export const NOTICES_PER_SESSION = 3

const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const DATE = /^\d{4}-\d{2}-\d{2}$/

function isObj(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === 'object' && !Array.isArray(x)
}

function versionOrder(a: string, b: string): number {
  const split = (v: string): { nums: number[], pre: string } => {
    const t = v.trim().replace(/^v/, '')
    const dash = t.indexOf('-')
    const core = dash < 0 ? t : t.slice(0, dash)
    return { nums: core.split('.').map(n => Number.parseInt(n, 10) || 0), pre: dash < 0 ? '' : t.slice(dash + 1) }
  }
  const x = split(a)
  const y = split(b)
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length, 3); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0)
    if (d !== 0) return d < 0 ? -1 : 1
  }
  if (x.pre === y.pre) return 0
  if (x.pre === '') return 1
  if (y.pre === '') return -1
  return x.pre < y.pre ? -1 : 1
}

export function validateNotices(x: unknown): string[] {
  if (!isObj(x) || !Array.isArray(x['notices'])) return ['(root): expected { notices: [...] }']
  const errors: string[] = []
  for (const k of Object.keys(x)) if (k !== 'notices') errors.push(`(root).${k}: unknown key`)
  const seen = new Set<string>()
  ;(x['notices'] as unknown[]).forEach((n, i) => {
    const at = `notices[${i}]`
    if (!isObj(n)) { errors.push(`${at}: expected a mapping`); return }
    for (const k of Object.keys(n)) if (!['id', 'since', 'until', 'message'].includes(k)) errors.push(`${at}.${k}: unknown key`)
    const id = n['id']
    if (typeof id !== 'string' || !NOTICE_ID.test(id)) errors.push(`${at}.id: expected lower-case letters, digits, dots and hyphens`)
    else if (seen.has(id)) errors.push(`${at}.id: duplicate ${id}`)
    else seen.add(id)
    if (typeof n['since'] !== 'string' || !VERSION.test(n['since'])) errors.push(`${at}.since: expected a version such as 0.5.0`)
    const until = n['until']
    if (until !== undefined && (typeof until !== 'string' || !(VERSION.test(until) || (DATE.test(until) && !Number.isNaN(Date.parse(`${until}T00:00:00Z`)))))) {
      errors.push(`${at}.until: expected a version such as 0.6.0 or a date such as 2026-12-31`)
    }
    const message = n['message']
    if (typeof message !== 'string' || message.trim() === '') errors.push(`${at}.message: expected the text to show`)
    else if (message.length > NOTICE_MESSAGE_MAX) errors.push(`${at}.message: at most ${NOTICE_MESSAGE_MAX} characters`)
  })
  return errors
}

function current(n: Notice, version: string, nowMs: number): boolean {
  if (versionOrder(version, n.since) < 0) return false
  if (n.until === undefined) return true
  if (DATE.test(n.until)) return nowMs < Date.parse(`${n.until}T00:00:00Z`)
  return versionOrder(version, n.until) < 0
}

export function pendingNotices(notices: readonly Notice[], o: { version: string, nowMs: number, acked: ReadonlySet<string> }): Notice[] {
  return (Array.isArray(notices) ? notices : [])
    .filter(n => isObj(n) && typeof n.id === 'string' && NOTICE_ID.test(n.id) && typeof n.since === 'string' && (n.until === undefined || typeof n.until === 'string') && typeof n.message === 'string' && n.message.trim() !== '')
    .filter(n => !o.acked.has(n.id) && current(n, o.version, o.nowMs))
    .slice(0, NOTICES_PER_SESSION)
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

export interface NoticeTexts { user: string, model: string }

export function noticeTexts(shown: readonly Notice[]): NoticeTexts | undefined {
  const list = shown.filter(n => typeof n.message === 'string' && n.message.trim() !== '')
  if (list.length === 0) return undefined
  const user = list.map(n => `Buracle ${n.since}: ${oneLine(n.message)}`).join('\n')
  const model = [
    `Buracle notice, shown once on this machine. Tell the user in one short line at the start of your next reply, do not ask anything about it, and carry on with their request:`,
    ...list.map(n => `- ${oneLine(n.message)}`),
  ].join('\n')
  return { user, model }
}
