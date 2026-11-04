import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { devContext } from '../../../src/adapters/omp/dev-build'
import { doctor } from '../../../src/adapters/omp/doctor'
import { OMP_TESTED_WITH } from '../../../src/adapters/omp/generated'
import { hostLimitsOf } from '../../../src/adapters/shared/host-limits'
import { withSandbox } from '../../helpers/sandbox'

const REPO = join(import.meta.dir, '..', '..', '..')

const detect = (version: string | undefined) => async () => (version === undefined ? { installed: false } : { installed: true, version, path: '/nonexistent/omp' })

describe('omp doctor: host limits (PARITY-10)', () => {
  test('without omp: the skipped-checks warning, and still the version row plus one ok row per limit with its fallback and the README pointer', () => withSandbox(async () => {
    const items = await doctor(devContext(REPO), { detect: detect(undefined) })
    const skipped = items.find(i => i.check === 'omp')
    expect(skipped?.level).toBe('warn')
    expect(skipped?.detail).toContain('omp is not on PATH')
    const limits = items.find(i => i.check === 'omp.limits')
    expect(limits?.level).toBe('ok')
    expect(limits?.detail).toContain('companion-shell')
    const row = items.find(i => i.check === 'omp.companion-shell')
    expect(row?.level).toBe('ok')
    expect(row?.detail).toContain('. Fallback: the second opinion runs with read, grep and glob only')
    expect(row?.detail).toEndWith('See the Host limits table in README.md.')
    expect(items.filter(i => i.detail.includes('DESIGN §4.5'))).toEqual([])
    expect(items.filter(i => hostLimitsOf('omp').some(l => l.id === i.check)).map(i => i.check)).toEqual(hostLimitsOf('omp').map(l => l.id))
  }))

  test('with a newer omp: only the version row warns and names the re-check; the limit rows stay ok', () => withSandbox(async () => {
    const newer = OMP_TESTED_WITH.replace(/\d+$/, n => String(Number(n) + 1))
    const items = await doctor(devContext(REPO), { detect: detect(newer) })
    const limits = items.find(i => i.check === 'omp.limits')
    expect(limits?.level).toBe('warn')
    expect(limits?.detail).toContain(`${newer} is newer than`)
    expect(items.find(i => i.check === 'omp.companion-shell')?.level).toBe('ok')
    expect(items.find(i => i.check === 'omp version')?.level).toBe('warn')
  }), 60_000)
})
