import { describe, expect, test } from 'bun:test'
import { wslInterop } from '../../src/engine/platform'
import { desktopNotification, notify } from '../../src/workflow/notify'
import { withEnv, withSandbox } from '../helpers/sandbox'
import { ctxAt } from './fixture'

const PS = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'
const finds = (...names: string[]) => (n: string): string | undefined => (names.includes(n) ? (n === 'powershell.exe' ? PS : `/usr/bin/${n}`) : undefined)

describe('desktop notifications per host', () => {
  test('WSL: a Windows PowerShell tray balloon; the title and message travel in the environment only, passed on by WSLENV', () => {
    const evil = '"; Remove-Item -Recurse C:\\ ; "'
    const n = desktopNotification('wsl', 'attention_needed', 'Approval "now"; $(x)', evil, finds('powershell.exe', 'notify-send'), 'WT_SESSION:WT_PROFILE_ID/u')
    expect(n?.argv.slice(0, 6)).toEqual([PS, '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command'])
    expect(n?.argv).toHaveLength(7)
    for (const word of ['Remove-Item', 'Approval', '$(x)']) expect(n?.argv.join(' ')).not.toContain(word)
    expect(n?.env).toEqual({
      BURACLE_NOTIFY_TITLE: 'Buracle: Approval "now"; $(x)',
      BURACLE_NOTIFY_MESSAGE: evil,
      WSLENV: 'WT_SESSION:WT_PROFILE_ID/u:BURACLE_NOTIFY_TITLE/w:BURACLE_NOTIFY_MESSAGE/w',
    })
    expect(n?.detached).toBe(true)
  })

  test('WSL: an empty or missing WSLENV gets no leading colon, and one that already passes the texts is kept as it is', () => {
    const want = 'BURACLE_NOTIFY_TITLE/w:BURACLE_NOTIFY_MESSAGE/w'
    for (const old of [undefined, '']) expect(desktopNotification('wsl', 'info', 'a', 'b', finds('powershell.exe'), old)?.env?.['WSLENV']).toBe(want)
    expect(desktopNotification('wsl', 'info', 'a', 'b', finds('powershell.exe'), want)?.env?.['WSLENV']).toBe(want)
  })

  test('WSL without powershell.exe, or with interop off: nothing to show, never notify-send', () => {
    expect(desktopNotification('wsl', 'info', 'a', 'b', finds('notify-send'))).toBeUndefined()
    expect(desktopNotification('wsl-no-interop', 'info', 'a', 'b', finds('powershell.exe', 'notify-send'))).toBeUndefined()
  })

  test('macOS: osascript with the texts as arguments; Linux: notify-send when installed, else nothing', () => {
    const mac = desktopNotification('darwin', 'plan_approval', 'Plan ready', 'Waiting for your approval', finds())
    expect(mac?.argv[0]).toBe('osascript')
    expect(mac?.argv.slice(-4)).toEqual(['Buracle', 'Plan ready', 'Waiting for your approval', 'Glass'])
    expect(desktopNotification('linux', 'info', 'a', 'b', finds())).toBeUndefined()
    expect(desktopNotification('linux', 'info', 'a', 'b', finds('notify-send', 'powershell.exe'))?.argv).toEqual(['notify-send', '--app-name=Buracle', 'Buracle: a', 'b'])
  })

  // `desktop: false` is how a terminal that notifies on its own (herdr, cmux) keeps Buracle's banner from doubling it.
  test.skipIf(wslInterop())('desktop: false still records the notification and skips only the desktop banner', () => withSandbox(async ({ root }) => {
    await withEnv({ BURACLE_PLATFORM: 'linux' }, async () => {
      const env = { BURACLE_NO_NOTIFY: undefined, WSL_DISTRO_NAME: 'Ubuntu' }
      const quiet = await notify('attention_needed', 'T', 'M', { desktop: false }, ctxAt(root, undefined, env), undefined)
      expect(quiet.code).toBe(0)
      expect(quiet.data['delivery']).toEqual({ macos: 'skipped' })
      expect(quiet.data['recorded']).not.toBeNull()
      const normal = await notify('attention_needed', 'T', 'M', {}, ctxAt(root, undefined, env), undefined)
      expect(normal.data['delivery']).toEqual({ macos: 'unsupported' })
    })
  }))

  // On a real WSL machine with interop on, this would show a balloon; there the test skips.
  test.skipIf(wslInterop())('the notify command in WSL without interop reports the desktop as unsupported, with no error', () => withSandbox(async ({ root }) => {
    await withEnv({ BURACLE_PLATFORM: 'linux' }, async () => {
      const r = await notify('info', 'T', 'M', {}, ctxAt(root, undefined, { BURACLE_NO_NOTIFY: undefined, WSL_DISTRO_NAME: 'Ubuntu' }), undefined)
      expect(r.code).toBe(0)
      expect(r.errors).toEqual([])
      expect(r.data['delivery']).toEqual({ macos: 'unsupported' })
    })
  }))
})
