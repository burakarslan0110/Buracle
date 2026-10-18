import { relative, sep } from 'node:path'

export function repoRelativeModuleComments(text: string, repoRoot: string, cwd: string = process.cwd()): string {
  const rel = relative(cwd, repoRoot).split(sep).join('/')
  if (rel === '') return text
  const prefix = `// ${rel}/`
  return text.split('\n').map(line => (line.startsWith(prefix) ? `// ${line.slice(prefix.length)}` : line)).join('\n')
}
