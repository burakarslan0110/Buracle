import { beforeEach, describe, expect, test } from 'bun:test'
import { BuracleRuntime, REGISTRY_KEY, type PluginDeps } from '../../../src/adapters/opencode/runtime/plugin'
import { clearRepoCache } from '../../../src/adapters/opencode/runtime/adapter-rules'
import { answerAsk, openAsks, postAsk, readAnswer, tuiPresent, writeTuiBeat, TUI_FRESH_MS } from '../../../src/adapters/opencode/runtime/consent-relay'
import { consentRelayTick, type ConsentRelayHost } from '../../../src/adapters/opencode/runtime/tui-consent'
import type { PermissionEvaluation } from '../../../src/adapters/opencode/runtime/types'
import { clearPreparedWorkspaces } from '../../../src/adapters/opencode/runtime/workspace'
import { readConsentState } from '../../../src/adapters/shared/consent-store'
import type { WorkspaceInfo } from '../../../src/core/workspace'
import { withSandbox } from '../../helpers/sandbox'
import { fakeMemory, fakeServerContext, testBaked } from './helpers'

const SID = 'ses_consent1'

beforeEach(() => {
  delete (globalThis as unknown as Record<symbol, unknown>)[REGISTRY_KEY]
  clearRepoCache()
  clearPreparedWorkspaces()
})

function noProject(cwd: string): WorkspaceInfo {
  return { cwd, children: [], index: { codegraph: { state: 'off' }, semble: { state: 'off' } } }
}

async function runtime(dir: string) {
  const f = fakeServerContext(dir)
  const deps: PluginDeps = {
    baked: testBaked(), memory: fakeMemory(), settleMs: 0, runChecker: async () => ({ code: 0, stdout: '', stderr: '' }),
    capture: () => true, maint: () => ({ removed: [] }), notify: () => undefined,
    workspace: async cwd => noProject(cwd), workspaceRead: async cwd => noProject(cwd),
    consentAsk: { pollMs: 10, timeoutMs: 5_000 },
  }
  const rt = new BuracleRuntime(f.ctx, deps)
  await rt.register()
  await rt.handleEvent({ type: 'session.created', data: { sessionID: SID, location: { directory: dir } } })
  return { f, rt }
}

const shell = (command: string): PermissionEvaluation => ({ sessionID: SID, action: 'shell', resources: [command], effect: 'allow' })

async function answerWhenAsked(answer: 'once' | 'session' | 'refuse' | 'dismiss', seen: string[] = []): Promise<void> {
  for (let i = 0; i < 300; i++) {
    const ask = openAsks(SID)[0]
    if (ask !== undefined) { seen.push(ask.question); answerAsk(SID, ask.id, answer, Date.now()); return }
    await Bun.sleep(5)
  }
  throw new Error('no consent question was posted')
}

describe('OpenCode H20 consent dialog: the server waits while the TUI asks', () => {
  test('without a live TUI the held command is denied at once with what to ask, and how to ask with the question tool', () => withSandbox(async ({ root }) => {
    const { f } = await runtime(root)
    const held = await f.trigger('permission.evaluate', shell('git push origin main'))
    expect(held.effect).toBe('deny')
    expect(held.message).toStartWith('[Buracle H20 consent.gate] ')
    expect(held.message).toContain('call the `question` tool with one question whose text is exactly "Buracle consent: `git push origin main` pushes to a remote. Run it?" and the options "Allow once", "Allow for this session", "Refuse"')
    expect(openAsks(SID)).toEqual([])
  }))

  test('without a TUI (web, desktop), the question tool asks: an allow for Buracle\'s question and options records the grant; anything else records none', () => withSandbox(async ({ root }) => {
    const { f } = await runtime(root)
    const text = 'Buracle consent: `git push origin main` pushes to a remote. Run it?'
    const options = ['Allow once', 'Allow for this session', 'Refuse'].map(label => ({ label, description: label }))
    const asked = (questions: unknown[], answers: string[][], id: string) => f.trigger('tool.execute.after', {
      tool: 'question', sessionID: SID, agent: 'build', messageID: 'm1', id, input: { questions },
      status: 'completed' as const, result: { output: { answers }, content: 'User has answered your questions', metadata: { answers } },
    })
    expect((await f.trigger('permission.evaluate', shell('git push origin main'))).effect).toBe('deny')
    await asked([{ question: text, header: 'Consent', options }], [['Refuse']], 'q1')
    await asked([{ question: 'Push it?', header: 'Consent', options }], [['Allow once']], 'q2')
    await asked([{ question: text, header: 'Consent', options: options.slice(0, 2) }], [['Allow once']], 'q3')
    await asked([{ question: text, header: 'Consent', options, multiple: true }], [['Allow once']], 'q4')
    expect(readConsentState('opencode', SID).grants).toEqual([])
    expect((await f.trigger('permission.evaluate', shell('git push origin main'))).effect).toBe('deny')
    await asked([{ question: 'Which branch?', header: 'Branch', options: [{ label: 'main', description: 'x' }] }, { question: text, header: 'Consent', options }], [['main'], ['Allow once']], 'q5')
    expect(readConsentState('opencode', SID).grants.map(g => [g.kind, g.source, g.uses])).toEqual([['push', 'ask', 1]])
    expect((await f.trigger('permission.evaluate', shell('git push origin main'))).effect).toBe('allow')
    expect((await f.trigger('permission.evaluate', shell('git push origin main'))).effect).toBe('deny')
  }))

  test('"Allow once" lets this call through and records a one-use grant; the next push asks again', () => withSandbox(async ({ root }) => {
    const { f } = await runtime(root)
    writeTuiBeat(SID, Date.now(), 1)
    const seen: string[] = []
    const [ev] = await Promise.all([f.trigger('permission.evaluate', shell('git push origin main')), answerWhenAsked('once', seen)])
    expect(ev.effect).toBe('allow')
    expect(ev.message).toBeUndefined()
    expect(seen[0]).toBe('Buracle consent: `git push origin main` pushes to a remote. Run it?')
    expect(openAsks(SID)).toEqual([])
    writeTuiBeat(SID, Date.now(), 1)
    const [again] = await Promise.all([f.trigger('permission.evaluate', shell('git push origin feature')), answerWhenAsked('dismiss')])
    expect(again.effect).toBe('deny')
    expect(again.message).toContain('Ask the user first')
  }))

  test('"Allow for this session" covers later commands of that kind without a question', () => withSandbox(async ({ root }) => {
    const { f } = await runtime(root)
    writeTuiBeat(SID, Date.now(), 1)
    const [ev] = await Promise.all([f.trigger('permission.evaluate', shell('git push --no-verify origin main')), answerWhenAsked('session')])
    expect(ev.effect).toBe('allow')
    expect(readConsentState('opencode', SID).grants.map(g => [g.kind, g.source]).sort()).toEqual([['push', 'ask'], ['skip-hooks', 'ask']])
    expect((await f.trigger('permission.evaluate', shell('git push origin other'))).effect).toBe('allow')
  }))

  test('a TUI that has not reached the new session yet gets two seconds to arrive before the plain denial', () => withSandbox(async ({ root }) => {
    const { f } = await runtime(root)
    writeTuiBeat(undefined, Date.now(), 1)
    const late = (async () => { await Bun.sleep(150); writeTuiBeat(SID, Date.now(), 1); await answerWhenAsked('once') })()
    const [ev] = await Promise.all([f.trigger('permission.evaluate', shell('git push origin main')), late])
    expect(ev.effect).toBe('allow')
  }))

  test('"Refuse" keeps the denial and tells the agent the user refused', () => withSandbox(async ({ root }) => {
    const { f } = await runtime(root)
    writeTuiBeat(SID, Date.now(), 1)
    const [ev] = await Promise.all([f.trigger('permission.evaluate', shell('npm publish')), answerWhenAsked('refuse')])
    expect(ev.effect).toBe('deny')
    expect(ev.message).toContain('the user refused `npm publish` in the consent dialog')
  }))

  test('a subagent\'s held command keeps the plain denial', () => withSandbox(async ({ root }) => {
    const { f, rt } = await runtime(root)
    const child = 'ses_consentchild1'
    f.parents[child] = SID
    await rt.handleEvent({ type: 'session.created', data: { sessionID: child, parentID: SID, location: { directory: root } } })
    writeTuiBeat(child, Date.now(), 1)
    const ev = await f.trigger('permission.evaluate', { ...shell('git push origin main'), sessionID: child })
    expect(ev.effect).toBe('deny')
    expect(openAsks(child)).toEqual([])
  }))
})

describe('OpenCode TUI consent relay', () => {
  function host(sid: string | undefined, picks: Array<(v: string | undefined) => void>, titles: string[], cleared: number[]): ConsentRelayHost {
    return {
      sessionID: () => sid, now: () => Date.now(), pid: 7, clear: () => { cleared.push(1) },
      select: async o => { titles.push(o.title); expect(o.options.map(x => x.title)).toEqual(['Allow once', 'Allow for this session', 'Refuse']); return new Promise(r => { picks.push(r) }) },
    }
  }

  test('the TUI beats for the session it shows, asks an open question once and writes the pick', () => withSandbox(async () => {
    const picks: Array<(v: string | undefined) => void> = []
    const titles: string[] = []
    const h = host(SID, picks, titles, [])
    const state = {}
    consentRelayTick(h, state)
    expect(tuiPresent(SID, Date.now())).toBe(true)
    expect(tuiPresent(SID, Date.now() + TUI_FRESH_MS + 1)).toBe(false)
    postAsk(SID, { id: 'ask-0001', question: 'Buracle consent: `git push` pushes to a remote. Run it?', command: 'git push', at: 1 })
    consentRelayTick(h, state)
    consentRelayTick(h, state)
    expect(titles).toEqual(['Buracle consent: `git push` pushes to a remote. Run it?'])
    picks[0]?.('Allow for this session')
    await Bun.sleep(5)
    expect(readAnswer(SID, 'ask-0001')).toBe('session')
    expect(answerAsk(SID, 'ask-0001', 'refuse', 2)).toBe(false)
  }))

  test('a question the server withdrew closes the dialog; Escape answers dismiss', () => withSandbox(async () => {
    const picks: Array<(v: string | undefined) => void> = []
    const cleared: number[] = []
    const h = host(SID, picks, [], cleared)
    const state = {}
    postAsk(SID, { id: 'ask-0002', question: 'q', command: 'git push', at: 1 })
    consentRelayTick(h, state)
    const { clearAsk } = await import('../../../src/adapters/opencode/runtime/consent-relay')
    clearAsk(SID, 'ask-0002')
    consentRelayTick(h, state)
    expect(cleared).toEqual([1])
    postAsk(SID, { id: 'ask-0003', question: 'q', command: 'git push', at: 2 })
    consentRelayTick(h, state)
    picks[1]?.(undefined)
    await Bun.sleep(5)
    expect(readAnswer(SID, 'ask-0003')).toBe('dismiss')
    consentRelayTick(host(undefined, [], [], []), {})
  }))
})
