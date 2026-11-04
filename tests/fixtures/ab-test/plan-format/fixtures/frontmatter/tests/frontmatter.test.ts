import { expect, test } from 'bun:test'
import { parseFrontmatter } from '../src/frontmatter'

test('reads the key: value lines between the --- fences', () => {
  expect(parseFrontmatter('---\ntitle: Hello\nstatus: draft\n---\n# Hello\n')).toEqual({ title: 'Hello', status: 'draft' })
  expect(parseFrontmatter('---\nname:  spaced value  \n---\n')).toEqual({ name: 'spaced value' })
})

test('a document without a frontmatter block is an error', () => {
  expect(() => parseFrontmatter('# Hello\n')).toThrow('no frontmatter')
  expect(() => parseFrontmatter('---\ntitle: x\n')).toThrow('no frontmatter')
})
