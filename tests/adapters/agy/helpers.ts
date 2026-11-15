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

/** An AGY hook payload: the camelCase fields every event carries, then the event's own. */
export function payload(event: string, extra: Record<string, unknown> = {}, cwd = '/work/app'): string {
  return JSON.stringify({ conversationId: SID, workspacePaths: [cwd], transcriptPath: '/t.jsonl', artifactDirectoryPath: '/a', modelName: 'auto', lastUserInput: '', hookEventName: event, cwd, ...extra })
}

/** The `toolCall` part of a PreToolUse or PostToolUse payload. */
export const call = (name: string, args: Record<string, unknown>): { toolCall: { id: string, name: string, args: Record<string, unknown> }, stepIdx: number } => ({ toolCall: { id: 'toolu_01', name, args }, stepIdx: 3 })

export function json(stdout: string): Record<string, unknown> {
  return JSON.parse(stdout) as Record<string, unknown>
}

/** The text of the system message steps an event injected. */
export function injected(stdout: string): string {
  const steps = (json(stdout)['injectSteps'] ?? []) as Array<{ systemMessage: { systemMessage: string } }>
  return steps.map(s => s.systemMessage.systemMessage).join('\n')
}
