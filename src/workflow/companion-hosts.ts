import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pluginMcpPattern } from '../adapters/claude/plugin'
import { ompAgentTools } from '../adapters/omp/build'
import { READONLY_SHELL_ALLOW, READONLY_SHELL_DENY } from '../adapters/opencode/constants'
import { agentPermissions } from '../adapters/opencode/render'
import type { AgentDoc } from '../core/catalog'
import type { Harness } from '../core/events'
import { claudeResultText } from '../core/plan/companion'
import { COMPANION_MCP_SERVERS, COMPANION_OMP_TOOLS } from '../core/policy/companion-fence'
import { tomlParse, tomlValue } from '../engine/merge'
import * as paths from '../engine/paths'
import { MEMORY_RUNNER_DIR_PREFIX } from '../memory/spawn'

export const COMPANION_MCP: readonly string[] = COMPANION_MCP_SERVERS
export const OPENCODE_COMPANION_AGENT = 'buracle-companion'
export const COMPANION_DIR_PREFIX = `${MEMORY_RUNNER_DIR_PREFIX}companion-`
export const COMPANION_BIN: Readonly<Record<Harness, string>> = { claude: 'claude', codex: 'codex', opencode: 'opencode', omp: 'omp' }

const CLAUDE_SHELL_ALLOW: readonly string[] = ['git status *', 'git diff *', 'git log *', 'git show *', 'git ls-files *', 'git blame *', 'git merge-base *', 'git rev-parse *', 'rg *']
const CLAUDE_SHELL_DENY: readonly string[] = ['git *--output*', 'rg *--pre*', 'rg *--hostname-bin*']
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g

export interface HostPrepare { prompt: string, repo: string, outDir: string, timeoutMs: number, agent: AgentDoc }
export interface PreparedRun { argv: string[], cwd: string, stdin: string, read(stdout: string): { ok: boolean, text: string }, cleanup(): void }
export interface CompanionHost { harness: Harness, shell: boolean, scratch: boolean, prepare(o: HostPrepare): PreparedRun }

function plain(stdout: string): { ok: boolean, text: string } {
  return { ok: true, text: stdout.replace(ANSI, '') }
}

export function claudeArgv(): string[] {
  const allow = ['Read', ...CLAUDE_SHELL_ALLOW.map(p => `Bash(${p})`), ...COMPANION_MCP.map(pluginMcpPattern)]
  const deny = ['Write', 'Edit', 'NotebookEdit', ...CLAUDE_SHELL_DENY.map(p => `Bash(${p})`)]
  return ['claude', '-p', '--output-format', 'json', '--no-session-persistence', '--setting-sources', 'user', '--permission-mode', 'dontAsk', '--tools', 'Read,Bash', '--allowedTools', allow.join(','), '--disallowedTools', deny.join(',')]
}

const claude: CompanionHost = {
  harness: 'claude',
  shell: true,
  scratch: false,
  prepare: o => ({
    argv: claudeArgv(),
    cwd: o.repo,
    stdin: o.prompt,
    read: stdout => claudeResultText(stdout) ?? { ok: false, text: stdout.replace(ANSI, '') },
    cleanup: () => undefined,
  }),
}

export function codexMcpServers(configText: string): string[] {
  let config: Record<string, unknown>
  try { config = tomlParse(configText) } catch (e) {
    throw new Error(`config.toml does not parse, so its MCP servers cannot be switched off for a read-only run (${e instanceof Error ? e.message : String(e)})`)
  }
  const servers = config['mcp_servers']
  return servers !== null && typeof servers === 'object' && !Array.isArray(servers) ? Object.keys(servers) : []
}

function codexConfigText(): string {
  try { return readFileSync(join(paths.codexHome(), 'config.toml'), 'utf8') } catch { return '' }
}

export function codexArgv(repo: string, answerFile: string, configText: string): string[] {
  const off = codexMcpServers(configText).filter(id => !COMPANION_MCP.includes(id))
  const overrides = off.length > 0 ? ['-c', `mcp_servers=${tomlValue(Object.fromEntries(off.map(id => [id, { enabled: false }])))}`] : []
  return ['codex', 'exec', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only', '--color', 'never', '-C', repo, '-o', answerFile, ...overrides, '-']
}

const codex: CompanionHost = {
  harness: 'codex',
  shell: true,
  scratch: false,
  prepare: o => {
    const answer = join(o.outDir, 'codex-answer.txt')
    rmSync(answer, { force: true })
    return {
      argv: codexArgv(o.repo, answer, codexConfigText()),
      cwd: o.repo,
      stdin: o.prompt,
      read: stdout => {
        let text = ''
        try { text = existsSync(answer) ? readFileSync(answer, 'utf8') : '' } catch { text = '' }
        return { ok: true, text: text.trim() !== '' ? text : stdout.replace(ANSI, '') }
      },
      cleanup: () => undefined,
    }
  },
}

interface Rule { action: string, resource: string, effect: 'allow' | 'deny' | 'ask' }

function q(s: string): string {
  return JSON.stringify(s)
}

export function companionShellPatterns(repo: string): string[] {
  const out: string[] = []
  for (const p of READONLY_SHELL_ALLOW) {
    if (p.startsWith('buracle ')) continue
    if (!p.startsWith('git -C * ')) { out.push(p); continue }
    const rest = p.slice('git -C * '.length)
    for (const dir of [repo, `"${repo}"`, `'${repo}'`]) out.push(`git -C ${dir} ${rest}`)
  }
  return out
}

export function opencodeAgentFile(agent: AgentDoc, repo: string): string {
  const shell = companionShellPatterns(repo)
  const base = agentPermissions(agent)
  const rules: Rule[] = [
    ...base.filter(r => r.action !== 'shell' && r.action !== 'edit').map(r => (r.action === 'external_directory' ? { ...r, effect: 'allow' as const } : r)),
    ...(base.some(r => r.action === 'shell') ? shell.map(resource => ({ action: 'shell', resource, effect: 'allow' as const })) : []),
    ...READONLY_SHELL_DENY.map(resource => ({ action: 'shell', resource, effect: 'deny' as const })),
    { action: 'edit', resource: '*', effect: 'deny' },
  ]
  return [
    '---',
    `description: ${q('Buracle second-opinion reviewer: one read-only review, then a JSON report.')}`,
    'mode: "primary"',
    'permissions:',
    ...rules.map(r => `  - { action: ${q(r.action)}, resource: ${q(r.resource)}, effect: ${q(r.effect)} }`),
    '---',
    'You are Buracle\'s second-opinion reviewer. Follow the review instructions in the message. You are read-only: never edit, create or delete a file.',
    '',
  ].join('\n')
}

export function opencodePolicies(repo: string): Rule[] {
  return [
    { action: 'tool.use', resource: '*', effect: 'deny' },
    ...['read:*', 'glob:*', 'grep:*', 'external_directory:*'].map(resource => ({ action: 'tool.use', resource, effect: 'allow' as const })),
    ...companionShellPatterns(repo).map(p => ({ action: 'tool.use', resource: `shell:${p}`, effect: 'allow' as const })),
    ...COMPANION_MCP.map(s => ({ action: 'tool.use', resource: `${s.replace(/[^a-zA-Z0-9_-]/g, '_')}_*:*`, effect: 'allow' as const })),
    ...READONLY_SHELL_DENY.map(p => ({ action: 'tool.use', resource: `shell:${p}`, effect: 'deny' as const })),
    { action: 'tool.use', resource: 'edit:*', effect: 'deny' },
  ]
}

const opencode: CompanionHost = {
  harness: 'opencode',
  shell: true,
  scratch: true,
  prepare: o => {
    const scratch = mkdtempSync(join(tmpdir(), COMPANION_DIR_PREFIX))
    mkdirSync(join(scratch, '.opencode', 'agents'), { recursive: true })
    writeFileSync(join(scratch, '.opencode', 'agents', `${OPENCODE_COMPANION_AGENT}.md`), opencodeAgentFile(o.agent, o.repo))
    writeFileSync(join(scratch, '.opencode', 'opencode.json'), JSON.stringify({ policies: opencodePolicies(o.repo) }, null, 2) + '\n')
    return {
      argv: ['opencode', 'run', '--standalone', '--agent', OPENCODE_COMPANION_AGENT, '--title', 'Buracle second opinion'],
      cwd: scratch,
      stdin: o.prompt,
      read: plain,
      cleanup: () => { rmSync(scratch, { recursive: true, force: true }) },
    }
  },
}

export function ompArgv(agent: AgentDoc, repo: string, timeoutMs: number): string[] {
  const tools = ompAgentTools(agent).filter(t => COMPANION_OMP_TOOLS.includes(t))
  return ['omp', '-p', '--no-session', '--no-title', '--no-skills', '--cwd', repo, `--tools=${tools.join(',')}`, `--max-time=${Math.max(60, Math.ceil(timeoutMs / 1000))}`]
}

const omp: CompanionHost = {
  harness: 'omp',
  shell: false,
  scratch: false,
  prepare: o => ({ argv: ompArgv(o.agent, o.repo, o.timeoutMs), cwd: o.repo, stdin: o.prompt, read: plain, cleanup: () => undefined }),
}

const HOSTS: Readonly<Record<Harness, CompanionHost>> = { claude, codex, opencode, omp }

export const companionTestHooks: { extraArgs?: (h: Harness) => string[] } = {}

function withExtra(h: Harness, run: PreparedRun): PreparedRun {
  const extra = companionTestHooks.extraArgs?.(h) ?? []
  if (extra.length === 0) return run
  const argv = [...run.argv]
  const at = h === 'codex' && argv.at(-1) === '-' ? argv.length - 1 : argv.length
  argv.splice(at, 0, ...extra)
  return { ...run, argv }
}

export function companionHost(h: Harness): CompanionHost {
  const host = HOSTS[h]
  return { ...host, prepare: o => withExtra(h, host.prepare(o)) }
}
