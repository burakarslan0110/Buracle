import { relative } from 'node:path'

// Bun names each module in a comment relative to the process cwd; the generated bundle names it relative to the repository.
export function repoRelativeModuleComments(text: string, repoRoot: string, cwd: string = process.cwd()): string {
  const rel = relative(cwd, repoRoot)
  const roots = [...new Set([rel, repoRoot].filter(r => r !== ''))]
  if (roots.length === 0) return text
  return text.split('\n').map(line => {
    if (!line.startsWith('// ')) return line
    const name = line.slice(3)
    const root = roots.find(r => name.startsWith(`${r}/`))
    return root !== undefined ? `// ${name.slice(root.length + 1)}` : line
  }).join('\n')
}
