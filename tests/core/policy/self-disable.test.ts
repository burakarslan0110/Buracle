import { describe, expect, test } from 'bun:test'
import { checkBash, type BashGuardOptions } from '../../../src/core/policy/bash-guard'
import { checkEval } from '../../../src/core/policy/eval-guard'
import { isStartupFile, mentionsRelocation, renderPrintf } from '../../../src/core/policy/self-disable'

const home = '/Users/u'
const opts: BashGuardOptions = { extraDeny: [], home, cwd: `${home}/code/app` }
const denied = (cmd: string): string | undefined => checkBash(cmd, opts).deny
const OFF = "would switch off Buracle's guards"

describe("G2: Buracle's CLI and the harness CLIs cannot switch the guards off", () => {
  test("Buracle's CLI: uninstall, rollback and config keys that turn guards or hooks off, in every spelling", () => {
    for (const cmd of [
      'buracle uninstall', 'buracle uninstall --yes --purge-state', '~/.buracle/bin/buracle uninstall', '"$BURACLE_HOME/bin/buracle" uninstall',
      '"${BURACLE_HOME:-$HOME/.buracle}/bin/buracle" uninstall --force', 'bun src/cli/main.ts uninstall', 'bun run /opt/buracle/src/cli/main.ts uninstall --yes',
      'bun harness/claude/bin/buracle.ts uninstall', 'buracle rollback', 'buracle --json rollback abc123',
      'buracle rollback toolchain', 'buracle rollback toolchain @upstash/context7-mcp --json',
      'buracle config set permissions.enforce false', 'buracle config set permissions.bypass false', 'buracle config set guards.bash.extraDeny "[]"',
      'buracle config set guards.write.protect "[]"', 'buracle config unset guards.write.protect', 'buracle config set guards.redact false',
      'buracle config set harnesses.claude.enabled false', 'buracle config set routing.strictness off', 'buracle config set plan.stopGuard false',
      'buracle config set plan.runaway.perPlan 0', 'buracle config set repo /tmp/evil', 'buracle config set guards "{}"',
      "buracle config set 'guards'.\"bash\".extraDeny x", 'buracle config set --string permissions.enforce no', 'buracle config set "$KEY" x',
      'sudo buracle uninstall', "bash -c 'buracle uninstall'", 'x=uninstall; buracle $x',
      'sh ~/.buracle/bin/buracle config set guards.bash.enabled false', 'bash -x -o pipefail "$HOME/.buracle/bin/buracle" uninstall', 'source ~/.buracle/bin/buracle rollback',
      'bun --bun src/cli/main.ts config set guards.bash.enabled false', 'node --import tsx /opt/buracle/src/cli/main.ts config set permissions.enforce false', 'deno run -A src/cli/main.ts uninstall',
    ]) expect({ cmd, reason: denied(cmd) }).toEqual({ cmd, reason: expect.stringContaining(OFF) })
  })

  test('the workflow switches that lower rigor are the user\'s: the independent reviews and goal-build verification', () => {
    for (const cmd of [
      'buracle config set plan.reviews.changes false', 'buracle config set plan.reviews.plan false', 'buracle config set plan.reviews.goal false',
      'buracle config unset plan.reviews', 'buracle config set plan.goalVerification false', 'buracle config set PLAN.GoalVerification false',
      'buracle config set plan.reviews.companion auto', 'buracle config set plan.reviews.companion off', 'buracle config unset plan.reviews.companion',
    ]) expect({ cmd, reason: denied(cmd) }).toEqual({ cmd, reason: expect.stringContaining(OFF) })
    for (const cmd of ['buracle config set plan.questions false', 'buracle config set plan.modelSwitch manual', 'buracle config get plan.reviews.changes', 'buracle config get plan']) {
      expect({ cmd, reason: denied(cmd) }).toEqual({ cmd, reason: undefined })
    }
  })

  test("the brain web UI's settings API is the user's too: a shell call or sandbox code that reaches it is refused, a mention is not", () => {
    for (const cmd of [
      "curl -s -X POST http://127.0.0.1:41777/api/settings -H 'x-buracle-token: abc' -d '{\"key\":\"plan.reviews.changes\",\"value\":false}'",
      'curl localhost:41778/api/settings', 'wget -qO- "http://[::1]:41777/api//settings"', "bash -c 'curl -d @x http://127.0.0.1:41777/api/settings'",
    ]) expect({ cmd, reason: denied(cmd) }).toEqual({ cmd, reason: expect.stringContaining("brain web UI's settings API") })
    const ctx = { cwd: `${home}/code/app`, home, vault: '', protect: [] }
    expect(checkEval("await fetch(`http://127.0.0.1:${port}/api/settings`, { method: 'POST', body: '{}' })", 'js', ctx).deny).toContain("brain web UI's settings API")
    expect(checkEval("import urllib.request; urllib.request.urlopen('http://localhost:41777/api/settings', b'{}')", 'python', ctx)).toMatchObject({ hook: 'H01' })
    for (const cmd of ['rg -n "/api/settings" src', 'curl -s http://127.0.0.1:41777/api/overview', 'curl https://example.com/api/settings']) expect({ cmd, reason: denied(cmd) }).toEqual({ cmd, reason: undefined })
  })

  test('the settings API is refused however its path is spelled: percent-encoded, twice encoded, with dot segments or built from joined strings', () => {
    for (const cmd of [
      "curl -X POST http://127.0.0.1:41777/api/%73ettings -d '{}'", "curl -X POST http://127.0.0.1:41777/api/%2573ettings -d '{}'",
      'curl -X POST http://127.0.0.1:41777/api%2Fsettings', 'curl -X POST http://127.0.0.1:41777/api/x/../settings', 'curl -X POST http://127.0.0.1:41777/api/./settings',
      "curl -X POST 'http://127.0.0.1:41777/api/%2e/settings'", 'curl -X POST http://%31%32%37.0.0.1:41777/api/settings', 'echo 100% done; curl -X POST http://127.0.0.1:41777/api/%73ettings',
      'P=settings; curl -X POST http://127.0.0.1:41777/api/$P',
    ]) expect({ cmd, reason: denied(cmd) }).toEqual({ cmd, reason: expect.stringContaining("brain web UI's settings API") })
    const ctx = { cwd: `${home}/code/app`, home, vault: '', protect: [] }
    expect(checkEval("await fetch('http://127.0.0.1:41777/api/' + 'settings', { method: 'POST' })", 'js', ctx).deny).toContain("brain web UI's settings API")
    expect(checkEval("await fetch('http://127.0.0.1:41777/api/%73ettings', { method: 'POST' })", 'js', ctx).deny).toContain("brain web UI's settings API")
    for (const cmd of ['curl https://example.com/api/%73ettings', 'cd .. && ls ./settings && curl -s localhost:41777/api/health', 'curl -s http://127.0.0.1:41777/api/x/../overview']) {
      expect({ cmd, reason: denied(cmd) }).toEqual({ cmd, reason: undefined })
    }
  })

  test("the settings API is refused when curl's own URL globbing or a shell expansion can spell its path", () => {
    for (const cmd of [
      "curl -X POST 'http://127.0.0.1:41777/api/{settings}'", "curl -X POST 'http://127.0.0.1:41777/api/s[e-e]ttings'", "curl -X POST 'http://127.0.0.1:41777/api/{sett,x}ings'",
      "curl -X POST 'http://127.0.0.1:41777/api/sett${EMPTY}ings'", "curl -X POST 'http://127.0.0.1:41777/api/sett$(true)ings'", "curl -X POST 'http://127.0.0.1:41777/api/`echo settings`'",
      'curl -X POST "http://127.0.0.1:41777/api/$(echo settings)"', "curl -X POST 'http://127.0.0.1:41777/ap{i,}/settings'", "curl -X POST 'http://localhost:41777/$X/settings'",
      "curl -X POST 'http://127.0.0.1:41777/api/x/{..}/settings'", "curl -X POST 'http://[::1]:41777/api/{settings}'", 'curl -g -X POST "http://127.0.0.1:$PORT/api/{settings}"',
    ]) expect({ cmd, reason: denied(cmd) }).toEqual({ cmd, reason: expect.stringContaining("brain web UI's settings API") })
    for (const cmd of [
      'curl -s http://127.0.0.1:41777/api/overview', 'curl -s "http://localhost:$PORT/api/overview?id=$ID"', "curl -X POST -d '{\"a\":1}' http://localhost:3000/api/users",
      "curl 'localhost:3000/items/{1,2}'", 'curl localhost:3000/api/users/$ID', 'curl http://localhost:$PORT/api/overview', 'curl https://example.com/api/{settings}',
      `curl -d '{"a":"settings"}' http://127.0.0.1:41777/api/overview`, '(curl -s http://127.0.0.1:41777/api/overview)', '(echo > /dev/tcp/127.0.0.1/3000) 2>/dev/null && echo up',
    ]) expect({ cmd, reason: denied(cmd) }).toEqual({ cmd, reason: undefined })
    const ctx = { cwd: `${home}/code/app`, home, vault: '', protect: [] }
    expect(checkEval('await fetch(`http://localhost:3000/api/${name}`)', 'js', ctx).deny).toBeUndefined()
  })

  test('the denial tells the agent to have the user run it with `!`', () => {
    expect(denied('buracle uninstall --yes')).toBe("`buracle uninstall --yes` would switch off Buracle's guards (it removes Buracle and its guard hooks from every harness); only the user may do that, so ask them to run it themselves by typing `! buracle uninstall --yes` in the prompt.")
  })

  test("the harness CLIs: plugin and marketplace removals, hook switches and one-run overrides", () => {
    for (const cmd of [
      'claude plugin disable buracle@buracle', 'claude plugin disable buracle@buracle --scope user', 'claude plugins uninstall buracle@buracle',
      'claude plugin remove buracle', 'claude plugin marketplace remove buracle', 'claude plugin disable --all', 'claude --bare -p "x"', 'claude --safe-mode',
      `claude -p x --settings '{"disableAllHooks": true}'`, 'claude -p x --setting-sources project,local', 'CLAUDE_CONFIG_DIR=/tmp/c claude -p "rm -rf ~"',
      'export BURACLE_HOME=/tmp/fb; claude -p x', 'codex plugin remove buracle', 'codex features disable hooks', 'codex -c features.hooks=false exec x',
      "codex exec --config 'features.hooks=false' x", 'codex --disable hooks exec x', 'CODEX_HOME=/tmp/x codex exec "x"', 'opencode plugin remove buracle',
      'opencode --pure run x', 'OPENCODE_PURE=1 opencode run x', 'omp plugin uninstall buracle-omp', 'omp plugin unlink buracle-omp', 'omp plugin disable buracle-omp',
      'omp --no-extensions -p x', 'omp config set disabledExtensions "[extension-module:buracle]"', 'env PI_CODING_AGENT_DIR=/tmp/o omp -p x',
    ]) expect({ cmd, reason: denied(cmd) }).toEqual({ cmd, reason: expect.stringContaining(OFF) })
  })

  test('everyday uses of the same CLIs stay allowed', () => {
    for (const cmd of [
      'buracle doctor', 'buracle plan status --json', 'buracle plan pause --kind decision --reason x', 'buracle config get guards', 'buracle config get permissions.enforce',
      'buracle config set statusline.style full', 'buracle config set memory.ui.port 41778', 'buracle uninstall --dry-run', 'buracle uninstall --help', 'buracle rollback --list',
      'buracle install', 'buracle update --check', 'bun src/cli/main.ts --help', 'HOME=/tmp/t BURACLE_HOME=/tmp/t/.buracle bun src/cli/main.ts build',
      'claude plugin list --json', 'claude plugin install context7@claude-plugins', 'claude plugin disable other@market', 'claude --version', 'claude -p "hi"',
      'CLAUDE_CONFIG_DIR=/tmp/c claude --version', 'codex features list', 'codex exec "hi"', 'codex -c model=o3 exec hi', 'opencode run "hi"', 'opencode plugin list',
      'omp plugin list', 'omp config get extensions', 'omp -p hi', 'claude plugin uninstall foo@bar',
    ]) expect({ cmd, reason: denied(cmd) }).toEqual({ cmd, reason: undefined })
  })
})

describe('G3: Buracle and the harness settings cannot be relocated for later sessions', () => {
  test('startup files that would set a relocation variable, in any spelling the shell reads', () => {
    for (const cmd of [
      "echo 'export BURACLE_HOME=/tmp/fb' >> ~/.zshrc", 'echo "export BURACLE_HOME=/tmp/fb" >> $HOME/.bash_profile', "echo 'export CLAUDE_CONFIG_DIR=/tmp/c' >> ~/.zprofile",
      "echo 'export CODEX_HOME=/tmp/x' >> ~/.zshenv", "echo 'export XDG_CONFIG_HOME=/tmp/x' >> ~/.profile", "echo 'export XDG_DATA_HOME=/tmp/x' >> ~/.bashrc",
      "echo 'export PI_CODING_AGENT_DIR=/tmp/x' >> ~/.zshrc", "echo 'export BURACLE_CORTEXDB_BIN=/tmp/v' >> ~/.zshrc", "echo 'set -gx BURACLE_HOME /tmp/fb' >> ~/.config/fish/config.fish",
      "printf 'export BURACLE_%s=/tmp/fb\\n' HOME >> ~/.zshrc", "echo -e 'export \\x42URACLE_HOME=/tmp/fb' >> ~/.zshrc", `echo 'export BURA""CLE_HOME=/tmp/fb' >> ~/.zshrc`,
      "echo 'export BURACLE_HOME=/tmp/fb' | tee -a ~/.zshrc", "cat >> ~/.zshrc <<'EOF'\nexport BURACLE_HOME=/tmp/fb\nEOF", 'tee -a ~/.zshrc <<< "export BURACLE_HOME=/tmp/fb"',
      "sed -i '' '1i\\\nexport BURACLE_HOME=/tmp/fb' ~/.zshrc", 'x=BURACLE; echo "export ${x}_HOME=/tmp/fb" >> ~/.zshrc', "echo 'export BURACLE_HOME=/tmp/fb' >> .envrc",
      `echo ${Buffer.from('export BURACLE_HOME=/tmp/fb').toString('base64')} | base64 -d >> ~/.zshrc`, "echo 'export BURACLE_HOME=/tmp' >> ~/.oh-my-zsh/custom/env.zsh",
      "sudo sh -c 'echo BURACLE_HOME=/tmp/fb >> /etc/environment'", "{ echo 'export BURACLE_HOME=/tmp/fb'; } >> ~/.zshrc",
    ]) expect({ cmd, reason: denied(cmd) }).toEqual({ cmd, reason: expect.stringMatching(/shell startup file .* set a variable that relocates Buracle/) })
  })

  test('launchctl setenv, fish universal variables, setx and systemd user environments', () => {
    for (const cmd of [
      'launchctl setenv BURACLE_HOME /tmp/fb', 'launchctl setenv CLAUDE_CONFIG_DIR /tmp/c', 'launchctl setenv "$V" /tmp/fb', "fish -c 'set -Ux BURACLE_HOME /tmp/fb'",
      'set --universal CODEX_HOME /tmp/x', 'setx BURACLE_HOME C:\\fb', 'systemctl --user set-environment XDG_CONFIG_HOME=/tmp/x',
    ]) expect({ cmd, reason: denied(cmd) }).toEqual({ cmd, reason: expect.stringContaining('relocates Buracle or the harness settings') })
  })

  test("writes into the shim's folder are refused (SEC-1 already covers $BURACLE_HOME/bin and ~/.buracle/bin)", () => {
    for (const cmd of ['echo x > ~/.buracle/bin/buracle', 'cp evil "$BURACLE_HOME/bin/buracle"', 'ln -sf /tmp/fb ~/.buracle/bin/buracle']) {
      expect({ cmd, reason: denied(cmd) }).toEqual({ cmd, reason: expect.stringContaining("Buracle's own installation") })
    }
  })

  test('everyday startup-file edits and variables stay allowed', () => {
    for (const cmd of [
      'echo hi >> ~/.zshrc', "echo 'export PATH=\"$HOME/bin:$PATH\"' >> ~/.zshrc", "echo 'eval \"$(/opt/homebrew/bin/brew shellenv)\"' >> ~/.zprofile", 'source ~/.zshrc',
      'cat ~/.zshrc', 'grep BURACLE_HOME ~/.zshrc', 'echo $BURACLE_HOME', 'launchctl setenv JAVA_HOME /opt/jdk', 'launchctl getenv BURACLE_HOME', 'set -x',
      'BURACLE_HOME=/tmp/t bun test', "echo 'BURACLE_HOME=/tmp/x' > /tmp/test-env.sh", "echo 'export BURACLE_HOME=x' >> notes.md",
    ]) expect({ cmd, reason: denied(cmd) }).toEqual({ cmd, reason: undefined })
  })

  test("code in context-mode's sandbox that runs such a command is refused too", () => {
    const ctx = { cwd: `${home}/code/app`, home, vault: '~/Documents/Buracle', protect: [] }
    expect(checkEval("import os; os.system('buracle uninstall --yes')", 'python', ctx).deny).toContain(OFF)
    expect(checkEval("require('child_process').execSync(\"echo 'export BURACLE_HOME=/tmp/fb' >> ~/.zshrc\")", 'js', ctx).deny).toContain('shell startup file')
  })
})

describe('the helpers', () => {
  test('mentionsRelocation reads the text as written, escapes decoded and as the shell reads it', () => {
    expect(mentionsRelocation('export BURACLE_HOME=/x')).toBe(true)
    expect(mentionsRelocation("export $'\\x42URACLE_HOME'=/x")).toBe(true)
    expect(mentionsRelocation('export BURA\\CLE_HOME=/x')).toBe(true)
    expect(mentionsRelocation('export ${:-BURACLE}_HOME=/x')).toBe(true)
    expect(mentionsRelocation('export PATH=$HOME/bin:$PATH')).toBe(false)
    expect(mentionsRelocation('')).toBe(false)
  })

  test('isStartupFile knows the startup files, the system ones and scripts in hidden folders of a home folder', () => {
    for (const p of ['/Users/u/.zshrc', '~/.bash_profile', '.envrc', '/etc/zshrc', '/private/etc/profile', '/etc/profile.d/x.sh', '/Users/u/.config/environment.d/a.conf', '/Users/u/.oh-my-zsh/custom/env.zsh', '/home/u/.config/fish/config.fish']) {
      expect({ p, startup: isStartupFile(p) }).toEqual({ p, startup: true })
    }
    for (const p of ['/Users/u/code/app/run.sh', '/Users/u/code/.github/x.sh', 'zshrc', '/tmp/x.sh', '/Users/u/.zshrc.bak']) {
      expect({ p, startup: isStartupFile(p) }).toEqual({ p, startup: false })
    }
  })

  test('renderPrintf reuses the format while arguments remain', () => {
    expect(renderPrintf('export BURACLE_%s=/x\\n', ['HOME'])).toBe('export BURACLE_HOME=/x\\n')
    expect(renderPrintf('%s-%s;', ['a', 'b', 'c'])).toBe('a-b;c-;')
    expect(renderPrintf('100%%', [])).toBe('100%')
  })
})
