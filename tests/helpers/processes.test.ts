import { describe, expect, test } from 'bun:test'
import { processRunning } from './processes'

describe('processRunning', () => {
  test('sees a running process by its command line, and no longer once it ended', async () => {
    const marker = `buracle-process-probe-${process.pid}-${Date.now()}`
    expect(processRunning(`${marker} [a-z]+`)).toBe(false)
    const child = Bun.spawn([process.execPath, '-e', 'setTimeout(() => {}, 20000)', marker, 'alive'], { stdout: 'ignore', stderr: 'ignore', env: { ...process.env } })
    try {
      let seen = false
      for (let i = 0; i < 100 && !seen; i++) {
        seen = processRunning(`${marker} [a-z]+`)
        if (!seen) await Bun.sleep(50)
      }
      expect(seen).toBe(true)
    } finally {
      child.kill('SIGKILL')
      await child.exited
    }
    expect(processRunning(`${marker} [a-z]+`)).toBe(false)
  }, 30_000)
})
