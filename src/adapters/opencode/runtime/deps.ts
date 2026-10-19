import { projectDeps as sharedProjectDeps } from '../../shared/project-deps'

export function projectDeps(root: string | undefined): string[] {
  if (root === undefined || root === '') return []
  return sharedProjectDeps(root)
}
