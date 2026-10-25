import type { On, SessionMeasureInput, SessionStartInput } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

const HOME = '/home/tester'
const BURACLE_HOME = `${HOME}/.buracle`
const VAULT = `${HOME}/Documents/Buracle`
const CWD = `${HOME}/work/app`
const SID = 'sess-0001'
const SHIM = `${BURACLE_HOME}/bin/buracle`
const BUN = `${HOME}/.bun/bin/bun`
const REPO_ROOT = `${HOME}/src/buracle`
const NOW = Date.UTC(2026, 9, 8, 12, 0, 0)
const RUNTIME = `${BURACLE_HOME}/state/runtime-config.json`
const STATE = `${BURACLE_HOME}/sessions/claude/${SID}/state.json`
const CONSENT = `${BURACLE_HOME}/sessions/claude/${SID}/consent.json`
const AWS_KEY = 'AKIA' + 'IOSFODNN7EXAMPLE'

const SESSION: SessionStartInput = { cwd: CWD, surface: 'terminal', isInteractive: true }
const HEADLESS: SessionStartInput = { cwd: CWD, surface: null, isInteractive: false }

interface WorldOptions {
  refuse?: string[]
  answer?: string
  results?: Record<string, unknown>
  config?: Record<string, unknown>
  onAsk?: (world: World) => void
  shell?: boolean
  shim?: string
  env?: Record<string, string>
}

interface World {
  files: Map<string, string>
  runs: string[][]
  toasts: string[]
  notices: string[]
  logs: string[]
  commands: string[]
  asked: Array<{ question: string, options: string[] }>
  reached: string[]
  compacted: Array<string | undefined>
  trail: string[]
  json: (path: string) => unknown
}

function worldOf(on: On, files: Record<string, string> = {}, options: WorldOptions = {}): World {
  mock.clock(on, { now: NOW })
  const world: World = {
    files: new Map(Object.entries({
      [RUNTIME]: JSON.stringify({ v: 1, config: options.config ?? {}, resolved: { buracleHome: BURACLE_HOME, vault: VAULT, shim: options.shim ?? SHIM, bun: BUN, repoRoot: REPO_ROOT } }),
      ...files,
    })),
    runs: [], toasts: [], notices: [], logs: [], commands: [], asked: [], reached: [], compacted: [], trail: [],
    json: path => JSON.parse(world.files.get(path) ?? 'null') as unknown,
  }
  const done = (stdout = '', exitCode = 0) => ({ exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })
  const env = options.env ?? { HOME }
  on('env.get', ($, e) => ({ value: env[e.name] }))
  on('fs.read', ($, e) => {
    const text = world.files.get(e.path)
    return text === undefined ? { deny: `ENOENT: ${e.path}` } : { value: text }
  })
  on('fs.write', ($, e) => { world.trail.push(`write ${e.path}`); world.files.set(e.path, e.text); return { value: undefined } })
  on('fs.exists', ($, e) => ({ value: world.files.has(e.path) }))
  on('fs.stat', ($, e) => {
    const text = world.files.get(e.path)
    return text === undefined ? { deny: `ENOENT: ${e.path}` } : { value: { kind: 'file' as const, size: text.length, mtimeMs: 1, isLink: false } }
  })
  on('process.run', ($, e) => {
    world.runs.push([...e.argv])
    if (e.argv[0] === SHIM && e.argv[1] === 'mem' && e.argv[2] === 'ui') return { value: done(e.argv.includes('review') ? '{"url":"http://localhost:41777","page":"http://localhost:41777/review"}' : '{"url":"http://localhost:41777"}') }
    if (e.argv[0] === SHIM) return { value: done('saved as a capture: capture-no-verify-is-forbidden-here (the next harness files it)\n') }
    const script = e.argv[0] === BUN && e.argv[1] === '-e' ? e.argv[2] ?? '' : ''
    if (options.shell === true && script.includes("flag: 'wx'") && e.argv.length === 5) {
      const lock = e.argv[4] ?? ''
      world.trail.push(`take ${lock}`)
      if (world.files.has(lock)) return { value: done('', 1) }
      world.files.set(lock, e.argv[3] ?? '')
      return { value: done() }
    }
    if (options.shell === true && script.includes('rmSync') && e.argv.length === 4) {
      world.trail.push(`drop ${e.argv[3] ?? ''}`)
      world.files.delete(e.argv[3] ?? '')
      return { value: done() }
    }
    return { value: done('', 127) }
  })
  on('session.id', () => ({ value: SID }))
  on('session.cwd', () => ({ value: CWD }))
  on('command.register', ($, e) => {
    if (options.refuse?.includes(e.name) === true) return { deny: `/${e.name} is taken` }
    world.commands.push(e.name)
    return { value: { command: e.name } }
  })
  on('ui.toast', ($, e) => { world.toasts.push(e.text); return { value: undefined } })
  on('ui.notice', ($, e) => { world.notices.push(e.text ?? ''); return { value: undefined } })
  on('ui.log', ($, e) => { world.logs.push(e.text); return { value: undefined } })
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('ui.close', () => ({ value: undefined }))
  on('prompt.suggest', () => ({ isShown: true }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.measure', ($, e) => ({ changed: [...e.changed] }))
  on('session.compact', ($, e) => {
    world.compacted.push(e.instructions)
    return { messages: [{ role: 'user' as const, text: 'Summary.', toolUses: [] }] }
  })
  on('tool.describe', ($, e) => ({ description: e.description, isDeferred: true }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('tool.call', ($, e) => {
    if (e.tool === 'AskUserQuestion') {
      const q = (e as unknown as { questions: Array<{ question: string, options: Array<{ label: string }> }> }).questions[0]
      world.asked.push({ question: q?.question ?? '', options: (q?.options ?? []).map(o => o.label) })
      options.onAsk?.(world)
      return { result: { questions: [], answers: { [q?.question ?? '']: options.answer ?? 'Refuse' } } as never }
    }
    world.reached.push(e.tool)
    return { result: (options.results?.[e.tool] ?? { stdout: 'ok', stderr: '', interrupted: false }) as never }
  })
  return world
}

function command(name: string, args = '') {
  return { command: name, args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: true, columns: 120 } }
}

function measure(pct: number): SessionMeasureInput {
  return { context: { tokens: pct * 2_000, window: 200_000, percent: pct }, rateLimits: [], changed: ['context'] }
}

function denyOf(result: unknown): string | undefined {
  const r = result as { deny?: string; isError?: boolean; text?: string }
  return r.deny ?? (r.isError === true ? r.text : undefined)
}

describe('commands', () => {
  test('the start registers the commands; /buracle-ping answers pong', async ($, on) => {
    const world = worldOf(on)
    await $.session.start(SESSION)
    expect(world.commands).toEqual(['buracle-ping', 'buracle-status', 'buracle', 'remember', 'brain', 'aside'])
    expect(await $.command.run(command('buracle-ping'))).toEqual({ text: 'pong' })
  })

  test('/buracle is the short name of /buracle-status', async ($, on) => {
    worldOf(on)
    await $.session.start(SESSION)
    expect(await $.command.run(command('buracle', 'nonsense'))).toEqual(await $.command.run(command('buracle-status', 'nonsense')))
    expect((await $.command.run(command('buracle', 'flow'))).text).toBe('No workflow is running.')
  })

  test('a refused /buracle leaves /buracle-status as the status command', async ($, on) => {
    const world = worldOf(on, {}, { refuse: ['buracle'] })
    await $.session.start(SESSION)
    expect(world.commands).toEqual(['buracle-ping', 'buracle-status', 'remember', 'brain', 'aside'])
  })

  test('a taken name leaves the mod with its buracle- name', async ($, on) => {
    const world = worldOf(on, {}, { refuse: ['remember', 'brain'] })
    await $.session.start(SESSION)
    expect(world.commands).toEqual(['buracle-ping', 'buracle-status', 'buracle', 'buracle-remember', 'buracle-brain', 'aside'])
    expect((await $.command.run(command('buracle-brain'))).text ?? '').toContain('http://localhost:41777')
  })

  test('/remember saves a capture through the buracle CLI, the text after --', async ($, on) => {
    const world = worldOf(on, { [SHIM]: '#!/bin/sh\n' })
    await $.session.start(SESSION)
    const answer = await $.command.run(command('remember', '--no-verify is forbidden here'))
    expect(answer.text).toBe('Remembered: capture-no-verify-is-forbidden-here')
    expect(world.runs).toContainEqual([SHIM, 'mem', 'remember', '--', '--no-verify is forbidden here'])
    expect((await $.command.run(command('remember', '  '))).text).toBe('Usage: /remember <text>')
  })

  test('/brain starts and opens the memory web UI', async ($, on) => {
    const world = worldOf(on, { [SHIM]: '#!/bin/sh\n' })
    await $.session.start(SESSION)
    const answer = await $.command.run(command('brain'))
    expect(answer.text).toBe('Memory UI: http://localhost:41777')
    expect(world.runs).toContainEqual([SHIM, 'mem', 'ui', '--open', '--json'])
    expect((await $.command.run(command('brain', 'review'))).text).toBe('Review page: http://localhost:41777/review')
    expect(world.runs).toContainEqual([SHIM, 'mem', 'ui', '--open', '--page', 'review', '--json'])
    expect((await $.command.run(command('brain', 'graph'))).text).toBe('Usage: /brain [review]')
  })

  test('/buracle-status reports the session, the permission mode and the commands, in English', async ($, on) => {
    worldOf(on)
    await $.session.start(SESSION)
    const text = (await $.command.run(command('buracle-status'))).text ?? ''
    expect(text).toContain(`session: ${SID} · interactive`)
    expect(text).toContain('permissions: bypass')
    expect(text).toContain('workflow band: on')
    expect(text).toContain('/brain')
    expect(/[çğıöşüÇĞİÖŞÜ]/.test(text)).toBe(false)
    // Nothing started the web UI and its record is absent: neither view names an address that leads nowhere.
    expect(text).not.toContain('memory UI:')
    expect((await $.command.run(command('buracle-status', 'memory'))).text ?? '').not.toContain('web UI:')
    expect((await $.command.run(command('buracle-status', 'nonsense'))).text).toBe('Usage: /buracle-status [status|memory|plan|flow]')
    expect((await $.command.run(command('buracle-status', 'flow'))).text).toBe('No workflow is running.')
  })
})

describe('critical MCP tools', () => {
  test('stay out of the deferred set', async ($, on) => {
    worldOf(on)
    await $.session.start(SESSION)
    const d = await $.tool.describe({ tool: 'mcp__plugin_buracle_context7__query-docs', description: 'docs', isDeferred: true } as never)
    expect((d as { isDeferred?: boolean }).isDeferred).toBe(false)
  })
})

describe('H20 consent dialog', () => {
  test('allowing once records a single-use grant for the command hook and lets the call through', async ($, on) => {
    const world = worldOf(on, {}, { answer: 'Allow once' })
    await $.session.start(SESSION)
    const ran = await $.tool.call({ tool: 'Bash', command: 'git push origin feature' })
    expect(denyOf(ran)).toBeUndefined()
    expect(world.asked[0]?.question).toBe('Buracle consent: `git push origin feature` pushes to a remote. Run it?')
    expect(world.asked[0]?.options).toEqual(['Allow once', 'Allow for this session', 'Refuse'])
    expect(world.reached).toEqual(['Bash'])
    const consent = world.json(CONSENT) as { grants: Array<{ kind: string, uses: number }> }
    expect(consent.grants).toEqual([expect.objectContaining({ kind: 'push', uses: 1 })])
  })

  test('refusing denies the call before it runs', async ($, on) => {
    const world = worldOf(on, {}, { answer: 'Refuse' })
    await $.session.start(SESSION)
    const ran = await $.tool.call({ tool: 'Bash', command: 'git reset --hard HEAD~3' })
    expect(denyOf(ran) ?? '').toContain('the user refused')
    expect(world.reached).toEqual([])
  })

  test('commands that need no consent, and headless sessions, are never asked about', async ($, on) => {
    const world = worldOf(on)
    await $.session.start(HEADLESS)
    await $.tool.call({ tool: 'Bash', command: 'git push' })
    await $.tool.call({ tool: 'Bash', command: 'ls -la' })
    expect(world.asked).toEqual([])
    expect(world.reached).toEqual(['Bash', 'Bash'])
  })

  test('the dialog keeps what the command hooks recorded while it was open (it reads the file again before writing)', async ($, on) => {
    const world = worldOf(on, {}, {
      answer: 'Allow once',
      onAsk: w => w.files.set(CONSENT, JSON.stringify({ v: 1, grants: [{ kind: 'history-rewrite', until: NOW + 60_000, uses: 1, source: 'prompt' }], pending: { kind: 'publish', summary: 's', command: 'npm publish', at: NOW } })),
    })
    await $.session.start(SESSION)
    expect(denyOf(await $.tool.call({ tool: 'Bash', command: 'git push origin feature' }))).toBeUndefined()
    const consent = world.json(CONSENT) as { grants: Array<{ kind: string, uses: number }>, pending?: { kind: string } }
    expect(consent.grants).toEqual([expect.objectContaining({ kind: 'history-rewrite', uses: 1 }), expect.objectContaining({ kind: 'push', uses: 1 })])
    expect(consent.pending?.kind).toBe('publish')
  })

  test('the dialog writes under the command hooks\' lock file and lets it go', async ($, on) => {
    const world = worldOf(on, {}, { answer: 'Allow once', shell: true })
    await $.session.start(SESSION)
    expect(denyOf(await $.tool.call({ tool: 'Bash', command: 'git push origin feature' }))).toBeUndefined()
    expect(world.trail).toEqual([`take ${CONSENT}.lock`, `write ${CONSENT}`, `drop ${CONSENT}.lock`])
    expect(world.files.has(`${CONSENT}.lock`)).toBe(false)
    expect((world.json(CONSENT) as { grants: Array<{ kind: string }> }).grants).toEqual([expect.objectContaining({ kind: 'push' })])
    expect(world.runs.some(r => r[0] === '/bin/sh' || r[0] === '/bin/rm')).toBe(false)
  })

  test('the PowerShell tool gets the same consent dialog as Bash', async ($, on) => {
    const world = worldOf(on, {}, { answer: 'Refuse' })
    await $.session.start(SESSION)
    const r = await $.tool.call({ tool: 'PowerShell', command: 'git push origin feature' } as never)
    expect(denyOf(r) ?? '').toContain('the user refused')
    expect(world.asked.map(a => a.question)).toEqual(['Buracle consent: `git push origin feature` pushes to a remote. Run it?'])
    expect(world.reached).toEqual([])
  })

  test('without HOME (Windows) the runtime comes from USERPROFILE; the .cmd shim runs through the plugin\'s bun launcher', async ($, on) => {
    const cmd = `${BURACLE_HOME}/bin/buracle.cmd`
    const world = worldOf(on, { [cmd]: '@echo off\r\n' }, { env: { USERPROFILE: HOME }, shim: cmd, answer: 'Allow once', shell: true })
    await $.session.start(SESSION)
    expect(denyOf(await $.tool.call({ tool: 'Bash', command: 'git push origin feature' }))).toBeUndefined()
    expect(world.trail).toEqual([`take ${CONSENT}.lock`, `write ${CONSENT}`, `drop ${CONSENT}.lock`])
    await $.command.run(command('remember', 'a note'))
    const remember = world.runs.find(r => r.includes('remember'))
    expect(remember?.[0]).toBe(BUN)
    expect(remember?.[1]).toBe(`${REPO_ROOT}/harness/claude/bin/buracle.ts`)
    expect(remember?.slice(2)).toEqual(['mem', 'remember', '--', 'a note'])
  })

  test('a lock a command hook keeps: the dialog tries a while, then writes without it and leaves the hook\'s lock alone', async ($, on) => {
    const world = worldOf(on, { [`${CONSENT}.lock`]: '{"pid":1}' }, { answer: 'Allow once', shell: true })
    await $.session.start(SESSION)
    expect(denyOf(await $.tool.call({ tool: 'Bash', command: 'git push origin feature' }))).toBeUndefined()
    expect(world.trail.filter(t => t.startsWith('take ')).length).toBeGreaterThan(1)
    expect(world.trail.filter(t => t.startsWith('drop '))).toEqual([])
    expect(world.trail.at(-1)).toBe(`write ${CONSENT}`)
    expect(world.files.get(`${CONSENT}.lock`)).toBe('{"pid":1}')
  })
})

describe('masking secrets in tool output', () => {
  test('a key in what Read returns is masked, with a notice on the row', async ($, on) => {
    const world = worldOf(on, {}, { results: { Read: { type: 'text', file: { filePath: `${CWD}/.env.local`, content: `AWS_ACCESS_KEY_ID=${AWS_KEY}\n`, numLines: 1, startLine: 1, totalLines: 1 } } } })
    await $.session.start(SESSION)
    const ran = await $.tool.call({ tool: 'Read', file_path: `${CWD}/.env.local` } as never)
    expect(JSON.stringify((ran as { result?: unknown }).result)).not.toContain(AWS_KEY)
    expect(world.notices).toEqual(['Buracle: 1 secret value hidden from the model'])
  })

  test('guards.redact: false leaves the output alone', async ($, on) => {
    worldOf(on, {}, { config: { guards: { redact: false } }, results: { Read: { type: 'text', file: { filePath: 'a', content: AWS_KEY, numLines: 1, startLine: 1, totalLines: 1 } } } })
    await $.session.start(SESSION)
    const ran = await $.tool.call({ tool: 'Read', file_path: 'a' } as never)
    expect(JSON.stringify((ran as { result?: unknown }).result)).toContain(AWS_KEY)
  })

  test('a runtime-config of another version is not read as this one: the defaults apply, so the output is still masked', async ($, on) => {
    const other = JSON.stringify({ v: 2, config: { guards: { redact: false } }, resolved: { buracleHome: BURACLE_HOME, vault: VAULT, shim: SHIM } })
    worldOf(on, { [RUNTIME]: other }, { results: { Read: { type: 'text', file: { filePath: 'a', content: AWS_KEY, numLines: 1, startLine: 1, totalLines: 1 } } } })
    await $.session.start(SESSION)
    const ran = await $.tool.call({ tool: 'Read', file_path: 'a' } as never)
    expect(JSON.stringify((ran as { result?: unknown }).result)).not.toContain(AWS_KEY)
  })
})

describe('turn receipt and loop alarms', () => {
  test('a code edit with no check after it ends the turn with an unverified toast', async ($, on) => {
    const world = worldOf(on)
    await $.session.start(SESSION)
    await $.tool.call({ tool: 'Edit', file_path: `${CWD}/src/a.ts`, old_string: 'a', new_string: 'b' } as never)
    await $.turn.complete({ answer: 'Fixed it.', durationMs: 1000, turnId: 't1', reason: 'answer' } as never)
    expect(world.toasts).toEqual(['Buracle · 1 file (+1 −1) · ⚠ success claimed without evidence: no test or check ran after the change'])
  })

  test('a passing check after the edit leaves no toast', async ($, on) => {
    const world = worldOf(on)
    await $.session.start(SESSION)
    await $.tool.call({ tool: 'Edit', file_path: `${CWD}/src/a.ts`, old_string: 'a', new_string: 'b' } as never)
    await $.tool.call({ tool: 'Bash', command: 'bun test' })
    await $.turn.complete({ answer: 'Done, tests pass.', durationMs: 1000, turnId: 't1', reason: 'answer' } as never)
    expect(world.toasts).toEqual([])
  })

  test('the same failing command three times in a row raises a loop alarm', async ($, on) => {
    const world = worldOf(on, {}, { results: { Bash: { stdout: '', stderr: 'boom', interrupted: false, exitCode: 1 } } })
    await $.session.start(SESSION)
    for (let i = 0; i < 3; i++) await $.tool.call({ tool: 'Bash', command: 'bun test' })
    expect(world.toasts).toEqual(['Buracle: the same command failed 3 times in a row: `bun test` (do not run it again as is; read the output and change your hypothesis)'])
  })
})

describe('context and compaction', () => {
  test('one toast per context threshold', async ($, on) => {
    const world = worldOf(on)
    await $.session.start(SESSION)
    await $.session.measure(measure(86))
    await $.session.measure(measure(88))
    await $.session.measure(measure(96))
    expect(world.toasts).toEqual([
      'Context 86% full. Run /compact at a good moment.',
      'Context 96% full (critical). Auto-compaction is near; run /compact now.',
    ])
  })

  test('the compaction instructions keep the registered plan, the work so far and the touched files', async ($, on) => {
    const plan = { v: 1, plan: { path: `${CWD}/docs/plans/p.md`, slug: 'login', status: 'IN_PROGRESS', type: 'Feature', phase: 'implement', registeredAt: NOW - 60_000 }, guard: { blocksForPlan: 0, blocksInChain: 0 } }
    const world = worldOf(on, { [STATE]: JSON.stringify(plan) })
    await $.session.start(SESSION)
    await $.tool.call({ tool: 'Edit', file_path: `${CWD}/src/login.ts`, old_string: 'a', new_string: 'b' } as never)
    await $.session.compact({ trigger: 'manual', instructions: undefined, messages: [{ role: 'user', text: 'work so far', toolUses: [] }] } as never)
    const text = world.compacted[0] ?? ''
    expect(text).toContain('docs/plans/p.md')
    expect(text).toContain('- Running workflow: plan-build: phase Implement')
    expect(text).toContain('tried and rejected')
    expect(text).toContain(`Files changed so far (keep these paths and what changed in each): ${CWD}/src/login.ts.`)
  })
})
