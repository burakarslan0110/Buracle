import { describe, expect, test } from 'bun:test'
import { desktopNotification, notify } from '../../src/workflow/notify'
import { withEnv, withSandbox } from '../helpers/sandbox'
import { ctxAt } from './fixture'

const finds = (...names: string[]) => (n: string): string | undefined => (names.includes(n) ? `/usr/bin/${n}` : undefined)

describe('desktop notifications per host', () => {
  test('macOS: osascript with the texts as arguments; Linux: notify-send when installed, else nothing', () => {
    const mac = desktopNotification('darwin', 'plan_approval', 'Plan ready', 'Waiting for your approval', finds())
    expect(mac?.argv[0]).toBe('osascript')
    expect(mac?.argv.slice(-4)).toEqual(['Buracle', 'Plan ready', 'Waiting for your approval', 'Glass'])
    expect(desktopNotification('linux', 'info', 'a', 'b', finds())).toBeUndefined()
    expect(desktopNotification('linux', 'info', 'a', 'b', finds('notify-send'))?.argv).toEqual(['notify-send', '--app-name=Buracle', 'Buracle: a', 'b'])
  })

  // `desktop: false` is how a terminal that notifies on its own (herdr, cmux) keeps Buracle's banner from doubling it.
  test('desktop: false still records the notification and skips only the desktop banner', () => withSandbox(async ({ root }) => {
    await withEnv({ BURACLE_PLATFORM: 'linux' }, async () => {
      const env = { BURACLE_NO_NOTIFY: undefined }
      const quiet = await notify('attention_needed', 'T', 'M', { desktop: false }, ctxAt(root, undefined, env), undefined)
      expect(quiet.code).toBe(0)
      expect(quiet.data['delivery']).toEqual({ macos: 'skipped' })
      expect(quiet.data['recorded']).not.toBeNull()
      const normal = await notify('attention_needed', 'T', 'M', {}, ctxAt(root, undefined, env), undefined)
      expect(normal.data['delivery']).toEqual({ macos: 'unsupported' })
    })
  }))
})
