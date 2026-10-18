import type { Redirect, Script } from './shell'
import { commandName, parseShell, unwrap } from './shell'

export type OutputKind = 'remote' | 'build'

const LOOPBACK = /^(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|::1?|\[::1?\])$/i
const QUIET_FLAGS = new Set(['--version', '--help', '--manual', '--offline'])

const CURL_SHORT_ARG = new Set(['A', 'b', 'c', 'C', 'd', 'D', 'E', 'e', 'F', 'H', 'K', 'm', 'o', 'P', 'Q', 'r', 'T', 't', 'U', 'u', 'w', 'X', 'x', 'Y', 'y', 'z'])
const CURL_LONG_ARG = new Set([
  '--url', '--output', '--output-dir', '--data', '--data-raw', '--data-binary', '--data-urlencode', '--data-ascii', '--json', '--header',
  '--proxy-header', '--request', '--user', '--user-agent', '--referer', '--cookie', '--cookie-jar', '--form', '--form-string', '--upload-file',
  '--write-out', '--max-time', '--connect-timeout', '--proxy', '--proxy-user', '--preproxy', '--noproxy', '--config', '--cert', '--key',
  '--cacert', '--capath', '--range', '--retry', '--retry-delay', '--retry-max-time', '--resolve', '--connect-to', '--dump-header',
  '--oauth2-bearer', '--unix-socket', '--abstract-unix-socket', '--interface', '--dns-servers', '--limit-rate', '--max-filesize',
  '--max-redirs', '--speed-limit', '--speed-time', '--time-cond', '--trace', '--trace-ascii', '--stderr', '--continue-at', '--quote',
  '--aws-sigv4', '--variable', '--url-query', '--expect100-timeout', '--keepalive-time', '--local-port', '--netrc-file', '--pass',
  '--cert-type', '--key-type', '--proto', '--proto-redir', '--proto-default', '--socks4', '--socks4a', '--socks5', '--socks5-hostname',
])
const WGET_SHORT_ARG = new Set(['O', 'o', 'a', 'i', 'B', 't', 'T', 'w', 'Q', 'P', 'U', 'e', 'l', 'A', 'R', 'D', 'X', 'I'])
const WGET_LONG_ARG = new Set([
  '--output-document', '--output-file', '--append-output', '--input-file', '--base', '--tries', '--timeout', '--wait', '--waitretry', '--quota',
  '--directory-prefix', '--user-agent', '--execute', '--level', '--accept', '--reject', '--domains', '--exclude-domains',
  '--exclude-directories', '--include-directories', '--header', '--post-data', '--post-file', '--user', '--password', '--http-user',
  '--http-password', '--proxy-user', '--proxy-password', '--load-cookies', '--save-cookies', '--referer', '--method', '--body-data',
  '--body-file', '--limit-rate', '--bind-address', '--dns-timeout', '--connect-timeout', '--read-timeout', '--ca-certificate',
  '--certificate', '--private-key', '--progress', '--restrict-file-names', '--config',
])
const HTTPIE_SHORT_ARG = new Set(['a', 'A', 'o', 's', 'p', 'P'])
const HTTPIE_LONG_ARG = new Set([
  '--auth', '--auth-type', '--output', '--style', '--print', '--history-print', '--session', '--session-read-only', '--verify', '--cert',
  '--cert-key', '--cert-key-pass', '--proxy', '--timeout', '--max-redirects', '--max-headers', '--pretty', '--format-options', '--boundary',
  '--raw', '--default-scheme', '--response-charset', '--response-mime', '--ssl', '--ciphers', '--bearer',
])
const BUILDS = new Set(['gradle', 'gradlew', 'mvn', 'mvnw', 'sbt'])
const BUILD_QUIET = new Set(['-v', '-version', '--version', '-h', '--help', '-?'])

function hostOf(word: string, shorthand: boolean): string | undefined {
  const w = word.trim()
  if (shorthand && /^:(?:\d+)?(?:[/?#]|$)/.test(w)) return 'localhost'
  const m = /^(?:([a-z][a-z0-9+.-]*):\/\/)?(?:[^/@\s]*@)?(\[[0-9a-f:.]+\]|[a-z0-9_.-]+)(?::\d+)?(?:[/?#]\S*)?$/i.exec(w)
  if (m === null) return undefined
  const host = (m[2] as string).toLowerCase()
  if (m[1] !== undefined) return host
  return host === 'localhost' || host.startsWith('[') || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(host) ? host : undefined
}

function remote(urls: readonly string[], shorthand = false): boolean {
  return urls.some(u => { const h = hostOf(u, shorthand); return h !== undefined && !LOOPBACK.test(h) })
}

interface Parsed { positional: string[]; values: Map<string, string[]>; flags: Set<string> }

function parseArgs(args: readonly string[], shortArg: ReadonlySet<string>, longArg: ReadonlySet<string>): Parsed {
  const out: Parsed = { positional: [], values: new Map(), flags: new Set() }
  const put = (k: string, v: string | undefined): void => { if (v !== undefined) out.values.set(k, [...(out.values.get(k) ?? []), v]) }
  for (let k = 0; k < args.length; k++) {
    const a = args[k] as string
    if (a === '--') { out.positional.push(...args.slice(k + 1)); break }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      const name = eq < 0 ? a : a.slice(0, eq)
      out.flags.add(name)
      if (eq >= 0) put(name, a.slice(eq + 1))
      else if (longArg.has(name)) { put(name, args[k + 1]); k++ }
      continue
    }
    if (a.startsWith('-') && a.length > 1) {
      for (let j = 1; j < a.length; j++) {
        const ch = a[j] as string
        out.flags.add(ch)
        if (!shortArg.has(ch)) continue
        const rest = a.slice(j + 1)
        if (rest !== '') put(ch, rest)
        else { put(ch, args[k + 1]); k++ }
        break
      }
      continue
    }
    out.positional.push(a)
  }
  return out
}

const STDOUT = (v: string): boolean => v === '-' || v === '/dev/stdout'

function curlKind(args: readonly string[]): OutputKind | undefined {
  const p = parseArgs(args, CURL_SHORT_ARG, CURL_LONG_ARG)
  if ([...QUIET_FLAGS, '--head', 'I', 'V', 'h', 'M'].some(f => p.flags.has(f))) return undefined
  if (p.flags.has('O') || p.flags.has('--remote-name') || p.flags.has('--remote-name-all')) return undefined
  if ([...(p.values.get('o') ?? []), ...(p.values.get('--output') ?? [])].some(v => !STDOUT(v))) return undefined
  return remote([...p.positional, ...(p.values.get('--url') ?? [])]) ? 'remote' : undefined
}

function wgetKind(args: readonly string[]): OutputKind | undefined {
  const p = parseArgs(args, WGET_SHORT_ARG, WGET_LONG_ARG)
  if ([...QUIET_FLAGS, 'V', 'h'].some(f => p.flags.has(f))) return undefined
  const toStdout = [...(p.values.get('O') ?? []), ...(p.values.get('--output-document') ?? [])].some(STDOUT)
  return toStdout && remote(p.positional) ? 'remote' : undefined
}

function httpieKind(args: readonly string[]): OutputKind | undefined {
  const p = parseArgs(args, HTTPIE_SHORT_ARG, HTTPIE_LONG_ARG)
  if ([...QUIET_FLAGS, 'h', 'd', '--download', '--headers'].some(f => p.flags.has(f))) return undefined
  if ([...(p.values.get('o') ?? []), ...(p.values.get('--output') ?? [])].some(v => !STDOUT(v))) return undefined
  const first = p.positional[0]
  const url = first !== undefined && /^[A-Z]+$/.test(first) ? p.positional[1] : first
  return url !== undefined && remote([url], true) ? 'remote' : undefined
}

function commandKind(name: string, args: readonly string[]): OutputKind | undefined {
  if (name === 'curl') return curlKind(args)
  if (name === 'wget') return wgetKind(args)
  if (name === 'http' || name === 'https' || name === 'xh' || name === 'xhs') return httpieKind(args)
  if (BUILDS.has(name)) return args.some(a => BUILD_QUIET.has(a)) ? undefined : 'build'
  return undefined
}

function toFile(redirects: readonly Redirect[]): boolean {
  return redirects.some(r => ['>', '>>', '>|', '&>', '&>>', '>&'].includes(r.op) && r.target !== undefined
    && !/^(?:\d+|-)$/.test(r.target.text) && !/^\/dev\/(?:null|stdout|stderr|tty|fd\/[0-2])$/.test(r.target.text))
}

function scriptKind(script: Script, depth: number, printed: boolean): OutputKind | undefined {
  for (const pl of script.pipelines) {
    for (const [i, stage] of pl.stages.entries()) {
      const shown = printed && i === pl.stages.length - 1 && !toFile(stage.kind === 'cmd' ? stage.cmd.redirects : stage.redirects)
      if (stage.kind === 'group') {
        if (depth < 4) { const k = scriptKind(stage.body, depth + 1, shown); if (k) return k }
        continue
      }
      const u = unwrap(stage.cmd.words)
      if (depth < 4) for (const s of u.scripts) { const k = scriptKind(parseShell(s).script, depth + 1, shown); if (k) return k }
      const name = commandName(u.argv[0])
      if (!shown || name === undefined) continue
      const k = commandKind(name, u.argv.slice(1).map(w => w.text))
      if (k) return k
    }
  }
  return undefined
}

export function largeOutputKind(command: string): OutputKind | undefined {
  if (typeof command !== 'string' || command.trim() === '') return undefined
  try {
    return scriptKind(parseShell(command).script, 0, true)
  } catch {
    return undefined
  }
}
