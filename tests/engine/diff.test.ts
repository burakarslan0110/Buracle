import { describe, expect, test } from 'bun:test'
import { unifiedDiff } from '../../src/engine/diff'

const L = { oldLabel: 'a/f', newLabel: 'b/f' }

describe('unifiedDiff', () => {
  test('equal texts produce no output', () => {
    expect(unifiedDiff('same\n', 'same\n', L)).toBe('')
  })

  test('single change with context', () => {
    const a = 'l1\nl2\nl3\nl4\nl5\nl6\nl7\n'
    const b = 'l1\nl2\nl3\nCHANGED\nl5\nl6\nl7\n'
    expect(unifiedDiff(a, b, L)).toBe('--- a/f\n+++ b/f\n@@ -1,7 +1,7 @@\n l1\n l2\n l3\n-l4\n+CHANGED\n l5\n l6\n l7\n')
  })

  test('file creation and deletion', () => {
    expect(unifiedDiff('', 'x\ny\n', { oldLabel: '/dev/null', newLabel: '/p' })).toBe('--- /dev/null\n+++ /p\n@@ -0,0 +1,2 @@\n+x\n+y\n')
    expect(unifiedDiff('x\n', '', { oldLabel: '/p', newLabel: '/dev/null' })).toBe('--- /p\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-x\n')
  })

  test('missing newline at end of file is shown', () => {
    expect(unifiedDiff('a\n', 'a', L)).toBe('--- a/f\n+++ b/f\n@@ -1,1 +1,1 @@\n-a\n+a\n\\ No newline at end of file\n')
  })

  test('distant changes become separate hunks', () => {
    const a = Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join('\n') + '\n'
    const b = a.replace('line2\n', 'two\n').replace('line19\n', 'nineteen\n')
    const d = unifiedDiff(a, b, L)
    expect(d.match(/^@@/gm)?.length).toBe(2)
    expect(d).toContain('@@ -1,5 +1,5 @@')
    expect(d).toContain('@@ -16,5 +16,5 @@')
  })
})
