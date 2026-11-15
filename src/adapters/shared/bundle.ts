import { join, relative } from 'node:path'

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

export interface ExtensionBundle {
  repoRoot: string
  /** The entry file, relative to the repository. */
  entry: string
  /** The module the build replaces with the baked canonical data (`generated-data.ts` next to the entry). */
  dataModule: RegExp
  dataSource: string
  banner: string
  label: string
  /** A last rewrite of the bundled text. */
  transform?: (text: string) => string
}

/** One extension file for a Pi-family host: the runtime and `src/core` bundled for Bun, the canonical data baked in. */
export async function bundleExtension(o: ExtensionBundle): Promise<string> {
  const result = await Bun.build({
    entrypoints: [join(o.repoRoot, o.entry)],
    root: o.repoRoot,
    target: 'bun',
    format: 'esm',
    splitting: false,
    sourcemap: 'none',
    minify: false,
    plugins: [{
      name: `buracle-${o.label}-generated-data`,
      setup(build) {
        build.onLoad({ filter: o.dataModule }, () => ({ contents: o.dataSource, loader: 'ts' }))
      },
    }],
  })
  if (!result.success) {
    const msgs = result.logs.map(l => String(l.message ?? l)).join('\n')
    throw new Error(`${o.label} extension bundle failed:\n${msgs}`)
  }
  const out = result.outputs.find(x => x.kind === 'entry-point') ?? result.outputs[0]
  if (out === undefined) throw new Error(`${o.label} extension bundle produced no output`)
  const bundled = repoRelativeModuleComments((await out.text()).replace(/\r\n/g, '\n'), o.repoRoot)
  const text = o.transform !== undefined ? o.transform(bundled) : bundled
  return o.banner + (text.endsWith('\n') ? text : text + '\n')
}
