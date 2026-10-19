import { describe, expect, test } from 'bun:test'
import { expandShellWord } from '../../src/engine/update/doctor'

const SHIM = '${BURACLE_HOME:-$HOME/.buracle}/bin/buracle'

describe('expandShellWord: the shim reference in hook and config files', () => {
  test('a POSIX home expands as the shell does', () => {
    expect(expandShellWord(SHIM, { HOME: '/home/me' })).toEqual({ value: '/home/me/.buracle/bin/buracle', missing: [] })
  })

  test('on Windows, where only USERPROFILE names the home, $HOME takes its value as Git Bash does', () => {
    expect(expandShellWord(SHIM, { USERPROFILE: 'C:\\Users\\me' })).toEqual({ value: 'C:\\Users\\me/.buracle/bin/buracle', missing: [] })
  })

  test('a variable missing inside a default is reported, so the check names it instead of a path that does not exist', () => {
    expect(expandShellWord(SHIM, {}).missing).toEqual(['HOME'])
  })

  test('BURACLE_HOME wins over the default', () => {
    expect(expandShellWord(SHIM, { BURACLE_HOME: '/opt/b', HOME: '/home/me' })).toEqual({ value: '/opt/b/bin/buracle', missing: [] })
  })
})
