import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { tildeFrom, tildeTextFrom } from '../../src/engine/update/output'

describe('home paths shown with ~', () => {
  test('a path under the home folder is ~/ and parts joined with /', () => {
    const home = join('/', 'h', 'u')
    expect(tildeFrom(home, home)).toBe('~')
    expect(tildeFrom(home, join(home, '.buracle', 'state', 'x.json'))).toBe('~/.buracle/state/x.json')
    expect(tildeFrom(home, join('/', 'elsewhere', 'x'))).toBe(join('/', 'elsewhere', 'x'))
  })

  test('in a message, the home folder becomes ~/', () => {
    expect(tildeTextFrom('/h/u', 'cannot read /h/u/.codex/config.toml: bad, /h/user stays')).toBe('cannot read ~/.codex/config.toml: bad, /h/user stays')
  })
})
