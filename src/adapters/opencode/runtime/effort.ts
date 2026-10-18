import type { BuracleConfig } from '../../../core/config'
import { resolveEffort } from '../../../core/effort'
import type { ModelEditor, ServerContext } from './types'

export function effortLevel(cfg: Pick<BuracleConfig, 'effort'>): string | undefined {
  const value = cfg.effort?.opencode
  const r = resolveEffort('opencode', typeof value === 'string' ? value : 'auto')
  return 'level' in r ? r.level : undefined
}

export function applyEffort(editor: ModelEditor, level: string): string[] {
  const touched: string[] = []
  for (const m of editor.list()) {
    const v = (Array.isArray(m.variants) ? m.variants : []).find(x => x !== null && typeof x === 'object' && x.id === level)
    if (v === undefined) continue
    editor.update(m.providerID, m.id, model => {
      if (v.settings !== undefined) model.settings = { ...(model.settings ?? {}), ...v.settings }
      if (v.body !== undefined) model.body = { ...(model.body ?? {}), ...v.body }
      if (v.headers !== undefined) model.headers = { ...(model.headers ?? {}), ...v.headers }
    })
    touched.push(`${m.providerID}/${m.id}`)
  }
  return touched.sort()
}

export async function registerEffort(
  ctx: Pick<ServerContext, 'model'>,
  cfg: () => Pick<BuracleConfig, 'effort'>,
  report: (level: string | undefined, touched: string[]) => void,
  onError: (error: unknown) => void,
): Promise<boolean> {
  const model = ctx.model
  if (typeof model.transform !== 'function') return false
  await model.transform(editor => {
    try {
      const level = effortLevel(cfg())
      report(level, level !== undefined ? applyEffort(editor, level) : [])
    } catch (e) {
      onError(e)
    }
  })
  return true
}
