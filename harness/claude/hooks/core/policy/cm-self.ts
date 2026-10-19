const PACKAGE_NAME = /^(?:(?:@[^\s/@]+\/)?[^\s/@]+@)?(?:npm:)?context-mode(?:@[^\s/]*)?$/i
const PACKAGE_SEGMENT = /^context-mode(?:\.git)?(?:@[^@]*)?$/i
const PACKAGE_TARBALL = /^context-mode-v?\d[^\s/]*\.(?:tgz|tar\.gz)$/i

function namesPackage(word: string): boolean {
  if (PACKAGE_NAME.test(word)) return true
  if (word.startsWith('@')) return false
  const segments = word.split(/[/:#?]/)
  return segments.slice(1).some(s => PACKAGE_SEGMENT.test(s)) || PACKAGE_TARBALL.test(segments[segments.length - 1] ?? '')
}
const MENTION = /(?:^|[^a-z0-9_-])context-mode(?:$|[^a-z0-9_-])/i
const MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun'])
const INSTALL_VERBS = new Set(['i', 'in', 'ins', 'inst', 'insta', 'instal', 'install', 'isntall', 'isnt', 'isnta', 'isntal', 'add', 'update', 'up', 'upgrade', 'udpate', 'link', 'ln'])
const RUNNERS = new Set(['npx', 'bunx', 'pnpx'])
const INTERPRETERS = new Set(['node', 'nodejs', 'bun', 'deno'])
const HARNESS_CLIS = new Set(['claude', 'codex', 'opencode', 'omp'])
const PLUGIN_SAFE = new Set(['uninstall', 'remove', 'rm', 'disable', 'list', 'ls', 'info', 'show', 'help', '--help', '-h'])

function basename(p: string): string {
  return p.slice(Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')) + 1).toLowerCase()
}

function isCli(word: string | undefined): boolean {
  if (word === undefined) return false
  const base = basename(word)
  return base === 'context-mode' || base === 'context-mode.cmd' || base === 'cli.bundle.mjs' || /(?:^|[\\/])context-mode[\\/](?:build[\\/])?cli\.m?js$/i.test(word)
}

function positional(args: readonly string[]): string[] {
  return args.filter(a => !a.startsWith('-'))
}

function isGlobal(args: readonly string[]): boolean {
  return args.some((a, i) => a === '--global' || a === '--location=global' || (a === '--location' && args[i + 1] === 'global') || /^-[A-Za-z]*g[A-Za-z]*$/.test(a))
}

function npmOn(value: string): boolean {
  if (value === 'false' || value === 'null') return false
  const n = Number(value)
  return Number.isNaN(n) || n !== 0
}

function globalByEnv(assigns: readonly string[], env: ReadonlyMap<string, string> | undefined): boolean {
  const pairs: Array<[string, string]> = []
  for (const a of assigns) {
    const eq = typeof a === 'string' ? a.indexOf('=') : -1
    if (eq > 0) pairs.push([a.slice(0, eq), a.slice(eq + 1)])
  }
  if (env !== undefined && typeof env.forEach === 'function') env.forEach((v, k) => { pairs.push([k, v]) })
  return pairs.some(([k, v]) => {
    const key = k.toLowerCase()
    if (key === 'npm_config_global') return !/^[\w.-]*$/.test(v) || npmOn(v)
    return key === 'npm_config_location' && (!/^[\w.-]*$/.test(v) || v.toLowerCase() === 'global')
  })
}

function runsUpgrade(args: readonly string[]): boolean {
  const at = args.findIndex(namesPackage)
  return at >= 0 && args.slice(at + 1).includes('upgrade')
}

const UPGRADE_REASON = 'would install or upgrade context-mode outside Buracle, which keeps its own copy current; ask the user to run `buracle update context-mode` instead (`buracle doctor context-mode` shows the installed version).'
const PLUGIN_REASON = "would install context-mode's own plugin or server next to the one Buracle already runs on every harness; its plugins rewrite harness settings outside Buracle. Leave context-mode to Buracle (check it with `buracle doctor context-mode`)."

export function cmSelfManagement(name: string, args: readonly string[], assigns: readonly string[] = [], env?: ReadonlyMap<string, string>): string | undefined {
  const pos = positional(args)
  if (isCli(name) && pos[0] === 'upgrade') return UPGRADE_REASON
  if (INTERPRETERS.has(name)) {
    const at = pos.findIndex(isCli)
    if (at >= 0 && pos.slice(at + 1).includes('upgrade')) return UPGRADE_REASON
  }
  if (RUNNERS.has(name) && runsUpgrade(args)) return UPGRADE_REASON
  if (MANAGERS.has(name)) {
    if (['dlx', 'exec', 'x'].includes(pos[0] ?? '') && runsUpgrade(args)) return UPGRADE_REASON
    if (args.some(namesPackage)) {
      const at = pos.findIndex(w => INSTALL_VERBS.has(w.toLowerCase()))
      const yarnGlobal = name === 'yarn' && pos.slice(0, Math.max(0, at)).includes('global')
      if (at >= 0 && (yarnGlobal || isGlobal(args) || globalByEnv(assigns, env))) return UPGRADE_REASON
    }
  }
  if (HARNESS_CLIS.has(name) && args.some(a => MENTION.test(a))) {
    const sub = pos[0]?.toLowerCase()
    if (sub === 'plugin' || sub === 'plugins') {
      const verb = pos[1]?.toLowerCase()
      const marketVerb = verb === 'marketplace' ? pos[2]?.toLowerCase() : undefined
      if (verb !== undefined && !PLUGIN_SAFE.has(verb) && (marketVerb === undefined || !PLUGIN_SAFE.has(marketVerb))) return PLUGIN_REASON
    }
    if (sub === 'mcp' && (name === 'claude' || name === 'codex') && ['add', 'add-json', 'add-from-claude-desktop'].includes(pos[1]?.toLowerCase() ?? '')) return PLUGIN_REASON
  }
  return undefined
}
