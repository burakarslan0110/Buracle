import { describe, expect, test } from 'bun:test'
import { shellFileRead, shellFileWrite } from '../../../src/core/policy/shell-files'

describe('shellFileWrite: shell commands that write project files', () => {
  test('redirects, heredocs into files, tee and in-place edits', () => {
    expect(shellFileWrite('echo hi > src/a.ts')).toEqual({ label: 'a `>` redirect', file: 'src/a.ts' })
    expect(shellFileWrite("cat > src/app.py <<'EOF'\nprint(1) > 2\nEOF")).toEqual({ label: 'a `>` redirect', file: 'src/app.py' })
    expect(shellFileWrite('echo x >> .gitignore')?.file).toBe('.gitignore')
    expect(shellFileWrite('{ echo a; echo b; } > notes.txt')?.file).toBe('notes.txt')
    expect(shellFileWrite('printf x | tee -a src/b.ts')).toEqual({ label: 'tee', file: 'src/b.ts' })
    expect(shellFileWrite("sed -i 's/a/b/' src/a.ts")).toEqual({ label: 'sed -i in place', file: 'src/a.ts' })
    expect(shellFileWrite("sed -i '' -e 's/a/b/' src/a.ts")?.file).toBe('src/a.ts')
    expect(shellFileWrite("perl -pi -e 's/a/b/' lib/x.pl")).toEqual({ label: 'perl -i in place', file: 'lib/x.pl' })
    expect(shellFileWrite("gawk -i inplace '{print}' data.txt")).toEqual({ label: 'awk -i inplace', file: 'data.txt' })
    expect(shellFileWrite('cd src && echo x > a.ts')?.file).toBe('a.ts')
    expect(shellFileWrite("bash -c 'echo x > src/a.ts'")?.file).toBe('src/a.ts')
    expect(shellFileWrite('echo x > ~/notes.md')?.file).toBe('~/notes.md')
  })

  test('perl, ruby and sed option clusters that end in -e take the script, not the file', () => {
    expect(shellFileWrite("perl -i -pe 's/a/b/' src/x.ts")).toEqual({ label: 'perl -i in place', file: 'src/x.ts' })
    expect(shellFileWrite("perl -i.bak -pe 's/a/b/' src/x.ts")?.file).toBe('src/x.ts')
    expect(shellFileWrite("perl -i -nE 'print' src/x.ts")?.file).toBe('src/x.ts')
    expect(shellFileWrite("ruby -i -pe 'x' src/a.rb")).toEqual({ label: 'ruby -i in place', file: 'src/a.rb' })
    expect(shellFileWrite("sed -i -ne 's/a/b/p' src/a.ts")?.file).toBe('src/a.ts')
    expect(shellFileWrite("sed -E -i 's/a/b/' src/a.ts")?.file).toBe('src/a.ts')
    expect(shellFileWrite("perl -ne 'open(F, \">out.txt\")' src/a.ts")?.label).toBe('inline perl code')
    expect(shellFileWrite("perl -pie 's/a/b/' src/x.ts")).toEqual({ label: 'perl -i in place', file: 'src/x.ts' })
    expect(shellFileWrite("ruby -pie 'x' src/a.rb")?.file).toBe('src/a.rb')
    expect(shellFileWrite('perl -i -p fix.pl src/x.ts')?.file).toBe('src/x.ts')
  })

  test('find -exec runs the in-place editor on the files it finds', () => {
    expect(shellFileWrite("find . -name '*.ts' -exec sed -i 's/a/b/' {} +")).toEqual({ label: 'find -exec sed -i in place' })
    expect(shellFileWrite("find src -type f -exec perl -pi -e 's/a/b/' {} \\;")).toEqual({ label: 'find -exec perl -i in place' })
    expect(shellFileWrite("find . -name '*.ts' -exec grep -l x {} + -exec sed -i 's/a/b/' src/c.ts \\;")).toEqual({ label: 'find -exec sed -i in place', file: 'src/c.ts' })
    expect(shellFileWrite("find . -name '*.ts' -exec grep -l x {} +")).toBeUndefined()
  })

  test('find -exec sh -c and bash -c scripts are followed, with $1, $@ and {} standing for the found files', () => {
    expect(shellFileWrite(`find . -name '*.ts' -exec sh -c 'sed -i "s/a/b/" "$1"' _ {} \\;`)).toEqual({ label: 'find -exec sed -i in place' })
    expect(shellFileWrite(`find src -type f -exec bash -c 'perl -pi -e "s/a/b/" "$@"' _ {} +`)).toEqual({ label: 'find -exec perl -i in place' })
    expect(shellFileWrite(`find . -execdir sh -c 'echo x > notes.txt' \\;`)).toEqual({ label: 'find -execdir a `>` redirect', file: 'notes.txt' })
    expect(shellFileWrite(`find . -exec sh -c "sed -i s/a/b/ {}" \\;`)).toEqual({ label: 'find -exec sed -i in place' })
    expect(shellFileWrite(`find . -exec sh -c 'wc -l "$1"' _ {} \\;`)).toBeUndefined()
    expect(shellFileWrite(`find . -exec sh -c 'sed -i s/a/b/ "$OUT"' \\;`)).toBeUndefined()
    expect(shellFileWrite(`sh -c 'sed -i s/a/b/ "$1"' _ src/a.ts`)).toBeUndefined()
  })

  test('with the session scope, files outside the project, system files and home dotfiles are left alone', () => {
    const scope = { cwd: '/w/proj/sub', root: '/w/proj', home: '/w' }
    expect(shellFileWrite('echo x > notes/a.txt', scope)?.file).toBe('notes/a.txt')
    expect(shellFileWrite('echo x > ../lib/a.ts', scope)?.file).toBe('../lib/a.ts')
    expect(shellFileWrite('echo x > /w/proj/src/a.ts', scope)?.file).toBe('/w/proj/src/a.ts')
    for (const c of ['echo x | sudo tee -a /etc/hosts', 'echo x >> ~/.zshrc', 'echo x > ~/notes.md', 'echo x > /w/other/a.ts', 'echo x > ../../a.ts', "sed -i 's/a/b/' ~/.config/app.toml"]) {
      expect({ c, w: shellFileWrite(c, scope) }).toEqual({ c, w: undefined })
    }
    expect(shellFileWrite('echo x >> ~/.zshrc', { cwd: '/w', home: '/w' })).toBeUndefined()
    expect(shellFileWrite('echo x > ~/notes.md', { cwd: '/w', home: '/w' })?.file).toBe('~/notes.md')
    expect(shellFileWrite('echo x > ~/.dotfiles/zshrc', { cwd: '/w/.dotfiles', root: '/w/.dotfiles', home: '/w' })?.file).toBe('~/.dotfiles/zshrc')
    expect(shellFileWrite("echo x > 'C:\\w\\proj\\a.ts'", { cwd: 'C:\\w\\proj', root: 'C:\\w\\proj' })?.file).toBe('C:\\w\\proj\\a.ts')
    expect(shellFileWrite("echo x > 'C:\\w\\other\\a.ts'", { cwd: 'C:\\w\\proj', root: 'C:\\w\\proj' })).toBeUndefined()
    expect(shellFileWrite('echo x >> /etc/hosts')).toBeUndefined()
    expect(shellFileWrite('echo x >> ~/.zshrc')).toBeUndefined()
  })

  test('a cd earlier in the command moves where relative targets land', () => {
    const scope = { cwd: '/w/proj', root: '/w/proj', home: '/w' }
    for (const c of ['cd /tmp && echo x > a.txt', 'cd /w/other; sed -i s/a/b/ a.ts', 'cd "$TMPDIR" && echo x > a.txt', 'cd .. && echo x > a.txt', 'cd && echo x >> .zshrc', "cd ~ && sed -i 's/a/b/' .config/app.toml"]) {
      expect({ c, w: shellFileWrite(c, scope) }).toEqual({ c, w: undefined })
    }
    expect(shellFileWrite('cd src && echo x > a.ts', scope)?.file).toBe('a.ts')
    expect(shellFileWrite('cd /w/proj/lib && echo x > a.ts', scope)?.file).toBe('a.ts')
    expect(shellFileWrite('cd "$DIR" && echo x > a.ts', scope)?.file).toBe('a.ts')
    expect(shellFileWrite('cd /tmp | cat; echo x > a.ts', scope)?.file).toBe('a.ts')
    expect(shellFileWrite('(cd /tmp && echo x > a.txt); echo y > b.txt', scope)?.file).toBe('b.txt')
    expect(shellFileWrite('cd /tmp && echo x > a.txt')).toBeUndefined()
    expect(shellFileWrite("cd 'C:\\Temp' && echo x > a.txt", { cwd: 'C:\\w\\proj', root: 'C:\\w\\proj' })).toBeUndefined()
  })

  test('a project inside a temp folder still gets the note for its own files', () => {
    const scope = { cwd: '/private/tmp/work/proj', root: '/private/tmp/work/proj', home: '/Users/u' }
    expect(shellFileWrite('echo x > /private/tmp/work/proj/src/a.ts', scope)?.file).toBe('/private/tmp/work/proj/src/a.ts')
    expect(shellFileWrite("sed -i 's/a/b/' /private/tmp/work/proj/a.ts", scope)?.file).toBe('/private/tmp/work/proj/a.ts')
    expect(shellFileWrite('echo x | tee /tmp/w/p/b.ts', { cwd: '/tmp/w/p', home: '/Users/u' })?.file).toBe('/tmp/w/p/b.ts')
    expect(shellFileWrite('echo x > src/a.ts', scope)?.file).toBe('src/a.ts')
    for (const c of ['bun test > /private/tmp/work/out.txt 2>&1', 'cmd > /tmp/x.log', 'cmd > "$TMPDIR/x"', 'cmd 2>/dev/null', 'cd /tmp && echo x > a.txt']) {
      expect({ c, w: shellFileWrite(c, scope) }).toEqual({ c, w: undefined })
    }
    for (const temp of ['/tmp', '/private/tmp', '/var/folders/ab/cd1234/T']) {
      expect({ temp, w: shellFileWrite(`echo x > ${temp}/a.txt`, { cwd: temp, root: temp }) }).toEqual({ temp, w: undefined })
    }
  })

  test('a session at the file system root does not make every path a project file', () => {
    for (const scope of [{ cwd: '/', root: '/', home: '/w' }, { cwd: '/' }, { cwd: 'C:\\', root: 'C:\\' }]) {
      for (const c of ['echo x >> /etc/hosts', "echo x > 'C:\\Windows\\a.ini'"]) expect({ c, scope, w: shellFileWrite(c, scope) }).toEqual({ c, scope, w: undefined })
    }
    expect(shellFileWrite('echo x > /w/proj/a.ts', { cwd: '/', root: '/', home: '/w' })?.file).toBe('/w/proj/a.ts')
    expect(shellFileWrite('echo x > a.ts', { cwd: '/', root: '/' })?.file).toBe('a.ts')
  })

  test('inline interpreter code that writes files', () => {
    expect(shellFileWrite(`python3 -c "open('a.py','w').write('x')"`)).toEqual({ label: 'inline python3 code' })
    expect(shellFileWrite("node -e \"require('fs').writeFileSync('a.js', 'x')\"")?.label).toBe('inline node code')
    expect(shellFileWrite("python3 - <<'EOF'\nfrom pathlib import Path\nPath('a.py').write_text('x')\nEOF")?.label).toBe('inline python3 code')
    expect(shellFileWrite("bun -e \"await Bun.write('a.ts', 'x')\"")?.label).toBe('inline bun code')
    expect(shellFileWrite(`python3 -c "print(open('a.py').read())"`)).toBeUndefined()
  })

  test('temp files, devices, file descriptors, variables, Buracle and plain commands are no file edits', () => {
    for (const c of [
      'bun test > /tmp/out.txt 2>&1', 'cmd 2>/dev/null', 'cmd >&2', 'cmd > /private/tmp/claude-1/x', 'cmd > "$TMPDIR/x"', 'cmd > $OUT',
      'echo x | tee /dev/stderr', 'buracle mem search x > notes.md', 'sed -n 1,5p a.ts', 'prettier --write src', 'ruff check --fix .', 'gofmt -w a.go',
      'git commit -m "a > b"', 'ls -la', '', 'echo "a > b"', 'cat <<EOF\nx > y\nEOF',
    ]) expect({ c, w: shellFileWrite(c) }).toEqual({ c, w: undefined })
  })
})

describe('shellFileRead: printing source files in the shell', () => {
  test('cat, head, tail, sed -n ranges and nl of one to three files', () => {
    expect(shellFileRead('cat src/a.ts')).toEqual(['src/a.ts'])
    expect(shellFileRead('head -n 50 src/a.ts')).toEqual(['src/a.ts'])
    expect(shellFileRead('tail -20 README.md')).toEqual(['README.md'])
    expect(shellFileRead("sed -n '1,80p' src/core/x.ts")).toEqual(['src/core/x.ts'])
    expect(shellFileRead('cd app && cat -n main.py')).toEqual(['main.py'])
    expect(shellFileRead('cat a.ts; echo ---; cat b.ts')).toEqual(['a.ts', 'b.ts'])
    expect(shellFileRead('cat ~/x.md')).toEqual(['~/x.md'])
  })

  test('processing, following, logs, temp files, globs, stdin and many files stay in the shell', () => {
    for (const c of [
      'cat a.ts | grep x', 'cat a.json | jq .', 'tail -f app.log', 'tail -F x.ts', 'tail -n 100 build.log', 'head -c 100 a.bin', "sed -n '/foo/p' a.ts",
      "sed -n -i '1p' a.ts", 'cat /tmp/out.txt', 'cat src/*.ts', 'cat a b c d', 'cat', 'cat -', 'cat $F', 'cat a.ts > b.ts', 'cat <<EOF\nx\nEOF',
      'echo $(cat a.ts)', 'grep -n x a.ts', 'rg x a.ts', 'ls', 'FOO=1 cat a.ts', '',
    ]) expect({ c, r: shellFileRead(c) }).toEqual({ c, r: undefined })
  })
})
