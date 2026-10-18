import { cpSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const FIXTURES = join(import.meta.dir, '..', 'fixtures', 'usage')

export const NOW = Date.parse('2026-10-08T09:00:00.000Z')

export function installFixture(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true })
  cpSync(join(FIXTURES, from), to, { recursive: true })
}

