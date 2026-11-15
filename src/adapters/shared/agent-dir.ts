import { detectBinary } from '../../engine/proc'
import { readLedger } from '../../engine/txn'

// Pi (`pi`) and Oh My Pi (`omp`) both read PI_CODING_AGENT_DIR. Without it each has its own folder (~/.pi/agent and
// ~/.omp/agent); with it both read one folder, and Buracle's files for the two (extensions, MCP entries, settings)
// would overwrite each other. The rule: when the variable names one folder for two installed hosts, the harness whose
// files are already in it keeps it (the ledger says which; Oh My Pi, the older adapter, when neither is), the other's
// install writes nothing, and `buracle doctor` says why.

export type FamilyHost = 'pi' | 'omp'

export interface AgentDirConflict {
  /** The folder both hosts read. */
  dir: string
  /** The harness that keeps the folder. */
  keeper: FamilyHost
  /** The harness whose install is skipped. */
  skipped: FamilyHost
  message: string
}

export interface AgentDirProbe {
  /** `agentDirShared` of src/engine/paths.ts: the folder PI_CODING_AGENT_DIR names, if it is set. */
  shared(): string | undefined
  installed(bin: string): Promise<boolean>
  /** The hosts that already have files of Buracle's in the folder (the ownership ledger); none when unknown. */
  owners?(dir: string): Promise<readonly FamilyHost[]>
}

async function ledgerOwners(dir: string): Promise<FamilyHost[]> {
  try {
    const owners = new Set<FamilyHost>()
    const prefix = dir.endsWith('/') ? dir : `${dir}/`
    for (const e of Object.values(await readLedger())) {
      if ((e.owner === 'pi' || e.owner === 'omp') && (e.path === dir || e.path.startsWith(prefix))) owners.add(e.owner)
    }
    return [...owners]
  } catch {
    return []
  }
}

const realProbe = (paths: { agentDirShared(): string | undefined }): AgentDirProbe => ({
  shared: () => paths.agentDirShared(),
  installed: async bin => (await detectBinary(bin)).installed,
  owners: ledgerOwners,
})

export async function agentDirConflict(source: { agentDirShared(): string | undefined } | AgentDirProbe): Promise<AgentDirConflict | undefined> {
  const probe = 'installed' in source ? source : realProbe(source)
  const dir = probe.shared()
  if (dir === undefined) return undefined
  if (!(await probe.installed('pi')) || !(await probe.installed('omp'))) return undefined
  const owners = (await probe.owners?.(dir)) ?? []
  const keeper: FamilyHost = owners.includes('pi') && !owners.includes('omp') ? 'pi' : 'omp'
  const skipped: FamilyHost = keeper === 'pi' ? 'omp' : 'pi'
  const name = (h: FamilyHost): string => (h === 'pi' ? 'Pi' : 'Oh My Pi')
  return {
    dir, keeper, skipped,
    message: `PI_CODING_AGENT_DIR points Pi and Oh My Pi at one folder (${dir}), so Buracle installs into it for ${name(keeper)} only and leaves ${name(skipped)} out. Unset the variable for one of the two, or give each its own folder, then run \`buracle install\`.`,
  }
}
