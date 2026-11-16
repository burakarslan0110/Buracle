import { visitShellCommands } from './bash-guard'
import { codeLang, scanCode } from './code-scan'
import { buracleArgs } from './self-disable'

export const SUBAGENT_PLAN_COMMANDS: readonly string[] = ['pause', 'resume', 'set', 'complete', 'verify', 'register', 'unregister', 'approve-result', 'review', 'prepare-native']
export const SUBAGENT_FLOW_COMMANDS: readonly string[] = ['start', 'phase', 'end']
export const SUBAGENT_WORKTREE_COMMANDS: readonly string[] = ['cleanup']

const SUBAGENT_VALUE_FLAGS: readonly string[] = ['session', 'harness', 'kind', 'reason', 'phase', 'base', 'prefix', 'slug', 'type', 'title', 'dir', 'outcome', 'note', 'done', 'total', 'role', 'handle', 'provider', 'verdict', 'on', 'input', 'goal', 'timeout-min', 'wait', 'job']
const MENTIONS_BURACLE = /buracle|src\/cli\/main\.ts|bin\/buracle/

function positionals(args: readonly string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string
    if (a === '--') { out.push(...args.slice(i + 1)); break }
    if (!a.startsWith('-')) { out.push(a); continue }
    if (a.startsWith('--') && !a.includes('=') && SUBAGENT_VALUE_FLAGS.includes(a.slice(2))) i++
  }
  return out
}

function userApproval(sub: string, rest: readonly string[]): boolean {
  return sub === 'approve-result' || (sub === 'set' && rest[0] === 'approved')
}

function stateCommand(args: readonly string[]): string | undefined {
  const [group, sub, ...rest] = positionals(args)
  if (sub === undefined) return undefined
  if (group === 'plan' && SUBAGENT_PLAN_COMMANDS.includes(sub)) {
    if (sub === 'review' && rest[0] === 'status') return undefined
    const approval = userApproval(sub, rest)
    return `buracle plan ${sub}${approval && sub === 'set' ? ' approved' : ''}`
  }
  if (group === 'flow' && SUBAGENT_FLOW_COMMANDS.includes(sub)) return `buracle flow ${sub}`
  if (group === 'worktree' && SUBAGENT_WORKTREE_COMMANDS.includes(sub)) return `buracle worktree ${sub}`
  return undefined
}

export function subagentStateDenial(command: string): string | undefined {
  if (typeof command !== 'string' || !MENTIONS_BURACLE.test(command)) return undefined
  let hit: string | undefined
  visitShellCommands(command, argv => {
    const args = buracleArgs(argv)
    hit = args !== undefined ? stateCommand(args) : undefined
    return hit !== undefined
  })
  if (hit === undefined) return undefined
  return `Buracle Stack H01: a subagent does not run \`${hit}\`, because the plan, the workflow state and the worktree merges belong to the lead. Return status \`blocked\` with the question and its options; the lead asks the user and changes the state. Read-only commands such as \`buracle plan status\`, \`buracle plan review status\` and \`buracle plan validate\` stay allowed.`
}

export function subagentStateDenialAll(commands: readonly string[]): string | undefined {
  try {
    for (const c of Array.isArray(commands) ? commands : []) {
      const d = subagentStateDenial(c)
      if (d !== undefined) return d
    }
  } catch {
    return undefined
  }
  return undefined
}

export function subagentCodeDenial(code: string, language: string): string | undefined {
  if (typeof code !== 'string' || !MENTIONS_BURACLE.test(code)) return undefined
  try {
    return subagentStateDenialAll(scanCode(code, codeLang(typeof language === 'string' ? language : 'js')).flatMap(s => s.kind === 'shell' ? [s.command] : []))
  } catch {
    return undefined
  }
}
