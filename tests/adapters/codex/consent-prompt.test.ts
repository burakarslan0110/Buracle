import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { consentRunCommand, parseConsentRun, singleQuoted, unquoteSingle, UNKNOWN_CONSENT_RUN } from '../../../src/adapters/codex/consent-prompt'
import { consentPromptRule, literalProgram, renderRulesFile } from '../../../src/adapters/codex/execpolicy'
import { handleCodexHook } from '../../../src/adapters/codex/hook'
import { consentAskKey, consentAsksDir, markConsentAsked, postConsentAsk, readConsentAsk, takeConsentAsk } from '../../../src/adapters/shared/consent-asks'
import { runConsent } from '../../../src/cli/commands/consent'
import { defaultConfig } from '../../../src/core/config'
import * as paths from '../../../src/engine/paths'
import { run } from '../../../src/engine/proc'
import { pathOf, systemPathDirs } from '../../helpers/fake-exe'
import { withSandbox } from '../../helpers/sandbox'
import { ctx, deps, payload, SID } from './hook-helpers'

const CODEX = Bun.which('codex')
const quiet = { checkBash: () => ({}), checkWrite: () => ({}), checkQuestion: () => ({}), routeTool: () => ({ action: 'allow' as const }), detectIntent: () => null }
const guarded = { checkWrite: () => ({}), checkQuestion: () => ({}), routeTool: () => ({ action: 'allow' as const }), detectIntent: () => null, capabilityCard: () => 'c', restoreContext: () => undefined }
const ID = '0123456789abcdef'
const CODEX_ENV = { CODEX_THREAD_ID: SID, SHELL: '/bin/sh' }
// The prompt needs a shim path Codex's prefix rules can match literally (an absolute POSIX path). The
// installed shim on Windows (buracle.cmd) is not one, so there the prompt is off and the plain denial
// stays (the Windows case below). With this path the prompt's own logic runs the same on every host.
const SHIM = '/home/u/.buracle/bin/buracle'
const hctx = (config = defaultConfig()) => ({ ...ctx(config), buracleBin: SHIM })

function withId(id = ID, over: Partial<typeof guarded> | typeof quiet = quiet) {
  const d = deps(over)
  d.newId = () => id
  d.platform = 'darwin'
  return d
}

const wrapped = (command: string): string | undefined => {
  const parsed = parseConsentRun(command)
  return parsed !== undefined ? unquoteSingle(parsed.quoted) : undefined
}

function rolloutWith(dir: string, outputs: string[]): string {
  const path = join(dir, 'rollout.jsonl')
  const lines = [
    { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'c1', arguments: '{"cmd":"git push origin main"}' } },
    ...outputs.map(id => ({ type: 'response_item', payload: { type: 'function_call_output', call_id: id, output: 'exec command rejected by user' } })),
  ]
  writeFileSync(path, lines.map(l => JSON.stringify(l)).join('\n') + '\n')
  return path
}

async function askedHold(command = 'git push origin main'): Promise<void> {
  const held = out((await handleCodexHook('PreToolUse', bash(command), hctx(), withId())).stdout)
  expect(held['permissionDecision']).toBe('allow')
  expect(readConsentAsk(ID)?.call).toBe('c1')
  expect((await handleCodexHook('PermissionRequest', permission('Bash', { command: String((held['updatedInput'] as Record<string, unknown>)['command']) }), hctx(), withId())).stdout).toBe('')
  expect(typeof readConsentAsk(ID)?.asked).toBe('number')
}

const bash = (command: string, extra: Record<string, unknown> = {}) => payload('PreToolUse', { tool_name: 'Bash', tool_use_id: 'c1', tool_input: { command }, ...extra })
const permission = (tool: string, input: Record<string, unknown>) => payload('PermissionRequest', { tool_name: tool, tool_input: input })
const out = (stdout: string): Record<string, unknown> => (stdout === '' ? {} : JSON.parse(stdout).hookSpecificOutput as Record<string, unknown>)

function io() {
  let o = ''
  let e = ''
  return { stdout: { write: (s: string) => { o += s } }, stderr: { write: (s: string) => { e += s } }, stdin: { isTTY: false, text: async () => '' }, flags: { json: false, verbose: false }, out: () => o, err: () => e }
}

describe('the wrapper command and its quoting', () => {
  test('single quotes survive the round trip and the wrapper is recognized only for buracle', () => {
    for (const c of ['git push origin main', "git commit -m 'it''s' && git push", 'echo "$(date)" | tee x', "a'b'c", '']) {
      expect(unquoteSingle(singleQuoted(c))).toBe(c)
      expect(wrapped(consentRunCommand('/u/.buracle/bin/buracle', ID, c))).toBe(c)
    }
    expect(parseConsentRun(`/u/bin/other consent run ${ID} 'x'`)).toBeUndefined()
    expect(parseConsentRun(`buracle consent run ${ID} 'x'`)?.id).toBe(ID)
    expect(parseConsentRun(`buracle consent run XYZ 'x'`)).toBeUndefined()
    expect(literalProgram('/Users/u/.buracle/bin/buracle')).toBe(true)
    for (const p of ['{buracle}', '/Users/a b/.buracle/bin/buracle', 'buracle', '/x/$HOME/buracle', '/x/../buracle', undefined]) expect(literalProgram(p)).toBe(false)
    expect(consentPromptRule('{buracle}')).toBeUndefined()
    expect(renderRulesFile({ shim: '/u/.buracle/bin/buracle' })).toContain('pattern = ["/u/.buracle/bin/buracle", "consent", "run"],\n    decision = "prompt",')
    expect(renderRulesFile({ shim: '{buracle}' })).not.toContain('decision = "prompt"')
  })
})

describe('Codex H20: a held command asks in Codex\'s own approval prompt', () => {
  test('with approvals able to surface, the held push is rewritten into the consent wrapper; nothing else changes', () => withSandbox(async () => {
    const r = out((await handleCodexHook('PreToolUse', bash('git push origin main'), hctx(), withId())).stdout)
    expect(r['permissionDecision']).toBe('allow')
    expect(r['updatedInput']).toEqual({ command: `${SHIM} consent run ${ID} 'git push origin main'` })
    expect(readConsentAsk(ID)).toMatchObject({ sid: SID, command: 'git push origin main', harness: 'codex' })
    expect((await handleCodexHook('PreToolUse', bash('git status'), hctx(), withId())).stdout).toBe('')
  }))

  test('the no-approval policy (codex exec, --yolo), a subagent, Windows or another shell keep the plain denial', () => withSandbox(async () => {
    const denied = async (p: string, d = withId()) => out((await handleCodexHook('PreToolUse', p, hctx(), d)).stdout)['permissionDecision']
    expect(await denied(bash('git push origin main', { permission_mode: 'bypassPermissions' }))).toBe('deny')
    expect(await denied(bash('git push origin main', { agent_id: 'a1', agent_type: 'worker' }))).toBe('deny')
    const win = withId()
    win.platform = 'win32'
    expect(await denied(bash('git push origin main'), win)).toBe('deny')
    const cmdShim = out((await handleCodexHook('PreToolUse', bash('git push origin main'), { ...hctx(), buracleBin: 'C:\\Users\\u\\.buracle\\bin\\buracle.cmd' }, withId())).stdout)
    expect(cmdShim['permissionDecision']).toBe('deny')
    const fish = deps(quiet, {}, { SHELL: '/opt/homebrew/bin/fish' })
    fish.newId = () => ID
    expect(await denied(bash('git push origin main'), fish)).toBe('deny')
    expect(readConsentAsk(ID)).toBeUndefined()
  }))

  test('an automatic approvals reviewer would answer the question instead of the user, so the plain denial stays', () => withSandbox(async () => {
    const decision = async () => out((await handleCodexHook('PreToolUse', bash('git push origin main'), hctx(), withId())).stdout)['permissionDecision']
    mkdirSync(paths.codexHome(), { recursive: true })
    const toml = join(paths.codexHome(), 'config.toml')
    const spend = () => rmSync(join(paths.stateDir(), 'consent-asks'), { recursive: true, force: true })
    expect(await decision()).toBe('allow')
    spend()
    for (const [text, want] of [
      ['approvals_reviewer = "user"\n', 'allow'],
      ['approval_policy = "on-request"\napprovals_reviewer = "auto_review"\n', 'deny'],
      ['profile = "ci"\n[profiles.ci]\napprovals_reviewer = "auto_review"\n', 'deny'],
      ['profile = "ci"\napprovals_reviewer = "auto_review"\n[profiles.ci]\napprovals_reviewer = "user"\n', 'allow'],
      ['approvals_reviewer = [\n', 'deny'],
    ] as const) {
      writeFileSync(toml, text)
      expect({ text, decision: await decision() }).toEqual({ text, decision: want })
      spend()
    }
  }))

  test('PermissionRequest marks the question as asked; consent run then runs the command once', () => withSandbox(async ({ root }) => {
    await handleCodexHook('PreToolUse', bash("echo 'ok' > done.txt"), hctx(), withId())
    const wrapper = `${SHIM} consent run ${ID} ${singleQuoted("echo 'ok' > done.txt")}`
    expect(readConsentAsk(ID)).toBeUndefined()
    postConsentAsk('codex', SID, "echo 'ok' > done.txt", ID, Date.now())
    expect((await handleCodexHook('PermissionRequest', permission('Bash', { command: wrapper }), hctx(), withId())).stdout).toBe('')
    expect(typeof readConsentAsk(ID)?.asked).toBe('number')
    // consent run starts a POSIX shell; Windows turns the Codex consent prompt off (consent-prompt.ts), so it never gets there.
    if (process.platform === 'win32') return
    const t = io()
    const cwd = process.cwd()
    process.chdir(root)
    try {
      expect(await runConsent(['run', ID, "echo 'ok' > done.txt"], t, Date.now(), CODEX_ENV)).toBe(0)
    } finally { process.chdir(cwd) }
    expect(await Bun.file(join(root, 'done.txt')).text()).toBe('ok\n')
    const again = io()
    expect(await runConsent(['run', ID, "echo 'ok' > done.txt"], again, Date.now(), CODEX_ENV)).toBe(1)
    expect(again.err()).toContain('Buracle holds no such command')
  }))

  test('consent run refuses a question that never reached the user, a changed command and an expired one', () => withSandbox(async () => {
    const now = Date.now()
    postConsentAsk('codex', SID, 'git push', 'aaaaaaaaaaaa', now)
    expect(takeConsentAsk('aaaaaaaaaaaa', 'git push', now)).toEqual({ ok: false, why: 'not-asked' })
    postConsentAsk('codex', SID, 'git push', 'bbbbbbbbbbbb', now)
    expect(takeConsentAsk('bbbbbbbbbbbb', 'git push --force', now)).toEqual({ ok: false, why: 'changed' })
    postConsentAsk('codex', SID, 'git push', 'cccccccccccc', now - 16 * 60_000)
    expect(takeConsentAsk('cccccccccccc', 'git push', now)).toEqual({ ok: false, why: 'expired' })
    const t = io()
    expect(await runConsent(['run', 'not-an-id', 'x'], t)).toBe(1)
    expect(t.err()).toContain('Usage: buracle consent run')
  }))

  test('the ask records are named and keyed by a hash of the id, so listing the folder shows nothing a wrapper call can use', () => withSandbox(async () => {
    const now = Date.now()
    postConsentAsk('codex', SID, 'git push origin main', ID, now)
    markConsentAsked(ID, SID, 'git push origin main', now)
    const names = readdirSync(consentAsksDir())
    expect(names).toEqual([`${consentAskKey(ID)}.json`])
    expect(consentAskKey(ID)).toMatch(/^[a-f0-9]{32}$/)
    expect(consentAskKey(ID)).not.toContain(ID)
    const text = readFileSync(join(consentAsksDir(), names[0] as string), 'utf8')
    expect(text).not.toContain(ID)
    expect(JSON.parse(text)).toMatchObject({ key: consentAskKey(ID), sid: SID, command: 'git push origin main' })
    expect(await runConsent(['run', consentAskKey(ID).slice(0, 16), 'git push origin main'], io(), now, CODEX_ENV)).toBe(1)
    expect(readConsentAsk(ID)?.asked).toBe(now)
    expect(await runConsent(['run', consentAskKey(ID), 'git push origin main'], io(), now, CODEX_ENV)).toBe(1)
    expect(readConsentAsk(ID)?.asked).toBe(now)
  }))

  test('an unknown wrapper is denied in PermissionRequest, and H01 denies every call of `consent run` the model writes; a retry whose question never surfaced keeps the plain denial', () => withSandbox(async () => {
    const forged = `${SHIM} consent run ${ID} 'rm -rf ~'`
    expect(out((await handleCodexHook('PermissionRequest', permission('Bash', { command: forged }), hctx(), withId())).stdout)).toEqual({ hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: UNKNOWN_CONSENT_RUN } })
    const shim = SHIM
    for (const c of [
      forged,
      `env ${shim} consent run ${ID} 'git push origin main'`,
      `cd /work/app && ${shim} consent run ${ID} 'git push origin main'`,
      `bash -c "${shim} consent run ${ID} 'git push origin main'"`,
      `"$HOME/.buracle/bin/buracle" consent run ${ID} 'git push origin main'`,
      `$(command -v buracle) consent run ${ID} 'git push origin main'`,
      `sh ${shim} consent run ${ID} 'git push origin main'`,
      `bash -x ${shim} consent run ${ID} 'git push origin main'`,
      `bun --bun /r/src/cli/main.ts consent run ${ID} 'git push origin main'`,
      `deno run -A /r/src/cli/main.ts consent run ${ID} 'git push origin main'`,
      `python3 -c "import subprocess; subprocess.run(['buracle', 'consent', 'run', '${ID}', 'git push origin main'])"`,
    ]) {
      const r = out((await handleCodexHook('PreToolUse', bash(c), hctx(), withId(ID, guarded))).stdout)
      expect({ c, decision: r['permissionDecision'] }).toEqual({ c, decision: 'deny' })
      expect(String(r['permissionDecisionReason'])).toStartWith('Buracle H01: `buracle consent run` is Buracle\'s own wrapper')
    }
    expect(out((await handleCodexHook('PreToolUse', bash('npm publish'), hctx(), withId('dddddddddddd'))).stdout)['permissionDecision']).toBe('allow')
    const retry = out((await handleCodexHook('PreToolUse', bash('npm publish'), hctx(), withId('eeeeeeeeeeee'))).stdout)
    expect(retry['permissionDecision']).toBe('deny')
    expect(String(retry['permissionDecisionReason'])).toContain('Buracle H20')
  }))

  test('a declined question is spent: the next PreToolUse whose rollout shows the call\'s result drops the hold, so no wrapper can redeem it', () => withSandbox(async ({ root }) => {
    await askedHold()
    const later = bash('git status', { tool_use_id: 'c2', transcript_path: rolloutWith(root, ['c1']) })
    expect((await handleCodexHook('PreToolUse', later, hctx(), withId('fedcba9876543210'))).stdout).toBe('')
    expect(readConsentAsk(ID)).toBeUndefined()
    const t = io()
    expect(await runConsent(['run', ID, 'git push origin main'], t, Date.now(), CODEX_ENV)).toBe(1)
    expect(t.err()).toContain('Buracle holds no such command')
  }))

  test('a hold still waiting for the user survives a parallel call\'s PreToolUse; the turn\'s end, the next prompt or a missing rollout drop it', () => withSandbox(async ({ root }) => {
    await askedHold()
    const parallel = bash('git status', { tool_use_id: 'c2', transcript_path: rolloutWith(root, []) })
    await handleCodexHook('PreToolUse', parallel, hctx(), withId('fedcba9876543210'))
    expect(typeof readConsentAsk(ID)?.asked).toBe('number')
    await handleCodexHook('Stop', payload('Stop', { stop_hook_active: false, last_assistant_message: 'done' }), hctx(), withId())
    expect(readConsentAsk(ID)).toBeUndefined()
    await askedHold()
    await handleCodexHook('UserPromptSubmit', payload('UserPromptSubmit', { prompt: 'what now?' }), hctx(), withId(ID, guarded))
    expect(readConsentAsk(ID)).toBeUndefined()
    await askedHold()
    await handleCodexHook('PreToolUse', bash('git status', { tool_use_id: 'c2' }), hctx(), withId('fedcba9876543210'))
    expect(readConsentAsk(ID)).toBeUndefined()
  }))

  test('consent run refuses outside the Codex session that asked, and re-checks the command with H01 before it runs', () => withSandbox(async ({ root }) => {
    const now = Date.now()
    postConsentAsk('codex', SID, 'git push origin main', ID, now)
    markConsentAsked(ID, SID, 'git push origin main', now)
    for (const env of [{ SHELL: '/bin/sh' }, { CODEX_THREAD_ID: '019a1b2c-3d4e-7f60-8a9b-0c1d2e3f4a5c', SHELL: '/bin/sh' }]) {
      postConsentAsk('codex', SID, 'git push origin main', ID, now)
      markConsentAsked(ID, SID, 'git push origin main', now)
      const t = io()
      expect(await runConsent(['run', ID, 'git push origin main'], t, now, env)).toBe(1)
      expect(t.err()).toContain('it does not run in the Codex session that asked the user')
      expect(readConsentAsk(ID)).toBeUndefined()
    }
    const marker = join(root, 'ran.txt')
    const forged = `rm -rf ~ ; touch ${marker}`
    postConsentAsk('codex', SID, forged, ID, now)
    markConsentAsked(ID, SID, forged, now)
    const t = io()
    const cwd = process.cwd()
    process.chdir(root)
    try {
      expect(await runConsent(['run', ID, forged], t, now, CODEX_ENV)).toBe(1)
    } finally { process.chdir(cwd) }
    expect(t.err()).toContain('nothing ran, because Buracle H01 refuses it')
    expect(existsSync(marker)).toBe(false)
    expect(existsSync(paths.home())).toBe(true)
  }))

  test('MCP approvals are answered allow while permissions.bypass is on and Buracle\'s policy is live (as approval_policy "never" did); other Bash prompts stay the user\'s', () => withSandbox(async () => {
    const config = join(paths.codexHome(), 'config.toml')
    mkdirSync(paths.codexHome(), { recursive: true })
    writeFileSync(config, 'approval_policy = "on-request"\n')
    expect((await handleCodexHook('PermissionRequest', permission('mcp__github__delete_repo', { repo: 'x' }), hctx(), withId())).stdout).toBe('')
    writeFileSync(config, 'approval_policy = { granular = { sandbox_approval = false, rules = true, skill_approval = false, request_permissions = false, mcp_elicitations = false } }\n')
    expect(out((await handleCodexHook('PermissionRequest', permission('mcp__github__delete_repo', { repo: 'x' }), hctx(), withId())).stdout)).toEqual({ hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } })
    const off = defaultConfig()
    off.permissions.bypass = false
    expect((await handleCodexHook('PermissionRequest', permission('mcp__github__delete_repo', { repo: 'x' }), ctx(off), withId())).stdout).toBe('')
    expect((await handleCodexHook('PermissionRequest', permission('Bash', { command: 'terraform apply' }), hctx(), withId())).stdout).toBe('')
  }))
})

describe.skipIf(CODEX === null || CODEX === undefined)('the consent rule against the real `codex execpolicy check` (isolated)', () => {
  test('the wrapper argv is a prompt; the forbidden rules still win', () => withSandbox(async ({ root, home }) => {
    const shim = join(home, '.buracle', 'bin', 'buracle')
    const rules = join(root, 'buracle.rules')
    writeFileSync(rules, renderRulesFile({ home, shim }))
    const env: Record<string, string | undefined> = {}
    for (const k of Object.keys(process.env)) env[k] = undefined
    Object.assign(env, { PATH: pathOf(...systemPathDirs(), '/opt/homebrew/bin', '/usr/local/bin'), HOME: home, CODEX_HOME: join(home, '.codex') })
    const check = async (argv: string[]) => JSON.parse((await run([CODEX as string, 'execpolicy', 'check', '--rules', rules, '--', ...argv], { env, timeoutMs: 30_000 })).stdout) as { decision?: string }
    expect((await check([shim, 'consent', 'run', ID, 'git push origin main'])).decision).toBe('prompt')
    expect((await check(['buracle', 'consent', 'run', ID, 'git push'])).decision).toBeUndefined()
    expect((await check(['rm', '-rf', '/'])).decision).toBe('forbidden')
  }), 60_000)
})
