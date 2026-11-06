import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MIN_CLAUDE } from '../../src/adapters/claude/constants'
import { MIN_CODEX } from '../../src/adapters/codex/doctor'
import { OMP_MIN_VERSION } from '../../src/adapters/omp/generated'
import { MIN_VERSION as OPENCODE_MIN } from '../../src/adapters/opencode/constants'
import { MIN_VERSIONS } from '../../src/engine/update/min-versions'
import { parseVersionString } from '../../src/engine/update/versions'

const REPO = join(import.meta.dir, '..', '..')

describe('minimum harness versions', () => {
  test('every adapter constant equals the single source, and the mod README names the Claude Code minimum', () => {
    expect([MIN_CLAUDE, MIN_CODEX, OPENCODE_MIN, OMP_MIN_VERSION]).toEqual([MIN_VERSIONS.claude, MIN_VERSIONS.codex, MIN_VERSIONS.opencode, MIN_VERSIONS.omp])
    expect(readFileSync(join(REPO, 'src/adapters/claude/template/README.md'), 'utf8')).toContain(`Minimum Claude Code version: **${MIN_VERSIONS.claude}**.`)
  })

  test('each minimum is a plain release', () => {
    for (const [h, v] of Object.entries(MIN_VERSIONS)) {
      const parsed = parseVersionString(v)
      expect(parsed, h).toBeDefined()
      expect(parsed?.pre, h).toBeUndefined()
    }
  })

  test('the adapter files hold no version literal of their own', () => {
    const files = [
      'src/adapters/claude/constants.ts', 'src/adapters/codex/doctor.ts',
      'src/adapters/opencode/constants.ts', 'src/adapters/omp/generated.ts',
    ]
    for (const f of files) {
      const text = readFileSync(join(REPO, f), 'utf8')
      for (const v of Object.values(MIN_VERSIONS)) expect(text.includes(`'${v}'`), `${f} spells ${v}`).toBe(false)
    }
  })
})
