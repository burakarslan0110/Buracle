import type * as YamlModule from 'yaml'

type Yaml = typeof YamlModule

let loaded: Yaml | undefined

/**
 * The `yaml` package, loaded on first use. Importing it costs 8-11 ms and most hook events never
 * parse YAML (config.ts reads the merged configuration from the runtime snapshot), so a static
 * import would charge every event for it. `require` keeps the call synchronous, and the bundler
 * that builds the OpenCode and omp bundles still sees the dependency.
 */
export function yaml(): Yaml {
  return (loaded ??= require('yaml') as Yaml)
}

export function parseYaml(text: string): unknown {
  return yaml().parse(text)
}
