import type { ShellWord } from './shell'

export interface Launched { argv: ShellWord[]; scripts: string[]; stdin?: boolean }

interface Launcher {
  subs?: readonly string[]
  scriptSubs?: readonly string[]
  short?: string
  long?: readonly string[]
  script?: readonly string[]
  restAfter?: readonly string[]
  shellFlags?: string
  skip?: number
  dashDash?: boolean
  scriptOnly?: boolean
}

const RUN: Launcher = { subs: ['run'] }

const LAUNCHERS: Readonly<Record<string, Launcher>> = {
  setsid: {},
  flock: { short: 'wE', long: ['--wait', '--timeout', '--conflict-exit-code'], script: ['-c', '--command'], skip: 1 },
  chrt: { short: 'TPD', long: ['--sched-runtime', '--sched-period', '--sched-deadline'], skip: 1 },
  taskset: { skip: 1 },
  'sandbox-exec': { short: 'fpnD' },
  strace: { short: 'abeEIoOpPsSuX' },
  dtruss: { short: 'bnpt' },
  time: { short: 'fo', long: ['--format', '--output'] },
  ionice: { short: 'cnpPu', long: ['--class', '--classdata', '--pid', '--pgid', '--uid'] },
  arch: { long: ['-arch', '-d', '-e'] },
  entr: { shellFlags: 's' },
  uv: { subs: ['run'], short: 'p', long: ['--with', '--with-editable', '--with-requirements', '--python', '--project', '--directory', '--package', '--extra', '--group', '--only-group', '--env-file', '--index', '--index-url', '--extra-index-url', '--cache-dir', '--config-file'] },
  poetry: { subs: ['run'], short: 'CP', long: ['--directory', '--project'] },
  pipenv: RUN, pdm: RUN, hatch: RUN, rye: RUN, devbox: RUN,
  bundle: { subs: ['exec'], long: ['--gemfile'] },
  npm: { subs: ['exec', 'x'], long: ['--package', '--prefix', '--workspace', '-w'], script: ['-c', '--call'], scriptOnly: true },
  npx: { long: ['--package', '-p'], script: ['-c', '--call'], scriptOnly: true },
  pnpm: { subs: ['exec'], short: 'C', long: ['--dir', '--filter', '-F', '--workspace-concurrency'] },
  yarn: { subs: ['exec'], long: ['--cwd'] },
  bun: { scriptSubs: ['exec'] },
  mise: { subs: ['exec', 'x'], short: 'C', long: ['--cd'], dashDash: true },
  asdf: { subs: ['exec'] },
  direnv: { subs: ['exec'], skip: 1 },
  conda: { subs: ['run'], short: 'np', long: ['--name', '--prefix', '--cwd'] },
  mamba: { subs: ['run'], short: 'np', long: ['--name', '--prefix', '--cwd'] },
  micromamba: { subs: ['run'], short: 'np', long: ['--name', '--prefix', '--cwd'] },
  'nix-shell': { script: ['--run', '--command'], long: ['-p', '--packages', '-I', '-A', '--attr', '--arg', '--argstr', '--option'], dashDash: true },
  nix: { subs: ['develop', 'shell'], restAfter: ['-c', '--command'], dashDash: true },
  op: { subs: ['run'], long: ['--env-file'], dashDash: true },
  'aws-vault': { subs: ['exec'], skip: 1, long: ['--duration', '--region', '--mfa-token'] },
  doppler: { subs: ['run'], script: ['--command'], long: ['--project', '-p', '--config', '-c', '--token'] },
  dotenv: { short: 'ecv', dashDash: true },
}

function joinWords(ws: readonly ShellWord[]): string {
  return ws.map(w => (w.dynamic ? w.raw : w.text)).join(' ')
}

function scriptText(w: ShellWord): string {
  return w.dynamic ? w.raw : w.text
}

function launchWith(spec: Launcher, rest: ShellWord[]): Launched | undefined {
  const scripts: string[] = []
  const short = spec.short ?? ''
  const long = spec.long ?? []
  const script = spec.script ?? []
  const needSub = spec.subs !== undefined || spec.scriptSubs !== undefined
  let sub = false
  let skipped = 0
  let shellText = false
  let dashed = false
  let k = 0
  for (let guard = 0; guard < 512 && k < rest.length; guard++) {
    const w = rest[k] as ShellWord
    const t = w.text
    if (t === '--') {
      if (needSub && !sub) return undefined
      dashed = true
      k++
      break
    }
    if (t.startsWith('-') && t.length > 1) {
      const eq = t.indexOf('=')
      const name = eq < 0 ? t : t.slice(0, eq)
      if (script.includes(name)) {
        const s = eq >= 0 ? t.slice(eq + 1) : rest[k + 1] !== undefined ? scriptText(rest[k + 1] as ShellWord) : undefined
        if (s !== undefined) scripts.push(s)
        k += eq >= 0 ? 1 : 2
        continue
      }
      if (spec.restAfter?.includes(name) === true) return { argv: rest.slice(k + 1), scripts }
      if (long.includes(name)) { k += eq < 0 ? 2 : 1; continue }
      if (t.startsWith('--')) { k++; continue }
      const letters = t.slice(1)
      let consumed = 1
      for (let j = 0; j < letters.length; j++) {
        const l = letters[j] as string
        if (spec.shellFlags?.includes(l) === true) shellText = true
        if (short.includes(l)) { consumed = j === letters.length - 1 ? 2 : 1; break }
      }
      k += consumed
      continue
    }
    if (needSub && !sub) {
      if (spec.scriptSubs?.includes(t) === true) {
        const body = rest.slice(k + 1)
        return body.length > 0 ? { argv: [], scripts: [...scripts, joinWords(body)] } : undefined
      }
      if (spec.subs?.includes(t) !== true) return undefined
      sub = true
      k++
      continue
    }
    if (skipped < (spec.skip ?? 0)) { skipped++; k++; continue }
    if (spec.dashDash === true) { k++; continue }
    break
  }
  if (needSub && !sub) return undefined
  if (spec.scriptOnly === true) return scripts.length > 0 ? { argv: [], scripts } : undefined
  if (spec.dashDash === true && !dashed) return { argv: [], scripts }
  const argv = rest.slice(k)
  if (shellText && argv[0] !== undefined) return { argv: [], scripts: [...scripts, scriptText(argv[0])] }
  return { argv, scripts }
}

const TMUX_RUNS: Readonly<Record<string, string>> = {
  'new-session': 'cefFnstxy', 'new-window': 'ceFnt', 'split-window': 'celtFp', 'respawn-pane': 'cet', 'respawn-window': 'cet',
  'run-shell': 'cdt', 'display-popup': 'bcdehsStTwxy', 'pipe-pane': 't', 'if-shell': 't', 'send-keys': 'cNt',
}
const TMUX_ALIAS: Readonly<Record<string, string>> = {
  new: 'new-session', neww: 'new-window', splitw: 'split-window', respawnp: 'respawn-pane', respawnw: 'respawn-window',
  run: 'run-shell', popup: 'display-popup', pipep: 'pipe-pane', if: 'if-shell', send: 'send-keys',
}
const NAMED_KEY = /^(?:[CMS]-.+|Enter|KPEnter|Space|Tab|BTab|Escape|BSpace|Up|Down|Left|Right|Home|End|IC|DC|NPage|PageDown|PgDn|PPage|PageUp|PgUp|F\d{1,2})$/

function keyText(t: string): string {
  if (t === 'Space') return ' '
  if (t === 'Tab' || t === 'C-i') return '\t'
  return '\n'
}

function tmuxCommand(words: ShellWord[], scripts: string[]): void {
  const first = words[0]?.text ?? ''
  const name = TMUX_ALIAS[first] ?? first
  const args = TMUX_RUNS[name]
  if (args === undefined) return
  const pos: ShellWord[] = []
  let literal = false
  let k = 1
  for (; k < words.length; k++) {
    const t = (words[k] as ShellWord).text
    if (t === '--') { k++; break }
    if (!t.startsWith('-') || t.length < 2) break
    const letters = t.slice(1)
    if (letters.includes('l')) literal = true
    const at = [...letters].findIndex(l => args.includes(l))
    if (at >= 0 && at === letters.length - 1) k++
  }
  pos.push(...words.slice(k))
  if (pos.length === 0) return
  if (name === 'if-shell') { scripts.push(scriptText(pos[0] as ShellWord)); return }
  if (name === 'send-keys') {
    const typed = pos.map(w => (!literal && NAMED_KEY.test(w.text) ? keyText(w.text) : scriptText(w))).join('')
    if (typed.trim() !== '') scripts.push(typed)
    return
  }
  scripts.push(joinWords(pos))
}

function tmux(rest: ShellWord[]): Launched {
  const scripts: string[] = []
  let k = 0
  while (k < rest.length) {
    const t = (rest[k] as ShellWord).text
    if (t === '--') { k++; break }
    if (!t.startsWith('-') || t.length < 2) break
    if (t === '-c') { const s = rest[k + 1]; if (s !== undefined) scripts.push(scriptText(s)); k += 2; continue }
    k += /[fLST]$/.test(t) ? 2 : 1
  }
  let cur: ShellWord[] = []
  for (const w of rest.slice(k)) {
    if (w.text === ';') { tmuxCommand(cur, scripts); cur = []; continue }
    cur.push(w)
  }
  tmuxCommand(cur, scripts)
  return { argv: [], scripts }
}

const SCREEN_WORDS = new Set(['-ls', '-list', '-wipe', '-version', '-v', '-d', '-m', '-r', '-x', '-R', '-D', '-q', '-L', '-U', '-A', '-a', '-O', '-i', '-f', '-fn', '-fa'])

function screen(rest: ShellWord[]): Launched {
  let k = 0
  while (k < rest.length) {
    const t = (rest[k] as ShellWord).text
    if (t === '--') { k++; break }
    if (!t.startsWith('-') || t.length < 2) break
    if (t === '-X') {
      const cmd = rest.slice(k + 1)
      const verb = cmd[0]?.text
      if (verb === 'stuff') {
        const typed = cmd.slice(1).map(scriptText).join(' ').replace(/\^M|\\r|\\n/g, '\n')
        return { argv: [], scripts: typed.trim() === '' ? [] : [typed] }
      }
      if (verb === 'exec' || verb === 'screen') return { argv: cmd.slice(1).filter((w, i) => !(i === 0 && /^[.!|:]+$/.test(w.text))), scripts: [] }
      return { argv: [], scripts: [] }
    }
    k += t === '-Logfile' || (!SCREEN_WORDS.has(t) && /^-[A-Za-z]*[cehpSstT]$/.test(t)) ? 2 : 1
  }
  return { argv: rest.slice(k), scripts: [] }
}

function atJob(rest: ShellWord[]): Launched {
  const words = rest.map(w => w.text)
  if (words.some(t => /^-[a-zA-Z]*[flrcd]/.test(t))) return { argv: [], scripts: [] }
  return { argv: [], scripts: [], stdin: true }
}

export function launched(name: string, rest: ShellWord[]): Launched | undefined {
  if (name === 'tmux') return tmux(rest)
  if (name === 'screen') return screen(rest)
  if (name === 'at' || name === 'batch') return atJob(rest)
  const spec = Object.prototype.hasOwnProperty.call(LAUNCHERS, name) ? LAUNCHERS[name] : undefined
  return spec === undefined ? undefined : launchWith(spec, rest)
}
