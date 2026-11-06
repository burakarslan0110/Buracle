import { describe, expect, test } from 'bun:test'
import { editOf, emptyReceipt, isCheckCommand, lineDelta, longTurnText, maskSecrets, noteChanges, noteCommand, noteEdit, parseReceipt, receiptLine, shellFailed, unverified } from '../../src/core/receipt'

describe('isCheckCommand', () => {
  test.each(['bun test', 'bun test tests/a.test.ts', 'bunx tsc --noEmit -p .', 'npm test', 'pnpm run lint', 'pytest -q', 'python -m pytest', 'go test ./...', 'cargo check', 'claude plugin test harness/claude', 'buracle build --check', 'make test', 'ruff check .'])('%s verifies', c => {
    expect(isCheckCommand(c)).toBe(true)
  })
  test.each(['ls -la', 'git status', 'cat package.json', 'echo test', 'rg pytest', 'git commit -m "add tests"'])('%s does not', c => {
    expect(isCheckCommand(c)).toBe(false)
  })
})

describe('lineDelta', () => {
  test('counts like a diff stat, ignoring shared head and tail lines', () => {
    expect(lineDelta('a\nb\nc', 'a\nB\nc')).toEqual({ added: 1, removed: 1 })
    expect(lineDelta('', 'x\ny')).toEqual({ added: 2, removed: 0 })
    expect(lineDelta('x\ny\nz', 'x')).toEqual({ added: 0, removed: 2 })
    expect(lineDelta('same', 'same')).toEqual({ added: 0, removed: 0 })
  })
})

describe('receipt', () => {
  test('a code edit without a check after it is unverified; a passing check verifies it', () => {
    let s = noteEdit(emptyReceipt(), { path: 'src/a.ts', added: 3, removed: 1 }).state
    expect(unverified(s)).toBe(true)
    expect(receiptLine(s)?.line).toBe('Buracle · 1 file (+3 −1) · ⚠ unverified change')
    s = noteCommand(s, 'bun test', false).state
    expect(unverified(s)).toBe(false)
    expect(receiptLine(s)?.line).toBe('Buracle · 1 file (+3 −1) · 1 command · ✓ checked')
    s = noteEdit(s, { path: 'src/a.ts', added: 1, removed: 0 }).state
    expect(unverified(s)).toBe(true)
  })

  test('prose edits need no check; a failed check is reported', () => {
    let s = noteEdit(emptyReceipt(), { path: 'README.md', added: 2, removed: 0 }).state
    expect(unverified(s)).toBe(false)
    s = noteCommand(s, 'bun test', true).state
    expect(receiptLine(s)).toEqual({ line: 'Buracle · 1 file (+2 −0) · 1 command (1 failed) · ✗ last check failed', warn: true })
    s = noteEdit(s, { path: 'docs/b.md', added: 1, removed: 1 }).state
    s = noteCommand(s, 'git status', false).state
    expect(receiptLine(s)?.line).toBe('Buracle · 2 files (+3 −1) · 2 commands (1 failed) · ✗ last check failed')
  })

  test('an unverified change gets the same warning whatever the answer says: the receipt reads no claims', () => {
    const s = noteEdit(emptyReceipt(), { path: 'src/a.py', added: 1, removed: 1 }).state
    expect(receiptLine(s)).toEqual({ line: 'Buracle · 1 file (+1 −1) · ⚠ unverified change', warn: true })
  })

  test('the third same failure in a row raises a loop alarm; an edit resets the streak', () => {
    let s = emptyReceipt()
    let alarm: string | undefined
    for (let i = 0; i < 3; i++) ({ state: s, alarm } = noteCommand(s, 'bun test', true))
    expect(alarm).toBe('the same command failed 3 times in a row: `bun test` (do not run it again as is; read the output and change your hypothesis)')
    s = noteEdit(s, { path: 'src/a.ts', added: 1, removed: 1 }).state
    ;({ alarm } = noteCommand(s, 'bun test', true))
    expect(alarm).toBeUndefined()
  })

  test('an edit that puts back what an earlier edit removed, twice, is a flip-flop', () => {
    let s = emptyReceipt()
    const alarms: string[] = []
    const edit = (removedText: string, addedText: string) => {
      const r = noteEdit(s, { path: 'a.ts', added: 1, removed: 1, removedText, addedText })
      s = r.state
      if (r.alarm !== undefined) alarms.push(r.alarm)
    }
    edit('const x = 1', 'const x = 2')
    edit('const x = 2', 'const x = 1')
    expect(alarms).toEqual([])
    edit('const x = 1', 'const x = 2')
    expect(alarms).toHaveLength(1)
    expect(alarms[0]).toBe('a.ts: the same change was undone and redone twice (you may be going in circles; rethink the approach)')
    edit('const x = 2', 'const x = 1')
    expect(alarms).toHaveLength(1)
  })

  test('an empty turn has no receipt', () => {
    expect(receiptLine(emptyReceipt())).toBeUndefined()
  })
})

describe('what the command-hook harnesses keep between hook runs', () => {
  test('noteChanges counts each file of a multi-file edit and keeps the flip-flop texts', () => {
    let s = noteChanges(emptyReceipt(), [{ path: 'src/a.ts', removed: 'a\nb', added: 'a\nB\nC' }, { path: 'README.md', removed: '', added: 'x' }, { path: '', removed: '', added: 'ignored' }]).state
    expect(receiptLine(s)?.line).toBe('Buracle · 2 files (+3 −1) · ⚠ unverified change')
    const alarms: string[] = []
    for (const [removed, added] of [['x = 1', 'x = 2'], ['x = 2', 'x = 1'], ['x = 1', 'x = 2']] as const) {
      const r = noteChanges(s, [{ path: 'src/b.ts', removed, added }])
      s = r.state
      if (r.alarm !== undefined) alarms.push(r.alarm)
    }
    expect(alarms).toEqual(['src/b.ts: the same change was undone and redone twice (you may be going in circles; rethink the approach)'])
  })

  test('parseReceipt restores a saved state exactly and repairs a broken one', () => {
    let s = noteChanges(emptyReceipt(), [{ path: 'src/a.ts', removed: 'x', added: 'y' }]).state
    s = noteCommand(s, 'bun test', true).state
    s = noteCommand(s, 'bun test', true).state
    const back = parseReceipt(JSON.parse(JSON.stringify(s)))
    expect(back).toEqual(s)
    expect(noteCommand(back, 'bun test', true).alarm).toContain('failed 3 times in a row')
    expect(parseReceipt(undefined)).toEqual(emptyReceipt())
    expect(parseReceipt({ edits: { 'a.ts': { added: -3, removed: 'x' } }, commands: [{ command: 7 }, { command: 'ls' }], seq: 'two', failStreak: { count: 2 } })).toEqual({
      ...emptyReceipt(), edits: { 'a.ts': { added: 0, removed: 0 } }, commands: [{ command: 'ls', failed: false, check: false }],
    })
  })

  test('longTurnText: only a turn at least notifyAfterSec long, rounded to whole minutes; 0 turns it off', () => {
    expect(longTurnText(119_000, 120)).toBeUndefined()
    expect(longTurnText(120_000, 120)).toBe('Turn finished after 2 min')
    expect(longTurnText(185_000, 120, 'plan-build (phase Implement)')).toBe('Turn finished after 3 min: plan-build (phase Implement)')
    expect(longTurnText(10 * 60_000, 0)).toBeUndefined()
    expect(longTurnText(Number.NaN, 120)).toBeUndefined()
  })
})

describe('what the mod reads from tool calls', () => {
  test('editOf: the file and the text an edit removed and added', () => {
    expect(editOf('Edit', { file_path: '/r/a.ts', old_string: 'a', new_string: 'b' })).toEqual({ path: '/r/a.ts', removed: 'a', added: 'b' })
    expect(editOf('Write', { file_path: '/r/b.ts', content: 'x\ny' })).toEqual({ path: '/r/b.ts', removed: '', added: 'x\ny' })
    expect(editOf('NotebookEdit', { notebook_path: '/r/n.ipynb', new_source: 'print(1)' })).toEqual({ path: '/r/n.ipynb', removed: '', added: 'print(1)' })
    expect(editOf('MultiEdit', { file_path: '/r/c.ts', edits: [{ old_string: 'a', new_string: 'b' }, null, { old_string: 'c', new_string: 'd' }] })).toEqual({ path: '/r/c.ts', removed: 'a\nc\n', added: 'b\nd\n' })
    expect(editOf('Edit', { old_string: 'a' })).toBeUndefined()
  })

  test('shellFailed: an exit code other than 0, or an interrupt', () => {
    expect(shellFailed({ exitCode: 1 })).toBe(true)
    expect(shellFailed({ returnCode: 0, interrupted: true })).toBe(false)
    expect(shellFailed({ stdout: 'x', interrupted: true })).toBe(true)
    expect(shellFailed({ stdout: 'x' })).toBe(false)
    expect(shellFailed('exit 1')).toBe(false)
  })

  test('maskSecrets: every string of a result, bounded; a clean value comes back as it was', () => {
    const key = 'AKIA' + 'IOSFODNN7EXAMPLE'
    const r = maskSecrets({ file: { content: `AWS_ACCESS_KEY_ID=${key}\n`, lines: [`id ${key} here`, 'short'] }, n: 3 }, 400_000)
    expect(r.count).toBe(2)
    expect(JSON.stringify(r.value)).not.toContain(key)
    const clean = { stdout: 'nothing secret in this output', code: 0 }
    expect(maskSecrets(clean, 400_000)).toEqual({ value: clean, count: 0 })
    expect(maskSecrets(clean, 400_000).value).toBe(clean)
    expect(maskSecrets(`x${key}`.padEnd(64, 'y'), 32).count).toBe(0)
  })

  // The base64 of 1536 pseudo-random bytes from a fixed seed: deterministic, and as bare text it reads like a key.
  const B64 = (() => {
    let seed = 0x2545f491
    const bytes = new Uint8Array(1536)
    for (let i = 0; i < bytes.length; i++) { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; bytes[i] = seed >>> 24 }
    return btoa(String.fromCharCode(...bytes))
  })()
  const KEY = 'AKIA' + 'IOSFODNN7EXAMPLE'

  test('maskSecrets: as bare text the payload used below is masked (the cases are not vacuous)', () => {
    expect(maskSecrets(B64, 400_000)).toEqual({ value: '[REDACTED:entropy]', count: 1 })
  })

  test.each<[string, unknown]>([
    ['an image Read returns', { type: 'image', file: { base64: B64, type: 'image/png', originalSize: 1536, dimensions: { width: 4, height: 4 } } }],
    ['a notebook cell image Read returns', { type: 'notebook', file: { filePath: 'plot.ipynb', cells: [{ cell_type: 'code', source: 'plt.show()', outputs: [{ output_type: 'display_data', image: { image_data: B64, media_type: 'image/png' } }] }] } }],
    ['an API image block', [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: B64 } }]],
    ['an API document block (a PDF)', { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: B64 } }],
    ['an MCP image block', [{ type: 'image', data: B64, mimeType: 'image/png' }]],
    ['an MCP audio block', [{ type: 'audio', data: B64, mimeType: 'audio/wav' }]],
    ['an MCP resource with a binary blob', { type: 'resource', resource: { uri: 'file:///a.pdf', mimeType: 'application/pdf', blob: B64 } }],
    ['an MCP resource blob without a declared type', { type: 'resource', resource: { uri: 'file:///a.bin', blob: B64 } }],
    ['a Bash stdout that is an image data URI', { stdout: `data:image/png;base64,${B64}`, stderr: '', interrupted: false, isImage: true }],
  ])('maskSecrets: %s passes through as it is', (_name, value) => {
    const r = maskSecrets(value, 400_000)
    expect(r.count).toBe(0)
    expect(r.value).toBe(value)
  })

  test('maskSecrets: text next to a binary payload is still masked, and the payload stays', () => {
    const blocks = [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: B64 } }, { type: 'text', text: `token ${KEY}` }]
    const r = maskSecrets(blocks, 400_000)
    expect(r.count).toBe(1)
    expect(JSON.stringify(r.value)).toContain(B64)
    expect(JSON.stringify(r.value)).not.toContain(KEY)
  })

  test.each<[string, unknown]>([
    ['data without a type', { data: KEY }],
    ['data of a text type', { data: KEY, mimeType: 'text/plain' }],
    ['data of a JSON type', { data: KEY, mimeType: 'application/json; charset=utf-8' }],
    ['data of a vendor text type', { data: KEY, mimeType: 'application/x-yaml' }],
    ['a blob without a uri or a type', { blob: B64 }],
    ['a resource blob of a text type', { type: 'resource', resource: { uri: 'file:///a.txt', mimeType: 'text/plain', blob: B64 } }],
    ['image_data without a media type', { image: { image_data: B64 } }],
    ['a data URI of a text type', { stdout: `data:text/plain;base64,${B64}` }],
    ['a plain stdout', { stdout: `key ${KEY}` }],
  ])('maskSecrets: %s is masked as before', (_name, value) => {
    const r = maskSecrets(value, 400_000)
    expect(r.count).toBe(1)
    expect(JSON.stringify(r.value)).not.toContain(KEY)
    expect(JSON.stringify(r.value)).not.toContain(B64)
  })
})
