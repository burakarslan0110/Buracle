import { relative, sep } from 'node:path'

// Bun names each module in a comment relative to the process cwd. Across Windows drives (repo on D:, cwd on C:) there
// is no relative path: the comment carries the absolute one, with either separator and drive letter case, and Bun may
// prefix it with the '../' that climb from the cwd to its drive root ('../../D:/a/repo/src/x.ts').
export function repoRelativeModuleComments(text: string, repoRoot: string, cwd: string = process.cwd()): string {
  const fwd = (p: string) => p.split(sep).join('/').replace(/\\/g, '/')
  const drive = (p: string) => p.replace(/^[a-z]:\//, d => d.toUpperCase())
  const rel = relative(cwd, repoRoot)
  const roots = [...new Set([rel, repoRoot].filter(r => r !== '').map(r => drive(fwd(r))))]
  if (roots.length === 0) return text
  return text.split('\n').map(line => {
    if (!line.startsWith('// ')) return line
    const name = fwd(line.slice(3)).replace(/^(?:\.\.\/)+(?=[A-Za-z]:\/)/, '')
    const root = roots.find(r => drive(name).startsWith(`${r}/`))
    return root !== undefined ? `// ${name.slice(root.length + 1)}` : line
  }).join('\n')
}
