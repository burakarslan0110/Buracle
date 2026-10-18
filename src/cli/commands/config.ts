import { join } from 'node:path'
import { stringify as yamlStringify } from 'yaml'
import type { CommandIO } from '../router'
import type { BuracleConfig } from '../../core/config'
import { loadConfigSync } from '../../engine/config'
import { setConfigValue } from '../../engine/config-edit'
import { getIn, parseKeyPath, yamlParse, type KeyPath } from '../../engine/merge'
import * as paths from '../../engine/paths'
import { parseFlags } from '../../engine/update/args'
import { opsDeps } from '../../engine/update/deps'
import { errText, tilde, writeJson } from '../../engine/update/output'

export { setConfigValue } from '../../engine/config-edit'

export const name = 'config'
export const summary = 'Read or change the live configuration: get <key>, set <key> <value>, unset <key>, path'
export const usage = `Usage: buracle config get [<dotted.key>] [--json]
       buracle config set <dotted.key> <value> [--string]
       buracle config unset <dotted.key>
       buracle config path [--json]

get    prints the effective value (canonical/buracle.yaml defaults merged with
       ~/.buracle/config.yaml). Scalars print plainly (e.g. \`true\`), lists and
       mappings as one-line JSON; --json prints JSON. Without a key the whole
       configuration is printed. Exit 1 for an unknown key.
set    writes the value into ~/.buracle/config.yaml (comments are kept) after
       validating the result; the value is parsed as YAML (true, 85, [a, b]) unless
       --string is given. The runtime snapshot read by hooks is refreshed.
unset  removes the key from ~/.buracle/config.yaml (the default applies again).
path   prints the path of ~/.buracle/config.yaml.

Keys that \`buracle install\` writes into the harnesses' own settings (permissions.*,
effort.*, agents.teams, harnesses.*, routing.strictness, vault) reach them only at the next
\`buracle install\`: set and unset say so when such a key changes.

Examples:
  buracle config get routing.strictness
  buracle config set harnesses.codex.enabled false
  buracle config set memory.ui.port 41800`

function effective(repoRoot: string): BuracleConfig {
  const c = loadConfigSync({ repoRoot }).config
  return c.repo === undefined ? { ...c, repo: repoRoot } : c
}

function lookup(config: BuracleConfig, path: KeyPath): { found: boolean, value: unknown } {
  return getIn(config, path)
}

const SYNC_KEYS: readonly string[][] = [['permissions'], ['effort'], ['agents', 'teams'], ['harnesses'], ['routing', 'strictness']]

function syncHint(path: KeyPath): string | undefined {
  const segs = path.map(String)
  const applies = SYNC_KEYS.some(k => k.slice(0, segs.length).every((s, i) => s === segs[i]))
  return applies ? 'run `buracle install` to apply it to the harnesses' : undefined
}

function scalarText(v: unknown): string {
  if (v === null || v === undefined) return 'null'
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return JSON.stringify(v)
}

function parseValue(raw: string, current: unknown, forceString: boolean): unknown {
  if (forceString) return raw
  let v: unknown
  try { v = yamlParse(raw) } catch { return raw }
  if (v === null || v === undefined) return raw
  if (typeof current === 'string' && typeof v !== 'string') return raw
  return v
}

export async function run(argv: string[], io: CommandIO): Promise<number> {
  const p = parseFlags(argv, { flags: { json: 'bool', string: 'bool' } })
  const json = io.flags.json || p.bools.has('json')
  const [sub, ...args] = p.positionals
  const fail = (msg: string, code = 1): number => { io.stderr.write(`buracle config: ${msg}\n`); return code }
  if (p.errors.length > 0) return fail(`${p.errors.join('; ')}\n${usage}`)
  const repoRoot = opsDeps.repoRoot()

  switch (sub) {
    case 'get': {
      if (args.length > 1) return fail(`get takes one key\n${usage}`)
      const config = effective(repoRoot)
      if (args.length === 0) {
        io.stdout.write(json ? JSON.stringify(config, null, 2) + '\n' : yamlStringify(config, { lineWidth: 0 }))
        return 0
      }
      let path: KeyPath
      try { path = parseKeyPath(args[0] as string) } catch (e) { return fail(errText(e)) }
      const got = lookup(config, path)
      if (!got.found) return fail(`unknown key: ${args[0]}`)
      io.stdout.write((json ? JSON.stringify(got.value) : scalarText(got.value)) + '\n')
      return 0
    }
    case 'set': {
      if (args.length !== 2) return fail(`set needs <dotted.key> <value>\n${usage}`)
      const [key, raw] = args as [string, string]
      let path: KeyPath
      try { path = parseKeyPath(key) } catch (e) { return fail(errText(e)) }
      const current = lookup(effective(repoRoot), path)
      if (!current.found) return fail(`unknown key: ${key}`)
      const value = parseValue(raw, current.value, p.bools.has('string'))
      const r = await setConfigValue(key, value)
      if (!r.ok) return fail(r.error)
      const hint = r.changed ? syncHint(path) : undefined
      if (json) writeJson(io.stdout, { ok: true, key, value, changed: r.changed, file: paths.userConfigFile(), ...(hint !== undefined ? { sync: true, hint } : {}) })
      else io.stdout.write((r.changed ? `${key} = ${scalarText(value)} (${tilde(paths.userConfigFile())})\n` : `${key} is already ${scalarText(value)}\n`) + (hint !== undefined ? `Next: ${hint}.\n` : ''))
      return 0
    }
    case 'unset': {
      if (args.length !== 1) return fail(`unset needs <dotted.key>\n${usage}`)
      const key = args[0] as string
      const r = await setConfigValue(key, undefined)
      if (!r.ok) return fail(r.error)
      let hint: string | undefined
      try { hint = r.changed ? syncHint(parseKeyPath(key)) : undefined } catch { hint = undefined }
      if (json) writeJson(io.stdout, { ok: true, key, changed: r.changed, ...(hint !== undefined ? { sync: true, hint } : {}) })
      else io.stdout.write((r.changed ? `${key} removed from ${tilde(paths.userConfigFile())}; the default applies.\n` : `${key} is not set in ${tilde(paths.userConfigFile())}.\n`) + (hint !== undefined ? `Next: ${hint}.\n` : ''))
      return 0
    }
    case 'path': {
      if (args.length > 0) return fail(`path takes no arguments\n${usage}`)
      if (json) writeJson(io.stdout, { user: paths.userConfigFile(), canonical: join(repoRoot, 'canonical', 'buracle.yaml'), runtime: paths.runtimeConfigFile() })
      else io.stdout.write(`${paths.userConfigFile()}\n`)
      return 0
    }
    default:
      return fail(sub === undefined ? `missing subcommand\n${usage}` : `unknown subcommand ${sub}\n${usage}`)
  }
}
