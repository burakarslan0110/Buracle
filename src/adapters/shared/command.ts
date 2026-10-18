import { accessSync, constants, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { which } from '../../engine/proc'

export type Env = Record<string, string | undefined>

const PARAM = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?-)((?:[^{}]|\{[^{}]*\})*))?\}|\$([A-Za-z_][A-Za-z0-9_]*)/g

export function expandParams(text: string, env: Env, depth = 0): string | undefined {
  if (/[`]|\$\(/.test(text)) return undefined
  let failed = false
  const out = text.replace(PARAM, (_m, braced: string | undefined, op: string | undefined, def: string | undefined, bare: string | undefined) => {
    const name = (braced ?? bare) as string
    const value = env[name]
    if (op !== undefined) {
      const useDefault = op === ':-' ? value === undefined || value === '' : value === undefined
      if (!useDefault) return value as string
      const d = depth < 4 ? expandParams(def ?? '', env, depth + 1) : undefined
      if (d === undefined) failed = true
      return d ?? ''
    }
    if (value === undefined) { failed = true; return '' }
    return value
  })
  if (failed || /\$/.test(out.replace(/\\\$/g, ''))) return undefined
  return out
}

export function firstWord(command: string, env: Env): string | undefined {
  let t = command.trim()
  if (t.startsWith('exec ')) t = t.slice(5).trimStart()
  if (t === '') return undefined
  const q = t[0]
  if (q === '"' || q === "'") {
    const end = t.indexOf(q, 1)
    if (end < 0) return undefined
    const inner = t.slice(1, end)
    return q === "'" ? inner : expandParams(inner, env)
  }
  const word = t.split(/\s+/)[0] as string
  if (/["'\\]/.test(word)) return undefined
  const home = env['HOME']
  const tilde = word === '~' || word.startsWith('~/') ? (home !== undefined ? home + word.slice(1) : undefined) : word
  return tilde === undefined ? undefined : expandParams(tilde, env)
}

export function isExecutableFile(p: string): boolean {
  try { return statSync(p).isFile() && (accessSync(p, constants.X_OK), true) } catch { return false }
}

export interface ResolvedCommand {
  program?: string
  executable?: string
}

export function resolveProgram(program: string | undefined, cwd?: string): ResolvedCommand {
  if (program === undefined || program === '') return {}
  if (program.includes('/')) {
    const abs = isAbsolute(program) ? program : cwd !== undefined ? join(cwd, program) : undefined
    return abs !== undefined && isExecutableFile(abs) ? { program, executable: abs } : { program }
  }
  const found = which(program)
  return found !== undefined ? { program, executable: found } : { program }
}

const SHELL = /^(?:\/(?:usr\/)?(?:local\/)?bin\/)?(?:ba|z|da|k)?sh$/

export function resolveArgv(argv: readonly string[], env: Env): ResolvedCommand {
  const [cmd, flag, script] = argv
  if (cmd === undefined) return {}
  if (SHELL.test(cmd) && flag !== undefined && /^-[a-z]*c$/.test(flag) && script !== undefined) {
    return resolveProgram(firstWord(script, env))
  }
  return resolveProgram(firstWord(/\s/.test(cmd) ? `"${cmd}"` : cmd, env))
}

export function resolveCommandLine(command: string, env: Env): ResolvedCommand {
  return resolveProgram(firstWord(command, env))
}
