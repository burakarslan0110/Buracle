// Moves a built site under a sub-path, for a GitHub Pages address such as https://<user>.github.io/<repo>/ where the
// site cannot sit at the root. Usage: bun site/rebase.ts <dist> </sub-path>
// It rewrites the root-relative href, src and poster attributes of every .html file and the root-relative font urls of
// every .css file and <style> block. The canonical and Open Graph addresses stay those of SITE_URL. The Pages workflow
// runs it only while the repository variable PAGES_BASE is set; delete the variable once the custom domain serves the site.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [dist, rawBase] = process.argv.slice(2)
if (!dist || !rawBase) { console.error('usage: bun site/rebase.ts <dist> </sub-path>'); process.exit(2) }
const base = '/' + rawBase.replace(/^\/+|\/+$/g, '')

const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
  const p = join(dir, n)
  return statSync(p).isDirectory() ? walk(p) : [p]
})

let changed = 0
for (const f of walk(dist)) {
  const html = f.endsWith('.html'), css = f.endsWith('.css')
  if (!html && !css) continue
  const before = readFileSync(f, 'utf8')
  let after = before.replace(/url\((["']?)\/(?!\/)/g, `url($1${base}/`)
  if (html) after = after.replace(/\b(href|src|poster)="\/(?!\/)/g, `$1="${base}/`)
  if (after !== before) { writeFileSync(f, after); changed++ }
}
console.log(`rebase: ${changed} files moved under ${base}`)
