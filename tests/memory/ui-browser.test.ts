import { describe, expect, test } from 'bun:test'
import { browserArgv, openInBrowser } from '../../src/memory/ui'

const RUNDLL = '/mnt/c/Windows/System32/rundll32.exe'
const finds = (...names: string[]) => (n: string): string | undefined => (n === 'rundll32.exe' && names.includes(n) ? RUNDLL : names.includes(n) ? `/usr/bin/${n}` : undefined)

describe('opening the page in a browser', () => {
  test('macOS runs `open`, Linux `xdg-open`, each with the address as one argument', () => {
    expect(browserArgv('http://127.0.0.1:41777/?scope=project%3Ashop', 'darwin')).toEqual(['open', 'http://127.0.0.1:41777/?scope=project%3Ashop'])
    expect(browserArgv('http://127.0.0.1:41777/review?doc=a&x=b', 'linux')).toEqual(['xdg-open', 'http://127.0.0.1:41777/review?doc=a&x=b'])
  })

  test('WSL goes through the Windows rundll32.exe, never cmd.exe or xdg-open: & and spaces in the address stay inside one argument', () => {
    const argv = browserArgv('http://127.0.0.1:41777/review?doc=my plan&x=1%252', 'wsl', finds('rundll32.exe', 'wslview', 'xdg-open'))
    expect(argv).toEqual([RUNDLL, 'url.dll,FileProtocolHandler', 'http://127.0.0.1:41777/review?doc=my%20plan&x=1%252'])
    expect(argv?.join(' ')).not.toMatch(/cmd|start|xdg-open|explorer/i)
    expect(argv).toHaveLength(3)
  })

  test('WSL without rundll32.exe uses wslview; with neither, or with interop off, nothing opens', () => {
    expect(browserArgv('http://127.0.0.1:41777/', 'wsl', finds('wslview', 'xdg-open'))).toEqual(['/usr/bin/wslview', 'http://127.0.0.1:41777/'])
    expect(browserArgv('http://127.0.0.1:41777/', 'wsl', finds('xdg-open'))).toBeUndefined()
    expect(browserArgv('http://127.0.0.1:41777/', 'wsl-no-interop', finds('rundll32.exe', 'wslview', 'xdg-open'))).toBeUndefined()
    expect(openInBrowser('http://127.0.0.1:41777/', 'wsl-no-interop')).toBe(false)
  })

  test('only an http(s) address is opened: a file, a script, a command or garbage is not', () => {
    for (const os of ['darwin', 'linux', 'wsl'] as const) {
      for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'calc.exe', '', 'C:\\Windows\\system32\\calc.exe', 'ftp://x/y', '-a Calculator']) expect(browserArgv(bad, os, finds('rundll32.exe'))).toBeUndefined()
      expect(browserArgv('https://example.com/a', os, finds('rundll32.exe'))?.at(-1)).toBe('https://example.com/a')
    }
  })
})
