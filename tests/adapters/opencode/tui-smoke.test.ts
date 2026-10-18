import { describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { installPlan } from '../../../src/adapters/opencode/install'
import { jsoncSet } from '../../../src/engine/merge'
import * as paths from '../../../src/engine/paths'
import { parseVersion } from '../../../src/engine/proc'
import { applyPlans } from '../../../src/engine/txn'
import { brainProjectsDir } from '../../../src/memory/layout'
import { listAll, personRef, projectRef } from '../../../src/memory/store'
import { readFlow, writeFlow } from '../../../src/workflow/flow'
import { flowPhase } from '../../../src/core/flow/record'
import { withSandbox } from '../../helpers/sandbox'
import { lastUserText, startFakeProvider, type ToolRule } from './fake-provider'
import { adapterContext, REPO } from './helpers'

const OPENCODE = Bun.which('opencode', { PATH: process.env['PATH'] ?? '' })
const TMUX = Bun.which('tmux', { PATH: `${process.env['PATH'] ?? ''}:/opt/homebrew/bin:/usr/local/bin` })
const BUN = process.execPath
const OUT = process.env['BURACLE_TUI_SMOKE_OUT']
const MIDDLE_DOT = String.fromCodePoint(0xb7)
const CURRENT_PHASE = String.fromCodePoint(0x25cf)
const MODEL = 'claude-opus-5-5'
const FOOTER_MARK = MODEL

function versionOk(): boolean {
  if (OPENCODE === null) return false
  const probe = join(paths.home(), 'tui-version-probe')
  const r = Bun.spawnSync([OPENCODE, '--version'], { env: { PATH: '/usr/bin:/bin', HOME: probe, XDG_DATA_HOME: join(probe, 'data'), XDG_CONFIG_HOME: join(probe, 'config'), XDG_STATE_HOME: join(probe, 'state'), XDG_CACHE_HOME: join(probe, 'cache') } })
  const v = parseVersion(r.stdout.toString())
  return v !== undefined && Number(v.split('.')[0]) >= 2
}

const enabled = process.env['BURACLE_TUI_SMOKE'] === '1' && TMUX !== null && versionOk()

function primary(body: Record<string, unknown> | undefined): boolean {
  return Array.isArray(body?.['tools']) && (body['tools'] as unknown[]).length > 0
}

async function tuiSetup({ root, home, buracleHome }: { root: string, home: string, buracleHome: string }, rules: ToolRule[] = []) {
  const stubBin = join(root, 'stub-bin')
  mkdirSync(stubBin, { recursive: true })
  for (const name of ['npx', 'uvx']) {
    writeFileSync(join(stubBin, name), '#!/bin/sh\nexit 1\n')
    chmodSync(join(stubBin, name), 0o755)
  }
  mkdirSync(dirname(paths.shimPath()), { recursive: true })
  writeFileSync(paths.shimPath(), `#!/bin/sh\nexec "${BUN}" "${join(REPO, 'src', 'cli', 'main.ts')}" "$@"\n`)
  chmodSync(paths.shimPath(), 0o755)
  mkdirSync(join(root, 'tmp'), { recursive: true })
  const project = join(root, 'project')
  mkdirSync(project, { recursive: true })
  mkdirSync(join(paths.agentsDir(), 'skills'), { recursive: true })
  symlinkSync(join(REPO, 'harness', 'agents-skills', 'plan-build'), join(paths.agentsDir(), 'skills', 'plan-build'))

  await applyPlans([await installPlan(adapterContext(), { opencode: null })])
  const provider = startFakeProvider(rules)
  const cfgFile = join(paths.opencodeConfigDir(), 'opencode.jsonc')
  let cfgText = jsoncSet(readFileSync(cfgFile, 'utf8'), ['mcp', 'servers', 'grep', 'disabled'], true)
  cfgText = jsoncSet(cfgText, ['providers', 'anthropic', 'settings'], { baseURL: provider.baseURL, apiKey: 'fake-key' })
  cfgText = jsoncSet(cfgText, ['model'], 'anthropic/claude-opus-5-5')
  writeFileSync(cfgFile, cfgText)

  const env: Record<string, string> = {
    PATH: [stubBin, dirname(OPENCODE as string), dirname(BUN), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'),
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_STATE_HOME: join(home, '.local', 'state'),
    XDG_CACHE_HOME: join(home, '.cache'),
    TMPDIR: join(root, 'tmp') + '/',
    BURACLE_HOME: buracleHome,
    BURACLE_CORTEXDB_BIN: process.env['BURACLE_CORTEXDB_BIN'] ?? '',
    BURACLE_NO_AUTOSTART: '1',
    BURACLE_NO_NOTIFY: '1',
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_DISABLE_MODELS_FETCH: '1',
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    LANG: 'en_US.UTF-8',
  }
  const tmux = (...args: string[]) => Bun.spawnSync([TMUX as string, '-S', 't.sock', ...args], { cwd: root, env })
  const screen = () => tmux('capture-pane', '-p', '-t', 'oc').stdout.toString()
  let shot = 0
  const save = (label: string, text: string) => {
    if (OUT === undefined) return
    mkdirSync(OUT, { recursive: true })
    writeFileSync(join(OUT, `${String(++shot).padStart(2, '0')}-${label}.txt`), text)
  }
  const waitFor = async (pred: (s: string) => boolean, label: string, ms = 60_000): Promise<string> => {
    const end = Date.now() + ms
    let s = ''
    while (Date.now() < end) {
      s = screen()
      if (pred(s)) { save(label, s); return s }
      await Bun.sleep(300)
    }
    save(`${label}-TIMEOUT`, s)
    throw new Error(`screen never showed ${label}:\n${s}`)
  }
  const submit = async (text: string) => {
    tmux('send-keys', '-t', 'oc', '-l', text)
    await Bun.sleep(600)
    tmux('send-keys', '-t', 'oc', 'Enter')
  }
  const agentRequests = () => provider.requests.filter(r => primary(r.body)).length
  const submitBare = async (text: string, label: string) => {
    await submit(text)
    await Bun.sleep(800)
    save(label, screen())
    tmux('send-keys', '-t', 'oc', 'Enter')
  }
  const closeDialog = async (mark: string) => {
    tmux('send-keys', '-t', 'oc', 'Escape')
    await waitFor(s => !s.includes(mark), `closed-${mark.replace(/\W+/g, '-')}`, 10_000)
  }

  return { provider, tmux, screen, save, waitFor, submit, agentRequests, submitBare, closeDialog, project }
}

describe('opencode TUI (real binary in tmux, opt-in)', () => {
  (enabled ? test : test.skip)('utility commands run without a model turn; /plan-build shows the workflow band above the prompt', () => withSandbox(async ({ root, home, buracleHome }) => {
    const { provider, tmux, waitFor, submit, agentRequests, submitBare, closeDialog, project } = await tuiSetup({ root, home, buracleHome })
    const start = tmux('new-session', '-d', '-s', 'oc', '-x', '140', '-y', '45', `cd '${project}' && exec '${OPENCODE as string}' --standalone`)
    expect(start.exitCode).toBe(0)
    try {
      await waitFor(s => s.includes('Ask anything') && s.includes(FOOTER_MARK), 'home')

      const before = agentRequests()
      await submit('/remember buracle tui smoke note')
      await waitFor(s => s.includes('Remembered: '), 'remember-toast', 30_000)
      const projects = existsSync(brainProjectsDir()) ? readdirSync(brainProjectsDir()).filter(f => f.endsWith('.db')).map(f => projectRef(f.slice(0, -3))) : []
      const captures = (await Promise.all([personRef(), ...projects].map(r => listAll(r)))).flat().filter(i => i.kind === 'capture')
      expect(captures.some(i => i.title === 'buracle tui smoke note')).toBe(true)
      expect(agentRequests()).toBe(before)

      await submit('/plan-build add a health check endpoint')
      await waitFor(() => provider.requests.some(r => primary(r.body) && lastUserText(r.body).includes('<skill_content name="plan-build">')), 'spec-request', 60_000).catch(() => undefined)
      const head = `plan-build ${MIDDLE_DOT} add a health check endpoint`
      const withBand = await waitFor(s => s.includes(head), 'band', 60_000)
      const lines = withBand.split('\n')
      const bandAt = lines.findIndex(l => l.includes(head))
      const footerAt = lines.findIndex((l, i) => i > bandAt && l.includes(FOOTER_MARK))
      expect(bandAt).toBeGreaterThanOrEqual(0)
      expect(footerAt).toBeGreaterThan(bandAt)
      expect(lines.slice(bandAt, bandAt + 3).join('\n')).toContain('Plan')

      const sid = readdirSync(paths.sessionsDir('opencode')).find(d => readFlow('opencode', d)?.stack[0]?.workflow === 'plan-build') as string
      const rec = readFlow('opencode', sid)
      const moved = flowPhase(rec, { phase: 'implement' }, Date.now())
      writeFlow('opencode', sid, moved.record)
      await waitFor(s => s.split('\n').some(l => l.includes(`${CURRENT_PHASE} Implement`)), 'band-phase', 15_000)

      const beforeStatus = agentRequests()
      await submit('/buracle-status flow')
      await waitFor(s => s.includes('Buracle workflow') && s.includes('phases:'), 'status-dialog', 20_000)
      expect(agentRequests()).toBe(beforeStatus)
      await closeDialog('Buracle workflow')
      await submit('/buracle-status plan')
      await waitFor(s => s.includes('Buracle plan') && s.includes('Live view, updated every few seconds'), 'plan-pane', 20_000)
      expect(agentRequests()).toBe(beforeStatus)
      await closeDialog('Live view, updated every few seconds')

      const beforeBare = provider.requests.length
      await submitBare('/buracle-ping', 'ping-completed')
      await waitFor(s => s.split('\n').some(l => /\bpong\b/.test(l)), 'ping-toast', 20_000)
      await submitBare('/buracle', 'bare-status-completed')
      await waitFor(s => s.includes('Buracle status') && s.includes('Buracle on OpenCode'), 'bare-status-dialog', 20_000)
      expect(provider.requests.length).toBe(beforeBare)
      await closeDialog('Buracle on OpenCode')

      const QUESTION = 'what does the health check return'
      await submit(`/aside ${QUESTION}`)
      await waitFor(s => s.includes('/btw') && s.includes(QUESTION) && s.includes('ok'), 'aside-dialog', 30_000)
      const side = provider.requests.filter(r => lastUserText(r.body).includes(QUESTION))
      expect(side.length).toBe(1)
      expect(lastUserText(side[0]?.body)).toContain('quick side question')
      await closeDialog(QUESTION)
      const NEXT = 'one more turn after the side question'
      await submit(NEXT)
      await waitFor(() => provider.requests.some(r => primary(r.body) && lastUserText(r.body).includes(NEXT)), 'turn-after-aside', 30_000)
      const next = provider.requests.find(r => primary(r.body) && lastUserText(r.body).includes(NEXT))
      expect(JSON.stringify(next?.body?.['messages'])).not.toContain(QUESTION)
    } finally {
      tmux('kill-server')
      provider.stop()
    }
  }), 240_000)

  ;(enabled ? test : test.skip)('H20: a held push opens the consent dialog in the TUI; "Allow once" runs it, "Refuse" does not', () => withSandbox(async ({ root, home, buracleHome }) => {
    const MARK_ONE = 'consent smoke first step'
    const MARK_TWO = 'consent smoke second step'
    const rules: ToolRule[] = [
      { when: t => t.includes(MARK_ONE), name: 'shell', input: { command: 'git push -q origin HEAD:refs/heads/feature', description: 'Push the branch' } },
      { when: t => t.includes(MARK_TWO), name: 'shell', input: { command: 'git push -q origin HEAD:refs/heads/other', description: 'Push the other branch' } },
    ]
    const { provider, tmux, waitFor, submit, project } = await tuiSetup({ root, home, buracleHome }, rules)
    const gitEnv = { PATH: '/usr/bin:/bin:/opt/homebrew/bin', HOME: home, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' }
    const git = (cwd: string, ...args: string[]) => Bun.spawnSync(['git', ...args], { cwd, env: gitEnv }).exitCode
    const remote = join(root, 'remote.git')
    expect(git(root, 'init', '-q', '--bare', remote)).toBe(0)
    for (const args of [['init', '-q', '-b', 'main'], ['commit', '-q', '--allow-empty', '-m', 'one'], ['remote', 'add', 'origin', remote]]) expect(git(project, ...args)).toBe(0)
    const start = tmux('new-session', '-d', '-s', 'oc', '-x', '140', '-y', '45', `cd '${project}' && exec '${OPENCODE as string}' --standalone`)
    expect(start.exitCode).toBe(0)
    try {
      await waitFor(s => s.includes('Ask anything') && s.includes(FOOTER_MARK), 'consent-home')
      await submit(MARK_ONE)
      await waitFor(s => s.includes('Buracle consent:') && s.includes('Allow once') && s.includes('Allow for this session') && s.includes('Refuse'), 'consent-dialog', 60_000)
      tmux('send-keys', '-t', 'oc', 'Enter')
      const end = Date.now() + 30_000
      while (Date.now() < end && git(remote, 'rev-parse', '--verify', '-q', 'refs/heads/feature') !== 0) await Bun.sleep(300)
      expect(git(remote, 'rev-parse', '--verify', '-q', 'refs/heads/feature')).toBe(0)
      await waitFor(s => !s.includes('Buracle consent:'), 'consent-closed', 30_000)
      await submit(MARK_TWO)
      await waitFor(s => s.includes('Buracle consent:') && s.includes('heads/other'), 'consent-dialog-2', 60_000)
      tmux('send-keys', '-t', 'oc', 'Down')
      tmux('send-keys', '-t', 'oc', 'Down')
      await Bun.sleep(300)
      tmux('send-keys', '-t', 'oc', 'Enter')
      await waitFor(() => provider.requests.some(r => JSON.stringify(r.body ?? {}).includes('the user refused')), 'consent-refused', 30_000)
      expect(git(remote, 'rev-parse', '--verify', '-q', 'refs/heads/other')).not.toBe(0)
    } finally {
      tmux('kill-server')
      provider.stop()
    }
  }), 240_000)
})
