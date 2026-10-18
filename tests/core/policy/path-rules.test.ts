import { describe, expect, test } from 'bun:test'
import {
  matchPathRules, pathRuleIndex, pathRuleNote, projectRelative, ruleFileId, ruleGlobs, ruleText, type PathRuleIndex,
} from '../../../src/core/policy/path-rules'
import { protectGlobToRegExp } from '../../../src/core/policy/write-guard'
import { loadCanonicalSync } from '../../../src/engine/canonical'
import * as paths from '../../../src/engine/paths'

const RULES: PathRuleIndex[] = [
  { id: 'typescript', globs: ['**/*.ts', '**/*.tsx', '**/package.json'] },
  { id: 'backend', globs: ['**/api/**', '**/*.sql'] },
  { id: 'mobile', globs: ['**/app.config.{js,ts}', '**/Podfile', '**/*.xcodeproj/project.pbxproj'] },
]

describe('matchPathRules', () => {
  test('matches the project-relative path against each rule, in rule order, once per rule', () => {
    expect(matchPathRules('src/api/users.ts', RULES)).toEqual(['typescript', 'backend'])
    expect(matchPathRules('index.ts', RULES)).toEqual(['typescript'])
    expect(matchPathRules('package.json', RULES)).toEqual(['typescript'])
    expect(matchPathRules('db/schema.sql', RULES)).toEqual(['backend'])
    expect(matchPathRules('src/apix/users.go', RULES)).toEqual([])
    expect(matchPathRules('README.md', RULES)).toEqual([])
  })

  test('braces, files in folders and the root folder itself', () => {
    expect(matchPathRules('app.config.ts', RULES)).toEqual(['typescript', 'mobile'])
    expect(matchPathRules('apps/mobile/app.config.js', RULES)).toEqual(['mobile'])
    expect(matchPathRules('apps/mobile/app.config.json', RULES)).toEqual([])
    expect(matchPathRules('ios/Podfile', RULES)).toEqual(['mobile'])
    expect(matchPathRules('ios/App.xcodeproj/project.pbxproj', RULES)).toEqual(['mobile'])
  })

  test('backslashes and a leading ./ are normalized', () => {
    expect(matchPathRules('src\\api\\users.ts', RULES)).toEqual(['typescript', 'backend'])
    expect(matchPathRules('./src/a.tsx', RULES)).toEqual(['typescript'])
    expect(matchPathRules('', RULES)).toEqual([])
  })
})

describe('projectRelative', () => {
  test('an absolute path inside the root, a relative one joined to the working folder, one outside both', () => {
    expect(projectRelative('/w/app/src/a.ts', { root: '/w/app', cwd: '/w/app' })).toBe('src/a.ts')
    expect(projectRelative('a.ts', { root: '/w/app', cwd: '/w/app/src' })).toBe('src/a.ts')
    expect(projectRelative('./lib/b.ts', { root: '/w/app', cwd: '/w/app' })).toBe('lib/b.ts')
    expect(projectRelative('/tmp/x/api/a.ts', { root: '/w/app', cwd: '/w/app' })).toBe('tmp/x/api/a.ts')
    expect(projectRelative('src/a.ts', {})).toBe('src/a.ts')
  })

  test('Windows paths and case-insensitive roots', () => {
    expect(projectRelative('C:\\Proj\\src\\a.ts', { root: 'C:\\Proj' })).toBe('src/a.ts')
    expect(projectRelative('/Users/U/App/src/a.ts', { root: '/users/u/app', caseInsensitive: true })).toBe('src/a.ts')
    expect(projectRelative('/Users/U/App/src/a.ts', { root: '/users/u/app' })).toBe('Users/U/App/src/a.ts')
  })
})

describe('rule files', () => {
  const src = { rules: RULES, dir: '/h/.buracle/rules/paths' }

  test('ruleText drops the frontmatter', () => {
    expect(ruleText('---\npaths:\n  - "**/*.go"\n---\n# Go\n\n- gofmt\n')).toBe('# Go\n\n- gofmt')
    expect(ruleText('# Plain\n')).toBe('# Plain')
  })

  test('ruleFileId names a rule only for its file under the rule folder', () => {
    expect(ruleFileId('/h/.buracle/rules/paths/typescript.md', src)).toBe('typescript')
    expect(ruleFileId('~/.buracle/rules/paths/backend.md', src)).toBe('backend')
    expect(ruleFileId('$HOME/.buracle/rules/paths/mobile.md', src)).toBe('mobile')
    expect(ruleFileId('/custom/home/rules/paths/typescript.md', { rules: RULES, dir: '/custom/home/rules/paths' })).toBe('typescript')
    expect(ruleFileId('/repo/docs/rules/paths/typescript.md', src)).toBeUndefined()
    expect(ruleFileId('/h/.buracle/rules/paths/python.md', src)).toBeUndefined()
    expect(ruleFileId('/h/.buracle/rules/paths/typescript.txt', src)).toBeUndefined()
    expect(ruleFileId('${HOME}/.buracle/rules/paths/backend.md', src)).toBe('backend')
    expect(ruleFileId('$BURACLE_HOME/rules/paths/backend.md', src)).toBe('backend')
    expect(ruleFileId('/tmp/x/.buracle/rules/paths/typescript.md', src)).toBeUndefined()
    expect(ruleFileId('.buracle/rules/paths/typescript.md', src)).toBeUndefined()
    expect(ruleFileId('~/other/.buracle/rules/paths/typescript.md', src)).toBeUndefined()
    const custom = { rules: RULES, dir: '/Users/u/custom/rules/paths', shownDir: '~/custom/rules/paths' }
    expect(ruleFileId('~/custom/rules/paths/typescript.md', custom)).toBe('typescript')
    expect(ruleFileId('$HOME/custom/rules/paths/typescript.md', custom)).toBe('typescript')
    expect(ruleFileId('~/.buracle/rules/paths/typescript.md', custom)).toBe('typescript')
  })

  test('ruleGlobs and pathRuleIndex read the paths frontmatter of path rules only, sorted by id', () => {
    expect(ruleGlobs({ paths: '**/*.go' })).toEqual(['**/*.go'])
    expect(ruleGlobs({ paths: ['a/**', 3] })).toEqual(['a/**'])
    expect(ruleGlobs({})).toEqual([])
    const index = pathRuleIndex([
      { id: 'zz', scope: 'paths', frontmatter: { paths: ['**/*.z'] } },
      { id: 'core', scope: 'always', frontmatter: {} },
      { id: 'aa', scope: 'paths', frontmatter: { paths: ['**/*.a'] } },
      { id: 'none', scope: 'paths', frontmatter: {} },
    ])
    expect(index).toEqual([{ id: 'aa', globs: ['**/*.a'] }, { id: 'zz', globs: ['**/*.z'] }])
  })
})

describe('pathRuleNote', () => {
  const body = (n: number) => `---\npaths: []\n---\n# Rule\n\n${'x'.repeat(n)}\n`

  test('inlines the rule texts while they fit and points to the files of the rest', () => {
    const bodies: Record<string, string> = { typescript: body(3000), backend: body(3000), mobile: body(3000) }
    const n = pathRuleNote('deny', 'src/api/a.ts', ['typescript', 'backend', 'mobile'], { rules: RULES, dir: '/h/.buracle/rules/paths', body: id => bodies[id] })
    expect(n?.inlined).toEqual(['typescript', 'backend'])
    expect(n?.pointed).toEqual(['mobile'])
    expect(n?.delivered).toEqual(['typescript', 'backend', 'mobile'])
    expect(n?.text.startsWith('Buracle: src/api/a.ts matches the path rules `typescript`, `backend`, `mobile`')).toBe(true)
    expect(n?.text).toContain('retry the edit; the retry is allowed')
    expect(n?.text).toContain('`/h/.buracle/rules/paths/mobile.md`')
    expect(n?.text).not.toContain('paths: []')
    expect(n?.text.length).toBeLessThan(7000)
  })

  test('the first rule is always inlined; a rule whose file cannot be read is left out; none readable gives no note', () => {
    const n = pathRuleNote('read', 'a.ts', ['typescript', 'backend', 'mobile'], { rules: RULES, dir: '/r', maxChars: 100, body: id => (id === 'backend' ? undefined : body(500)) })
    expect(n?.inlined).toEqual(['typescript'])
    expect(n?.pointed).toEqual(['mobile'])
    expect(n?.delivered).toEqual(['typescript', 'mobile'])
    expect(n?.text).toContain('matches the path rules `typescript`, `mobile`; follow them when you change files like this one.')
    expect(n?.text).not.toContain('backend')
    expect(pathRuleNote('edit', 'a.ts', ['typescript'], { rules: RULES, dir: '/r', body: () => { throw new Error('io') } })).toBeUndefined()
    expect(pathRuleNote('edit', 'a.ts', ['typescript'], { rules: RULES, dir: '/r' })).toBeUndefined()
  })

  test('the pointer shows the folder the way the user knows it', () => {
    const n = pathRuleNote('deny', 'a.ts', ['typescript', 'backend'], { rules: RULES, dir: '/h/.buracle/rules/paths', shownDir: '~/.buracle/rules/paths', maxChars: 10, body: () => body(50) })
    expect(n?.text).toContain('Read this rule file before the edit: `~/.buracle/rules/paths/backend.md`.')
  })
})

describe('the canonical path rules', () => {
  const canonical = loadCanonicalSync(paths.canonicalDir())
  const index = pathRuleIndex(canonical.rules)

  test('every glob compiles to a matcher', () => {
    for (const r of index) for (const g of r.globs) expect({ id: r.id, g, ok: protectGlobToRegExp(g) !== null }).toEqual({ id: r.id, g, ok: true })
  })

  test.each([
    ['ios/App.xcodeproj/project.pbxproj', ['mobile']],
    ['android/app/build.gradle.kts', ['mobile']],
    ['android/app/src/main/AndroidManifest.xml', ['mobile']],
    ['pubspec.yaml', ['mobile']],
    ['eas.json', ['mobile']],
    ['src/Orders/OrderService.cs', ['dotnet']],
    ['Directory.Packages.props', ['dotnet']],
    ['global.json', ['dotnet']],
    ['Pages/Index.razor', ['blazor', 'browser-automation', 'frontend']],
    ['Pages/Index.razor.cs', ['blazor', 'dotnet']],
    ['Pages/Index.razor.css', ['blazor', 'browser-automation', 'frontend']],
    ['app/queries/orders.py', ['backend', 'python']],
    ['db/alembic/env.py', ['backend', 'python']],
    ['tests/playwright/login.spec.ts', ['browser-automation', 'typescript']],
    ['src/__tests__/login.test.js', ['browser-automation', 'typescript']],
    ['tests/unit/login.test.js', ['typescript']],
  ])('%s matches %p', (file, want) => {
    expect(matchPathRules(file, index).sort()).toEqual([...want].sort())
  })
})
