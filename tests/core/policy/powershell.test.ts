import { describe, expect, test } from 'bun:test'
import { decodeEncodedCommand, looksLikePowerShell, parseCmd, parsePowerShell } from '../../../src/core/policy/powershell'
import { DYN, HOME } from '../../../src/core/policy/shell'

const texts = (src: string): string[][] => parsePowerShell(src).statements.flatMap(s => s.stages.map(c => c.words.map(w => w.text)))

describe('parsePowerShell', () => {
  test('backslashes are path characters, the backtick escapes, quotes follow PowerShell', () => {
    expect(texts("Remove-Item -Recurse C:\\Users\\Me 'it''s' \"a`tb\" x`;y")).toEqual([['Remove-Item', '-Recurse', 'C:\\Users\\Me', "it's", 'a\tb', 'x;y']])
    expect(texts('a; b | c && d\ne')).toEqual([['a'], ['b'], ['c'], ['d'], ['e']])
    expect(texts('Get-Item x `\n  -Force')).toEqual([['Get-Item', 'x', '-Force']])
  })

  test('~, $HOME and $env:USERPROFILE are the home folder; other variables and subexpressions are unknown', () => {
    expect(texts('ri ~ $HOME\\x $env:USERPROFILE "$HOME\\y" $env:TEMP $(Get-Date)')).toEqual([['ri', HOME, `${HOME}\\x`, HOME, `${HOME}\\y`, DYN, DYN]])
  })

  test('assignments, keywords and expression statements; nested code is collected', () => {
    const s = parsePowerShell("$x = 'C:\\x'; $env:CODEX_HOME = 'D:\\c'; if ($a) { Remove-Item ~ } ; [IO.File]::Delete('y')")
    expect(s.statements.map(t => t.assign ?? t.keyword ?? t.expr)).toEqual([{ name: 'x', env: false, value: [expect.objectContaining({ text: 'C:\\x' })] },
      { name: 'codex_home', env: true, value: [expect.objectContaining({ text: 'D:\\c' })] }, 'if', "[IO.File]::Delete('y')"])
    expect(s.nested).toContain(' Remove-Item ~ ')
  })

  test('redirections, comments, here-strings and a bash here-document are not commands', () => {
    const s = parsePowerShell("git status 2>&1 > out.txt # rm -rf /\n<# Remove-Item ~ #>\n$t = @'\nRemove-Item ~\n'@\ncat <<'EOF'\nRemove-Item ~\nEOF\necho ok")
    expect(s.statements.flatMap(t => t.stages.map(c => c.words.map(w => w.text)))).toEqual([['git', 'status'], ['cat'], ['echo', 'ok']])
    expect(s.statements[0]?.stages[0]?.redirects.map(r => [r.op, r.target.text])).toEqual([['>', 'out.txt']])
  })
})

describe('parseCmd', () => {
  test('`^` escapes, quotes group, &, && and | separate, parenthesized blocks nest, %USERPROFILE% is home', () => {
    const s = parseCmd('rd /s /q "C:\\Program Files\\x" & del /q %USERPROFILE%\\*.tmp && echo a^&b > o.txt\nif exist x (rd /s /q x)')
    expect(s.commands.map(c => c.words.map(w => w.text))).toEqual([['rd', '/s', '/q', 'C:\\Program Files\\x'], ['del', '/q', `${HOME}\\*.tmp`], ['echo', 'a&b'], ['if', 'exist', 'x']])
    expect(s.commands[2]?.redirects.map(r => r.target.text)).toEqual(['o.txt'])
    expect(s.nested).toEqual(['rd /s /q x'])
  })
})

describe('looksLikePowerShell and decodeEncodedCommand', () => {
  test('PowerShell cmdlets, variables, parameters and backslash paths are signs; ordinary POSIX lines are not', () => {
    for (const c of ['Remove-Item x', '$env:X = 1', 'rm -r -fo C:\\x', 'ls -Recurse', 'cmd /c dir', "[IO.File]::Delete('x')", 'del .\\x']) expect({ c, ps: looksLikePowerShell(c) }).toEqual({ c, ps: true })
    for (const c of ['rm -rf build', 'git push origin main', 'ls -la', 'echo $HOME/x', 'find . -name x']) expect({ c, ps: looksLikePowerShell(c) }).toEqual({ c, ps: false })
  })

  test('-EncodedCommand is base64 of UTF-16LE; anything else is unreadable', () => {
    expect(decodeEncodedCommand('UgBlAG0AbwB2AGUALQBJAHQAZQBtACAAfgA=')).toBe('Remove-Item ~')
    for (const b of ['@@@', '', 'UgBl', 'AAAA']) expect({ b, d: decodeEncodedCommand(b) }).toEqual({ b, d: undefined })
  })
})
