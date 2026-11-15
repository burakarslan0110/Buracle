import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { devContext } from '../../../src/adapters/omp/dev-build'
import { adapter as omp } from '../../../src/adapters/omp/index'
import { adapter as pi } from '../../../src/adapters/pi/index'
import { agentDirConflict, type AgentDirProbe, type FamilyHost } from '../../../src/adapters/shared/agent-dir'
import * as paths from '../../../src/engine/paths'
import { applyPlans } from '../../../src/engine/txn'
import { fakeExe, narrowPath } from '../../helpers/fake-exe'
import { withEnv, withSandbox } from '../../helpers/sandbox'

const probe = (owners: FamilyHost[], installed = ['pi', 'omp']): AgentDirProbe => ({ shared: () => '/d', installed: async b => installed.includes(b), owners: async () => owners })

describe('one PI_CODING_AGENT_DIR for Pi and omp: the first owner keeps it', () => {
  test('neither owns it yet: omp keeps it (the older adapter), Pi is left out', async () => {
    expect(await agentDirConflict(probe([]))).toMatchObject({ keeper: 'omp', skipped: 'pi' })
  })

  test('omp owns files in it: omp keeps it, Pi is left out', async () => {
    expect(await agentDirConflict(probe(['omp']))).toMatchObject({ keeper: 'omp', skipped: 'pi' })
  })

  test('Pi owns files in it: Pi keeps it, omp is left out and the message names Oh My Pi as the one left out', async () => {
    const c = await agentDirConflict(probe(['pi']))
    expect(c).toMatchObject({ keeper: 'pi', skipped: 'omp' })
    expect(c?.message).toContain('installs into it for Pi only and leaves Oh My Pi out')
  })

  test('both own files (the folder was shared before): omp keeps it', async () => {
    expect(await agentDirConflict(probe(['pi', 'omp']))).toMatchObject({ keeper: 'omp', skipped: 'pi' })
  })

  test('one host installed is no conflict', async () => {
    expect(await agentDirConflict(probe(['pi'], ['pi']))).toBeUndefined()
    expect(await agentDirConflict(probe(['omp'], ['omp']))).toBeUndefined()
  })
})

describe('the two installs over one folder, through the real ledger', () => {
  const setup = async (root: string) => {
    const bin = join(root, 'bin')
    fakeExe(join(bin, 'pi'), 'console.log("1.5.2")')
    fakeExe(join(bin, 'omp'), 'console.log("omp/18.10.1")')
    return bin
  }

  test('Pi installed first: its files stay, omp\'s install writes nothing and its doctor warns omp.agent-dir; Pi keeps installing', () => withSandbox(async ({ root }) => {
    const shared = join(root, 'shared-agent')
    const c = devContext(paths.repoRoot())
    // Pi on its own (omp not on PATH yet) writes into the folder.
    await withEnv({ PI_CODING_AGENT_DIR: shared, PATH: narrowPath(join(root, 'only-pi')) }, async () => {
      fakeExe(join(root, 'only-pi', 'pi'), 'console.log("1.5.2")')
      await applyPlans([await pi.installPlan(c)])
    })
    // omp arrives: the ledger says Pi was first.
    const bin = await setup(root)
    await withEnv({ PI_CODING_AGENT_DIR: shared, PATH: narrowPath(bin) }, async () => {
      expect((await omp.installPlan(c)).ops).toEqual([])
      expect((await pi.installPlan(c)).ops.length).toBeGreaterThan(0)
      const rows = await omp.doctor(c)
      expect(rows.map(r => r.check)).toEqual(['omp.agent-dir'])
      expect(rows[0]?.level).toBe('warn')
      expect((await pi.doctor(c)).some(r => r.check === 'pi.agent-dir')).toBe(false)
    })
  }))

  test('omp installed first: omp keeps the folder, Pi writes nothing and its doctor warns pi.agent-dir', () => withSandbox(async ({ root }) => {
    const shared = join(root, 'shared-agent')
    const c = devContext(paths.repoRoot())
    const bin = await setup(root)
    await withEnv({ PI_CODING_AGENT_DIR: shared, PATH: narrowPath(bin) }, async () => {
      await applyPlans([{ id: 'omp', harness: 'omp', ops: [{ kind: 'file', path: join(shared, 'config.yml'), content: 'a: 1\n', owner: 'omp' }] }])
      expect((await pi.installPlan(c)).ops).toEqual([])
      expect((await pi.doctor(c)).map(r => r.check)).toEqual(['pi.agent-dir'])
      expect((await omp.doctor(c)).some(r => r.check === 'omp.agent-dir')).toBe(false)
    })
  }))

  test('without the variable the two have their own folders and both install', () => withSandbox(async ({ root }) => {
    const c = devContext(paths.repoRoot())
    const bin = await setup(root)
    await withEnv({ PATH: narrowPath(bin) }, async () => {
      expect((await pi.installPlan(c)).ops.length).toBeGreaterThan(0)
      expect((await omp.doctor(c)).some(r => r.check === 'omp.agent-dir')).toBe(false)
    })
  }))
})
