import { normalizePath, resolvePath } from '../events'
import type { BashGuardOptions } from './bash-guard'
import { catastrophicPath, checkBash, extraDenyReason, forbiddenWritePath } from './bash-guard'
import type { CodeOp } from './code-scan'
import { codeLang, scanCode } from './code-scan'
import { UI_SETTINGS_REASON, uiSettingsCall } from './self-disable'
import { DYN, HOME } from './shell'
import { withCd } from './shell-text'
import type { WriteGuardContext } from './write-guard'
import { checkWrite, selfProtectedArea, selfProtectionText } from './write-guard'

export interface EvalGuardOptions {
  execCwd?: string
  extraDeny?: string[]
}

function q(s: string): string {
  return '`' + s.replace(/`/g, "'") + '`'
}

function expandHome(p: string, home: string): string {
  if (home === '') return p
  if (p === '~') return home
  if (p.startsWith('~/')) return home.replace(/\/+$/, '') + p.slice(1)
  return p
}

function concrete(target: string, home: string): string | undefined {
  if (target === '' || target.includes(DYN)) return undefined
  if (target.startsWith(HOME)) return home === '' ? undefined : home.replace(/\/+$/, '') + target.slice(1)
  return target
}

function lower(s: string): string { return s.toLowerCase() }

function protectedInside(abs: string, ctx: WriteGuardContext): string | undefined {
  const home = typeof ctx.home === 'string' ? normalizePath(ctx.home) : ''
  const vault = typeof ctx.vault === 'string' && ctx.vault !== '' ? normalizePath(expandHome(ctx.vault, ctx.home)) : ''
  const roots: Array<[string, string]> = []
  if (home !== '' && home !== '/') {
    roots.push([`${home}/.ssh`, "the user's SSH directory"], [`${home}/.aws`, "the user's AWS credentials directory"], [`${home}/.buracle/state`, "Buracle's own state"])
  }
  if (vault !== '' && vault !== '/') roots.push([vault, 'the Buracle memory vault'])
  const a = lower(abs.replace(/\/+$/, ''))
  for (const [root, what] of roots) {
    const r = lower(root)
    if (a === '' || r === a || r.startsWith(a === '/' ? '/' : a + '/')) return what
  }
  return undefined
}

function shellOptions(ctx: WriteGuardContext, extraDeny: string[]): BashGuardOptions {
  const o: BashGuardOptions = { extraDeny }
  if (typeof ctx.home === 'string' && ctx.home.startsWith('/')) o.home = ctx.home
  if (ctx.selfPaths !== null && typeof ctx.selfPaths === 'object') o.selfPaths = ctx.selfPaths
  if (typeof ctx.cwd === 'string' && ctx.cwd.startsWith('/')) o.cwd = ctx.cwd
  if (typeof ctx.vault === 'string' && ctx.vault !== '') o.vault = ctx.vault
  if (Array.isArray(ctx.protect)) o.protect = ctx.protect
  if (typeof ctx.buracleRepo === 'string' && ctx.buracleRepo !== '') o.buracleRepo = ctx.buracleRepo
  if (typeof ctx.realpath === 'function') o.realpath = ctx.realpath
  return o
}

function resolveIn(base: string, p: string, home: string): string {
  if (p.startsWith('/')) return normalizePath(p)
  if (home !== '' && (p === '~' || p.startsWith('~/'))) return resolvePath('', p, home) ?? p
  return base.startsWith('/') ? resolvePath(base, p) ?? p : p
}

function judge(op: CodeOp, ctx: WriteGuardContext, execCwd: string, extraDeny: string[]): { deny: string, hook: 'H01' | 'H02' } | undefined {
  const home = typeof ctx.home === 'string' ? ctx.home : ''
  const cwd = typeof ctx.cwd === 'string' ? ctx.cwd : ''
  if (op.kind === 'unreadable') {
    return { deny: `The guard could not check all of this code (${op.why}); run it in smaller steps.`, hook: 'H01' }
  }
  if (op.kind === 'shell') {
    const command = execCwd !== cwd && execCwd.startsWith('/') ? withCd(execCwd, op.command) : op.command
    const r = checkBash(command, shellOptions(ctx, extraDeny))
    return r.deny !== undefined ? { deny: r.deny, hook: 'H01' } : undefined
  }
  if (op.kind === 'delete-tree' || op.kind === 'move') {
    const target = op.kind === 'move' ? op.src : op.target
    if (target !== undefined) {
      const mode = op.kind === 'move' ? 'perm' : 'rm'
      const path = concrete(target, home)
      const abs = path !== undefined ? resolveIn(execCwd, path, home) : undefined
      const what = catastrophicPath(target, mode) ?? (abs !== undefined && abs.startsWith('/') && abs !== target ? catastrophicPath(abs, mode) : undefined)
      if (what) {
        return op.kind === 'move'
          ? { deny: `${q(op.api)} would move ${what} away and break the system or the user's account; move only specific files inside the project.`, hook: 'H01' }
          : { deny: `${q(op.api)} would delete ${what}; delete only the specific paths you need, inside the project.`, hook: 'H01' }
      }
      if (abs !== undefined) {
        const inside = abs.startsWith('/') ? protectedInside(abs, ctx) : undefined
        if (inside) return { deny: `${q(op.api)} would ${op.kind === 'move' ? 'move away' : 'delete'} ${inside}; leave it to the user and Buracle.`, hook: 'H02' }
        const area = abs.startsWith('/') ? selfProtectedArea(abs, home, ctx.selfPaths, true, cwd) : undefined
        if (area !== undefined) {
          const t = selfProtectionText(area)
          return { deny: `${q(op.api)} would ${op.kind === 'move' ? 'move away' : 'delete'} ${t.what}; ${t.remedy}.`, hook: 'H02' }
        }
        const w = checkWrite([abs], ctx)
        if (w.deny !== undefined) return { deny: `${q(op.api)} would ${op.kind === 'move' ? 'move' : 'delete'} a protected path: ${w.deny}`, hook: 'H02' }
      }
    }
  }
  const dst = op.kind === 'write' || op.kind === 'delete' ? op.target : op.kind === 'move' ? op.dst : undefined
  if (dst !== undefined) {
    const path = concrete(dst, home)
    const abs = path !== undefined ? resolveIn(execCwd, path, home) : undefined
    const bad = forbiddenWritePath(dst) ?? (abs !== undefined && abs.startsWith('/') && abs !== dst ? forbiddenWritePath(abs) : undefined)
    if (bad) {
      return bad.startsWith('~')
        ? { deny: `Writing into ${bad} changes the user's credentials; ask the user to make this change themselves.`, hook: 'H01' }
        : { deny: `${q(op.api)} writes to ${bad} and destroys its data; write to a regular file instead.`, hook: 'H01' }
    }
    if (abs !== undefined) {
      const w = checkWrite([abs], ctx)
      if (w.deny !== undefined) return { deny: `${q(op.api)} would ${op.kind === 'delete' ? 'delete' : 'write'} a protected path: ${w.deny}`, hook: 'H02' }
    }
  }
  return undefined
}

export function checkEval(code: string, language: string, ctx: WriteGuardContext, opts?: EvalGuardOptions): { deny?: string, hook?: 'H01' | 'H02' } {
  if (typeof code !== 'string' || code.trim() === '') return {}
  const c: WriteGuardContext = ctx !== null && typeof ctx === 'object' ? ctx : { cwd: '', home: '', vault: '', protect: [] }
  const session = typeof c.cwd === 'string' ? c.cwd : ''
  const exec = typeof opts?.execCwd === 'string' && opts.execCwd.startsWith('/') ? normalizePath(opts.execCwd) : session
  const extraDeny = Array.isArray(opts?.extraDeny) ? opts.extraDeny.filter((p): p is string => typeof p === 'string') : []
  try {
    for (const op of scanCode(code, codeLang(typeof language === 'string' ? language : ''))) {
      const r = judge(op, c, exec, extraDeny)
      if (r) return r
    }
  } catch {
    if (/\b(?:rmtree|rm_rf|rmSync|rimraf|os\.system|execSync|subprocess)\b|rm\s+-[a-z]*r/i.test(code)) {
      return { deny: 'The guard could not read this code, and it deletes files or runs shell commands; run the step as a reviewed shell command instead.', hook: 'H01' }
    }
  }
  if (uiSettingsCall([code])) return { deny: UI_SETTINGS_REASON, hook: 'H01' }
  const extra = extraDenyReason(extraDeny, [code])
  return extra !== undefined ? { deny: extra, hook: 'H01' } : {}
}
