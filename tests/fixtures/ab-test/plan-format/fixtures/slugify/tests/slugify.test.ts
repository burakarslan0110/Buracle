import { expect, test } from 'bun:test'
import { slugify } from '../src/slugify'

test('lower-cases, folds Turkish letters and joins words with one dash', () => {
  expect(slugify('Kurulum Başlar')).toBe('kurulum-baslar')
  expect(slugify('  İnceleme   sayfası! ')).toBe('inceleme-sayfasi')
  expect(slugify('ışık ğüşöç')).toBe('isik-gusoc')
})

test('an empty or blank title is an error', () => {
  expect(() => slugify('   ')).toThrow('empty title')
})
