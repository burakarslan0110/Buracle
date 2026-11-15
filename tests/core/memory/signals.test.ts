import { describe, expect, test } from 'bun:test'
import { profileCategory } from '../../../src/core/memory/signals'

describe('profile helpers', () => {
  test('a negative statement is always "avoid"; otherwise the category follows the topic', () => {
    expect(profileCategory('Never deploy on Fridays', -1)).toBe('avoid')
    expect(profileCategory('Reply in a concise tone')).toBe('communication')
    expect(profileCategory('Run the tests and verify the result')).toBe('quality')
    expect(profileCategory('Banana')).toBe('other')
  })
})
