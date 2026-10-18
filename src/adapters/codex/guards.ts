import type { Harness, ToolCall } from '../../core/events'
import { normalizePath } from '../../core/events'
import type * as core from '../../core/index'
import type { BashGuardOptions } from '../../core/policy/bash-guard'
import { mcpWritePaths } from '../../core/policy/mcp-paths'
import type { WriteGuardContext } from '../../core/policy/write-guard'
import { log } from '../../engine/log'
import type { AdapterContext } from '../registry'
import { realWriteTarget, withRealpath } from '../shared/realpath'
import { buracleRepoFor } from '../shared/repo'
import { selfPaths } from '../shared/self-paths'
import { codexPatchChanges, CONFIG_PARSERS, guardedContents, patchChanges, type FileChange } from '../shared/write-content'
import { denyReason, errText, rec, step, str, type Payload } from './hook-io'
import { shellApplyPatch, shellPatchTargets, type ShellPatch } from './shell-patch'

type CoreFns = typeof core
const H: Harness = 'codex'

export const SHELL_TOOL = 'Bash'

export const GUARDED_TOOLS: ReadonlySet<string> = new Set([SHELL_TOOL, 'apply_patch'])

export function bashOptions(ctx: AdapterContext, cwd: string): BashGuardOptions {
  return {
    ...ctx.config.guards.bash, home: ctx.paths.home(), selfPaths: selfPaths(ctx.config.repo, ctx.paths), cwd,
    vault: ctx.paths.oldVaultRoot(), protect: ctx.config.guards.write.protect, realpath: realWriteTarget,
  }
}

export function guardFailed(hook: 'H01' | 'H02', e: unknown): string {
  const what = hook === 'H01' ? 'bash guard could not check this command' : 'write guard could not check the files of this edit'
  return denyReason(hook, `the ${what} (${errText(e)}), so the call is blocked: Buracle's guards fail closed. Ask the user to run it themselves, or have them check \`buracle doctor\`.`)
}

export function shellPatchOf(p: Payload): ShellPatch {
  if (str(p['tool_name']) !== SHELL_TOOL) return { kind: 'none' }
  return shellApplyPatch(rec(p['tool_input'])['command'])
}

function shellPatchDeny(sp: ShellPatch, undetermined?: string): string {
  const instead = 'Use the apply_patch tool instead (its paths resolve against the session directory), or absolute paths.'
  if (sp.kind === 'opaque') return `this command runs apply_patch through the shell in a form Buracle cannot follow (${sp.why}), so the write guard cannot tell which files it changes. ${instead}`
  return `apply_patch through the shell resolves \`${undetermined ?? '?'}\` against the command's working directory (a \`cd\` or exec workdir), which Codex does not show to hooks, so the write guard cannot check where it lands. ${instead}`
}

export async function writeContext(ev: string, cwd: string, ctx: AdapterContext): Promise<WriteGuardContext> {
  const repo = await step(ev, 'H02 buracleRepo', undefined as string | undefined, () => buracleRepoFor(cwd, {
    known: [ctx.repoRoot, ctx.config.repo], home: ctx.paths.home(),
  }))
  return withRealpath({
    cwd, home: ctx.paths.home(), vault: ctx.paths.oldVaultRoot(), protect: ctx.config.guards.write.protect,
    selfPaths: selfPaths(ctx.config.repo, ctx.paths), parsers: CONFIG_PARSERS,
    ...(repo !== undefined ? { buracleRepo: repo } : {}),
  })
}

function shellPatchText(sp: Extract<ShellPatch, { kind: 'patch' }>): { text: string, base: string } | undefined {
  if (sp.expands && /[$`\\]/.test(sp.body)) return undefined
  return { text: sp.body, base: sp.cd !== undefined && sp.cd.startsWith('/') ? normalizePath(sp.cd) : '' }
}

export async function writeDenial(p: Payload, call: ToolCall, cwd: string, ctx: AdapterContext, c: CoreFns, ev: string): Promise<string | undefined> {
  try {
    let paths: string[] = []
    let changes: FileChange[] = []
    if (call.tool === SHELL_TOOL) {
      const sp = shellPatchOf(p)
      if (sp.kind === 'opaque') return denyReason('H02', shellPatchDeny(sp))
      if (sp.kind === 'patch') {
        const t = shellPatchTargets(sp, c.parseApplyPatch)
        if ('undetermined' in t) return denyReason('H02', shellPatchDeny(sp, t.undetermined))
        paths = t.paths
        const fed = shellPatchText(sp)
        if (fed !== undefined) changes = patchChanges(fed.text, fed.base)
      }
    } else {
      paths = call.paths
      if (call.kind === 'patch') changes = codexPatchChanges(call.input, cwd)
    }
    if (paths.length === 0) return undefined
    const wctx = await writeContext(ev, cwd, ctx)
    const contents = guardedContents(changes, paths, wctx.home, wctx.realpath !== undefined ? { realpath: wctx.realpath } : {})
    const r = c.checkWrite(paths, Object.keys(contents).length > 0 ? { ...wctx, contents } : wctx)
    return r.deny ? denyReason('H02', r.deny) : undefined
  } catch (e) {
    log('error', 'codex hook PreToolUse: H02 write guard failed; denying (fail closed)', { harness: H, error: e })
    return guardFailed('H02', e)
  }
}

export async function mcpWriteDenial(call: ToolCall, cwd: string, ctx: AdapterContext, c: CoreFns, ev: string): Promise<string | undefined> {
  if (call.kind !== 'mcp') return undefined
  try {
    if (c.cmCall(call) !== undefined) return undefined
    const targets = mcpWritePaths(call.tool, call.input, call.mcp)
    if (targets.length === 0) return undefined
    const r = c.checkWrite(targets, await writeContext(ev, cwd, ctx))
    return r.deny ? denyReason('H02', r.deny) : undefined
  } catch (e) {
    log('error', 'codex hook PreToolUse: H02 write guard failed for an MCP call; denying (fail closed)', { tool: call.tool, error: e })
    return guardFailed('H02', e)
  }
}
