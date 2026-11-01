export interface CommandSpec {
  subs: readonly string[] | null | 'any'
  nested?: Readonly<Record<string, readonly string[]>>
  ops?: boolean
}

export const SKILL_COMMANDS: Readonly<Record<string, CommandSpec>> = {
  plan: {
    subs: ['init', 'capture', 'validate', 'register', 'prepare-native', 'status', 'set', 'pause', 'resume', 'complete', 'approve-result', 'verify', 'review', 'unregister', 'audit', 'notes'],
    nested: { set: ['status', 'phase', 'approved', 'iterations', 'rounds', 'worktree'], review: ['start', 'done', 'status', 'companion'] },
  },
  worktree: { subs: ['create', 'branch', 'detect', 'diff', 'sync', 'cleanup', 'status'] },
  'review-scope': { subs: null },
  notify: { subs: ['info', 'plan_approval', 'prd_approval', 'attention_needed', 'verification_complete', 'list', 'read'] },
  project: { subs: ['init', 'sync', 'check'] },
  skills: { subs: ['lint', 'list', 'new', 'find', 'add', 'remove', 'update'] },
  rules: { subs: ['lint'] },
  diagram: { subs: null },
  mem: { subs: ['search', 'get', 'write', 'update', 'remember', 'status', 'context', 'capture', 'finalize', 'import-vault', 'doctor', 'ui', 'backup', 'restore', 'export', 'import'] },
  usage: { subs: null },
  flow: { subs: ['start', 'phase', 'step', 'end', 'status'] },
  index: { subs: ['ensure', 'status'] },
  config: { subs: ['get'] },
  doctor: { subs: 'any', ops: true },
  update: { subs: ['self', 'skills', 'mcp', 'plugins', 'harness', 'tools', 'pricing'], ops: true },
  install: { subs: ['claude', 'codex', 'opencode', 'omp'], ops: true },
  build: { subs: null, ops: true },
  rollback: { subs: 'any', ops: true },
}

export interface MentionProblem { command: string, message: string }

function isPlaceholderToken(t: string): boolean {
  return /^[<[{(]/.test(t) || t === '…' || t === '...' || /^["'`]/.test(t) || t.startsWith('$')
}

function alternatives(t: string): string[] {
  return t.replace(/\\\|/g, '|').split('|').map(x => x.trim()).filter(x => x !== '')
}

const END_TOKENS = new Set(['|', '||', '&&', ';', '#', '>', '>>', '2>&1', '&'])

export function checkMention(tokens: readonly string[]): MentionProblem[] {
  const words: string[] = []
  for (const raw of tokens) {
    const t = raw.replace(/[`),.;:]+$/, '')
    if (END_TOKENS.has(raw) || END_TOKENS.has(t) || t.startsWith('#')) break
    if (t === '') continue
    words.push(t)
  }
  const cmdTok = words[0]
  if (cmdTok === undefined || cmdTok.startsWith('-') || isPlaceholderToken(cmdTok)) return []
  const problems: MentionProblem[] = []
  for (const cmd of alternatives(cmdTok)) {
    const spec = SKILL_COMMANDS[cmd]
    if (spec === undefined) {
      problems.push({ command: cmd, message: `'buracle ${cmd}' is not a documented helper command (CONTRACTS §10.1)` })
      continue
    }
    let sub: string | undefined
    let subAt = -1
    for (let i = 1; i < words.length; i++) {
      const w = words[i] as string
      if (w.startsWith('-')) { if (!w.includes('=') && i + 1 < words.length && !(words[i + 1] as string).startsWith('-')) i++; continue }
      sub = w
      subAt = i
      break
    }
    if (sub === undefined || isPlaceholderToken(sub) || spec.subs === 'any') continue
    if (spec.subs === null) {
      problems.push({ command: cmd, message: `'buracle ${cmd}' takes no subcommand (found '${sub}')` })
      continue
    }
    for (const alt of alternatives(sub)) {
      if (!spec.subs.includes(alt)) {
        problems.push({ command: cmd, message: `'buracle ${cmd} ${alt}' is not a documented subcommand (allowed: ${spec.subs.join(', ')})` })
        continue
      }
      const nested = spec.nested?.[alt]
      const next = words[subAt + 1]
      if (nested === undefined || next === undefined || next.startsWith('-') || isPlaceholderToken(next)) continue
      for (const n of alternatives(next)) {
        if (!nested.includes(n)) problems.push({ command: cmd, message: `'buracle ${cmd} ${alt} ${n}' is not documented (allowed: ${nested.join(', ')})` })
      }
    }
  }
  return problems
}

export function findMentions(code: string): Array<{ index: number, tokens: string[] }> {
  const out: Array<{ index: number, tokens: string[] }> = []
  const re = /(^|[\s(`"'$=;&|])buracle[ \t]+/g
  let m: RegExpExecArray | null
  while ((m = re.exec(code)) !== null) {
    const start = m.index + (m[1] ?? '').length
    const after = code.slice(m.index + m[0].length)
    const stop = after.search(/[`\n]|\s(?:\||&&|;|#)\s|\s>{1,2}\s/)
    const segment = stop >= 0 ? after.slice(0, stop) : after
    out.push({ index: start, tokens: segment.split(/[ \t]+/).filter(t => t !== '') })
  }
  return out
}
