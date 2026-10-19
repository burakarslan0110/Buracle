import { isAbsPath, normalizePath } from '../../core/events'
import { commandName, parseShell, SHELL_NAMES, simpleCommands, unwrap } from '../../core/policy/shell'

export type ShellPatch =
  | { kind: 'none' }
  | { kind: 'opaque', why: string }
  | { kind: 'patch', body: string, cd?: string, expands: boolean }

const PATCH_NAMES = new Set(['apply_patch', 'applypatch'])
const HIDDEN_FLAG = '--codex-run-as-apply-patch'
const MAX_DEPTH = 8

function basename(s: string): string {
  return s.slice(Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\')) + 1).replace(/\.exe$/i, '')
}

function runsApplyPatch(script: string, depth: number): boolean {
  if (depth > MAX_DEPTH) return true
  const parsed = parseShell(script)
  for (const cmd of simpleCommands(parsed.script)) {
    const u = unwrap(cmd.words)
    const name = commandName(u.argv[0])
    if (name !== undefined && PATCH_NAMES.has(name)) return true
    if (u.argv.some(w => w.text === HIDDEN_FLAG)) return true
    for (const s of u.scripts) if (runsApplyPatch(s, depth + 1)) return true
    if (u.shellReadsStdin || (name !== undefined && SHELL_NAMES.has(name))) {
      for (const r of cmd.redirects) {
        if ((r.op === '<<' || r.op === '<<-') && r.body !== undefined && runsApplyPatch(r.body, depth + 1)) return true
        if (r.op === '<<<' && r.target !== undefined && runsApplyPatch(r.target.text, depth + 1)) return true
      }
    }
  }
  for (const s of parsed.subs) if (runsApplyPatch(s, depth + 1)) return true
  return false
}

const CD_WORD = String.raw`[^\s'"$\x60\\;&|<>()*?[\]{}#]+`
const CD_DQ = String.raw`"[^"$\x60\\\n]*"`
const CD_SQ = String.raw`'[^'\n]*'`
// A Windows drive path keeps its backslashes, as PowerShell and cmd.exe read them.
const CD_WIN = String.raw`[A-Za-z]:\\[^\s'"$\x60;&|<>()*?[\]{}#]*|"[A-Za-z]:\\[^"$\x60\n]*"`
const DELIM = String.raw`'[^'\n]+'|"[^"\n]+"|[A-Za-z0-9_.-]+`
const HEADER = new RegExp(String.raw`^(?:cd[ \t]+(${CD_WIN}|${CD_WORD}|${CD_DQ}|${CD_SQ})[ \t]*&&[ \t]*)?(?:apply_patch|applypatch)[ \t]*<<(-?)[ \t]*(${DELIM})[ \t]*$`)

function unquote(s: string): string {
  return (s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"')) ? s.slice(1, -1) : s
}

function heredocForm(script: string): ShellPatch | undefined {
  const text = script.replace(/\r\n/g, '\n').trim()
  const nl = text.indexOf('\n')
  if (nl < 0) return undefined
  const m = HEADER.exec(text.slice(0, nl))
  if (!m) return undefined
  const cdRaw = m[1]
  const dash = m[2] === '-'
  const delimRaw = m[3] as string
  const delim = unquote(delimRaw)
  const lines = text.slice(nl + 1).split('\n')
  let end = lines.findIndex(l => (dash ? l.replace(/^\t+/, '') : l) === delim)
  if (end >= 0 && lines.slice(end + 1).some(l => l.trim() !== '')) return undefined
  if (end < 0) end = lines.length
  const body = lines.slice(0, end).map(l => (dash ? l.replace(/^\t+/, '') : l)).join('\n')
  const expands = !/^['"]/.test(delimRaw)
  return cdRaw !== undefined ? { kind: 'patch', body, cd: unquote(cdRaw), expands } : { kind: 'patch', body, expands }
}

export function shellApplyPatch(command: unknown): ShellPatch {
  let script: string
  if (Array.isArray(command)) {
    const argv = command.filter((x): x is string => typeof x === 'string')
    if (argv.length !== command.length || argv.length === 0) return { kind: 'none' }
    const name = basename(argv[0] as string)
    if (PATCH_NAMES.has(name)) return argv.length === 2 ? { kind: 'patch', body: argv[1] as string, expands: false } : { kind: 'opaque', why: 'apply_patch with an unexpected argument list' }
    const shellLike = argv.length === 3 && SHELL_NAMES.has(name) && /^-[a-z]*c$/.test(argv[1] as string)
    script = shellLike ? argv[2] as string : argv.join(' ')
  } else if (typeof command === 'string') {
    script = command
  } else {
    return { kind: 'none' }
  }
  const mentions = /apply_?patch|codex-run-as-apply-patch/i.test(script)
  if (!mentions) return { kind: 'none' }
  const invoked = runsApplyPatch(script, 0)
  const hasPatch = script.includes('*** Begin Patch')
  if (!invoked && !hasPatch) return { kind: 'none' }
  const form = heredocForm(script)
  if (form !== undefined) return form
  if (!invoked) return { kind: 'opaque', why: 'the command builds and runs a patch indirectly' }
  return hasPatch
    ? { kind: 'opaque', why: 'apply_patch runs inside a larger shell script' }
    : { kind: 'opaque', why: 'the patch text is not part of the command' }
}

export type PatchParser = (patch: string, cwd: string) => { paths: string[], added: Record<string, string> }

export function shellPatchTargets(p: Extract<ShellPatch, { kind: 'patch' }>, parse: PatchParser): { paths: string[], added: Record<string, string> } | { undetermined: string } {
  const base = p.cd !== undefined && isAbsPath(p.cd) ? normalizePath(p.cd) : undefined
  const raw = parse(p.body, '')
  for (const path of raw.paths) {
    if (p.expands && /[$\x60]/.test(path)) return { undetermined: path }
    if (!isAbsPath(path) && base === undefined) return { undetermined: path }
  }
  return base !== undefined ? parse(p.body, base) : raw
}
