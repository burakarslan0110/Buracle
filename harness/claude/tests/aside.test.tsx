import type { On, SessionStartInput } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

const HOME = '/home/tester'
const BURACLE_HOME = `${HOME}/.buracle`
const CWD = `${HOME}/work/app`
const SID = 'sess-aside'
const RUNTIME = `${BURACLE_HOME}/state/runtime-config.json`
const SESSION: SessionStartInput = { cwd: CWD, surface: 'terminal', isInteractive: true }
const USAGE = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

interface Fork { isAnswered: boolean, text?: string, reason?: string }

interface World {
  commands: string[]
  logs: string[]
  forks: string[]
  trail: string[]
}

function worldOf(on: On, options: { refuse?: string[], fork?: Fork } = {}): World {
  mock.clock(on, { now: Date.UTC(2026, 9, 12, 12, 0, 0) })
  const files = new Map<string, string>([
    [RUNTIME, JSON.stringify({ v: 1, config: {}, resolved: { buracleHome: BURACLE_HOME, vault: `${HOME}/Documents/Buracle`, shim: `${BURACLE_HOME}/bin/buracle` } })],
  ])
  const world: World = { commands: [], logs: [], forks: [], trail: [] }
  on('env.get', ($, e) => ({ value: e.name === 'HOME' ? HOME : undefined }))
  on('fs.read', ($, e) => {
    const text = files.get(e.path)
    return text === undefined ? { deny: `ENOENT: ${e.path}` } : { value: text }
  })
  on('fs.write', ($, e) => { world.trail.push(`write ${e.path}`); files.set(e.path, e.text); return { value: undefined } })
  on('fs.exists', ($, e) => ({ value: files.has(e.path) }))
  on('fs.stat', ($, e) => {
    const text = files.get(e.path)
    return text === undefined ? { deny: `ENOENT: ${e.path}` } : { value: { kind: 'file' as const, size: text.length, mtimeMs: 1, isLink: false } }
  })
  on('process.run', ($, e) => {
    world.trail.push(`run ${e.argv.join(' ')}`)
    return { value: { exitCode: 127, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('session.id', () => ({ value: SID }))
  on('session.cwd', () => ({ value: CWD }))
  on('command.register', ($, e) => {
    if (options.refuse?.includes(e.name) === true) return { deny: `/${e.name} is taken` }
    world.commands.push(e.name)
    return { value: { command: e.name } }
  })
  on('model.fork', ($, e) => {
    world.forks.push(e.prompt)
    return { value: (options.fork ?? { isAnswered: true, text: 'The parser runs first.', usage: USAGE }) as never }
  })
  on('ui.log', ($, e) => { world.logs.push(e.text); return { value: undefined } })
  on('ui.toast', () => ({ value: undefined }))
  on('ui.notice', () => ({ value: undefined }))
  on('prompt.suggest', () => ({ isShown: true }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  return world
}

function command(name: string, args = '') {
  return { command: name, args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: true, columns: 120 } }
}

describe('/aside', () => {
  test('asks one side question over the conversation and shows the answer, leaving the session untouched', async ($, on) => {
    const world = worldOf(on)
    await $.session.start(SESSION)
    expect(world.commands).toContain('aside')
    const before = world.trail.length
    const answer = await $.command.run(command('aside', 'which module runs first?'))
    expect(world.forks).toHaveLength(1)
    expect(world.forks[0]).toContain('which module runs first?')
    expect(world.forks[0]).toContain('without changing anything')
    expect(world.logs).toContain('aside: The parser runs first.')
    expect(answer.text ?? '').toBe('')
    expect(world.trail.slice(before)).toEqual([])
  })

  test('without a question it shows the usage and asks nothing', async ($, on) => {
    const world = worldOf(on)
    await $.session.start(SESSION)
    await $.command.run(command('aside', '   '))
    expect(world.logs).toContain('Usage: /aside <question>')
    expect(world.forks).toEqual([])
  })

  test('a fork that gets no answer says why', async ($, on) => {
    const world = worldOf(on, { fork: { isAnswered: false, reason: 'nothing-to-fork' } })
    await $.session.start(SESSION)
    await $.command.run(command('aside', 'what did we change?'))
    expect(world.logs).toContain('aside: no answer (nothing-to-fork)')
  })

  test('a taken name leaves the mod with /buracle-aside, which works the same', async ($, on) => {
    const world = worldOf(on, { refuse: ['aside'] })
    await $.session.start(SESSION)
    expect(world.commands).toContain('buracle-aside')
    expect(world.commands).not.toContain('aside')
    await $.command.run(command('buracle-aside', 'is the cache warm?'))
    expect(world.forks).toHaveLength(1)
    expect(world.logs).toContain('aside: The parser runs first.')
  })
})
