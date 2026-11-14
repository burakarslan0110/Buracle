import { describe, expect, test } from 'bun:test'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { applyPlans, readJournal, repairUnsettled, type Op, type Plan } from '../../src/engine/txn'
import { withSandbox } from '../helpers/sandbox'
import { halfRolledBack } from '../helpers/unsettled-txn'

const O = 'test'
const plan = (ops: Op[]): Plan => ({ id: 'p', harness: 'core', ops })

describe('repairUnsettled: what install and update run before they write', () => {
  test('nothing unsettled: nothing to do, also after a committed transaction', () => withSandbox(async sb => {
    expect(await repairUnsettled()).toEqual([])
    await applyPlans([plan([{ kind: 'file', path: join(sb.home, 'ok.txt'), content: '1', owner: O }])])
    expect(await repairUnsettled()).toEqual([])
    expect(existsSync(join(sb.home, 'ok.txt'))).toBe(true)
  }))

  test('a rollback that failed part way is finished once its cause is gone; while it is not, the repair fails closed and the journal stays', () => withSandbox(async sb => {
    const { txn, marker, flag, file } = await halfRolledBack(sb)
    expect((await readJournal(txn)).status).toBe('rollback-failed')
    expect(existsSync(marker)).toBe(true)
    expect(existsSync(file)).toBe(false)

    await expect(repairUnsettled()).rejects.toThrow(new RegExp(`could not be rolled back completely; fix the paths below:\\n${txn}`))
    const still = await readJournal(txn)
    expect(still.status).toBe('rollback-failed')
    expect(still.error).toContain('the rollback was tried again at the next install')
    await expect(repairUnsettled()).rejects.toThrow(/could not be rolled back completely/)
    expect((await readJournal(txn)).error?.split('\n').filter(l => l.includes('tried again'))).toHaveLength(1)

    writeFileSync(flag, '')
    expect(await repairUnsettled()).toEqual([txn])
    expect(existsSync(marker)).toBe(false)
    expect((await readJournal(txn)).status).toBe('rolled-back')
    expect(await repairUnsettled()).toEqual([])
  }))

  test('the next applyPlans alone does not retry a failed rollback: only the repair does', () => withSandbox(async sb => {
    const { txn, flag } = await halfRolledBack(sb)
    writeFileSync(flag, '')
    const r = await applyPlans([plan([{ kind: 'file', path: join(sb.home, 'other.txt'), content: '1', owner: O }])])
    expect(r.recovered).toBeUndefined()
    expect((await readJournal(txn)).status).toBe('rollback-failed')
  }))
})
