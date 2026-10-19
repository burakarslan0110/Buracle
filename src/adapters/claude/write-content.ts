import type { WriteContent } from '../../core/policy/write-guard'
import { claudeChanges, CONFIG_PARSERS, guardedContents } from '../shared/write-content'

export { CONFIG_PARSERS }

export function writeContents(tool: string, input: Record<string, unknown>, paths: readonly string[], home: string, realpath?: (p: string) => string | undefined): Record<string, WriteContent> {
  return guardedContents(claudeChanges(tool, input, paths), paths, home, realpath !== undefined ? { realpath } : {})
}
