import { detectBinary } from '../../engine/proc'

// Pi (`pi`) and Oh My Pi (`omp`) both read PI_CODING_AGENT_DIR. Without it each has its own folder (~/.pi/agent and
// ~/.omp/agent); with it both read one folder, and Buracle's files for the two (extensions, MCP entries, settings)
// would overwrite each other. The rule: when the variable names one folder for two installed hosts, Oh My Pi
// (the older adapter) keeps it, Pi's install writes nothing, and `buracle doctor` says why.

export interface AgentDirConflict {
  /** The folder both hosts read. */
  dir: string
  /** The harness whose install is skipped. */
  skipped: 'pi'
  message: string
}

export interface AgentDirProbe {
  /** `agentDirShared` of src/engine/paths.ts: the folder PI_CODING_AGENT_DIR names, if it is set. */
  shared(): string | undefined
  installed(bin: string): Promise<boolean>
}

const realProbe = (paths: { agentDirShared(): string | undefined }): AgentDirProbe => ({
  shared: () => paths.agentDirShared(),
  installed: async bin => (await detectBinary(bin)).installed,
})

export async function agentDirConflict(source: { agentDirShared(): string | undefined } | AgentDirProbe): Promise<AgentDirConflict | undefined> {
  const probe = 'installed' in source ? source : realProbe(source)
  const dir = probe.shared()
  if (dir === undefined) return undefined
  if (!(await probe.installed('pi')) || !(await probe.installed('omp'))) return undefined
  return {
    dir,
    skipped: 'pi',
    message: `PI_CODING_AGENT_DIR points Pi and Oh My Pi at one folder (${dir}), so Buracle installs into it for Oh My Pi only and leaves Pi out. Unset the variable for one of the two, or give each its own folder, then run \`buracle install\`.`,
  }
}
