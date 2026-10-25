import { log } from '../engine/log'

export type NotifyType = 'info' | 'plan_approval' | 'prd_approval' | 'attention_needed' | 'verification_complete'

export interface ProjectInitInput {
  cwd: string
  root: string
  now: number
}

export type BridgeResult =
  | { status: 'ok', path?: string, detail?: string[], needsUser?: string[] }
  | { status: 'skipped', reason: string }
  | { status: 'error', error: string }

let cached: Record<string, unknown> | null | undefined

async function memoryModule(): Promise<Record<string, unknown> | undefined> {
  if (cached !== undefined) return cached ?? undefined
  const spec = '../memory/project-init'
  try {
    cached = (await import(spec)) as Record<string, unknown>
  } catch (e) {
    log('debug', 'memory module project-init not available', { error: e })
    cached = null
  }
  return cached ?? undefined
}

export function resetMemoryBridgeCache(): void {
  cached = undefined
}

interface ProjectInitResultLike { slug?: string, db?: string, claudeRedirect?: string, warnings?: unknown[] }

export async function projectInit(input: ProjectInitInput): Promise<BridgeResult> {
  if (process.env['BURACLE_NO_MEMORY'] === '1') return { status: 'skipped', reason: 'BURACLE_NO_MEMORY=1' }
  const mod = await memoryModule()
  const init = typeof mod?.['projectInit'] === 'function' ? mod['projectInit'] as (cwd: string) => Promise<ProjectInitResultLike> : undefined
  if (!init) return { status: 'skipped', reason: 'the memory module is not available' }
  try {
    const r = await init(input.root)
    const detail: string[] = []
    if (r.slug !== undefined) detail.push(`project ${r.slug}${r.db !== undefined ? ` (${r.db})` : ''}`)
    if (r.claudeRedirect === 'removed') detail.push('the old Claude Code memory redirect was taken back')
    for (const w of r.warnings ?? []) detail.push(String(w))
    return { status: 'ok', ...(r.db !== undefined ? { path: r.db } : {}), detail }
  } catch (e) {
    log('warn', 'memory project init failed', { error: e })
    return { status: 'error', error: e instanceof Error ? e.message : String(e) }
  }
}

export function describeBridge(what: string, r: BridgeResult): string {
  if (r.status === 'ok') return `${what}: ${r.detail !== undefined && r.detail.length > 0 ? r.detail.join('; ') : 'ok'}`
  if (r.status === 'skipped') return `${what}: skipped (${r.reason})`
  return `${what}: failed (${r.error})`
}
