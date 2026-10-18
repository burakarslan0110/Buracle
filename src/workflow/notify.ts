import { appendFileSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { atomicWriteSync } from '../engine/fsx'
import { stateDir } from '../engine/paths'
import { run } from '../engine/proc'
import { log } from '../engine/log'
import type { ResolvedSession } from './session-store'
import type { NotifyType } from './memory-bridge'
import { newNotificationId, notificationsFile } from './notify-inbox'
import { fail, ok, type CmdResult, type WorkflowCtx } from './result'
import { docId, reviewPageUrl } from './review-notes'

export { notificationsFile } from './notify-inbox'

export const NOTIFY_TYPES: readonly NotifyType[] = ['info', 'plan_approval', 'prd_approval', 'attention_needed', 'verification_complete']


const SOUND: Partial<Record<NotifyType, string>> = { plan_approval: 'Glass', prd_approval: 'Glass', attention_needed: 'Sosumi', verification_complete: 'Hero' }

export const NOTIFICATIONS_MAX_BYTES = 1024 * 1024
export const NOTIFICATIONS_KEEP = 500

function trimNotifications(file: string): void {
  try {
    if (statSync(file).size <= NOTIFICATIONS_MAX_BYTES) return
    const lines = readFileSync(file, 'utf8').split('\n').filter(l => l.trim() !== '')
    atomicWriteSync(file, lines.slice(-NOTIFICATIONS_KEEP).join('\n') + '\n', { mode: 0o600 })
  } catch (e) {
    log('warn', 'could not trim notifications.jsonl', { error: e })
  }
}

const APPLESCRIPT = [
  'on run argv',
  '  set theTitle to item 1 of argv',
  '  set theSubtitle to item 2 of argv',
  '  set theMessage to item 3 of argv',
  '  if (count of argv) > 3 then',
  '    display notification theMessage with title theTitle subtitle theSubtitle sound name (item 4 of argv)',
  '  else',
  '    display notification theMessage with title theTitle subtitle theSubtitle',
  '  end if',
  'end run',
]

type Delivery = 'shown' | 'skipped' | 'unsupported' | 'error'

const POWERSHELL_BALLOON = [
  'Add-Type -AssemblyName System.Windows.Forms',
  '$n = New-Object System.Windows.Forms.NotifyIcon',
  '$n.Icon = [System.Drawing.SystemIcons]::Information',
  '$n.Visible = $true',
  '$n.ShowBalloonTip(6000, $env:BURACLE_NOTIFY_TITLE, $env:BURACLE_NOTIFY_MESSAGE, [System.Windows.Forms.ToolTipIcon]::Info)',
  'Start-Sleep -Seconds 7',
  '$n.Dispose()',
].join('; ')

export function desktopNotification(platform: string, type: NotifyType, title: string, message: string, have: (cmd: string) => boolean): { argv: string[], env?: Record<string, string>, detached?: boolean } | undefined {
  if (platform === 'darwin') {
    const argv = ['osascript', ...APPLESCRIPT.flatMap(l => ['-e', l]), 'Buracle', clip(title, 120), clip(message, 400)]
    const sound = SOUND[type]
    if (sound !== undefined) argv.push(sound)
    return { argv }
  }
  if (platform === 'win32') {
    return { argv: ['powershell.exe', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', POWERSHELL_BALLOON], env: { BURACLE_NOTIFY_TITLE: `Buracle: ${clip(title, 100)}`, BURACLE_NOTIFY_MESSAGE: clip(message, 240) }, detached: true }
  }
  if (have('notify-send')) return { argv: ['notify-send', '--app-name=Buracle', `Buracle: ${clip(title, 120)}`, clip(message, 400)] }
  return undefined
}

async function showDesktopNotification(type: NotifyType, title: string, message: string, env: Record<string, string | undefined>): Promise<{ status: Delivery, error?: string }> {
  if (env['BURACLE_NO_NOTIFY'] === '1') return { status: 'skipped' }
  const n = desktopNotification(process.platform, type, title, message, cmd => Bun.which(cmd) !== null)
  if (n === undefined) return { status: 'unsupported' }
  if (n.detached === true) {
    try {
      const child = Bun.spawn(n.argv, { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore', detached: true, env: { ...process.env, ...n.env } })
      child.unref()
      return { status: 'shown' }
    } catch (e) {
      return { status: 'error', error: e instanceof Error ? e.message : String(e) }
    }
  }
  const r = await run(n.argv, { timeoutMs: 5000, ...(n.env !== undefined ? { env: n.env } : {}) })
  if (r.code === 0) return { status: 'shown' }
  return { status: 'error', error: (r.stderr.trim().split('\n')[0] ?? '') || `${n.argv[0]} exited ${r.code}` }
}

function clip(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > n ? one.slice(0, n - 1) + '…' : one
}

export async function notify(typeArg: string | undefined, title: string | undefined, message: string | undefined, o: { plan?: string }, ctx: WorkflowCtx, s: ResolvedSession | undefined): Promise<CmdResult> {
  const type = typeArg as NotifyType
  if (typeArg === undefined || !NOTIFY_TYPES.includes(type)) {
    return fail('usage', `notify type must be one of ${NOTIFY_TYPES.join(', ')}${typeArg !== undefined ? ` (got '${typeArg}')` : ''}`)
  }
  if (title === undefined || title.trim() === '') return fail('usage', 'missing "<title>": buracle notify <type> "<title>" "<message>" [--plan <path>]')
  if (message === undefined) return fail('usage', 'missing "<message>": buracle notify <type> "<title>" "<message>" [--plan <path>]')
  const planPath = o.plan !== undefined ? resolve(ctx.cwd, o.plan) : undefined
  const warnings: string[] = []
  const page = type === 'plan_approval' || type === 'prd_approval' ? reviewPageUrl(planPath !== undefined ? { doc: docId(planPath) } : {}) : undefined

  const mac = await showDesktopNotification(type, title, message, ctx.env)
  if (mac.status === 'error') warnings.push(`desktop notification failed: ${mac.error}`)

  const id = newNotificationId(ctx.now)
  const record: Record<string, unknown> = {
    id, ts: new Date(ctx.now).toISOString(), type, title: title.trim(), message, cwd: ctx.cwd,
    ...(planPath !== undefined ? { plan: planPath } : {}),
    ...(page !== undefined ? { page } : {}),
    ...(s !== undefined ? { harness: s.harness, session: s.sessionId } : {}),
    delivery: { macos: mac.status },
  }
  const file = notificationsFile()
  let recorded = true
  try {
    mkdirSync(stateDir(), { recursive: true })
    appendFileSync(file, JSON.stringify(record) + '\n', { mode: 0o600 })
    trimNotifications(file)
  } catch (e) {
    recorded = false
    log('warn', 'could not append to notifications.jsonl', { error: e })
    warnings.push(`could not record the notification in ${file}: ${e instanceof Error ? e.message : String(e)}`)
  }
  if (!recorded && mac.status !== 'shown') {
    return fail('not_delivered', `the notification could not be delivered anywhere (${warnings.join('; ')})`)
  }
  const lines = [`Notified (${type}): ${title.trim()}${mac.status === 'shown' ? '' : ` [desktop: ${mac.status}]`}`]
  if (page !== undefined) lines.push(`Review page: ${page}`)
  return ok({ ok: true, id, type, title: title.trim(), message, plan: planPath ?? null, ...(type === 'plan_approval' || type === 'prd_approval' ? { page: page ?? null } : {}), recorded: recorded ? file : null, delivery: { macos: mac.status } }, lines, warnings)
}
