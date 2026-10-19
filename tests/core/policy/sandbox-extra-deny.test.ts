import { describe, expect, test } from 'bun:test'
import type { Harness, ToolCall } from '../../../src/core/events'
import { classifyTool } from '../../../src/core/events'
import { checkBash, type BashGuardOptions } from '../../../src/core/policy/bash-guard'
import { harnessMcpToolName } from '../../../src/core/policy/routing'
import type { SandboxGuardOptions } from '../../../src/core/policy/sandbox'
import { checkSandbox } from '../../../src/core/policy/sandbox'

const HOME = '/Users/me'
const PROJ = '/Users/me/work/prod-api'
const APP = '/Users/me/code/app'
const REPO = '/Users/me/Desktop/Buracle Plugin/buracle'

function cm(tool: string, input: Record<string, unknown>, cwd = PROJ, h: Harness = 'claude'): ToolCall {
  const name = harnessMcpToolName(h, 'context-mode', tool)
  return { harness: h, sessionId: 's', cwd, tool: name, input, ...classifyTool(h, name, input, cwd, ['context-mode']) }
}
function opts(extraDeny: string[], cwd = PROJ): SandboxGuardOptions {
  return {
    bash: { extraDeny, home: HOME, selfPaths: { repo: REPO }, cwd },
    write: { cwd, home: HOME, vault: '~/Documents/Buracle', protect: [], selfPaths: { repo: REPO } },
    serverDir: cwd,
  }
}
const extra = { deny: expect.stringContaining('guards.bash.extraDeny'), hook: 'H01' as const }

describe("guards.bash.extraDeny and ctx_execute_file's header", () => {
  test('a pattern that names part of the project folder does not lock out ctx_execute_file reads', () => {
    const reads: Array<[string, string]> = [
      ['javascript', 'console.log(FILE_CONTENT.length)'],
      ['python', 'print(len(FILE_CONTENT))'],
      ['shell', 'wc -l <<< "$FILE_CONTENT"'],
      ['ruby', 'puts FILE_CONTENT.length'],
      ['php', 'echo strlen($FILE_CONTENT);'],
      ['perl', 'print length($FILE_CONTENT);'],
    ]
    for (const [language, code] of reads) {
      expect({ language, r: checkSandbox(cm('ctx_execute_file', { path: 'README.md', language, code }), opts(['prod'])) }).toEqual({ language, r: {} })
    }
    const bashOpts: BashGuardOptions = { extraDeny: ['prod'], home: HOME, cwd: PROJ }
    expect(checkBash('wc -l README.md', bashOpts)).toEqual({})
    expect(checkSandbox(cm('ctx_execute', { language: 'javascript', code: 'console.log(require("fs").readFileSync("README.md", "utf-8").length)' }), opts(['prod']))).toEqual({})
  })

  test("the executor's own read primitives do not trip a pattern the agent's code does not contain", () => {
    expect(checkSandbox(cm('ctx_execute_file', { path: 'data.csv', language: 'shell', code: 'wc -l <<< "$FILE_CONTENT"' }, APP), opts(['\\bcat\\b'], APP))).toEqual({})
    expect(checkSandbox(cm('ctx_execute_file', { path: 'README.md', language: 'javascript', code: 'console.log(FILE_CONTENT.length)' }, APP), opts(['readFileSync'], APP))).toEqual({})
    expect(checkSandbox(cm('ctx_execute_file', { path: 'README.md', language: 'python', code: 'print(len(FILE_CONTENT))' }, APP), opts(['open\\('], APP))).toEqual({})
  })

  test('patterns still meet the path the agent names, its code and the commands its code starts', () => {
    expect(checkSandbox(cm('ctx_execute_file', { path: 'db/backups/2024.sql', language: 'javascript', code: 'console.log(FILE_CONTENT.length)' }, APP), opts(['backup'], APP))).toEqual(extra)
    expect(checkSandbox(cm('ctx_execute_file', { path: 'README.md', language: 'javascript', code: "require('child_process').execSync('kubectl delete ns x')" }), opts(['kubectl\\s+delete']))).toEqual(extra)
    expect(checkSandbox(cm('ctx_execute_file', { path: 'README.md', language: 'python', code: "import os; os.system('kubectl delete ns x')" }), opts(['kubectl\\s+delete']))).toEqual(extra)
    expect(checkSandbox(cm('ctx_execute_file', { path: 'k8s.yaml', language: 'shell', code: 'kubectl delete -f "$FILE_CONTENT_PATH"' }), opts(['kubectl\\s+delete']))).toEqual(extra)
    expect(checkSandbox(cm('ctx_execute_file', { path: 'ns.txt', language: 'javascript', code: "require('child_process').execSync(`kubectl delete ns ${FILE_CONTENT.trim()}`)" }), opts(['kubectl\\s+delete']))).toEqual(extra)
  })

  test('writes through FILE_CONTENT_PATH / file_path are still judged with the header (security-1)', () => {
    const inHome = opts([], HOME)
    expect(checkSandbox(cm('ctx_execute_file', { path: '.buracle/bin/buracle', language: 'shell', code: 'printf "x" > "$file_path"' }, HOME), inHome).hook).toBe('H01')
    expect(checkSandbox(cm('ctx_execute_file', { path: '.codex/config.toml', language: 'python', code: "open(file_path, 'w').write('')" }, HOME), inHome)).toEqual({ deny: expect.stringContaining("Codex's own configuration"), hook: 'H02' })
    expect(checkSandbox(cm('ctx_execute_file', { path: '.codex/config.toml', language: 'python', code: "open(file_path, 'w').write('')" }, HOME), opts(['prod'], HOME))).toEqual({ deny: expect.stringContaining("Codex's own configuration"), hook: 'H02' })
  })
})
