import { describe, expect, test } from 'bun:test'
import { browserArgv } from '../../src/memory/ui'

describe('opening the page in a browser', () => {
  test('macOS runs `open`, Linux `xdg-open`, each with the address as one argument', () => {
    expect(browserArgv('http://127.0.0.1:41777/?scope=project%3Ashop', 'darwin')).toEqual(['open', 'http://127.0.0.1:41777/?scope=project%3Ashop'])
    expect(browserArgv('http://127.0.0.1:41777/review?doc=a&x=b', 'linux')).toEqual(['xdg-open', 'http://127.0.0.1:41777/review?doc=a&x=b'])
  })

  test('only an http(s) address is opened: a file, a script, a command or garbage is not', () => {
    for (const os of ['darwin', 'linux'] as const) {
      for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'calc.exe', '', 'C:\\Windows\\system32\\calc.exe', 'ftp://x/y', '-a Calculator']) expect(browserArgv(bad, os)).toBeUndefined()
      expect(browserArgv('https://example.com/a', os)?.at(-1)).toBe('https://example.com/a')
    }
  })
})
