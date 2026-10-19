import { describe, expect, test } from 'bun:test'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  applyPatchChunks, claudeChanges, codexPatchChanges, CONFIG_PARSERS, guardedContents, ompChanges, opencodeChanges, parsePatchSections, patchChanges, replaceText,
} from '../../../src/adapters/shared/write-content'
import { realWriteTarget } from '../../../src/adapters/shared/realpath'
import { parseApplyPatch } from '../../../src/core/events'
import { withSandbox } from '../../helpers/sandbox'

const patch = (...body: string[]): string => ['*** Begin Patch', ...body, '*** End Patch'].join('\n')
const fromFiles = (files: Record<string, string>) => (p: string): string | undefined => (Object.prototype.hasOwnProperty.call(files, p) ? files[p] : '')

describe('replaceText', () => {
  test('one occurrence is replaced; a missing or repeated old text has no certain result', () => {
    expect(replaceText('a b c', { old: 'b', new: 'B' })).toBe('a B c')
    expect(replaceText('a b c', { old: 'x', new: 'B' })).toBeUndefined()
    expect(replaceText('b b', { old: 'b', new: 'B' })).toBeUndefined()
    expect(replaceText('b b', { old: 'b', new: 'B', all: true })).toBe('B B')
    expect(replaceText('', { old: '', new: 'new file' })).toBe('new file')
    expect(replaceText('x', { old: '', new: 'y' })).toBeUndefined()
  })

  test('a replacement text a JavaScript replace would expand has no certain result', () => {
    for (const p of ['$&', "$'", '$`', '$1', '$<n>', '$$']) expect(replaceText('a b', { old: 'b', new: `x${p}` })).toBeUndefined()
    expect(replaceText('a b', { old: 'b', new: 'export PATH="$HOME/bin:$PATH"' })).toBe('a export PATH="$HOME/bin:$PATH"')
  })
})

describe('apply_patch envelopes', () => {
  test('sections are read as Codex reads them; text it would refuse is not followed', () => {
    expect(parsePatchSections(patch('*** Add File: a.txt', '+one', '+two', '*** Delete File: b.txt', '*** Update File: c.txt', '*** Move to: d.txt', '@@ ctx', ' keep', '-old', '+new'))).toEqual([
      { kind: 'add', path: 'a.txt', lines: ['one', 'two'] },
      { kind: 'delete', path: 'b.txt' },
      { kind: 'update', path: 'c.txt', moveTo: 'd.txt', chunks: [{ context: 'ctx', old: ['keep', 'old'], new: ['keep', 'new'], eof: false }] },
    ])
    expect(parsePatchSections(patch('[.claude/settings.json#a1b2]', 'PUT 2.=2:', '+"x": 1'))).toBeUndefined()
    expect(parsePatchSections('*** Add File: a.txt\n+x')).toBeUndefined()
    expect(parsePatchSections(patch('*** Update File: a.txt'))).toBeUndefined()
    expect(parsePatchSections(patch('*** Add File: a.txt', '+x', 'stray'))).toBeUndefined()
    expect(parsePatchSections(patch('*** Update File: a.txt', '@@', ' a', '+b', 'stray'))).toBeUndefined()
  })

  test('hunks are applied as Codex applies them: in order, after their context line, white space tolerated, a final newline kept', () => {
    const text = '{\n  "a": 1,\n  "b": 2\n}\n'
    const [s] = parsePatchSections(patch('*** Update File: f.json', '@@', '   "a": 1,', '-  "b": 2', '+  "b": 3', '+  ,"c": 4')) ?? []
    expect(applyPatchChunks(text, s?.chunks ?? [])).toBe('{\n  "a": 1,\n  "b": 3\n  ,"c": 4\n}\n')
    const [t] = parsePatchSections(patch('*** Update File: f', '@@', '-x', '+y')) ?? []
    expect(applyPatchChunks('x   \nz', t?.chunks ?? [])).toBe('y\nz\n')
    const [u] = parsePatchSections(patch('*** Update File: f', '@@', '+tail')) ?? []
    expect(applyPatchChunks('a\n', u?.chunks ?? [])).toBe('a\ntail\n')
    const [v] = parsePatchSections(patch('*** Update File: f', '@@', '-nope', '+y')) ?? []
    expect(applyPatchChunks('a\n', v?.chunks ?? [])).toBeUndefined()
    const [w] = parsePatchSections(patch('*** Update File: f', '@@', '-x', '+y', '*** End of File')) ?? []
    expect(applyPatchChunks('x\nm\nx\n', w?.chunks ?? [])).toBe('x\nm\ny\n')
  })

  test('changes are keyed like core parseApplyPatch; moved-away, deleted and twice-named files get none', () => {
    const text = patch('*** Add File: n.txt', '+hi', '*** Update File: u.txt', '@@', '-a', '+b', '*** Update File: m.txt', '*** Move to: dest.txt', '@@', '-a', '+c', '*** Delete File: gone.txt')
    const changes = patchChanges(text, '/w')
    expect(changes.map(c => c.file)).toEqual(['/w/n.txt', '/w/u.txt', '/w/dest.txt'])
    expect(parseApplyPatch(text, '/w').paths).toEqual(expect.arrayContaining(changes.map(c => c.file)))
    const read = fromFiles({ '/w/u.txt': 'a\n', '/w/m.txt': 'a\n' })
    expect(changes.map(c => c.after(read))).toEqual(['hi\n', 'b\n', 'c\n'])
    expect(patchChanges(patch('*** Add File: x', '+1', '*** Update File: x', '@@', '-1', '+2'), '/w')).toEqual([])
    expect(patchChanges(patch('*** Add File: ~/.zshrc', '+x'), '/w', '/h').map(c => c.file)).toEqual(['/h/.zshrc'])
    expect(codexPatchChanges({ command: patch('*** Add File: ~/.zshrc', '+x') }, '/w').map(c => c.file)).toEqual(['/w/~/.zshrc'])
  })
})

describe('the harnesses\' file tools', () => {
  test('Claude, OpenCode and omp edits and writes', () => {
    const read = fromFiles({ '/p/f': 'a b c' })
    expect(claudeChanges('Edit', { old_string: 'b', new_string: 'B' }, ['/p/f'])[0]?.after(read)).toBe('a B c')
    expect(claudeChanges('MultiEdit', { edits: [{ old_string: 'a', new_string: 'A' }, { old_string: 'c', new_string: 'C' }] }, ['/p/f'])[0]?.after(read)).toBe('A b C')
    expect(claudeChanges('NotebookEdit', { new_source: 'x' }, ['/p/f'])).toEqual([])
    expect(opencodeChanges('edit', { filePath: '/p/f', oldString: 'b', newString: 'B' }, ['/p/f'], '/p', '/h')[0]?.after(read)).toBe('a B c')
    expect(opencodeChanges('multiedit', { filePath: '/p/f', edits: [{ oldString: 'a', newString: 'A' }] }, ['/p/f'], '/p', '/h')[0]?.after(read)).toBe('A b c')
    expect(opencodeChanges('write', { filePath: '/p/f', content: 'w' }, ['/p/f'], '/p', '/h')[0]?.after(read)).toBe('w')
    expect(opencodeChanges('apply_patch', { patchText: patch('*** Update File: f', '@@', '-a b c', '+x') }, [], '/p', '/h')[0]?.after(read)).toBe('x\n')
    expect(ompChanges('edit', { path: '/p/f', old_text: 'b', new_text: 'B' }, ['/p/f'], '/p', '/h')[0]?.after(read)).toBe('a B c')
    expect(ompChanges('edit', { input: patch('*** Update File: f', '@@', '-a b c', '+y') }, ['/p/f'], '/p', '/h')[0]?.after(read)).toBe('y\n')
    expect(ompChanges('edit', { input: '[f#a1b2]\nPUT 1.=1:\n+z' }, ['/p/f'], '/p', '/h')).toEqual([])
    expect(ompChanges('write', { path: '/p/f', content: 'w' }, ['/p/f'], '/p', '/h')[0]?.after(read)).toBe('w')
  })

  test('guardedContents reads only guarded files, keeps `before`, and leaves out what it cannot work out', () => withSandbox(async ({ root, home }) => {
    const proj = join(root, 'proj')
    mkdirSync(join(proj, '.claude'), { recursive: true })
    const settings = join(proj, '.claude', 'settings.json')
    writeFileSync(settings, '{ "permissions": {} }\n')
    const plain = join(proj, 'a.ts')
    let reads = 0
    const read = (p: string): string | undefined => { reads++; return p === settings ? '{ "permissions": {} }\n' : '' }
    const changes = claudeChanges('Edit', { old_string: '{}', new_string: '{ "allow": [] }' }, [settings, plain])
    expect(guardedContents(changes, [settings, plain], home, { read })).toEqual({ [settings]: { after: '{ "permissions": { "allow": [] } }\n', before: '{ "permissions": {} }\n' } })
    expect(reads).toBe(2)
    expect(guardedContents(claudeChanges('Edit', { old_string: 'nope', new_string: 'x' }, [settings]), [settings], home)).toEqual({})
    const fresh = join(proj, '.codex', 'config.toml')
    expect(guardedContents(claudeChanges('Write', { content: 'x = 1\n' }, [fresh]), [fresh], home)).toEqual({ [fresh]: { after: 'x = 1\n' } })
    const link = join(root, 'link.json')
    symlinkSync(settings, link)
    expect(guardedContents(claudeChanges('Write', { content: '{}' }, [settings]), [link], home, { realpath: realWriteTarget })).toEqual({ [link]: { after: '{}', before: '{ "permissions": {} }\n' } })
  }))
})

describe('CONFIG_PARSERS', () => {
  test('JSON with comments, TOML and YAML parse; broken text throws', () => {
    expect(CONFIG_PARSERS.jsonc?.('{ // c\n "a": [1,], }')).toEqual({ a: [1] })
    expect(() => CONFIG_PARSERS.jsonc?.('{ "a": ')).toThrow()
    expect(CONFIG_PARSERS.toml?.('[features]\nhooks = false\n')).toEqual({ features: { hooks: false } })
    expect(() => CONFIG_PARSERS.toml?.('[features\n')).toThrow()
    expect(CONFIG_PARSERS.yaml?.('disabled:\n  - x\n')).toEqual({ disabled: ['x'] })
  })
})
