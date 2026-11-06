import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { pickTip, TIP_TEXT_MAX, TIPS_MAX, validateTips, type Tip } from '../../src/core/tips'

describe('validateTips: the shape of canonical/tips.yaml', () => {
  test('the shipped list is valid', () => {
    const raw: unknown = parseYaml(readFileSync(join(import.meta.dir, '..', '..', 'canonical', 'tips.yaml'), 'utf8'))
    expect(validateTips(raw)).toEqual([])
  })

  test('rejects bad ids, duplicates, unknown keys, empty, multi-line and long texts', () => {
    const errs = validateTips({
      extra: 1,
      tips: [
        { id: 'Bad Id', text: 'x' },
        { id: 'a', text: 'one' },
        { id: 'a', text: 'two' },
        { id: 'b', text: ' ' },
        { id: 'c', text: 'line\nbreak' },
        { id: 'd', text: 'x'.repeat(TIP_TEXT_MAX + 1) },
        { id: 'e', text: 'ok', cooldown: 3 },
      ],
    })
    expect(errs).toEqual([
      '(root).extra: unknown key',
      "tips[0].id: expected lower-case letters, digits, '.', '_' and '-'",
      'tips[2].id: duplicate a',
      'tips[3].text: expected the tip',
      'tips[4].text: one line only',
      `tips[5].text: at most ${TIP_TEXT_MAX} characters`,
      'tips[6].cooldown: unknown key',
    ])
    expect(validateTips({ tips: Array.from({ length: TIPS_MAX + 1 }, (_, i) => ({ id: `t${i}`, text: 'x' })) })).toEqual([`(root).tips: at most ${TIPS_MAX} tips`])
    expect(validateTips([])).toEqual(['(root): expected { tips: [...] }'])
  })
})

describe('pickTip: one tip per draw', () => {
  const tips: Tip[] = [{ id: 'a', text: 'first' }, { id: 'b', text: 'second' }, { id: 'c', text: 'third' }]

  test('wraps any integer, negative ones included, onto the list', () => {
    expect([0, 1, 2, 3, -1, 7.9].map(n => pickTip(tips, n)?.id)).toEqual(['a', 'b', 'c', 'a', 'c', 'b'])
  })

  test('no tips, or only blank ones, gives nothing', () => {
    expect(pickTip(undefined, 4)).toBeUndefined()
    expect(pickTip([{ id: 'x', text: '  ' }], 0)).toBeUndefined()
  })
})
