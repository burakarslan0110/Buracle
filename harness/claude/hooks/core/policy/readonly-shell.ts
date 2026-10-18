export const REVIEW_AGENT_TYPE = /^(?:buracle:)?(?:plan-build|changes|goal-build)-review$|^buracle:[a-z0-9-]+-review$/

export function reviewerShellDenial(agentType: string | undefined, command: string): string | undefined {
  if (agentType === undefined || !REVIEW_AGENT_TYPE.test(agentType)) return undefined
  const problem = readOnlyShellProblem(command)
  if (problem === undefined) return undefined
  return `Buracle: ${agentType} is a read-only reviewer and ${problem}. Read files with Read, search with rg, and see the change with git diff, log or show and \`buracle review-scope --json\`; change nothing.`
}

export function readOnlyShellProblem(command: string): string | undefined {
  const line = shellCommands(command, 0)
  if (line.problem !== undefined) return line.problem
  for (const argv of line.commands) {
    const problem = commandProblem(argv)
    if (problem !== undefined) return problem
  }
  return undefined
}

interface ShellLine { commands: string[][]; problem?: string }

function shellCommands(src: string, depth: number): ShellLine {
  const out: ShellLine = { commands: [] }
  if (depth > 3) return { commands: [], problem: 'its command substitutions nest too deeply to check' }
  let words: string[] = []
  let word = ''
  let inWord = false
  let quoted = false
  const endWord = (): void => {
    if (inWord) {
      if (!quoted && (word === '{' || word === '}' || word === '!')) endCommand()
      else words.push(word)
    }
    word = ''
    inWord = false
    quoted = false
  }
  const endCommand = (): void => {
    if (words.length > 0) out.commands.push(words)
    words = []
  }
  const nested = (inner: string): string | undefined => {
    const sub = shellCommands(inner, depth + 1)
    out.commands.push(...sub.commands)
    return sub.problem
  }
  const fail = (problem: string): ShellLine => ({ commands: out.commands, problem })
  const bodies: Array<{ word: string; quoted: boolean; tabs: boolean }> = []
  let i = 0
  while (i < src.length) {
    const c = src.charAt(i)
    if (c === '\n' && bodies.length > 0) {
      endWord()
      endCommand()
      const body = skipBodies(src, i + 1, bodies.splice(0))
      if (body.problem !== undefined) return fail(body.problem)
      i = body.end
      continue
    }
    if (c === '\\') {
      if (src.charAt(i + 1) !== '\n') {
        word += src.charAt(i + 1)
        inWord = true
      }
      i += 2
      continue
    }
    if (c === "'") {
      const end = src.indexOf("'", i + 1)
      if (end < 0) return fail('its quotes do not close')
      word += src.slice(i + 1, end)
      inWord = true
      quoted = true
      i = end + 1
      continue
    }
    if (c === '"') {
      let j = i + 1
      for (; j < src.length && src.charAt(j) !== '"'; j++) {
        const d = src.charAt(j)
        if (d === '\\' && '"\\$`\n'.includes(src.charAt(j + 1))) {
          word += src.charAt(j + 1)
          j++
          continue
        }
        if (d === '`' || (d === '$' && src.charAt(j + 1) === '(')) {
          const sub = substitution(src, j)
          if (sub === undefined) return fail('its command substitution does not close')
          const problem = sub.text === undefined ? undefined : nested(sub.text)
          if (problem !== undefined) return fail(problem)
          word += '…'
          j = sub.end - 1
          continue
        }
        word += d
      }
      if (j >= src.length) return fail('its quotes do not close')
      inWord = true
      quoted = true
      i = j + 1
      continue
    }
    if (c === '`' || (c === '$' && src.charAt(i + 1) === '(')) {
      const sub = substitution(src, i)
      if (sub === undefined) return fail('its command substitution does not close')
      const problem = sub.text === undefined ? undefined : nested(sub.text)
      if (problem !== undefined) return fail(problem)
      word += '…'
      inWord = true
      i = sub.end
      continue
    }
    if ((c === '<' || c === '>') && src.charAt(i + 1) === '(') {
      if (c === '>') return fail('it writes through a process substitution `>(…)`')
      const end = closingParen(src, i + 1)
      if (end < 0) return fail('its process substitution does not close')
      const problem = nested(src.slice(i + 2, end))
      if (problem !== undefined) return fail(problem)
      word += '…'
      inWord = true
      i = end + 1
      continue
    }
    if (c === ' ' || c === '\t') {
      endWord()
      i++
      continue
    }
    if (c === '#' && !inWord) {
      const eol = src.indexOf('\n', i)
      i = eol < 0 ? src.length : eol
      continue
    }
    if (c === '<' || c === '>' || (c === '&' && src.charAt(i + 1) === '>')) {
      if (inWord && !quoted && /^\d+$/.test(word)) {
        word = ''
        inWord = false
      } else endWord()
      const redirect = redirection(src, i)
      if (redirect.problem !== undefined) return fail(redirect.problem)
      if (redirect.body !== undefined) bodies.push(redirect.body)
      i = redirect.end
      continue
    }
    if (c === '\n' || c === ';' || c === '|' || c === '&' || c === '(' || c === ')') {
      endWord()
      endCommand()
      i++
      continue
    }
    word += c
    inWord = true
    i++
  }
  endWord()
  endCommand()
  return out
}

function substitution(src: string, start: number): { text?: string; end: number } | undefined {
  if (src.charAt(start) === '`') {
    const end = src.indexOf('`', start + 1)
    return end < 0 ? undefined : { text: src.slice(start + 1, end), end: end + 1 }
  }
  const end = closingParen(src, start + 1)
  if (end < 0) return undefined
  const inner = src.slice(start + 2, end)
  if (inner.startsWith('(') && inner.endsWith(')')) return /\$\(|`/.test(inner) ? { text: inner.slice(1, -1), end: end + 1 } : { end: end + 1 }
  return { text: inner, end: end + 1 }
}

function closingParen(src: string, open: number): number {
  let level = 0
  for (let i = open; i < src.length; i++) {
    const c = src.charAt(i)
    if (c === '\\') {
      i++
      continue
    }
    if (c === "'") {
      const end = src.indexOf("'", i + 1)
      if (end < 0) return -1
      i = end
      continue
    }
    if (c === '"') {
      let j = i + 1
      while (j < src.length && src.charAt(j) !== '"') j += src.charAt(j) === '\\' ? 2 : 1
      if (j >= src.length) return -1
      i = j
      continue
    }
    if (c === '(') level++
    else if (c === ')') {
      level--
      if (level === 0) return i
    }
  }
  return -1
}

function redirection(src: string, start: number): { end: number; problem?: string; body?: { word: string; quoted: boolean; tabs: boolean } } {
  const op = /^(?:&>>|&>|>>|>\||>&|<<<|<<-|<<|<&|<>|>|<)/.exec(src.slice(start))?.[0] ?? src.charAt(start)
  let i = start + op.length
  while (src.charAt(i) === ' ' || src.charAt(i) === '\t') i++
  const target = targetWord(src, i)
  if (target === undefined) return { end: i, problem: 'its redirection has no target it can check' }
  if (op === '<<' || op === '<<-') return { end: target.end, body: { word: target.word, quoted: target.quoted, tabs: op === '<<-' } }
  if (target.runs) return { end: target.end, problem: 'its redirection target runs a command' }
  if (op === '<' || op === '<<<' || op === '<&') return { end: target.end }
  if (op === '<>') return { end: target.end, problem: `it opens ${target.word} for writing` }
  if (op === '>&' && /^(?:\d+|-)$/.test(target.word)) return { end: target.end }
  if (target.word === '/dev/null') return { end: target.end }
  return { end: target.end, problem: `it writes ${target.word} (output redirection)` }
}

function skipBodies(src: string, start: number, bodies: ReadonlyArray<{ word: string; quoted: boolean; tabs: boolean }>): { end: number; problem?: string } {
  let i = start
  for (const body of bodies) {
    for (;;) {
      if (i >= src.length) return { end: src.length }
      const eol = src.indexOf('\n', i)
      const raw = src.slice(i, eol < 0 ? src.length : eol)
      i = eol < 0 ? src.length : eol + 1
      if ((body.tabs ? raw.replace(/^\t+/, '') : raw) === body.word) break
      if (!body.quoted && /\$\(|`/.test(raw)) return { end: i, problem: 'its here-document runs a command' }
    }
  }
  return { end: i }
}

function targetWord(src: string, start: number): { word: string; end: number; quoted: boolean; runs: boolean } | undefined {
  let i = start
  let word = ''
  let quoted = false
  let runs = false
  while (i < src.length) {
    const c = src.charAt(i)
    if (c === "'" || c === '"') {
      const end = src.indexOf(c, i + 1)
      if (end < 0) return undefined
      const inner = src.slice(i + 1, end)
      if (c === '"' && /\$\(|`/.test(inner)) runs = true
      word += inner
      quoted = true
      i = end + 1
      continue
    }
    if (c === '\\') {
      word += src.charAt(i + 1)
      i += 2
      continue
    }
    if (c === '`' || (c === '$' && src.charAt(i + 1) === '(')) runs = true
    if (/[\s;&|()<>]/.test(c)) break
    word += c
    i++
  }
  return word === '' && !quoted ? undefined : { word, end: i, quoted, runs }
}

const SAFE_VARIABLE = /^(?:LC_[A-Z]+|LANG|LANGUAGE|TZ|NO_COLOR|CLICOLOR|COLUMNS|LINES|TERM|[a-z][a-z0-9_]*)$/
const TIED_VARIABLES = new Set(['path', 'cdpath', 'fpath', 'manpath', 'mailpath', 'module_path'])

function variableProblem(name: string): string | undefined {
  if (SAFE_VARIABLE.test(name) && !TIED_VARIABLES.has(name)) return undefined
  return `setting ${name} can make git or another tool run a program (use a lower-case name for your own variables)`
}

function assignmentProblem(word: string): string | undefined {
  const name = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(word)?.[1]
  return name === undefined ? undefined : variableProblem(name)
}

function longOption(arg: string, name: string, min: number): boolean {
  const head = arg.split('=')[0] as string
  return head.length >= min && head.length <= name.length && name.startsWith(head)
}

const READONLY: Readonly<Record<string, (args: readonly string[]) => string | undefined>> = {
  cat: () => undefined, head: () => undefined, tail: () => undefined, wc: () => undefined, nl: () => undefined,
  cut: () => undefined, tr: () => undefined, column: () => undefined, fold: () => undefined, fmt: () => undefined,
  comm: () => undefined, cmp: () => undefined, diff: () => undefined, file: () => undefined, stat: () => undefined,
  ls: () => undefined, du: () => undefined, pwd: () => undefined, cd: () => undefined, pushd: () => undefined, popd: () => undefined,
  echo: () => undefined, printf: args => (args[0] === '-v' ? '`printf -v` sets a variable' : undefined), true: () => undefined, false: () => undefined, test: () => undefined, '[': () => undefined,
  basename: () => undefined, dirname: () => undefined, realpath: () => undefined, readlink: () => undefined, which: () => undefined,
  grep: () => undefined, egrep: () => undefined, fgrep: () => undefined, jq: () => undefined,
  rg: args => {
    const bad = args.find(a => /^--pre(?:=|$)/.test(a) || /^--hostname-bin(?:=|$)/.test(a))
    return bad !== undefined ? `\`rg ${bad.split('=')[0]}\` runs another program` : undefined
  },
  'ast-grep': args => astGrepProblem(args),
  sg: args => astGrepProblem(args),
  sort: args => {
    if (args.some(a => longOption(a, '--compress-program', 4))) return '`sort --compress-program` runs another program'
    return args.some(a => longOption(a, '--output', 3) || /^-[A-Za-z]*o/.test(a)) ? '`sort -o` writes a file' : undefined
  },
  uniq: args => (args.filter(a => !a.startsWith('-') && !/^\d+$/.test(a)).length > 1 ? '`uniq` with two file names writes the second' : undefined),
  tree: args => (args.some(a => a === '-o') ? '`tree -o` writes a file' : undefined),
  find: args => {
    const bad = args.find(a => ['-exec', '-execdir', '-ok', '-okdir', '-delete', '-fprint', '-fprint0', '-fprintf', '-fls'].includes(a))
    return bad !== undefined ? `\`find ${bad}\` runs commands or changes files` : undefined
  },
  xargs: args => {
    let i = 0
    while (i < args.length && (args[i] ?? '').startsWith('-')) i += /^-[nILPdsEa]$|^--(?:max-args|replace|max-lines|max-procs|delimiter|max-chars|eof|arg-file)$/.test(args[i] ?? '') ? 2 : 1
    return i < args.length ? commandProblem(args.slice(i)) : undefined
  },
  timeout: args => {
    let i = 0
    while (i < args.length && (args[i] ?? '').startsWith('-')) i += /^-[sk]$|^--(?:signal|kill-after)$/.test(args[i] ?? '') ? 2 : 1
    return i + 1 < args.length ? commandProblem(args.slice(i + 1)) : undefined
  },
  time: args => (args.length > 0 ? commandProblem(args[0] === '-p' ? args.slice(1) : args) : undefined),
  env: args => {
    let i = 0
    while (i < args.length && ((args[i] ?? '').startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(args[i] ?? ''))) {
      const problem = assignmentProblem(args[i] ?? '')
      if (problem !== undefined) return problem
      i += args[i] === '-u' || args[i] === '--unset' ? 2 : 1
    }
    return i < args.length ? commandProblem(args.slice(i)) : undefined
  },
  git: args => gitProblem(args),
  buracle: args => buracleProblem(args),
}

const GIT_READ = new Set([
  'status', 'diff', 'log', 'show', 'ls-files', 'ls-tree', 'blame', 'annotate', 'merge-base', 'rev-parse', 'rev-list',
  'describe', 'shortlog', 'grep', 'cat-file', 'name-rev', 'for-each-ref', 'show-ref', 'check-ignore', 'count-objects',
  'whatchanged', 'range-diff', 'cherry', 'show-branch', 'version', 'help',
])

const SHELL_LEAD = new Set(['if', 'then', 'elif', 'else', 'do', 'while', 'until'])
const SHELL_CLOSE = new Set(['fi', 'done'])

function commandProblem(argv: readonly string[]): string | undefined {
  let i = 0
  while (i < argv.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[i] ?? '') || SHELL_LEAD.has(argv[i] ?? ''))) {
    const problem = assignmentProblem(argv[i] ?? '')
    if (problem !== undefined) return problem
    i++
  }
  const program = argv[i]
  if (program === undefined) return undefined
  if (program === 'for' || program === 'select') {
    const variable = argv[i + 1]
    return variable !== undefined && /^[A-Za-z_][A-Za-z0-9_]*$/.test(variable) ? variableProblem(variable) : undefined
  }
  if (SHELL_CLOSE.has(program)) return commandProblem(argv.slice(i + 1))
  const name = program.slice(program.lastIndexOf('/') + 1)
  const rule = Object.prototype.hasOwnProperty.call(READONLY, name) ? READONLY[name] : undefined
  if (rule === undefined) return `\`${name === '' ? program : name}\` is not one of its read-only commands`
  return rule(argv.slice(i + 1))
}

function astGrepProblem(args: readonly string[]): string | undefined {
  const bad = args.find(a => a === '-U' || a === '--update-all' || a === '-i' || a === '--interactive')
  return bad !== undefined ? `\`ast-grep ${bad}\` rewrites files` : undefined
}

function gitProblem(args: readonly string[]): string | undefined {
  let i = 0
  while (i < args.length && (args[i] ?? '').startsWith('-')) {
    const a = args[i] ?? ''
    if (a === '-C' || a === '--git-dir' || a === '--work-tree') i += 2
    else if (/^--(?:git-dir|work-tree)=/.test(a) || ['--no-pager', '-P', '--no-optional-locks', '--literal-pathspecs', '--no-replace-objects'].includes(a)) i++
    else return `\`git ${a}\` can change what git runs`
  }
  const sub = args[i]
  if (sub === undefined) return undefined
  const rest = args.slice(i + 1)
  if (rest.some(a => /^--output(?:=|$)/.test(a) || /^-O/.test(a) || (sub === 'grep' && /^-[A-Za-z0-9]+O/.test(a)) || longOption(a, '--open-files-in-pager', 3))) return `\`git ${sub}\` with that option writes or runs a program`
  if (GIT_READ.has(sub)) return undefined
  const listing = (allowed: readonly string[], withValue: readonly string[] = []): boolean => {
    for (let k = 0; k < rest.length; k++) {
      const a = rest[k] ?? ''
      if (withValue.includes(a)) {
        k++
        continue
      }
      if (!allowed.some(x => a === x || a.startsWith(`${x}=`))) return false
    }
    return true
  }
  if (sub === 'branch' && listing(['--show-current', '--list', '-l', '-a', '--all', '-r', '--remotes', '-v', '-vv', '--verbose', '--contains', '--no-contains', '--merged', '--no-merged', '--sort', '--format', '--points-at', '--column', '--no-column', '--color', '--no-color'], ['--contains', '--no-contains', '--merged', '--no-merged', '--sort', '--format', '--points-at'])) return undefined
  if (sub === 'tag' && (rest.length === 0 || rest.includes('-l') || rest.includes('--list'))) return undefined
  if (sub === 'stash' && (rest[0] === 'list' || rest[0] === 'show')) return undefined
  if (sub === 'worktree' && rest[0] === 'list') return undefined
  if (sub === 'remote' && (rest.length === 0 || rest[0] === '-v' || rest[0] === 'show' || rest[0] === 'get-url')) return undefined
  if (sub === 'config' && rest.some(a => ['--get', '--get-all', '--get-regexp', '--list', '-l', 'get', 'list'].includes(a)) && !rest.some(a => ['--add', '--unset', '--unset-all', '--replace-all', '--rename-section', '--remove-section', '-e', '--edit', 'set', 'unset'].includes(a))) return undefined
  return `\`git ${sub}\` can change the repository`
}

const BURACLE_READ: Readonly<Record<string, readonly string[] | true>> = {
  'review-scope': true, version: true, help: true,
  plan: ['status', 'validate'], worktree: ['detect', 'status', 'diff'], mem: ['search', 'get', 'status', 'context'],
  config: ['get', 'path'], skills: ['lint'], rules: ['lint'],
}

function buracleProblem(args: readonly string[]): string | undefined {
  const words = args.filter(a => !a.startsWith('-'))
  const command = words[0]
  if (command === undefined) return undefined
  const allowed = Object.prototype.hasOwnProperty.call(BURACLE_READ, command) ? BURACLE_READ[command] : undefined
  if (allowed === true || (allowed !== undefined && allowed.includes(words[1] ?? ''))) return undefined
  return `\`buracle ${[command, words[1]].filter(w => w !== undefined).join(' ')}\` is not one of its read-only commands`
}
