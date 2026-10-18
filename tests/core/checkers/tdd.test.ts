import { describe, expect, test } from 'bun:test'
import { dotnetLogicFree, importsModule, isDotnetTestProjectName, isTestFileName, tddHint, trivialEdit } from '../../../src/core/checkers'

describe('tddHint', () => {
  test('hints when no sibling test exists, for py/ts/tsx/js/go/cs', () => {
    expect(tddHint('/repo/src/rate-limit.ts', ['rate-limit.ts', 'server.ts'])).toContain('rate-limit.test.ts')
    expect(tddHint('/repo/app/billing.py', ['billing.py'])).toContain('test_billing.py')
    expect(tddHint('/repo/ui/Button.tsx', [])).toContain('Button.test.tsx')
    expect(tddHint('/repo/lib/util.js', [])).toContain('util.test.js')
    expect(tddHint('/repo/pkg/x/a.go', ['a.go'])).toContain('a_test.go')
    expect(tddHint('/repo/App/Calc.cs', ['Calc.cs'])).toContain('CalcTests.cs or CalcTest.cs')
    expect(tddHint('/repo/src/a.ts', [])).toContain('fails first')
    expect(tddHint('/repo/src/a.ts', [])).toContain('not coverage by itself')
  })

  test('is silent when a matching test sits next to it (any naming style)', () => {
    expect(tddHint('/repo/src/rate-limit.ts', ['rate-limit.test.ts'])).toBeUndefined()
    expect(tddHint('/repo/src/rateLimit.ts', ['rate-limit.spec.ts'])).toBeUndefined()
    expect(tddHint('/repo/src/Button.tsx', ['/repo/src/Button.test.tsx'])).toBeUndefined()
    expect(tddHint('/repo/app/billing.py', ['test_billing.py'])).toBeUndefined()
    expect(tddHint('/repo/app/billing.py', ['billing_test.py'])).toBeUndefined()
    expect(tddHint('/repo/pkg/x/a.go', ['other_test.go'])).toBeUndefined()
    expect(tddHint('/repo/App/Calc.cs', ['CalcTests.cs'])).toBeUndefined()
  })

  test('a mirrored test folder counts: tests/<path>/<name>.test.ts for src/<path>/<name>.ts', () => {
    const file = '/repo/src/core/checkers.ts'
    expect(tddHint(file, { siblings: ['checkers.ts', 'config.ts'] })).toContain('next to it')
    expect(tddHint(file, { siblings: ['checkers.ts'], testFiles: ['/repo/tests/core/policy/usage.test.ts'] })).toContain('in the test folders')
    expect(tddHint(file, { siblings: ['checkers.ts'], testFiles: ['/repo/tests/core/checkers/checkers.test.ts'] })).toBeUndefined()
    expect(tddHint('/repo/svc/app/billing.py', { siblings: [], testFiles: ['/repo/svc/tests/unit/test_billing.py'] })).toBeUndefined()
    expect(tddHint('/repo/pkg/x/a.go', { siblings: ['a.go'], testFiles: ['/repo/test/x/a_test.go'] })).toBeUndefined()
    expect(tddHint('/repo/src/App/Calc.cs', { siblings: [], testFiles: ['/repo/tests/App.Tests/CalcTests.cs'] })).toBeUndefined()
  })

  test('a test named after the folder covers its modules; index files take the folder name', () => {
    expect(tddHint('/repo/src/vault/view.ts', { siblings: [], testFiles: ['/repo/tests/vault-view.test.ts'] })).toBeUndefined()
    expect(tddHint('/repo/src/vault/view.ts', { siblings: [], testFiles: ['/repo/tests/vault.test.ts'] })).toBeUndefined()
    expect(tddHint('/repo/src/components/DatePicker/index.tsx', { siblings: [], testFiles: ['/repo/tests/date-picker.test.tsx'] })).toBeUndefined()
    expect(tddHint('/repo/src/vault/view.ts', { siblings: [], testFiles: ['/repo/tests/other.test.ts'] })).toContain('view.test.ts')
  })

  test('a test that imports the module counts, and a module with a failing pytest test is in a red-green cycle', () => {
    expect(tddHint('/repo/src/a.ts', { siblings: [], testFiles: [], importers: ['/repo/tests/flow.test.ts'] })).toBeUndefined()
    expect(tddHint('/repo/app/billing.py', { siblings: [], failing: ['tests/test_billing.py'] })).toBeUndefined()
    expect(tddHint('/repo/app/billing.py', { siblings: [], failing: ['tests/test_other.py'] })).toContain('test_billing.py')
  })

  test('trivial edits (imports only, pure deletions, new UPPER_CASE constants) get no reminder', () => {
    const file = '/repo/src/a.ts'
    expect(tddHint(file, [], { removed: "import { a } from './a'", added: "import { a, b } from './a'" })).toBeUndefined()
    expect(tddHint(file, [], { removed: 'const x = 1\nconst y = 2\nreturn x + y', added: 'const x = 1\nreturn x + y' })).toBeUndefined()
    expect(tddHint(file, [], { removed: 'export const A = 1', added: 'export const A = 1\nexport const MAX_RETRIES = 3' })).toBeUndefined()
    expect(tddHint(file, [], { removed: 'return a + b', added: 'return a - b' })).toContain('a.test.ts')
    expect(tddHint(file, [], { removed: '', added: 'export function f() { return 1 }' })).toContain('a.test.ts')
  })

  test('C#: files of a test project, build output, generated files and logic-free types are skipped', () => {
    for (const p of ['/repo/App.Tests/Helpers/Builder.cs', '/repo/IntegrationTests/Db.cs', '/repo/App/obj/Debug/App.AssemblyInfo.cs', '/repo/App/Form1.Designer.cs', '/repo/App/Models.g.cs', '/repo/App/CalcTests.cs']) expect(tddHint(p, [])).toBeUndefined()
    expect(tddHint('/repo/App/LoadTest/Runner.cs', [])).toContain('RunnerTests.cs')
    const dto = 'namespace App;\npublic record Point(int X, int Y);\npublic class Options\n{\n    public string Name { get; set; } = "";\n    public List<int> Ids { get; init; } = new() { 1, 2 };\n}\n'
    expect(tddHint('/repo/App/Options.cs', [], { source: dto })).toBeUndefined()
    expect(tddHint('/repo/App/Calc.cs', [], { source: 'public class Calc { public int Add(int a, int b) { return a + b; } }' })).toContain('CalcTests.cs')
  })

  test('is silent for tests, generated and config files and other languages', () => {
    for (const p of [
      '/repo/src/a.test.ts', '/repo/tests/core/a.ts', '/repo/app/test_x.py', '/repo/x_test.go', '/repo/src/__tests__/a.ts', '/repo/node_modules/x/a.js',
      '/repo/dist/a.js', '/repo/src/types.d.ts', '/repo/vite.config.ts', '/repo/app/__init__.py', '/repo/conftest.py', '/repo/README.md', '/repo/a.rs',
      '/repo/migrations/0001.py', '/repo/scripts/release.ts', '',
    ]) expect(tddHint(p, [])).toBeUndefined()
  })
})

describe('test pairing helpers', () => {
  test('test file and .NET test project names', () => {
    for (const n of ['test_a.py', 'a_test.py', 'a_test.go', 'a.test.ts', 'a.spec.tsx', 'a.test.mjs', 'CalcTests.cs', 'CalcTest.cs']) expect(isTestFileName(n)).toBe(true)
    for (const n of ['a.ts', 'testing.py', 'Contest.cs', 'latest.go']) expect(isTestFileName(n)).toBe(false)
    for (const n of ['App.Tests', 'App.UnitTests', 'App.Test', 'IntegrationTests']) expect(isDotnetTestProjectName(n)).toBe(true)
    for (const n of ['LoadTest', 'latest', 'contest', 'App']) expect(isDotnetTestProjectName(n)).toBe(false)
  })

  test('importsModule: relative TS/JS specifiers resolve against the test file; aliases match by their last segments', () => {
    const mod = '/repo/src/core/checkers.ts'
    expect(importsModule("import { checkersFor } from '../../../src/core/checkers'", '/repo/tests/core/checkers/a.test.ts', mod)).toBe(true)
    expect(importsModule("import { x } from '../../src/core/checkers.js'", '/repo/tests/core/a.test.ts', mod)).toBe(true)
    expect(importsModule("const c = require('../src/core/checkers')", '/repo/tests/a.test.js', mod)).toBe(true)
    expect(importsModule("vi.mock('@/core/checkers')", '/repo/tests/a.test.ts', mod)).toBe(true)
    expect(importsModule("import x from '../../src/other/checkers'", '/repo/tests/core/a.test.ts', mod)).toBe(false)
    expect(importsModule("import x from 'checkers'", '/repo/tests/a.test.ts', mod)).toBe(false)
    expect(importsModule("import { P } from '../src/ui/picker'", '/repo/tests/a.test.ts', '/repo/src/ui/picker/index.tsx')).toBe(true)
  })

  test('importsModule: Python imports and C# tests that reference the type', () => {
    expect(importsModule('from app.billing import charge\n', '/repo/tests/test_x.py', '/repo/app/billing.py')).toBe(true)
    expect(importsModule('from app import billing, tax\n', '/repo/tests/test_x.py', '/repo/app/billing.py')).toBe(true)
    expect(importsModule('import app.billing as b\n', '/repo/tests/test_x.py', '/repo/app/billing.py')).toBe(true)
    expect(importsModule('from app.billing_v2 import charge\n', '/repo/tests/test_x.py', '/repo/app/billing.py')).toBe(false)
    const cs = 'public class Flow { [Fact] public void Adds() { Assert.Equal(3, new Calc().Add(1, 2)); } }'
    expect(importsModule(cs, '/repo/App.Tests/Flow.cs', '/repo/App/Calc.cs')).toBe(true)
    expect(importsModule('public class Flow { [Fact] public void X() { } } // Calc later', '/repo/App.Tests/Flow.cs', '/repo/App/Calc.cs')).toBe(false)
    expect(importsModule('public class Helper { Calc c; }', '/repo/App.Tests/Helper.cs', '/repo/App/Calc.cs')).toBe(false)
  })

  test('trivialEdit and dotnetLogicFree', () => {
    expect(trivialEdit('', '')).toBe(false)
    expect(trivialEdit('a()\nb()', '')).toBe(true)
    expect(trivialEdit('import (\n  "fmt"\n)', 'import (\n  "fmt"\n  "os"\n)')).toBe(true)
    expect(trivialEdit('from a import (\n  x,\n)', 'from a import (\n  x,\n  y,\n)')).toBe(true)
    expect(trivialEdit('break', 'continue')).toBe(false)
    expect(trivialEdit('', 'MAX = 3')).toBe(true)
    expect(trivialEdit('', 'MAX = 3\nrun()')).toBe(false)
    expect(trivialEdit('A = 1', 'A = 1\nMAX = 3')).toBe(true)
    expect(dotnetLogicFree('public interface IRepo { Task<int> Count(); }')).toBe(true)
    expect(dotnetLogicFree('public enum Color { Red, Green }')).toBe(true)
    expect(dotnetLogicFree('public class A { public int X => 1; }')).toBe(false)
    expect(dotnetLogicFree('public class A { public int X { get { return 1; } } }')).toBe(false)
    expect(dotnetLogicFree('public class A { void F() { } }')).toBe(false)
    expect(dotnetLogicFree('// return if\npublic class A { public string S = "if (x) return"; }')).toBe(true)
    expect(dotnetLogicFree('Console.WriteLine(1);')).toBe(false)
  })
})
