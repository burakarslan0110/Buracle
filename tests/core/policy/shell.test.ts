import { describe, expect, test } from 'bun:test'
import { DYN, HOME, commandName, parseShell, simpleCommands, unwrap } from '../../../src/core/policy/shell'

const words = (src: string): string[][] => simpleCommands(parseShell(src).script).map(c => c.words.map(w => w.text))

describe('parseShell: words and quoting', () => {
  test('splits on whitespace and removes quotes', () => {
    expect(words(`echo 'a b' "c d" e\\ f`)).toEqual([['echo', 'a b', 'c d', 'e f']])
    expect(words(`printf "%s\\n" "x\\"y"`)).toEqual([['printf', '%s\\n', 'x"y']])
    expect(words(`echo $'tab\\there'`)).toEqual([['echo', 'tab\there']])
  })

  test('expansions become markers; HOME and PWD are recognized at the start of a word', () => {
    const [cmd] = simpleCommands(parseShell('rm ~ ~/x "$HOME" ${HOME}/y $PWD $(pwd) $X "$Y/z" ~user/q').script)
    expect(cmd?.words.map(w => w.text)).toEqual(['rm', HOME, `${HOME}/x`, HOME, `${HOME}/y`, '.', '.', DYN, `${DYN}/z`, `${HOME}/q`])
    expect(cmd?.words.map(w => w.dynamic)).toEqual([false, false, false, false, false, false, false, true, true, false])
  })

  test('quoted tilde and single-quoted variables stay literal', () => {
    expect(words(`echo "~" '$HOME' '~/x'`)).toEqual([['echo', '~', '$HOME', '~/x']])
  })

  test('collects command-substitution and process-substitution bodies', () => {
    expect(parseShell('echo $(date) `whoami` <(curl x) "$(id -u)"').subs).toEqual(['date', 'whoami', 'curl x', 'id -u'])
    expect(parseShell('echo ${X:-$(rm -rf /)}').subs).toEqual(['rm -rf /'])
  })

  test('comments are ignored, # inside words is not a comment', () => {
    expect(words('ls # rm -rf /\necho a#b')).toEqual([['ls'], ['echo', 'a#b']])
  })
})

describe('parseShell: structure', () => {
  test('lists, pipelines, groups and line continuations', () => {
    const { script } = parseShell('a && b || c; d | e |& f\ng & (h; i) | { j; }\nk \\\n  l')
    expect(script.pipelines.map(p => p.stages.length)).toEqual([1, 1, 1, 3, 1, 2, 1])
    expect(words('a && b || c; d | e |& f\ng & (h; i) | { j; }\nk \\\n  l')).toEqual([['a'], ['b'], ['c'], ['d'], ['e'], ['f'], ['g'], ['h'], ['i'], ['j'], ['k', 'l']])
  })

  test('redirections and fd prefixes', () => {
    const [cmd] = simpleCommands(parseShell('cmd 2>&1 >out.log 2>>err.log < in.txt &>/dev/null').script)
    expect(cmd?.words.map(w => w.text)).toEqual(['cmd'])
    expect(cmd?.redirects.map(r => [r.op, r.target?.text])).toEqual([['>&', '1'], ['>', 'out.log'], ['>>', 'err.log'], ['<', 'in.txt'], ['&>', '/dev/null']])
  })

  test('here-document bodies are attached, not parsed as commands', () => {
    const src = "cat <<'EOF' > notes.md\nrm -rf /\nEOF\necho done\ncat <<-X\n\tline\n\tX\nls"
    expect(words(src)).toEqual([['cat'], ['echo', 'done'], ['cat'], ['ls']])
    const cmds = simpleCommands(parseShell(src).script)
    expect(cmds[0]?.redirects.find(r => r.op === '<<')?.body).toBe('rm -rf /')
    expect(cmds[2]?.redirects.find(r => r.op === '<<-')?.body).toBe('\tline')
  })

  test('assignments, reserved words and function definitions', () => {
    const cmds = simpleCommands(parseShell('A=1 B="x y" cmd C=2; if true; then x; fi; for f in a b; do y "$f"; done; f() { z; }').script)
    expect(cmds[0]?.assigns.map(w => w.text)).toEqual(['A=1', 'B=x y'])
    expect(cmds[0]?.words.map(w => w.text)).toEqual(['cmd', 'C=2'])
    expect(cmds.slice(1).map(c => c.words[0]?.text)).toEqual(['true', 'x', 'y', 'z'])
  })

  test('never throws and stays linear on unbalanced input', () => {
    for (const s of ["'open", '"open', '$(open', '`open', '(((', ')))', '<<', 'cat <<EOF\nno end', '${', '\\']) expect(() => parseShell(s)).not.toThrow()
  })
})

describe('unwrap', () => {
  const u = (src: string) => {
    const [cmd] = simpleCommands(parseShell(src).script)
    const r = unwrap(cmd?.words ?? [])
    return { argv: r.argv.map(w => w.text), scripts: r.scripts, stdin: r.shellReadsStdin }
  }

  test('peels privilege, environment and process wrappers', () => {
    expect(u('sudo -u root -E rm -rf x').argv).toEqual(['rm', '-rf', 'x'])
    expect(u('doas -u root ls').argv).toEqual(['ls'])
    expect(u('env -i -u X A=1 B=2 node app.js').argv).toEqual(['node', 'app.js'])
    expect(u('nohup nice -n 5 timeout -s KILL 10 make').argv).toEqual(['make'])
    expect(u('xargs -0 -I {} rm -f {}').argv).toEqual(['rm', '-f', '{}'])
    expect(u('command -p ls').argv).toEqual(['ls'])
    expect(u('command -v rm').argv).toEqual([])
    expect(u('sudo -e /etc/hosts').argv).toEqual([])
  })

  test('collects the scripts shells, eval, su and env -S run', () => {
    expect(u("bash -c 'echo hi'").scripts).toEqual(['echo hi'])
    expect(u("bash -euo pipefail -c 'x'").scripts).toEqual(['x'])
    expect(u('sh -lc "a && b"').scripts).toEqual(['a && b'])
    expect(u('eval echo hi').scripts).toEqual(['echo hi'])
    expect(u("su root -c 'id'").scripts).toEqual(['id'])
    expect(u("env -S 'ls -l'").scripts).toEqual(['ls -l'])
  })

  test('recognizes a shell that reads its script from stdin', () => {
    expect(u('bash').stdin).toBe(true)
    expect(u('sh -s -- --flag').stdin).toBe(true)
    expect(u('bash -').stdin).toBe(true)
    expect(u('bash script.sh').stdin).toBe(false)
    expect(u("bash -c 'x'").stdin).toBe(false)
  })

  test('commandName lower-cases basenames and ignores dynamic words', () => {
    const [cmd] = simpleCommands(parseShell('/BIN/RM $X ~').script)
    expect(commandName(cmd?.words[0])).toBe('rm')
    expect(commandName(cmd?.words[1])).toBeUndefined()
    expect(commandName(cmd?.words[2])).toBeUndefined()
  })
})

describe('parseShell: arithmetic (SEC-05)', () => {
  test('(( … )) and for (( … )) are one opaque word; a << inside is a shift', () => {
    expect(words('(( x << 2 ))\nrm -rf ~')).toEqual([[DYN], ['rm', '-rf', HOME]])
    expect(words('for ((i=0; i<<1; i++)); do x; done\ny')).toEqual([['x'], ['y']])
    expect(words('if (( a << b )); then z; fi')).toEqual([[DYN], ['z']])
    expect(words('echo $[1<<2]\nls')).toEqual([['echo', DYN], ['ls']])
  })

  test('only at the start of a command, and only when it closes with ))', () => {
    expect(words('((echo a) | cat)')).toEqual([['echo', 'a'], ['cat']])
    expect(() => parseShell('(( x << 2')).not.toThrow()
  })

  test('command substitutions inside arithmetic are collected for checking', () => {
    expect(parseShell('echo $(( $(id -u) + 1 ))').subs).toEqual(['id -u'])
    expect(parseShell('echo $(( `whoami` ))').subs).toEqual(['whoami'])
    expect(parseShell('(( $(date +%s) > 0 ))').subs).toEqual(['date +%s'])
    expect(parseShell('echo $[ $(a) + ${x:-$(b)} ]').subs).toEqual(['a', 'b'])
  })

  test('a comment or here-document before (( does not confuse the arithmetic scan', () => {
    expect(words("# don't\n(( x << 2 ))\nrm -rf ~")).toEqual([[DYN], ['rm', '-rf', HOME]])
    expect(words("cat <<EOF\ndon't\nEOF\n(( x << 2 ))\nls")).toEqual([['cat'], [DYN], ['ls']])
  })
})

describe('parseShell: IFS splitting and brace expansion (SEC-06)', () => {
  test('an unquoted $IFS splits the word; quoted or in an assignment it does not', () => {
    expect(words('rm${IFS}-rf${IFS}/')).toEqual([['rm', '-rf', '/']])
    expect(words('touch$IFS"a b"')).toEqual([['touch', 'a b']])
    expect(words('echo "a${IFS}b"')).toEqual([['echo', `a${DYN}b`]])
    expect(simpleCommands(parseShell('OLD=$IFS').script)[0]?.assigns.map(w => w.text)).toEqual([`OLD=${DYN}`])
  })

  test('brace lists expand in bash order, nested, with sequences', () => {
    expect(words('{rm,-rf,/}')).toEqual([['rm', '-rf', '/']])
    expect(words('echo a{b,c}d')).toEqual([['echo', 'abd', 'acd']])
    expect(words('echo {a,b}{1,2}')).toEqual([['echo', 'a1', 'a2', 'b1', 'b2']])
    expect(words('echo {a,{b,c}}x')).toEqual([['echo', 'ax', 'bx', 'cx']])
    expect(words('echo {1..3} {c..a} {01..03} {1..7..3}')).toEqual([['echo', '1', '2', '3', 'c', 'b', 'a', '01', '02', '03', '1', '4', '7']])
    expect(words('cp f{,.bak}')).toEqual([['cp', 'f', 'f.bak']])
  })

  test('quoted braces, ${…}, {} and single groups stay literal', () => {
    expect(words(`echo '{a,b}' "{a,b}" {} {a} {a..} x{`)).toEqual([['echo', '{a,b}', '{a,b}', '{}', '{a}', '{a..}', 'x{']])
    expect(words('echo ${x,,} a,b')).toEqual([['echo', DYN, 'a,b']])
    expect(words('{ echo a; }')).toEqual([['echo', 'a']])
    expect(words('{rm,"-rf",/}')).toEqual([['rm', '-rf', '/']])
  })

  test('tilde expands at the start of each brace-expanded word', () => {
    expect(words('{rm,-rf,~}')).toEqual([['rm', '-rf', HOME]])
    expect(words('echo {~,~/x,a~}')).toEqual([['echo', HOME, `${HOME}/x`, 'a~']])
    expect(words('echo {"~",b}')).toEqual([['echo', '~', 'b']])
  })

  test('expansions keep their references through brace expansion', () => {
    const [cmd] = simpleCommands(parseShell('echo {$a,b}$c').script)
    expect(cmd?.words.map(w => w.text)).toEqual(['echo', `${DYN}${DYN}`, `b${DYN}`])
    expect(cmd?.words[1]?.vars?.map(v => v.name)).toEqual(['a', 'c'])
    expect(cmd?.words[2]?.vars?.map(v => v.name)).toEqual(['c'])
  })

  test('huge products are reduced to the distinct words, not enumerated', () => {
    const start = performance.now()
    const [cmd] = simpleCommands(parseShell('{rm,-rf,/}' + '{,}'.repeat(30)).script)
    expect(cmd?.words.map(w => w.text)).toEqual(['rm', '-rf', '/'])
    expect(performance.now() - start).toBeLessThan(200)
  })
})

describe('parseShell: variable references and here-document quoting', () => {
  test('each DYN marker records the variable it stands for and whether it was quoted', () => {
    const [cmd] = simpleCommands(parseShell('cmd $x "${y}" $1 "$(id)" ${z:-q} pre$w').script)
    expect(cmd?.words.slice(1).map(w => w.vars?.map(v => [v.name ?? null, v.quoted]))).toEqual([
      [['x', false]], [['y', true]], [[null, false]], [[null, true]], [[null, false]], [['w', false]],
    ])
  })

  test('mid-word $HOME is a reference, the leading one the home marker; ~+ is $PWD', () => {
    const [cmd] = simpleCommands(parseShell('echo "x$HOME" ~+ ~-').script)
    expect(cmd?.words.map(w => w.text)).toEqual(['echo', `x${DYN}`, '.', DYN])
    expect(cmd?.words[1]?.vars?.[0]?.name).toBe('HOME')
  })

  test('${HOME%/} is the home directory and ${HOME%/*} its parent', () => {
    expect(words('rm -rf ${HOME%/} ${HOME%%/} ${HOME%/*}')).toEqual([['rm', '-rf', HOME, HOME, `${HOME}/..`]])
  })

  test('a here-document with an unquoted delimiter expands its body', () => {
    const [a] = simpleCommands(parseShell('cat <<EOF\n$(x)\nEOF').script)
    const [b] = simpleCommands(parseShell("cat <<'EOF'\n$(x)\nEOF").script)
    expect(a?.redirects[0]?.bodyExpands).toBe(true)
    expect(b?.redirects[0]?.bodyExpands).toBeUndefined()
  })
})

describe('unwrap: more wrappers', () => {
  const argv = (src: string): string[] => unwrap(simpleCommands(parseShell(src).script)[0]?.words ?? []).argv.map(w => w.text)
  const u = (src: string) => unwrap(simpleCommands(parseShell(src).script)[0]?.words ?? [])

  test('coproc, caffeinate -t, taskpolicy -c, env -P, zsh - and repeat, script', () => {
    expect(argv('coproc rm -rf x')).toEqual(['rm', '-rf', 'x'])
    expect(argv('coproc W { rm -rf x; }')).toEqual(['rm', '-rf', 'x'])
    expect(argv('caffeinate -t 5 make')).toEqual(['make'])
    expect(argv('taskpolicy -c utility make')).toEqual(['make'])
    expect(argv('env -P /bin rm x')).toEqual(['rm', 'x'])
    expect(argv('- rm x')).toEqual(['rm', 'x'])
    expect(argv('repeat 3 rm x')).toEqual(['rm', 'x'])
    expect(argv('script -q /dev/null rm x')).toEqual(['rm', 'x'])
  })

  test('trap and script -c collect the script they run; bash /dev/stdin reads stdin', () => {
    expect(u("trap 'rm -f lock' EXIT").scripts).toEqual(['rm -f lock'])
    expect(u('trap -p').scripts).toEqual([])
    expect(u("script -q -c 'make test' log.txt").scripts).toEqual(['make test'])
    expect(u('bash /dev/stdin').shellReadsStdin).toBe(true)
  })

  test('setsid, flock, chrt, taskset, sandbox-exec, strace, ionice, time -o and arch -arch reach the command', () => {
    expect(argv('setsid git push --force origin main')).toEqual(['git', 'push', '--force', 'origin', 'main'])
    expect(argv('setsid -f rm x')).toEqual(['rm', 'x'])
    expect(argv('flock /tmp/lock git push -f origin main')).toEqual(['git', 'push', '-f', 'origin', 'main'])
    expect(argv('flock -w 5 -x /tmp/lock rm x')).toEqual(['rm', 'x'])
    expect(u("flock /tmp/lock -c 'rm -rf x'").scripts).toEqual(['rm -rf x'])
    expect(argv('chrt -f 10 rm x')).toEqual(['rm', 'x'])
    expect(argv('taskset -c 0,1 rm x')).toEqual(['rm', 'x'])
    expect(argv("sandbox-exec -p '(version 1)' rm x")).toEqual(['rm', 'x'])
    expect(argv('strace -f -o trace.txt rm x')).toEqual(['rm', 'x'])
    expect(argv('ionice -c 3 rm x')).toEqual(['rm', 'x'])
    expect(argv('time -o t.txt rm x')).toEqual(['rm', 'x'])
    expect(argv('arch -arch x86_64 rm x')).toEqual(['rm', 'x'])
    expect(argv('nice -n 5 timeout 10 stdbuf -oL nohup rm x')).toEqual(['rm', 'x'])
  })

  test('tmux and screen run their shell text, send-keys types it, at reads its job from stdin', () => {
    expect(u("tmux new-session -d -s w 'rm -rf x'").scripts).toEqual(['rm -rf x'])
    expect(u("tmux new -d 'rm -rf x'").scripts).toEqual(['rm -rf x'])
    expect(u("tmux -c 'rm -rf x'").scripts).toEqual(['rm -rf x'])
    expect(u("tmux send-keys -t w 'rm -rf x' Enter").scripts).toEqual(['rm -rf x\n'])
    expect(u("tmux new -d \\; split-window 'make' \\; send -t 1 'rm -rf x' C-m").scripts).toEqual(['make', 'rm -rf x\n'])
    expect(u('tmux attach -t w').scripts).toEqual([])
    expect(argv('screen -dmS w rm -rf x')).toEqual(['rm', '-rf', 'x'])
    expect(u("screen -S w -X stuff 'rm -rf x^M'").scripts).toEqual(['rm -rf x\n'])
    expect(u('at now + 1 minute').shellReadsStdin).toBe(true)
    expect(u('at -f job.sh now').shellReadsStdin).toBe(false)
  })

  test('sudo -s and -i hand the command to a shell as text', () => {
    expect(u("sudo -s 'rm -rf $HOME'").scripts).toEqual(['rm -rf $HOME'])
    expect(u('sudo -iu root rm x').scripts).toEqual(['rm x'])
    expect(u('sudo -u root rm x').scripts).toEqual([])
  })

  test('environment runners reach the command; package runners only through their shell text', () => {
    expect(argv('uv run --with requests rm x')).toEqual(['rm', 'x'])
    expect(argv('poetry run rm x')).toEqual(['rm', 'x'])
    expect(argv('bundle exec rm x')).toEqual(['rm', 'x'])
    expect(argv('pnpm --filter app exec rm x')).toEqual(['rm', 'x'])
    expect(argv('mise exec node@20 -- rm x')).toEqual(['rm', 'x'])
    expect(argv('direnv exec . rm x')).toEqual(['rm', 'x'])
    expect(argv('conda run -n env rm x')).toEqual(['rm', 'x'])
    expect(argv('nix develop -c rm x')).toEqual(['rm', 'x'])
    expect(argv('aws-vault exec prod -- rm x')).toEqual(['rm', 'x'])
    expect(u("nix-shell -p hello --run 'rm -rf x'").scripts).toEqual(['rm -rf x'])
    expect(u("bun exec 'rm -rf x'").scripts).toEqual(['rm -rf x'])
    expect(u("npx -c 'rm -rf x'").scripts).toEqual(['rm -rf x'])
    expect(u("npm exec -c 'rm -rf x'").scripts).toEqual(['rm -rf x'])
    expect(argv('npx prettier --check .')).toEqual(['npx', 'prettier', '--check', '.'])
    expect(argv('uv pip install x')).toEqual(['uv', 'pip', 'install', 'x'])
    expect(argv('bun run build')).toEqual(['bun', 'run', 'build'])
    expect(argv('npm test')).toEqual(['npm', 'test'])
  })

  test('more wrappers than unwrap follows, and expansions nested deeper than the parser follows, are flagged', () => {
    expect(u(`${'nice '.repeat(30)}rm x`).tooDeep).toBe(true)
    expect(u(`${'nice '.repeat(5)}rm x`).tooDeep).toBeUndefined()
    expect(parseShell(`${'${x:-'.repeat(40)}$(rm -rf x)${'}'.repeat(40)}`).truncated).toBe(true)
    expect(parseShell(`echo $(( ${'$(( '.repeat(20)}1${' ))'.repeat(20)} ))`).truncated).toBe(true)
    expect(parseShell('echo ${x:-$(date)} $(( 1 + 2 ))').truncated).toBeUndefined()
  })
})
