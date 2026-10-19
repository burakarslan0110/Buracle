import type { Harness, ToolCall } from '../events'
import { isAbsPath, isWindowsPath, normalizePath, pathRoot } from '../events'
import type { CmExecTool, CmHiddenTool } from '../context-mode'
import { CM_BATCH_COMMAND_KEYS, CM_EXEC_INPUT_KEYS, CM_SERVER_ID, isCmExecTool, isCmHiddenTool, isCmTool } from '../context-mode'
import type { BashGuardOptions } from './bash-guard'
import { checkBash, extraDenyReason, visitShellCommands } from './bash-guard'
import { codeLang, scanCode } from './code-scan'
import { checkEval } from './eval-guard'
import { REVIEW_AGENT_TYPE, readOnlyShellProblem } from './readonly-shell'
import { commandName } from './shell'
import { shellQuote, withCd } from './shell-text'
import type { WriteGuardContext } from './write-guard'
import { credentialLocation } from './write-guard'

function isObj(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === 'object' && !Array.isArray(x)
}

function q(s: string): string {
  return '`' + s.replace(/`/g, "'") + '`'
}

function clip(s: string, max = 60): string {
  return s.length > max ? `${s.slice(0, max - 3)}...` : s
}

const CM_NAME: Readonly<Record<Harness, RegExp>> = {
  claude: /^mcp__(?:plugin_[^_]+_)?context-mode__(ctx_[A-Za-z0-9_]+)$/,
  codex: /^mcp__context_mode__(ctx_[A-Za-z0-9_]+)$/,
  opencode: /^context-mode_(ctx_[A-Za-z0-9_]+)$/,
  omp: /^mcp__context_mode_(ctx_[a-z0-9_]+)$/,
}

export function cmToolOfName(harness: Harness, name: string): string | undefined {
  const re = typeof harness === 'string' ? CM_NAME[harness] : undefined
  if (re === undefined || typeof name !== 'string') return undefined
  return re.exec(name)?.[1]
}

const CM_EXEC_NAME = /(?:^|_)context[-_]mode_{1,2}ctx_(?:execute|execute_file|batch_execute)$/i

export function looksLikeCmExecTool(name: string): boolean {
  return typeof name === 'string' && CM_EXEC_NAME.test(name)
}

export interface CmCall { tool: string; input: Record<string, unknown> }

export function cmCall(call: ToolCall): CmCall | undefined {
  if (call === null || typeof call !== 'object') return undefined
  const input = isObj(call.input) ? call.input : {}
  const m = call.mcp
  if (call.kind === 'mcp' && isObj(m) && m.server === CM_SERVER_ID && typeof m.tool === 'string' && m.tool !== '') return { tool: m.tool, input }
  const tool = typeof call.tool === 'string' ? cmToolOfName(call.harness, call.tool) : undefined
  return tool !== undefined ? { tool, input } : undefined
}

const HIDDEN_REASON: Readonly<Record<CmHiddenTool, string>> = {
  ctx_upgrade: "context-mode's ctx_upgrade is not used under Buracle: Buracle keeps context-mode current (`buracle update --yes context-mode`, with the user's go-ahead).",
  ctx_insight: "context-mode's ctx_insight opens context-mode's hosted dashboard; it is not used under Buracle.",
  ctx_doctor: "context-mode's ctx_doctor checks context-mode's own installs, not the one Buracle runs; run `buracle doctor context-mode` instead.",
}

export function cmToolDenial(call: ToolCall): string | undefined {
  const c = cmCall(call)
  if (c === undefined) return undefined
  if (isCmHiddenTool(c.tool)) return HIDDEN_REASON[c.tool]
  if (!isCmTool(c.tool)) return `${q(clip(c.tool))} is a context-mode tool this Buracle version does not know, so its guards cannot check what it does; do not use it, and run \`buracle doctor context-mode\` (or tell the user).`
  return undefined
}

export type SandboxOp =
  | { kind: 'shell', tool: CmExecTool, command: string, cwd?: string }
  | { kind: 'code', tool: CmExecTool, language: string, code: string, cwd?: string }
  | { kind: 'read', tool: CmExecTool, path: string }
  | { kind: 'unreadable', tool: string, why: string }

const SHELL_LANGUAGES: ReadonlySet<string> = new Set(['shell', 'bash', 'sh', 'zsh', 'dash', 'ksh'])
const MAX_BATCH_COMMANDS = 100

function batchCommands(v: unknown): string[] | { why: string } {
  let list: unknown = v
  if (typeof v === 'string') {
    if (v.trim() === '') return { why: 'its commands are empty' }
    try {
      const parsed: unknown = JSON.parse(v)
      list = Array.isArray(parsed) ? parsed : [v]
    } catch {
      list = [v]
    }
  }
  if (!Array.isArray(list)) return { why: 'its commands are not a list' }
  if (list.length === 0) return { why: 'it names no commands' }
  if (list.length > MAX_BATCH_COMMANDS) return { why: `it holds more than ${MAX_BATCH_COMMANDS} commands` }
  const out: string[] = []
  for (const item of list) {
    if (typeof item === 'string') { out.push(item); continue }
    if (isObj(item) && typeof item['command'] === 'string' && Object.keys(item).every(k => CM_BATCH_COMMAND_KEYS.includes(k))) { out.push(item['command']); continue }
    return { why: 'a command is neither text nor a {label, command} entry' }
  }
  return out
}

export function sandboxOps(call: ToolCall): SandboxOp[] {
  try {
    const c = cmCall(call)
    if (c === undefined || !isCmExecTool(c.tool)) return []
    const tool = c.tool
    const input = c.input
    const unreadable = (why: string): SandboxOp[] => [{ kind: 'unreadable', tool, why }]
    const extra = Object.keys(input).find(k => !CM_EXEC_INPUT_KEYS[tool].includes(k))
    if (extra !== undefined) return unreadable(`it has the input field ${q(clip(extra, 40))}, which this Buracle version does not know`)
    let cwd: string | undefined
    if (input['cwd'] !== undefined) {
      const v = input['cwd']
      if (typeof v !== 'string' || v.trim() === '') return unreadable('its `cwd` names no folder')
      cwd = v
    }
    const at = cwd !== undefined ? { cwd } : {}
    if (tool === 'ctx_batch_execute') {
      const cmds = batchCommands(input['commands'])
      if (!Array.isArray(cmds)) return unreadable(cmds.why)
      return cmds.map((command): SandboxOp => ({ kind: 'shell', tool, command, ...at }))
    }
    const language = typeof input['language'] === 'string' ? input['language'].trim().toLowerCase() : ''
    const code = input['code']
    if (language === '') return unreadable('it names no language')
    if (typeof code !== 'string') return unreadable('its code is not text')
    const ops: SandboxOp[] = []
    if (tool === 'ctx_execute_file') {
      const path = input['path']
      if (typeof path !== 'string' || path.trim() === '') return unreadable('it names no file')
      ops.push({ kind: 'read', tool, path })
    }
    ops.push(SHELL_LANGUAGES.has(language) ? { kind: 'shell', tool, command: code, ...at } : { kind: 'code', tool, language, code, ...at })
    return ops
  } catch {
    return [{ kind: 'unreadable', tool: 'context-mode', why: 'the guard failed to read it' }]
  }
}

export interface SandboxGuardOptions {
  bash: BashGuardOptions
  write: WriteGuardContext
  serverDir?: string
  pinnedDir?: string
}

export interface SandboxVerdict { deny?: string; hook?: 'H01' | 'H02' }

const APPLY_PATCH_REASON = "context-mode's sandbox would run `apply_patch`, which writes files where the write guard cannot check them; make the change with your own edit or apply_patch tool instead."

function absDir(x: unknown): string | undefined {
  return typeof x === 'string' && isAbsPath(x) ? normalizePath(x) : undefined
}

function resolveDir(server: string, cwd: string): string {
  const c = cwd.trim()
  if (isAbsPath(c)) return normalizePath(c)
  if (isWindowsPath(server) && /^[\\/]/.test(c)) return normalizePath(`${pathRoot(server).replace(/\/$/, '')}${c}`)
  return isAbsPath(server) ? normalizePath(`${server}/${c}`) : c
}

function runsApplyPatch(command: string): boolean {
  let found = false
  visitShellCommands(command, argv => {
    const name = commandName(argv[0])
    found = name === 'apply_patch' || name === 'applypatch' || argv.some(w => w.text === '--codex-run-as-apply-patch')
    return found
  })
  return found
}

function credentialDenial(tool: string, path: string, server: string, home: string): string | undefined {
  const why = credentialLocation(path, { cwd: server, home })
  return why === undefined ? undefined : `${q(clip(path, 80))} ${why}, and context-mode keeps what ${tool} reads in its search index; leave it out (ask the user if you need a value from it).`
}

const TYPESCRIPT_LANGUAGES: ReadonlySet<string> = new Set(['typescript', 'ts', 'tsx'])
const TYPESCRIPT_REASON = 'context-mode would run this TypeScript code, and Buracle\'s guards cannot read past its type annotations; run it as JavaScript instead (language: "javascript", without the type annotations; Bun runs both).'

function fileHeader(op: { kind: 'shell' } | { kind: 'code', language: string }, abs: string): string {
  const json = JSON.stringify(abs)
  if (op.kind === 'shell') {
    const sq = shellQuote(abs)
    return `FILE_CONTENT_PATH=${sq}\nfile_path=${sq}\nFILE_CONTENT=$(cat ${sq})\n`
  }
  switch (codeLang(op.language)) {
    case 'js': return `const FILE_CONTENT_PATH = ${json};\nconst file_path = FILE_CONTENT_PATH;\nconst FILE_CONTENT = require("fs").readFileSync(FILE_CONTENT_PATH, "utf-8");\n`
    case 'python': return `FILE_CONTENT_PATH = ${json}\nfile_path = FILE_CONTENT_PATH\nwith open(FILE_CONTENT_PATH, "r", encoding="utf-8") as _f:\n    FILE_CONTENT = _f.read()\n`
    case 'ruby': return `FILE_CONTENT_PATH = ${json}\nfile_path = FILE_CONTENT_PATH\nFILE_CONTENT = File.read(FILE_CONTENT_PATH, encoding: "utf-8")\n`
    case 'php': return `<?php\n$FILE_CONTENT_PATH = ${json};\n$file_path = $FILE_CONTENT_PATH;\n$FILE_CONTENT = file_get_contents($FILE_CONTENT_PATH);\n`
    case 'perl': return `my $FILE_CONTENT_PATH = ${json};\nmy $file_path = $FILE_CONTENT_PATH;\nopen(my $fh, '<:encoding(UTF-8)', $FILE_CONTENT_PATH) or die "Cannot open: $!";\nmy $FILE_CONTENT = do { local $/; <$fh> };\nclose($fh);\n`
    default: return ''
  }
}

const SECRET_EXTENSION = /^\.(?:pem|key|p12|pfx|env|local|prod(?:uction)?|dev(?:elopment)?|stag(?:e|ing)|test(?:ing)?|ci|qa|uat|preview|secrets?)$/i
const SECRET_NAMES: readonly string[] = ['.env', '.env.local', '.env.production', '.envrc', 'server.pem', 'server.key', 'cert.p12', 'cert.pfx', 'id_rsa', 'id_ed25519', 'id_ecdsa', 'credentials', 'credentials.json', 'credentials.yml']
const ORDINARY_NAMES: readonly string[] = ['README.md', 'index.ts', 'main.py', 'notes.txt', 'package.json', 'config.yaml', 'ci.yml', '.eslintrc.json', '.prettierrc']

function walkGlob(pattern: string): RegExp {
  let re = ''
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i] as string
    if (ch === '*') { if (pattern[i + 1] === '*') { re += '.*'; i++ } else re += '[^/]*'; continue }
    if (ch === '?') { re += '[^/]'; continue }
    re += '\\^$.|+()[]{}'.includes(ch) ? `\\${ch}` : ch
  }
  return new RegExp(`^${re}$`, 'i')
}

function includesSecrets(glob: string): boolean {
  const last = glob.slice(glob.lastIndexOf('/') + 1)
  if (last === '') return false
  const re = walkGlob(last)
  return SECRET_NAMES.some(n => re.test(n)) && !ORDINARY_NAMES.some(n => re.test(n))
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

function walkWidening(input: Record<string, unknown>): string | undefined {
  if (input['respectGitignore'] === false) return 'with respectGitignore: false would also index what .gitignore leaves out, where secrets such as .env files usually are'
  if (input['followSymlinks'] === true) return 'with followSymlinks: true would follow symbolic links to files the walk otherwise leaves out'
  const ext = strings(input['extensions']).find(e => SECRET_EXTENSION.test(e.startsWith('.') ? e : `.${e}`))
  if (ext !== undefined) return `with the extension ${q(clip(ext, 40))} would index secret files (private keys, certificates or .env files)`
  const glob = strings(input['include']).find(includesSecrets)
  if (glob !== undefined) return `with the include pattern ${q(clip(glob, 60))} would index files named like secrets`
  return undefined
}

function judgeSandbox(call: ToolCall, opts: SandboxGuardOptions): SandboxVerdict {
  const c = cmCall(call)
  if (c === undefined) return {}
  const denial = cmToolDenial(call)
  if (denial !== undefined) return { deny: denial, hook: 'H01' }
  const o: Partial<SandboxGuardOptions> = isObj(opts) ? opts : {}
  const bash: BashGuardOptions = isObj(o.bash) ? o.bash : { extraDeny: [] }
  const write: WriteGuardContext = isObj(o.write) ? o.write : { cwd: '', home: '', vault: '', protect: [] }
  const session = absDir(bash.cwd) ?? absDir(write.cwd) ?? absDir(call.cwd) ?? ''
  const home = typeof write.home === 'string' && write.home !== '' ? write.home : typeof bash.home === 'string' ? bash.home : ''
  const server = absDir(o.serverDir) ?? session
  const pinned = absDir(o.pinnedDir) ?? session

  if (c.tool === 'ctx_index') {
    const path = c.input['path']
    if (typeof path !== 'string' || path.trim() === '') return {}
    const why = credentialDenial(c.tool, path, server, home)
    if (why !== undefined) return { deny: why, hook: 'H02' }
    const wide = walkWidening(c.input)
    return wide === undefined ? {} : { deny: `ctx_index of ${q(clip(path, 80))} ${wide}, and context-mode keeps what it reads in its search index; index the folder with the default options, or name the files you need.`, hook: 'H02' }
  }
  if (!isCmExecTool(c.tool)) return {}

  const fromWrite: Partial<BashGuardOptions> = {}
  if (bash.vault === undefined && typeof write.vault === 'string' && write.vault !== '') fromWrite.vault = write.vault
  if (bash.protect === undefined && Array.isArray(write.protect)) fromWrite.protect = write.protect
  if (bash.buracleRepo === undefined && typeof write.buracleRepo === 'string') fromWrite.buracleRepo = write.buracleRepo
  if (bash.realpath === undefined && typeof write.realpath === 'function') fromWrite.realpath = write.realpath
  const shellOpts: BashGuardOptions = { ...bash, ...fromWrite, ...(session !== '' ? { cwd: session } : {}) }
  const writeCtx: WriteGuardContext = session !== '' ? { ...write, cwd: session } : write
  const extraDeny = strings(bash.extraDeny)
  let file: string | undefined
  for (const op of sandboxOps(call)) {
    if (op.kind === 'unreadable') {
      return { deny: `The guard could not read this ${op.tool} call (${op.why}), so it cannot check what would run; pass only the fields context-mode documents (batch commands as text or {label, command}), or run the step in the shell, where the guards see it.`, hook: 'H01' }
    }
    if (op.kind === 'read') {
      const why = credentialDenial(op.tool, op.path, server, home)
      if (why !== undefined) return { deny: why, hook: 'H02' }
      const named = extraDenyReason(extraDeny, [op.path])
      if (named !== undefined) return { deny: named, hook: 'H01' }
      file = resolveDir(server, op.path)
      continue
    }
    const dirs = op.tool === 'ctx_execute_file' ? [server] : op.cwd !== undefined ? [resolveDir(server, op.cwd)] : [...new Set([pinned, server])]
    if (op.kind === 'shell') {
      if (runsApplyPatch(op.command)) return { deny: APPLY_PATCH_REASON, hook: 'H02' }
      for (const dir of dirs) {
        const at = (s: string): string => dir !== '' && dir !== session ? withCd(dir, s) : s
        if (file !== undefined) {
          const h = checkBash(at(fileHeader(op, file) + op.command), { ...shellOpts, extraDeny: [] })
          if (h.deny !== undefined) return { deny: h.deny, hook: 'H01' }
        }
        const r = checkBash(at(op.command), shellOpts)
        if (r.deny !== undefined) return { deny: r.deny, hook: 'H01' }
      }
      continue
    }
    if (codeLang(op.language) === 'unknown') {
      return { deny: `context-mode would run this ${q(clip(op.language, 20))} code, which Buracle's guards cannot check; run it as shell, JavaScript or Python instead.`, hook: 'H01' }
    }
    if (TYPESCRIPT_LANGUAGES.has(op.language)) return { deny: TYPESCRIPT_REASON, hook: 'H01' }
    if (scanCode(op.code, codeLang(op.language)).some(s => s.kind === 'shell' && runsApplyPatch(s.command))) return { deny: APPLY_PATCH_REASON, hook: 'H02' }
    for (const dir of dirs) {
      const at = isAbsPath(dir) ? { execCwd: dir } : {}
      if (file !== undefined) {
        const h = checkEval(fileHeader(op, file) + op.code, op.language, writeCtx, at)
        if (h.deny !== undefined) return { deny: h.deny, hook: h.hook ?? 'H01' }
      }
      const r = checkEval(op.code, op.language, writeCtx, { ...at, extraDeny })
      if (r.deny !== undefined) return { deny: r.deny, hook: r.hook ?? 'H01' }
    }
  }
  return {}
}

export function checkSandbox(call: ToolCall, opts: SandboxGuardOptions): SandboxVerdict {
  try {
    return judgeSandbox(call, opts)
  } catch {
    const named = call !== null && typeof call === 'object' && typeof call.tool === 'string' && looksLikeCmExecTool(call.tool)
    return named || (call?.kind === 'mcp' && call.mcp?.server === CM_SERVER_ID)
      ? { deny: 'The guard could not check this context-mode call; run the step in the shell, where the guards see it.', hook: 'H01' }
      : {}
  }
}

export const CM_PURGE_COMMAND = 'ctx_purge'

function purgeCommand(input: Record<string, unknown>): string | undefined {
  const confirm = input['confirm']
  if (confirm !== true && !(typeof confirm === 'string' && confirm.trim().toLowerCase() === 'true')) return undefined
  const sid = typeof input['sessionId'] === 'string' ? input['sessionId'].replace(/[^A-Za-z0-9._:-]/g, '').slice(0, 64) : ''
  return sid !== '' ? `${CM_PURGE_COMMAND} --session ${sid}` : `${CM_PURGE_COMMAND} --scope project`
}

export function sandboxShellCommands(call: ToolCall): string[] {
  try {
    const c = cmCall(call)
    if (c === undefined) return []
    if (c.tool === 'ctx_purge') {
      const purge = purgeCommand(c.input)
      return purge !== undefined ? [purge] : []
    }
    const out: string[] = []
    for (const op of sandboxOps(call)) {
      if (op.kind === 'shell') out.push(op.command)
      else if (op.kind === 'code') for (const s of scanCode(op.code, codeLang(op.language))) if (s.kind === 'shell') out.push(s.command)
    }
    return out
  } catch {
    return []
  }
}

export function cmReviewerDenial(agentType: string | undefined, call: ToolCall): string | undefined {
  if (typeof agentType !== 'string' || !REVIEW_AGENT_TYPE.test(agentType)) return undefined
  const c = cmCall(call)
  if (c === undefined || c.tool === 'ctx_search' || c.tool === 'ctx_stats') return undefined
  const lead = `Buracle: ${agentType} is a read-only reviewer`
  const tail = 'Read files with Read, search with rg, and see the change with git diff, log or show and `buracle review-scope --json`; change nothing.'
  if (!isCmExecTool(c.tool)) return `${lead}, and context-mode's ${clip(c.tool)} changes the index the main session searches. ${tail}`
  for (const op of sandboxOps(call)) {
    if (op.kind === 'read') continue
    if (op.kind === 'shell') {
      const problem = readOnlyShellProblem(op.command)
      if (problem !== undefined) return `${lead} and ${problem}. ${tail}`
      continue
    }
    if (op.kind === 'code') return `${lead}, and context-mode would run ${clip(op.language, 20)} code that no guard can prove read-only; run read-only shell commands (language: "shell") instead. ${tail}`
    return `${lead}, and the guard could not read this ${op.tool} call (${op.why}). ${tail}`
  }
  return undefined
}
