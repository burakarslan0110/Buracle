import { join } from 'node:path'
import { applyPlans, listTxns, type Op } from '../../src/engine/txn'
import { withEnv, type Sandbox } from './sandbox'

/**
 * Leaves a transaction in `rollback-failed`: its second write (the ledger, after its exec ran) fails through
 * BURACLE_TXN_FAIL_AT, and the rollback then fails too, because the exec's undo needs the file `flag`.
 */
export async function halfRolledBack(sb: Sandbox): Promise<{ txn: string, marker: string, flag: string, file: string }> {
  const file = join(sb.home, 'f.txt')
  const marker = join(sb.root, 'installed')
  const flag = join(sb.root, 'undo-allowed')
  const ops: Op[] = [
    { kind: 'exec', argv: ['touch', marker], undo: ['sh', '-c', `test -e '${flag}' && rm -f '${marker}'`], owner: 'test' },
    { kind: 'file', path: file, content: 'x', owner: 'test' },
  ]
  const failed = await withEnv({ BURACLE_TXN_FAIL_AT: '2' }, () => applyPlans([{ id: 'p', harness: 'core', ops }])).then(() => undefined, (e: unknown) => e)
  if (!(failed instanceof Error) || !failed.message.includes('BURACLE_TXN_FAIL_AT=2')) throw new Error(`the injected failure did not happen: ${String(failed)}`)
  const [j] = await listTxns()
  if (j === undefined || j.status !== 'rollback-failed') throw new Error(`expected a rollback-failed journal, got ${j?.status ?? 'none'}`)
  return { txn: j.txn, marker, flag, file }
}
