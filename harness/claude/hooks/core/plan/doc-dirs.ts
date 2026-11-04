// The folders under docs/ that hold workflow documents: one per workflow id, plus the legacy name
// each one replaced. New files go to the new folders only. Every reader (the review page, the
// notes, the plan audit, the worktree stash exclusion, the plan-mode guard) accepts both.
export interface DocDir { readonly dir: string, readonly workflow: string, readonly legacy: string }

export const DOC_DIRS = [
  { dir: 'requirements', workflow: 'requirements', legacy: 'prd' },
  { dir: 'plan-build', workflow: 'plan-build', legacy: 'plans' },
  { dir: 'goal-build', workflow: 'goal-build', legacy: 'builds' },
  { dir: 'dead-code', workflow: 'dead-code', legacy: 'cleanup' },
] as const satisfies readonly DocDir[]

export const LEGACY_DOC_DIRS = ['prd', 'plans', 'builds', 'cleanup'] as const
export const ALL_DOC_DIRS = ['requirements', 'plan-build', 'goal-build', 'dead-code', 'prd', 'plans', 'builds', 'cleanup'] as const
export type DocDirName = typeof ALL_DOC_DIRS[number]
export type DocWorkflow = typeof DOC_DIRS[number]['workflow']

const NAMES = ALL_DOC_DIRS.join('|')

// A Markdown file directly inside one of the folders, as a repository-relative path with forward slashes.
export const DOC_FILE = new RegExp(`^docs/(${NAMES})/([^/]+\\.md)$`, 'u')

// Anything below one of the folders, in a relative or an absolute path.
export const DOC_DIR_PREFIX = new RegExp(`(?:^|/)docs/(?:${NAMES})/`)

// The folder a workflow writes its new documents into (never a legacy one).
export function docDirFor(workflow: DocWorkflow): string {
  const row = DOC_DIRS.find(d => d.workflow === workflow)
  return row === undefined ? workflow : row.dir
}

export function docDirOf(rel: string): { dir: DocDirName, workflow: DocWorkflow, legacy: boolean } | undefined {
  const dir = DOC_FILE.exec(rel.replace(/\\/g, '/'))?.[1]
  if (dir === undefined) return undefined
  const row = DOC_DIRS.find(d => d.dir === dir || d.legacy === dir)
  if (row === undefined) return undefined
  return { dir: dir as DocDirName, workflow: row.workflow, legacy: row.legacy === dir }
}
