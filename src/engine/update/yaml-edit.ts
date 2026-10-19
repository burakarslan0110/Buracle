import { yamlSet } from '../merge'

export function setYamlValue(text: string, dottedPath: string | ReadonlyArray<string | number>, value: unknown): string {
  return yamlSet(text, dottedPath, value)
}
