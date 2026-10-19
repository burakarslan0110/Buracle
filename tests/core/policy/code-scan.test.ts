import { describe, expect, test } from 'bun:test'
import type { CodeOp } from '../../../src/core/policy/code-scan'
import { codeLang, scanCode } from '../../../src/core/policy/code-scan'
import { DYN, HOME } from '../../../src/core/policy/shell'

const ops = (code: string, lang: string): CodeOp[] => scanCode(code, codeLang(lang))

describe('codeLang', () => {
  test('maps language names and file extensions', () => {
    expect(['py', 'python', 'Python3', 'ipython'].map(codeLang)).toEqual(['python', 'python', 'python', 'python'])
    expect(['js', 'javascript', 'node', 'bun', 'ts', 'TypeScript'].map(codeLang)).toEqual(['js', 'js', 'js', 'js', 'js', 'js'])
    expect(['rb', 'perl', 'php', 'lua', 'gawk', 'osascript', 'tclsh', 'pwsh'].map(codeLang)).toEqual(['ruby', 'perl', 'php', 'lua', 'awk', 'applescript', 'tcl', 'powershell'])
    expect([' ', 'cobol', undefined as unknown as string].map(codeLang)).toEqual(['unknown', 'unknown', 'unknown'])
  })
})

describe('scanCode: Python', () => {
  test('home and paths fold through expanduser, os.path.join, pathlib, f-strings and assignments', () => {
    expect(ops("shutil.rmtree(os.path.expanduser('~/Documents'))", 'py')).toEqual([{ kind: 'delete-tree', api: 'shutil.rmtree', target: `${HOME}/Documents` }])
    expect(ops("shutil.rmtree(os.path.join(os.path.expanduser('~'), 'a', 'b'))", 'py')[0]).toMatchObject({ target: `${HOME}/a/b` })
    expect(ops("shutil.rmtree(Path.home() / 'Documents')", 'py')[0]).toMatchObject({ target: `${HOME}/Documents` })
    expect(ops("x = f'{Path.home()}/Pictures'\nshutil.rmtree(x)", 'py')[0]).toMatchObject({ target: `${HOME}/Pictures` })
    expect(ops("shutil.rmtree(os.environ['HOME'])", 'py')[0]).toMatchObject({ target: HOME })
    expect(ops("shutil.rmtree(os.getenv('HOME') + '/x')", 'py')[0]).toMatchObject({ target: `${HOME}/x` })
    expect(ops('shutil.rmtree(tmpdir)', 'py')).toEqual([{ kind: 'delete-tree', api: 'shutil.rmtree' }])
    expect(ops("shutil.rmtree('/' + name)", 'py')[0]).toMatchObject({ target: `/${DYN}` })
  })

  test('writes need a writing mode; reads are not effects', () => {
    expect(ops("open('a.txt', 'w')", 'py')).toEqual([{ kind: 'write', api: 'open', target: 'a.txt' }])
    expect(ops("open('a.txt', mode='a')", 'py')).toEqual([{ kind: 'write', api: 'open', target: 'a.txt' }])
    expect(ops("open('a.txt')", 'py')).toEqual([])
    expect(ops("open('a.txt', 'rb')", 'py')).toEqual([])
    expect(ops("Path('x').open('w')", 'py')).toEqual([{ kind: 'write', api: 'open', target: 'x' }])
    expect(ops("shutil.copy('a', 'b')", 'py')).toEqual([{ kind: 'write', api: 'shutil.copy', target: 'b' }])
    expect(ops("os.rename('a', 'b')", 'py')).toEqual([{ kind: 'move', api: 'os.rename', src: 'a', dst: 'b' }])
  })

  test('processes: os.system, subprocess (string or argv), exec family, IPython magics', () => {
    expect(ops("os.system('ls')", 'py')).toEqual([{ kind: 'shell', api: 'os.system', command: 'ls' }])
    expect(ops("subprocess.run(['rm', '-rf', 'x'])", 'py')).toEqual([{ kind: 'shell', api: 'subprocess.run', command: "'rm' '-rf' 'x'" }])
    expect(ops("os.execvp('rm', ['rm', '-rf', '/'])", 'py')).toEqual([{ kind: 'shell', api: 'os.execvp', command: "'rm' '-rf' '/'" }])
    expect(ops('!ls -la\nx = !pwd', 'py').map(o => (o.kind === 'shell' ? o.command : ''))).toEqual(['ls -la', 'pwd'])
    expect(ops('%%bash\necho hi\n', 'py')).toEqual([{ kind: 'shell', api: '%%bash', command: 'echo hi\n' }])
    expect(ops("__import__('os').system('ls')", 'py')).toEqual([{ kind: 'shell', api: 'os.system', command: 'ls' }])
    expect(ops("exec(\"os.system('ls')\")", 'py')).toEqual([{ kind: 'shell', api: 'os.system', command: 'ls' }])
  })

  test('methods of other objects with file-API names are not effects', () => {
    expect(ops("items.remove('.env'); s.replace('.env', ''); q.put(x); asyncio.run(main())", 'py')).toEqual([])
  })
})

describe('scanCode: JavaScript', () => {
  test('fs, child_process, Bun and tagged templates', () => {
    expect(ops("require('fs').rmSync('x', { recursive: true })", 'js')).toEqual([{ kind: 'delete-tree', api: 'fs.rmSync', target: 'x' }])
    expect(ops("fs.rmSync('x')", 'js')).toEqual([{ kind: 'delete', api: 'fs.rmSync', target: 'x' }])
    expect(ops("fs.rmSync('x', opts)", 'js')).toEqual([{ kind: 'delete-tree', api: 'fs.rmSync', target: 'x' }])
    expect(ops("fs.writeFileSync(`${os.homedir()}/.zshrc`, s)", 'js')).toEqual([{ kind: 'write', api: 'fs.writeFileSync', target: `${HOME}/.zshrc` }])
    expect(ops("await Bun.write(Bun.file('a.txt'), 'x')", 'js')).toEqual([{ kind: 'write', api: 'Bun.write', target: 'a.txt' }])
    expect(ops("execFileSync('git', ['push', '-f'])", 'js')).toEqual([{ kind: 'shell', api: 'execFileSync', command: "'git' 'push' '-f'" }])
    expect(ops("spawn('ls -la', [], { shell: true })", 'js')).toEqual([{ kind: 'shell', api: 'spawn', command: 'ls -la' }])
    expect(ops('await $`rm -rf ${dir}`', 'js')).toEqual([{ kind: 'shell', api: '$', command: `rm -rf '${DYN}'` }])
    expect(ops("require('child_process')['execSync']('ls')", 'js')).toEqual([{ kind: 'shell', api: 'child_process.execSync', command: 'ls' }])
  })

  test('strings, comments and regex literals do not hide or invent calls', () => {
    expect(ops("// fs.rmSync('/', { recursive: true })\nconsole.log('fs.rmSync(\"/\")')", 'js')).toEqual([])
    expect(ops("const re = /'/; fs.unlinkSync('a')", 'js')).toEqual([{ kind: 'delete', api: 'fs.unlinkSync', target: 'a' }])
    expect(ops("const half = total / 2; fs.unlinkSync('b')", 'js')).toEqual([{ kind: 'delete', api: 'fs.unlinkSync', target: 'b' }])
  })
})

describe('scanCode: other languages', () => {
  test('perl, ruby, php, lua, awk, AppleScript and Tcl', () => {
    expect(ops('system("rm -rf ~")', 'perl')).toEqual([{ kind: 'shell', api: 'system', command: 'rm -rf ~' }])
    expect(ops('my $o = `ls`;', 'perl')).toEqual([{ kind: 'shell', api: '`…`', command: 'ls' }])
    expect(ops("open(my $fh, '>', '.env');", 'perl')).toEqual([{ kind: 'write', api: 'open', target: '.env' }])
    expect(ops('FileUtils.rm_rf Dir.home', 'ruby')).toEqual([{ kind: 'delete-tree', api: 'FileUtils.rm_rf', target: HOME }])
    expect(ops("%x(ls)", 'ruby')).toEqual([{ kind: 'shell', api: '`…`', command: 'ls' }])
    expect(ops("shell_exec('ls');", 'php')).toEqual([{ kind: 'shell', api: 'shell_exec', command: 'ls' }])
    expect(ops('os.execute("ls")', 'lua')).toEqual([{ kind: 'shell', api: 'os.execute', command: 'ls' }])
    expect(ops('BEGIN { system("ls") }', 'awk')).toEqual([{ kind: 'shell', api: 'system', command: 'ls' }])
    expect(ops('do shell script "ls"', 'applescript')).toContainEqual({ kind: 'shell', api: 'do shell script', command: 'ls' })
  })
})

describe('scanCode: robustness', () => {
  test('never throws and is bounded; past a bound it says so instead of going quiet', () => {
    expect(scanCode(undefined as unknown as string, 'js')).toEqual([])
    const many = scanCode('fs.writeFileSync(a, b); '.repeat(5000), 'js')
    expect(many.length).toBe(5000)
    expect(many.some(o => o.kind === 'unreadable')).toBe(false)
    const tooMany = scanCode('os.remove(a)\n'.repeat(12000), 'python')
    expect(tooMany[tooMany.length - 1]).toEqual({ kind: 'unreadable', api: 'scan', why: 'it has too many file or process effects' })
    expect(scanCode('x'.repeat(250_000), 'python').at(-1)).toEqual({ kind: 'unreadable', api: 'scan', why: 'it is too long' })
    expect(scanCode('os.system('.repeat(20000), 'python').at(-1)).toMatchObject({ kind: 'unreadable' })
    let nested = "os.system('ls')"
    for (let i = 0; i < 2; i++) nested = `exec(${JSON.stringify(nested)})`
    expect(scanCode(nested, 'python')).toEqual([{ kind: 'shell', api: 'os.system', command: 'ls' }])
    for (let i = 0; i < 3; i++) nested = `exec(${JSON.stringify(nested)})`
    expect(scanCode(nested, 'python').at(-1)).toEqual({ kind: 'unreadable', api: 'scan', why: 'it nests exec/eval strings too deeply' })
    expect(scanCode("os.system('ls')", 'py' as never)).toEqual([{ kind: 'shell', api: 'os.system', command: 'ls' }])
    const start = performance.now()
    for (const s of ['('.repeat(100000), '`${'.repeat(20000), "'".repeat(100000), 'a.b.c('.repeat(20000), '#'.repeat(100000)]) {
      expect(() => scanCode(s, 'js')).not.toThrow()
      expect(() => scanCode(s, 'python')).not.toThrow()
    }
    expect(performance.now() - start).toBeLessThan(2000)
  })
})

describe('scanCode: computed names and code built at run time', () => {
  const unreadable = (code: string, lang: string): boolean => ops(code, lang).some(o => o.kind === 'unreadable')

  test('a name the scan can fold is resolved to the call it names', () => {
    expect(ops("import os; getattr(os, 'sys' + 'tem')('rm -rf ~')", 'py')).toEqual([{ kind: 'shell', api: 'os.system', command: 'rm -rf ~' }])
    expect(ops("getattr(__import__('o' + 's'), 'system')('ls')", 'py')).toEqual([{ kind: 'shell', api: 'os.system', command: 'ls' }])
    expect(ops("getattr(shutil, 'rmtree')(os.path.expanduser('~'))", 'py')).toEqual([{ kind: 'delete-tree', api: 'shutil.rmtree', target: HOME }])
    expect(ops("require('child_' + 'process').execSync('rm -rf ~')", 'js')).toEqual([{ kind: 'shell', api: 'child_process.execSync', command: 'rm -rf ~' }])
    expect(ops("const cp = require('child_process'); cp['exec' + 'Sync']('ls')", 'js')).toEqual([{ kind: 'shell', api: 'child_process.execSync', command: 'ls' }])
    expect(ops("global['ev' + 'al'](\"require('child_process').execSync('ls')\")", 'js')).toEqual([{ kind: 'shell', api: 'child_process.execSync', command: 'ls' }])
  })

  test('a name it cannot work out on a process or file module, an import of one, and code built at run time are unreadable', () => {
    expect(unreadable('import os; getattr(os, name)(cmd)', 'py')).toBe(true)
    expect(unreadable('import os; f = getattr(os, n + x)', 'py')).toBe(true)
    expect(unreadable('m = __import__(name)', 'py')).toBe(true)
    expect(unreadable('m = importlib.import_module(name)', 'py')).toBe(true)
    expect(unreadable('exec(code)', 'py')).toBe(true)
    expect(unreadable("eval('o' + s)", 'py')).toBe(true)
    expect(unreadable('eval(src)', 'js')).toBe(true)
    expect(unreadable("new Function('a', body)", 'js')).toBe(true)
    expect(unreadable("const cp = require('child_process'); cp[m]('rm -rf ~')", 'js')).toBe(true)
    expect(unreadable('const m = require(name)', 'js')).toBe(true)
    expect(unreadable('globalThis[fn](x)', 'js')).toBe(true)
  })

  test('a command or code string longer than the evaluator keeps is unreadable, not cut short', () => {
    expect(unreadable(`import os; os.system('${'x'.repeat(9000)}; rm -rf ~')`, 'py')).toBe(true)
    expect(unreadable(`exec('${'#'.repeat(9000)}')`, 'py')).toBe(true)
    expect(unreadable(`open('out.txt', 'w').write('${'x'.repeat(9000)}')`, 'py')).toBe(false)
  })

  test('ordinary lookups and evaluations stay quiet', () => {
    for (const [code, lang] of [
      ["x = getattr(obj, 'name')", 'py'], ['x = getattr(obj, attr)', 'py'], ['x = getattr(settings, key, None)', 'py'], ['import re; r = re.compile(pattern)', 'py'],
      ['df.eval(expr)', 'py'], ['model.eval()', 'py'], ["exec('print(1)')", 'py'], ['const x = config[key]', 'js'], ['obj[key]()', 'js'],
      ["const fs = require('fs'); fs.readFileSync(p)", 'js'], ["eval('1 + 1')", 'js'],
    ] as const) expect({ code, ops: ops(code, lang) }).toEqual({ code, ops: [] })
  })
})
