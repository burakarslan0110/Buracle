import { describe, expect, test } from 'bun:test'
import { agyCompanionAgent } from '../../src/adapters/agy/plugin'
import { COMPANION_SETTINGS } from '../../src/core/config'
import { harnessProfile } from '../../src/core/harness/index'
import { AGY_PROMPT_MAX_BYTES, agyArgv, agyResultText, companionHost, companionTestHooks } from '../../src/workflow/companion-hosts'

describe('AGY as a second-opinion host', () => {
  test('the argv selects the companion agent, plan mode and JSON output, with the prompt as the last element', () => {
    const argv = agyArgv('review this')
    expect(argv).toEqual(['agy', '--agent', 'buracle-companion', '--mode', 'plan', '--output-format', 'json', '-p', 'review this'])
    expect(argv.at(-1)).toBe('review this')
  })

  test('a prompt over the limit is unavailable for the run and is not cut; one at the limit is passed whole', () => {
    expect(() => agyArgv('x'.repeat(AGY_PROMPT_MAX_BYTES + 1))).toThrow(/unavailable for this run/)
    // The limit counts bytes, not characters.
    expect(() => agyArgv('é'.repeat(AGY_PROMPT_MAX_BYTES / 2 + 1))).toThrow(/unavailable/)
    const ok = 'x'.repeat(AGY_PROMPT_MAX_BYTES)
    expect(agyArgv(ok).at(-1)).toBe(ok)
  })

  test('prepare feeds nothing on stdin, runs in the repository and keeps test-only extra arguments before -p', () => {
    const host = companionHost('agy')
    const run = host.prepare({ prompt: 'P', repo: '/some/repo', outDir: '/tmp', timeoutMs: 60_000, agent: {} as never })
    expect(run.stdin).toBe('')
    expect(run.cwd).toBe('/some/repo')
    expect(run.argv.at(-1)).toBe('P')
    companionTestHooks.extraArgs = h => (h === 'agy' ? ['--extra'] : [])
    try {
      const withExtra = host.prepare({ prompt: 'P', repo: '/some/repo', outDir: '/tmp', timeoutMs: 60_000, agent: {} as never })
      expect(withExtra.argv.at(-1)).toBe('P')
      expect(withExtra.argv.slice(-3)).toEqual(['--extra', '-p', 'P'])
    } finally { delete companionTestHooks.extraArgs }
  })

  test('the host is read-only: no shell, no scratch folder', () => {
    const host = companionHost('agy')
    expect(host.shell).toBe(false)
    expect(host.scratch).toBe(false)
  })

  test('JSON output: the text of the result; early ends and errors fail the attempt; anything else is read as text', () => {
    expect(agyResultText(JSON.stringify({ result: '{"verdict":"pass"}', conversation_id: 'c1' }))).toEqual({ ok: true, text: '{"verdict":"pass"}' })
    expect(agyResultText(JSON.stringify({ response: 'answer' }))).toEqual({ ok: true, text: 'answer' })
    const cut = agyResultText(JSON.stringify({ result: 'partial', finished_reason: 'print_timeout' }))
    expect(cut.ok).toBe(false)
    expect(cut.text).toContain('print_timeout')
    expect(agyResultText(JSON.stringify({ is_error: true, result: 'boom' }))).toEqual({ ok: false, text: 'boom' })
    expect(agyResultText('plain answer\n')).toEqual({ ok: true, text: 'plain answer\n' })
    expect(agyResultText('\u001b[1mbold\u001b[0m')).toEqual({ ok: true, text: 'bold' })
    expect(agyResultText('[1,2]')).toEqual({ ok: true, text: '[1,2]' })
    expect(agyResultText(JSON.stringify({ other: 1 }))).toEqual({ ok: true, text: '{"other":1}' })
  })

  test('the companion agent file: one read tool, no MCP, a main agent', () => {
    const f = agyCompanionAgent()
    expect(f.path).toBe('agents/buracle-companion.md')
    expect(f.content).toContain('tools: [read_file]')
    expect(f.content).toContain('inheritMcp: false')
    expect(f.content).toContain('mainAgent: true')
    expect(f.content).toContain('subagent: false')
    expect(f.content).not.toMatch(/run_command|edit_file|write_file|search_web|manage_task/)
  })

  test('the setting enum and the profile now include agy', () => {
    expect(COMPANION_SETTINGS).toContain('agy')
    expect(harnessProfile('agy').companionPending).toBeUndefined()
  })
})
