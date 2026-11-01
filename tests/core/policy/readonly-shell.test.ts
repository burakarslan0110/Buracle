import { describe, expect, test } from 'bun:test'
import { readOnlyShellProblem, reviewerShellDenial } from '../../../src/core/policy/readonly-shell'

const problem = (command: string): string | undefined => readOnlyShellProblem(command)

describe('buracle commands in a read-only shell', () => {
  test('buracle diagram only draws, so it passes; a command that writes does not', () => {
    for (const command of ['buracle diagram --ascii', 'buracle diagram flow.mmd', "printf 'flowchart TD\\n  A --> B\\n' | buracle diagram"]) {
      expect({ command, problem: problem(command) }).toEqual({ command, problem: undefined })
    }
    expect(problem('buracle plan set approved true')).toContain('is not one of its read-only commands')
  })
})

describe('the read-only shell fence: no way to make a command run another program', () => {
  test('a leading variable that git or a tool reads is refused, also through env, a bare assignment or a loop variable', () => {
    for (const command of [
      "GIT_EXTERNAL_DIFF='touch pwn;true' git diff",
      "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.fsmonitor GIT_CONFIG_VALUE_0='touch pwn;true' git status",
      'env GIT_EXTERNAL_DIFF=x git diff', 'LD_PRELOAD=./x.so git status', 'DYLD_INSERT_LIBRARIES=./x.dylib rg foo', 'BASH_ENV=./x.sh git status',
      'PAGER=./x git log', 'PATH=/tmp/evil git status', 'PATH=/tmp/evil; git status', 'HOME=/tmp/evil git status', 'RIPGREP_CONFIG_PATH=./rc rg foo',
      'for PATH in /tmp/evil; do git status; done', 'printf -v PATH /tmp/evil; git status',
    ]) expect({ command, refused: problem(command) !== undefined }).toEqual({ command, refused: true })
  })

  test('locale, time zone and color variables, and lower-case variables of its own, stay allowed', () => {
    for (const command of [
      'LC_ALL=C sort file', 'LANG=C git log -1', 'TZ=UTC git log -1', 'NO_COLOR=1 rg foo', 'env LC_ALL=C sort x',
      'base=$(git merge-base HEAD main); git diff $base', 'for f in $(git ls-files); do cat $f; done', 'sha=abc123 git show abc123',
    ]) expect({ command, problem: problem(command) }).toEqual({ command, problem: undefined })
  })

  test('git grep -O and --open-files-in-pager run a program however they are spelled', () => {
    for (const command of [
      "git grep -O'touch pwn;true' pat", 'git grep -Otouch pat', 'git grep -nOtouch pat', 'git grep -O pat',
      'git grep --open-files-in-pager=touch pat', 'git grep --open=touch pat', 'git -C /r grep -O"touch x" pat',
    ]) expect({ command, refused: problem(command) !== undefined }).toEqual({ command, refused: true })
    for (const command of ['git grep -n -i pat', 'git grep -e foo -- src', 'git grep -c pat', 'git log --oneline -3']) expect({ command, problem: problem(command) }).toEqual({ command, problem: undefined })
  })

  test('rg --hostname-bin and --pre run a program', () => {
    expect(problem('rg --color=always --hostname-bin=./h.sh --hyperlink-format=default foo')).toBe('`rg --hostname-bin` runs another program')
    expect(problem('rg --hostname-bin ./h.sh foo')).toBe('`rg --hostname-bin` runs another program')
    expect(problem('rg --pre ./x foo')).toBe('`rg --pre` runs another program')
    expect(problem('rg --pre=./x foo')).toBe('`rg --pre` runs another program')
    for (const command of ['rg -n foo src', 'rg --hyperlink-format=default foo']) expect({ command, problem: problem(command) }).toEqual({ command, problem: undefined })
  })

  test('sort --compress-program runs a program and sort -o writes a file, also abbreviated', () => {
    for (const command of ['sort -S 1 --compress-program=./c.sh in.txt', 'sort --compress-program ./c.sh in.txt', 'sort --compress=./c.sh in.txt', 'sort --com ./c.sh in.txt']) {
      expect({ command, problem: problem(command) }).toEqual({ command, problem: '`sort --compress-program` runs another program' })
    }
    for (const command of ['sort -o out in.txt', 'sort --output=out in.txt', 'sort --out=out in.txt']) expect({ command, problem: problem(command) }).toEqual({ command, problem: '`sort -o` writes a file' })
    for (const command of ['sort -u x', 'sort -r -n x', 'sort -S 1 in.txt']) expect({ command, problem: problem(command) }).toEqual({ command, problem: undefined })
  })

  test('a review agent gets the problem as its denial; other agents are not judged', () => {
    expect(reviewerShellDenial('buracle:changes-review', "GIT_EXTERNAL_DIFF='touch x' git diff")).toContain('is a read-only reviewer')
    expect(reviewerShellDenial('general-purpose', "GIT_EXTERNAL_DIFF='touch x' git diff")).toBeUndefined()
    expect(reviewerShellDenial('buracle:changes-review', 'git diff --stat')).toBeUndefined()
  })
})
