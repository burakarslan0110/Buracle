import { describe, expect, test } from 'bun:test'
import { SUBAGENT_FLOW_COMMANDS, SUBAGENT_PLAN_COMMANDS, SUBAGENT_WORKTREE_COMMANDS, subagentCodeDenial, subagentStateDenial, subagentStateDenialAll } from '../../../src/core/policy/subagent-guard'

describe('subagentStateDenial (H01 for subagents)', () => {
  test('denies every state-changing plan and flow command, however the CLI is reached', () => {
    for (const sub of SUBAGENT_PLAN_COMMANDS) expect({ sub, denied: subagentStateDenial(`buracle plan ${sub} x`) !== undefined }).toEqual({ sub, denied: true })
    for (const sub of SUBAGENT_FLOW_COMMANDS) expect({ sub, denied: subagentStateDenial(`buracle flow ${sub} verify`) !== undefined }).toEqual({ sub, denied: true })
    for (const sub of SUBAGENT_WORKTREE_COMMANDS) expect({ sub, denied: subagentStateDenial(`buracle worktree ${sub} rate-limit`) !== undefined }).toEqual({ sub, denied: true })
    for (const command of [
      '"${BURACLE_HOME:-$HOME/.buracle}/bin/buracle" plan resume',
      'cd /repo && buracle plan pause --kind decision --reason "merge?"',
      'bash -c "buracle plan verify"',
      'bun src/cli/main.ts plan complete',
      'buracle --json plan set status IN_PROGRESS',
      'env FOO=1 buracle flow end --outcome done',
      'buracle worktree cleanup rate-limit --json',
      'buracle worktree cleanup rate-limit --discard',
      'buracle --json worktree cleanup rate-limit',
    ]) expect({ command, denied: subagentStateDenial(command) !== undefined }).toEqual({ command, denied: true })
  })

  test('a shell or runtime that runs the shim or the entry file does not hide the command', () => {
    for (const command of [
      'sh ~/.buracle/bin/buracle plan verify', 'bash /Users/u/.buracle/bin/buracle plan complete', 'zsh -f "${BURACLE_HOME:-$HOME/.buracle}/bin/buracle" flow end',
      'bash -o pipefail /Users/u/.buracle/bin/buracle plan set approved true', 'source /Users/u/.buracle/bin/buracle worktree cleanup x',
      'bun --bun /r/src/cli/main.ts plan set approved true', 'bun -r x /r/src/cli/main.ts plan complete', 'bun --cwd /r src/cli/main.ts worktree cleanup x',
      'node --import tsx /r/src/cli/main.ts worktree cleanup x', 'deno run -A /r/src/cli/main.ts plan verify',
    ]) expect({ command, denied: subagentStateDenial(command) !== undefined }).toEqual({ command, denied: true })
    for (const command of ['sh ~/.buracle/bin/buracle plan status', 'bun --bun /r/src/cli/main.ts plan validate docs/plans/x.md', 'bash script.sh plan verify']) {
      expect({ command, denied: subagentStateDenial(command) !== undefined }).toEqual({ command, denied: false })
    }
  })

  test('a value flag before the subcommand does not hide it: the CLI accepts flags anywhere', () => {
    for (const command of [
      'buracle plan --session abc pause',
      'buracle plan --harness claude resume',
      'buracle plan --reason "x" pause',
      'buracle plan --kind decision --reason "merge?" pause',
      'buracle plan --phase verify register docs/plans/x.md',
      'buracle flow --title "Verify" start verify',
      'buracle flow --outcome done end',
      'buracle flow --note n phase verify',
      'buracle plan --session=abc resume',
      'buracle plan -- pause',
    ]) expect({ command, denied: subagentStateDenial(command) !== undefined }).toEqual({ command, denied: true })
    for (const command of ['buracle plan --session abc status', 'buracle plan --strict validate docs/plans/x.md', 'buracle plan --base main audit', 'buracle plan review status', 'buracle plan review --json status']) {
      expect({ command, denied: subagentStateDenial(command) !== undefined }).toEqual({ command, denied: false })
    }
  })

  test('--lane exempts nothing any more: the plan lanes it served are gone, so a lane flag does not let a subagent change plan state', () => {
    for (const command of [
      'buracle plan register /r/x.md --phase plan --lane billing', 'buracle plan pause --lane billing --kind decision --reason "plan approval"',
      'buracle plan resume --lane=billing', 'buracle plan verify --lane billing --json', 'buracle plan set approved true --lane billing',
      'buracle plan approve-result --lane billing', 'buracle plan review done --role changes --verdict pass --lane billing',
    ]) expect({ command, denied: subagentStateDenial(command) !== undefined }).toEqual({ command, denied: true })
    expect(subagentStateDenial('buracle plan set approved true --lane billing')).toContain('`buracle plan set approved`')
    expect(subagentStateDenial('buracle plan review done --role plan --verdict pass')).not.toContain('--lane')
  })

  test('a lane does not start, collect or cancel a second opinion; the companion flags take a value, so one cannot pass for `review status`', () => {
    for (const command of [
      'buracle plan review companion start --role plan', 'buracle plan review companion collect --role changes --wait 90', 'buracle plan review companion cancel --role goal',
      'buracle plan review --on status companion start --role plan', 'buracle plan review --wait status companion collect', 'buracle plan review --goal status companion start --role changes',
    ]) expect({ command, denied: subagentStateDenial(command) !== undefined }).toEqual({ command, denied: true })
    expect(subagentStateDenial('buracle plan review companion start --role plan')).toContain('`buracle plan review`')
  })

  test('the denial names the command and tells the lane to report blocked to the lead', () => {
    const reason = subagentStateDenial('buracle plan pause --kind decision') ?? ''
    expect(reason).toContain('`buracle plan pause`')
    expect(reason).toContain('Return status `blocked` with the question and its options')
  })

  test('read-only commands and other text stay allowed', () => {
    for (const command of ['buracle plan status --json', 'buracle plan validate docs/plans/x.md --strict', 'buracle plan audit --json', 'buracle review-scope --json', 'buracle flow', 'echo "buracle plan pause"', 'rg "buracle plan pause" docs', 'bun test', '', 'buracle worktree diff rate-limit --json', 'buracle worktree status', 'buracle worktree --prefix sync create x']) {
      expect({ command, denied: subagentStateDenial(command) !== undefined }).toEqual({ command, denied: false })
    }
  })

  test('the sandbox and eval paths: any denied command among several, and the shell a script spawns', () => {
    expect(subagentStateDenialAll(['ls', 'buracle plan status', 'cd /r && buracle plan resume'])).toContain('`buracle plan resume`')
    expect(subagentStateDenialAll(['ls', 'buracle plan status --json'])).toBeUndefined()
    expect(subagentStateDenialAll([])).toBeUndefined()
    for (const [language, code] of [
      ['javascript', "require('child_process').execSync('buracle plan resume')"],
      ['js', "const { spawnSync } = require('node:child_process'); spawnSync('buracle', ['plan', 'pause', '--kind', 'decision'])"],
      ['js', 'await Bun.$`buracle worktree cleanup rate-limit`'],
      ['python', "import subprocess\nsubprocess.run(['buracle', 'flow', 'end', '--outcome', 'done'])"],
      ['py', "import os\nos.system('bun src/cli/main.ts plan set status IN_PROGRESS')"],
    ] as const) expect({ language, denied: subagentCodeDenial(code, language) !== undefined }).toEqual({ language, denied: true })
    for (const [language, code] of [
      ['js', "require('child_process').execSync('buracle plan status --json')"],
      ['js', "console.log('buracle plan resume')"],
      ['python', 'print(1 + 1)'],
    ] as const) expect({ code, denied: subagentCodeDenial(code, language) !== undefined }).toEqual({ code, denied: false })
  })
})
