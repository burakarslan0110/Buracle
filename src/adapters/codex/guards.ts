import type { ToolCall } from '../../core/events'
import { isAbsPath, normalizePath } from '../../core/events'
import type * as core from '../../core/index'
import type { WriteTargets } from '../shared/pipeline/index'
import { codexPatchChanges, guardedContents, patchChanges, type FileChange } from '../shared/write-content'
import { rec, str, type Payload } from './hook-io'
import { shellApplyPatch, shellPatchTargets, type ShellPatch } from './shell-patch'

type CoreFns = typeof core

export { bashOptions } from '../shared/pipeline/index'

export const SHELL_TOOL = 'Bash'

export const GUARDED_TOOLS: ReadonlySet<string> = new Set([SHELL_TOOL, 'apply_patch'])

export function shellPatchOf(p: Payload): ShellPatch {
  if (str(p['tool_name']) !== SHELL_TOOL) return { kind: 'none' }
  return shellApplyPatch(rec(p['tool_input'])['command'])
}

function shellPatchDeny(sp: ShellPatch, undetermined?: string): string {
  const instead = 'Use the apply_patch tool instead (its paths resolve against the session directory), or absolute paths.'
  if (sp.kind === 'opaque') return `this command runs apply_patch through the shell in a form Buracle cannot follow (${sp.why}), so the write guard cannot tell which files it changes. ${instead}`
  return `apply_patch through the shell resolves \`${undetermined ?? '?'}\` against the command's working directory (a \`cd\` or exec workdir), which Codex does not show to hooks, so the write guard cannot check where it lands. ${instead}`
}

function shellPatchText(sp: Extract<ShellPatch, { kind: 'patch' }>): { text: string, base: string } | undefined {
  if (sp.expands && /[$`\\]/.test(sp.body)) return undefined
  return { text: sp.body, base: sp.cd !== undefined && isAbsPath(sp.cd) ? normalizePath(sp.cd) : '' }
}

/** The files a call writes and the text they get, for the pipeline's write guard (H02); a shell apply_patch Buracle cannot follow is denied here. */
export function writeTargets(p: Payload, call: ToolCall, cwd: string, c: Pick<CoreFns, 'parseApplyPatch'>): WriteTargets | { deny: string } | undefined {
  if (call.tool !== SHELL_TOOL && call.kind !== 'patch' && call.kind !== 'edit' && call.kind !== 'write') return undefined
  let paths: string[] = []
  let changes: FileChange[] = []
  if (call.tool === SHELL_TOOL) {
    const sp = shellPatchOf(p)
    if (sp.kind === 'opaque') return { deny: shellPatchDeny(sp) }
    if (sp.kind === 'patch') {
      const t = shellPatchTargets(sp, c.parseApplyPatch)
      if ('undetermined' in t) return { deny: shellPatchDeny(sp, t.undetermined) }
      paths = t.paths
      const fed = shellPatchText(sp)
      if (fed !== undefined) changes = patchChanges(fed.text, fed.base)
    }
  } else {
    paths = call.paths
    if (call.kind === 'patch') changes = codexPatchChanges(call.input, cwd)
  }
  return { paths, contents: g => guardedContents(changes, paths, g.home, g.realpath !== undefined ? { realpath: g.realpath } : {}) }
}
