import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MIN_CLAUDE, TESTED_WITH as CLAUDE_TESTED } from '../../src/adapters/claude/constants'
import { TESTED_WITH as DEV_ASSEMBLE_TESTED } from '../../src/adapters/claude/template/dev-assemble'
import { MIN_CODEX, TESTED_CODEX } from '../../src/adapters/codex/doctor'
import { OMP_MIN_VERSION, OMP_TESTED_WITH } from '../../src/adapters/omp/generated'
import { MIN_VERSION as OPENCODE_MIN, TESTED_WITH as OPENCODE_TESTED } from '../../src/adapters/opencode/constants'
import { TESTED_WITH as SOURCE } from '../../src/engine/update/tested-with'
import { TESTED_WITH as UPDATES_TESTED } from '../../src/engine/update/updates'
import { compareVersions, parseVersionString } from '../../src/engine/update/versions'

const REPO = join(import.meta.dir, '..', '..')

describe('tested harness versions', () => {
  test('every adapter constant equals the single source', () => {
    expect(UPDATES_TESTED).toBe(SOURCE)
    expect([CLAUDE_TESTED, MIN_CLAUDE]).toEqual([SOURCE.claude.tested, SOURCE.claude.min])
    expect(DEV_ASSEMBLE_TESTED).toBe(SOURCE.claude.tested)
    expect([TESTED_CODEX, MIN_CODEX]).toEqual([SOURCE.codex.tested, SOURCE.codex.min])
    expect([OPENCODE_TESTED, OPENCODE_MIN]).toEqual([SOURCE.opencode.tested, SOURCE.opencode.min])
    expect([OMP_TESTED_WITH, OMP_MIN_VERSION]).toEqual([SOURCE.omp.tested, SOURCE.omp.min])
    expect(readFileSync(join(REPO, 'src/adapters/claude/template/README.md'), 'utf8')).toContain(`Tested Claude Code version: **${SOURCE.claude.tested}**.`)
  })

  test('each tested version is a plain release at or above its minimum, in the same major', () => {
    for (const [h, v] of Object.entries(SOURCE)) {
      const tested = parseVersionString(v.tested)
      const min = parseVersionString(v.min)
      expect(tested?.pre, h).toBeUndefined()
      expect(compareVersions(v.tested, v.min), h).toBeGreaterThanOrEqual(0)
      expect(tested?.nums[0], h).toBe(min?.nums[0])
    }
  })

  test('the adapter files hold no version literal of their own', () => {
    const files = [
      'src/adapters/claude/constants.ts', 'src/adapters/codex/doctor.ts',
      'src/adapters/opencode/constants.ts', 'src/adapters/omp/generated.ts',
    ]
    const versions = new Set(Object.values(SOURCE).flatMap(v => [v.tested, v.min]))
    for (const f of files) {
      const text = readFileSync(join(REPO, f), 'utf8')
      for (const v of versions) expect(text.includes(`'${v}'`), `${f} spells ${v}`).toBe(false)
    }
  })
})
