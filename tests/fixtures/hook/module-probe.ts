// Preload for a child `bun`: when the process exits, writes to $PROBE_OUT how many modules of the `yaml` package
// and how many modules in all the process had loaded (Bun lists ES modules in require.cache).
import { writeFileSync } from 'node:fs'

process.on('exit', () => {
  const loaded = Object.keys(require.cache)
  const yaml = loaded.filter(k => /[\\/]node_modules[\\/]yaml[\\/]/.test(k)).length
  writeFileSync(process.env['PROBE_OUT'] ?? '', JSON.stringify({ yaml, total: loaded.length }))
})
