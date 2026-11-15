import { join } from 'node:path'
import type { AdapterContext } from '../../../src/adapters/registry'
import type { CanonicalBundle } from '../../../src/core/catalog'
import { defaultConfig, type BuracleConfig } from '../../../src/core/config'
import { loadCanonicalSync } from '../../../src/engine/canonical'
import * as paths from '../../../src/engine/paths'

export const REPO = join(import.meta.dir, '..', '..', '..')
export const canonical: CanonicalBundle = loadCanonicalSync(join(REPO, 'canonical'))

export function ctx(config: BuracleConfig = defaultConfig()): AdapterContext {
  return { repoRoot: REPO, config, canonical, paths, buracleBin: '/x/bin/buracle' }
}

export const SID = '8f1c1c3e-1111-4222-8333-444455556666'

/** A Qwen Code hook payload: the common fields every event carries, then the event's own. */
export function payload(event: string, extra: Record<string, unknown> = {}, cwd = '/work/app'): string {
  return JSON.stringify({ session_id: SID, transcript_path: '/t.jsonl', cwd, hook_event_name: event, permission_mode: 'default', ...extra })
}

export function json(stdout: string): Record<string, unknown> {
  return JSON.parse(stdout) as Record<string, unknown>
}
