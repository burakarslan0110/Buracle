import { configSchemaLeaves, type ConfigLeaf } from '../../core/config'
import { loadConfigSync } from '../../engine/config'
import { canonicalBase, setConfigValue } from '../../engine/config-edit'
import * as paths from '../../engine/paths'
import { opsDeps } from '../../engine/update/deps'
import { tilde } from '../../engine/update/output'
import { configDescription } from '../../engine/update/reference'
import { UiApiError } from './api'

export const SWITCH_PREFIX = 'plan'
const NOT_FROM_THE_PAGE: ReadonlySet<string> = new Set(['plan.stopGuard'])

type SwitchLeaf = Extract<ConfigLeaf, { t: 'bool' } | { t: 'enum' }>

export function workflowSwitchLeaves(): SwitchLeaf[] {
  return configSchemaLeaves(SWITCH_PREFIX).filter((l): l is SwitchLeaf => (l.t === 'bool' || l.t === 'enum') && !NOT_FROM_THE_PAGE.has(l.key))
}

function valueAt(root: unknown, key: string): unknown {
  let cur: unknown = root
  for (const seg of key.split('.')) {
    if (cur === null || typeof cur !== 'object' || !Object.prototype.hasOwnProperty.call(cur, seg)) return undefined
    cur = (cur as Record<string, unknown>)[seg]
  }
  return cur
}

export function workflowPayload(): Record<string, unknown> {
  let config: unknown
  let errors: string[] = []
  try {
    const loaded = loadConfigSync()
    config = loaded.config
    errors = loaded.errors
  } catch (e) {
    return { file: tilde(paths.userConfigFile()), switches: [], error: e instanceof Error ? e.message : String(e) }
  }
  const base = canonicalBase(opsDeps.repoRoot())
  return {
    file: tilde(paths.userConfigFile()),
    switches: workflowSwitchLeaves().map(l => {
      const description = configDescription(l.key)
      return {
        key: l.key, type: l.t, ...(l.t === 'enum' ? { values: l.values } : {}),
        value: valueAt(config, l.key), default: valueAt(base, l.key),
        ...(description !== undefined ? { description } : {}),
      }
    }),
    ...(errors.length > 0 ? { problems: errors } : {}),
  }
}

export async function saveSetting(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const key = body['key']
  const value = body['value']
  const leaf = typeof key === 'string' ? workflowSwitchLeaves().find(l => l.key === key) : undefined
  if (leaf === undefined) throw new UiApiError(400, 'not_editable', `the page changes only the workflow switches (${workflowSwitchLeaves().map(l => l.key).join(', ')}); use \`buracle config set\` for ${typeof key === 'string' ? key : 'other keys'}`)
  if (leaf.t === 'bool' && typeof value !== 'boolean') throw new UiApiError(400, 'bad_value', `${leaf.key} is true or false`)
  if (leaf.t === 'enum' && (typeof value !== 'string' || !leaf.values.includes(value))) throw new UiApiError(400, 'bad_value', `${leaf.key} is one of ${leaf.values.join(', ')}`)
  const r = await setConfigValue(leaf.key, value)
  if (!r.ok) throw new UiApiError(409, 'not_saved', r.error)
  return { ok: true, key: leaf.key, value, changed: r.changed }
}
