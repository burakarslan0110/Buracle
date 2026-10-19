import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { tildeFrom, tildeTextFrom } from '../../src/engine/update/output'
import { withEnv } from '../helpers/sandbox'

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

  test('on Windows a message spells the home folder either way and in any case; the rest of that path gets / too', () => withEnv({ BURACLE_PLATFORM: 'win32' }, () => {
    const home = 'C:\\Users\\me'
    expect(tildeTextFrom(home, 'cannot read C:\\Users\\me\\.buracle\\state\\x.json: bad JSON')).toBe('cannot read ~/.buracle/state/x.json: bad JSON')
    expect(tildeTextFrom(home, 'git: C:/Users/me/code/app is dirty; c:\\users\\ME\\x and "C:\\Users\\me\\a b"')).toBe('git: ~/code/app is dirty; ~/x and "~/a b"')
    expect(tildeTextFrom(home, 'C:\\Users\\meg\\x and D:\\Users\\me\\y stay')).toBe('C:\\Users\\meg\\x and D:\\Users\\me\\y stay')
  }))
})
