import { test } from 'bun:test'

export function isNotImplemented(e: unknown): boolean {
  return e instanceof Error && /^not implemented: /.test(e.message)
}

export function stillStubbed(probe: () => unknown): boolean {
  try {
    const r = probe()
    if (r instanceof Promise) r.catch(() => undefined)
    return false
  } catch (e) {
    return isNotImplemented(e)
  }
}

export function testWhenImplemented(name: string, probe: () => unknown, fn: () => unknown | Promise<unknown>): void {
  if (stillStubbed(probe)) test.skip(`${name} [waiting for stub: ${name}]`, () => undefined)
  else test(name, fn as () => void)
}
