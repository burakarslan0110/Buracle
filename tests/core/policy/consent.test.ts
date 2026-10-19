import { describe, expect, test } from 'bun:test'
import {
  addConsentGrants, applyPromptGrants, CONSENT_KINDS, CONSENT_LABEL, consentNeeded, consentNeeds, consentVerdict, consentVerdictAll, emptyConsent, grantsFromPrompt, GRANT_TTL_MS, GRANT_USES, parseConsent,
  PENDING_TTL_MS, type ConsentState,
} from '../../../src/core/policy/consent'
import { CM_PURGE_COMMAND } from '../../../src/core/policy/sandbox'

const NOW = 1_800_000_000_000

describe('consentNeeded', () => {
  test.each([
    ['git push --force origin feature', 'force-push'],
    ['git push -f', 'force-push'],
    ['git push --force-with-lease', 'force-push'],
    ['git push origin +feature', 'force-push'],
    ['git reset --hard HEAD~2', 'history-rewrite'],
    ['git rebase -i main', 'history-rewrite'],
    ['git commit --amend --no-edit', 'history-rewrite'],
    ['git checkout -- src/a.ts', 'discard-changes'],
    ['git restore src/a.ts', 'discard-changes'],
    ['git clean -fd', 'discard-changes'],
    ['git stash drop', 'discard-changes'],
    ['git branch -D old', 'branch-delete'],
    ['git push origin --delete old', 'branch-delete'],
    ['git push origin :old', 'branch-delete'],
    ['git commit -m x --no-verify', 'skip-hooks'],
    ['git -c core.hooksPath=/dev/null commit -m x', 'skip-hooks'],
    ['git push', 'push'],
    ['git push origin feature', 'push'],
    ['npm publish', 'publish'],
    ['gh pr merge 12 --squash', 'publish'],
    ['docker push me/app:1', 'publish'],
    ['psql -c "DROP TABLE users"', 'db-destroy'],
    ['npx prisma migrate reset --force', 'db-destroy'],
    ['rails db:drop', 'db-destroy'],
    ['rm -rf src/old', 'recursive-delete'],
    ['cd x && sudo git reset --hard', 'history-rewrite'],
    ['bash -c "git push --force"', 'force-push'],
    ['git merge --abort', 'discard-changes'],
    ['git rebase --abort', 'discard-changes'],
    ['git rebase --abo', 'discard-changes'],
    ['git cherry-pick --abort', 'discard-changes'],
    ['git revert --abort', 'discard-changes'],
    ['git am --abort', 'discard-changes'],
    ['git -C repo merge --abort', 'discard-changes'],
  ])('%s needs %s', (cmd, kind) => {
    expect(consentNeeded(cmd)?.kind).toBe(kind as never)
  })

  test.each([
    'git status', 'git log --oneline', 'git commit -m "x"', 'git rebase --continue', 'git rebase --skip', 'git rebase --quit', 'git reset HEAD~1', 'git reset --soft HEAD~1',
    'git restore --staged a.ts', 'git clean -n', 'git checkout main', 'git branch -a', 'rm -rf node_modules', 'rm -rf dist build .next',
    'rm file.txt', 'npm publish --dry-run', 'ls -la', 'psql -c "select 1"', 'git stash', 'git stash pop',
    'git merge --continue', 'git merge feature', 'git cherry-pick abc1234', 'git cherry-pick --continue', 'git revert --continue', 'git am --continue', 'git am patch.mbox',
  ])('%s needs nothing', cmd => {
    expect(consentNeeded(cmd)).toBeUndefined()
  })

  test.each([
    ["git -c alias.x='reset --hard HEAD~5' x", 'history-rewrite'],
    ['s=reset; git $s --hard HEAD~5', 'history-rewrite'],
    ["git -c alias.p='push --force origin my-feature' p", 'force-push'],
    ['g=push; git $g origin my-feature', 'push'],
    ['c=publish; npm $c', 'publish'],
    ["git -c alias.d='branch -D my-feature' d", 'branch-delete'],
    ['f=--force; git push $f origin feat', 'force-push'],
    ["git -c alias.y='!git push -f origin feat' y", 'force-push'],
    ["Z='reset --hard' git --config-env=alias.z=Z z", 'history-rewrite'],
    ["GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.r GIT_CONFIG_VALUE_0='reset --hard' git r", 'history-rewrite'],
    ['export S=reset; git $S --hard', 'history-rewrite'],
    ['read s <<< reset; git $s --hard', 'history-rewrite'],
    ['x="push --force"; git $x origin feat', 'force-push'],
    ['d=-D; git branch $d old', 'branch-delete'],
    ['g=git; $g push origin feat', 'push'],
  ])('%s needs %s', (cmd, kind) => {
    expect(consentNeeded(cmd)?.kind).toBe(kind as never)
  })

  test.each([
    ['bash <<EOF\ngit push --force\nEOF', 'force-push'],
    ['echo "git reset --hard" | sh', 'history-rewrite'],
    ['printf "git push" | bash', 'push'],
    [`python3 -c "import os; os.system('git push -f origin feat')"`, 'force-push'],
    ["git config alias.undo 'reset --hard HEAD~1'", 'history-rewrite'],
    ["git config --global alias.pf 'push --force'", 'force-push'],
    ["git config alias.up '!git push'", 'push'],
    ["git config set alias.del 'branch -D'", 'branch-delete'],
    ['git config core.hooksPath /dev/null', 'skip-hooks'],
    ['git config --global core.hooksPath /tmp/none', 'skip-hooks'],
    ['git --config-env=core.hooksPath=HP commit -m x', 'skip-hooks'],
    ['git --config-env core.hooksPath=HP commit -m x', 'skip-hooks'],
  ])('%s needs %s', (cmd, kind) => {
    expect(consentNeeded(cmd)?.kind).toBe(kind as never)
  })

  test.each([
    'git config alias.st status', 'git config --global alias.co checkout', 'git config set alias.lg "log --oneline"', 'git config --get alias.undo',
    'git config --unset core.hooksPath', 'git config --list', 'echo "git push --force"', 'git commit -m "fix: avoid git push --force"',
    'git log --grep="reset --hard"', "cat <<'EOF' > notes.md\ngit push --force\nEOF", 's=status; git $s', 'git -c alias.st=status st',
    'x=build; rm -rf $x', 'DIR=dist; rm -rf "$DIR"', 'xargs rm -rf <<< "dist build"',
  ])('%s needs nothing', cmd => {
    expect(consentNeeded(cmd)).toBeUndefined()
  })

  test('the need carries the command as written', () => {
    const need = consentNeeded('s=reset; git $s --hard HEAD~5')
    expect(need).toEqual({ kind: 'history-rewrite', summary: expect.any(String), command: 's=reset; git $s --hard HEAD~5' })
  })

  test('stays bounded and never throws on hostile input', () => {
    for (const s of ['$('.repeat(5000), '"'.repeat(1000), 'x=a; '.repeat(10000) + 'git push', '{a,b}'.repeat(5000), 'bash -c '.repeat(500) + "'git push'",
      Array.from({ length: 2000 }, (_, i) => `git -c alias.a${i}='push -f origin x${i}' a${i}`).join('; '), undefined as unknown as string]) {
      const start = performance.now()
      expect(() => consentNeeded(s)).not.toThrow()
      expect(performance.now() - start).toBeLessThan(1500)
    }
  })
})

describe('grantsFromPrompt', () => {
  const kinds = (text: string, pending?: Parameters<typeof grantsFromPrompt>[1]) => grantsFromPrompt(text, pending, NOW).map(g => g.kind).sort()

  test('a request in Turkish or English grants the kind it names', () => {
    expect(kinds('push et')).toEqual(['push'])
    expect(kinds('değişiklikleri commitle ve pushla')).toEqual(['push'])
    expect(kinds('force push yapabilirsin')).toEqual(['force-push'])
    expect(consentVerdict('git push origin feat', applyPromptGrants(emptyConsent(), 'force push yapabilirsin', NOW), NOW).allow).toBe(true)
    expect(kinds('main\'e rebase et')).toEqual(['history-rewrite'])
    expect(kinds('push it to origin')).toEqual(['push'])
    expect(kinds('reset to origin/main please')).toEqual(['history-rewrite'])
    expect(kinds('eski dalı sil')).toContain('branch-delete')
  })

  test('negations and questions grant nothing', () => {
    expect(kinds('push etme')).toEqual([])
    expect(kinds("don't push yet")).toEqual([])
    expect(kinds('push edelim mi?')).toEqual([])
    expect(kinds('should we force push?')).toEqual([])
    expect(kinds('push ile ilgili bir soru: neden yavaş?')).toEqual([])
    expect(kinds('bu dosyaya bak')).toEqual([])
  })

  test('capital letters are folded without a Turkish locale (an English I stays an i)', () => {
    expect(kinds('PUBLISH IT')).toEqual(['publish'])
    expect(kinds('DISCARD THE CHANGES, PLEASE')).toEqual(['discard-changes'])
    expect(kinds('Push It')).toEqual(['push'])
    expect(kinds('DO IT', { kind: 'push', summary: 's', command: 'git push', at: NOW })).toEqual(['push'])
    expect(kinds('DALI SİL')).toContain('branch-delete')
    expect(kinds('PUSH ETME')).toEqual([])
    expect(kinds('HAYIR', { kind: 'push', summary: 's', command: 'git push', at: NOW })).toEqual([])
  })

  test('a yes answers the pending question, only while it is fresh', () => {
    const pending = { kind: 'history-rewrite' as const, summary: 's', command: 'git reset --hard', at: NOW - 60_000 }
    expect(kinds('evet', pending)).toEqual(['history-rewrite'])
    expect(kinds('tamam, devam', pending)).toEqual(['history-rewrite'])
    expect(kinds('yes go ahead', pending)).toEqual(['history-rewrite'])
    expect(kinds('hayır', pending)).toEqual([])
    expect(kinds('evet', { ...pending, at: NOW - PENDING_TTL_MS - 1 })).toEqual([])
  })
})

describe('consentVerdict', () => {
  test('denies without a grant, records the pending question and says what to ask', () => {
    const v = consentVerdict('git push --force', emptyConsent(), NOW)
    expect(v.allow).toBe(false)
    expect(v.reason).toContain('Ask the user first, in their language')
    expect(v.reason).toContain('(for example: "May I run `git push --force`? It will force push.")')
    expect(v.reason).not.toMatch(/[ğüşıöçĞÜŞİÖÇ]/)
    expect(v.next.pending?.kind).toBe('force-push')
  })

  test('the labels are English', () => {
    for (const k of CONSENT_KINDS) {
      expect(CONSENT_LABEL[k]).not.toMatch(/[ğüşıöçĞÜŞİÖÇ]/)
      expect(consentVerdict(k === 'push' ? 'git push' : 'git push --force', emptyConsent(), NOW).reason).toContain('It will ')
    }
    expect(CONSENT_LABEL['history-rewrite']).toBe('rewrite git history')
  })

  test('a grant allows a few uses for a while, then runs out', () => {
    let s = applyPromptGrants(emptyConsent(), 'push et', NOW)
    for (let i = 0; i < GRANT_USES; i++) {
      const v = consentVerdict('git push', s, NOW + 1000)
      expect(v.allow).toBe(true)
      s = v.next
    }
    expect(consentVerdict('git push', s, NOW + 1000).allow).toBe(false)
    const fresh = applyPromptGrants(emptyConsent(), 'push et', NOW)
    expect(consentVerdict('git push', fresh, NOW + GRANT_TTL_MS + 1).allow).toBe(false)
  })

  test('a plain push grant does not allow a force push; a force-push grant allows a plain push', () => {
    const push = applyPromptGrants(emptyConsent(), 'push et', NOW)
    expect(consentVerdict('git push --force', push, NOW).allow).toBe(false)
    const force = parseConsent({ v: 1, grants: [{ kind: 'force-push', until: NOW + 1000, uses: 1, source: 'ask' }] })
    expect(consentVerdict('git push', force, NOW).allow).toBe(true)
  })

  test('commands that need nothing pass and leave the state alone', () => {
    const s = emptyConsent()
    const v = consentVerdict('git status', s, NOW)
    expect(v.allow).toBe(true)
    expect(v.next).toBe(s)
  })
})

describe('consentVerdictAll: a call that runs several commands (context-mode batches)', () => {
  const grant = (kind: ConsentState['grants'][number]['kind'], uses = GRANT_USES): ConsentState['grants'][number] => ({ kind, until: NOW + GRANT_TTL_MS, uses, source: 'prompt' })

  test('every command that needs consent needs a grant of its own kind', () => {
    const cmds = ['git status', 'git push origin feat', 'git reset --hard HEAD~1']
    const pushOnly: ConsentState = { v: 1, grants: [grant('push')] }
    const v = consentVerdictAll(cmds, pushOnly, NOW)
    expect(v).toMatchObject({ allow: false, need: { kind: 'history-rewrite', command: 'git reset --hard HEAD~1' } })
    expect(v.reason).toContain('May I run `git reset --hard HEAD~1`?')
    expect(v.next).toEqual({ v: 1, grants: pushOnly.grants, pending: { kind: 'history-rewrite', summary: expect.any(String), command: 'git reset --hard HEAD~1', at: NOW, targets: [expect.any(String)] } })
    const ok = consentVerdictAll(cmds, { v: 1, grants: [grant('push'), grant('history-rewrite')] }, NOW)
    expect(ok.allow).toBe(true)
    expect(ok.next.grants.map(g => [g.kind, g.uses])).toEqual([['push', GRANT_USES - 1], ['history-rewrite', GRANT_USES - 1]])
  })

  test('two commands of one kind use two uses: a last use covers only one of them', () => {
    const v = consentVerdictAll(['git push origin a', 'git push origin b'], { v: 1, grants: [grant('push', 1)] }, NOW)
    expect(v.allow).toBe(false)
    expect(v.next.grants).toEqual([grant('push', 1)])
    expect(consentVerdictAll(['git push origin a', 'git push origin b'], { v: 1, grants: [grant('push', 2)] }, NOW).allow).toBe(true)
  })

  test('commands that need nothing pass and leave the state alone', () => {
    const s = emptyConsent()
    expect(consentVerdictAll(['ls', 'npm test', 'git log -3'], s, NOW)).toEqual({ allow: true, next: s })
    expect(consentVerdictAll([], s, NOW)).toEqual({ allow: true, next: s })
  })

  test("context-mode's ctx_purge is a database drop; only the user's yes to its question lets it run", () => {
    const purge = `${CM_PURGE_COMMAND} --scope project`
    expect(consentNeeded(purge)?.kind).toBe('db-destroy')
    expect(consentNeeded(`${CM_PURGE_COMMAND} --session abc`)?.kind).toBe('db-destroy')
    const asked = consentVerdict(purge, emptyConsent(), NOW)
    expect(asked.allow).toBe(false)
    expect(asked.reason).toContain(`May I run \`${purge}\`?`)
    const yes = applyPromptGrants(asked.next, 'yes, go ahead', NOW + 1_000)
    expect(consentVerdict(purge, yes, NOW + 2_000).allow).toBe(true)
  })

  test('the everyday word "purge" grants nothing: a cache purge never allows a database drop', () => {
    for (const p of ['purge the redis cache and rerun the tests', 'please purge the old log files', 'purge node_modules and reinstall', 'purge the CDN cache for the landing page', "purge context-mode's index, please", 'Purge the old session events']) {
      expect({ p, grants: grantsFromPrompt(p, undefined, NOW) }).toEqual({ p, grants: [] })
    }
    const s = applyPromptGrants(emptyConsent(), 'purge the redis cache and rerun the tests', NOW)
    for (const cmd of ['dropdb app', `${CM_PURGE_COMMAND} --scope project`, 'npx prisma migrate reset --force']) expect({ cmd, allow: consentVerdict(cmd, s, NOW + 1_000).allow }).toEqual({ cmd, allow: false })
    expect(grantsFromPrompt('drop the test database', undefined, NOW).map(g => g.kind)).toContain('db-destroy')
  })
})

describe('consentNeeded: git forms that discard work or force a push', () => {
  test.each([
    ['git checkout .', 'discard-changes'],
    ['git checkout -- .', 'discard-changes'],
    ['git checkout ./src', 'discard-changes'],
    ['git checkout src/a.ts', 'discard-changes'],
    ['git checkout main src/a.ts', 'discard-changes'],
    ['git checkout :/', 'discard-changes'],
    ['git checkout "*.ts"', 'discard-changes'],
    ['git switch --discard-changes main', 'discard-changes'],
    ['git switch -f main', 'discard-changes'],
    ['git switch --force main', 'discard-changes'],
    ['git restore .', 'discard-changes'],
    ['git restore --worktree src/a.ts', 'discard-changes'],
    ['git restore -SW .', 'discard-changes'],
    ['git reset --har', 'history-rewrite'],
    ['git reset --ha HEAD~1', 'history-rewrite'],
    ['git reset --kee HEAD~1', 'history-rewrite'],
    ['git commit --amen --no-edit', 'history-rewrite'],
    ['git commit -anm wip', 'skip-hooks'],
    ['git commit --no-veri -m x', 'skip-hooks'],
    ['git push -u origin feat', 'push'],
    ['git push -fu origin feat', 'force-push'],
    ['git push -uf origin feat', 'force-push'],
    ['git push origin +feat', 'force-push'],
    ['git push origin +HEAD:feat', 'force-push'],
    ['git push --force-with-lease', 'force-push'],
    ['git push --force-with-lease=feat:abc123 origin feat', 'force-push'],
    ['git push --force-if-includes origin feat', 'force-push'],
    ['git push --forc origin feat', 'force-push'],
    ['git push --delet origin old', 'branch-delete'],
    ['git push --no-verif origin feat', 'skip-hooks'],
    ['git clean --forc -d', 'discard-changes'],
    ['git branch --del old', 'branch-delete'],
  ])('%s needs %s', (cmd, kind) => {
    expect(consentNeeded(cmd)?.kind).toBe(kind as never)
  })

  test.each([
    'git checkout main', 'git checkout -b feat/x origin/main', 'git checkout feat/login', 'git checkout v1.2.3', 'git checkout release/1.2',
    'git checkout -', 'git switch main', 'git switch -c feat', 'git commit -mn', 'git commit -m "n"', 'git reset --soft HEAD~1',
    'git reset --mixed HEAD~1', 'git restore --staged .', 'git push --dry-run --force origin feat', 'git push -n origin feat', 'git rebase --cont', 'git rebase --qui',
  ])('%s needs nothing', cmd => {
    expect(consentNeeded(cmd)).toBeUndefined()
  })
})

describe('consentNeeded: recursive deletes by other routes', () => {
  test.each([
    ['rm -rf node_modules/../src', 'recursive-delete'],
    ['rm -rf ./dist/../../app', 'recursive-delete'],
    ['rm -rf node_modules/x/../../src', 'recursive-delete'],
    ['rm -rf dist/..', 'recursive-delete'],
    ['rm -rf -- node_modules/../src', 'recursive-delete'],
    [`python3 -c "import shutil; shutil.rmtree('src')"`, 'recursive-delete'],
    [`python3 -c "from shutil import rmtree; rmtree('src')"`, 'recursive-delete'],
    [`node -e "require('fs').rmSync('src', { recursive: true })"`, 'recursive-delete'],
    [`node -e "require('fs').rm('src', { recursive: true, force: true }, () => {})"`, 'recursive-delete'],
    [`bun -e "import { rmSync } from 'node:fs'; rmSync('lib', { recursive: true })"`, 'recursive-delete'],
    [`ruby -e "require 'fileutils'; FileUtils.rm_rf('src')"`, 'recursive-delete'],
    [`perl -MFile::Path=remove_tree -e "remove_tree('src')"`, 'recursive-delete'],
    [`perl -e 'use File::Path; rmtree("src")'`, 'recursive-delete'],
    ["python3 - <<'EOF'\nimport shutil\nshutil.rmtree('src')\nEOF", 'recursive-delete'],
    [`ruby <<< "require 'fileutils'; FileUtils.rm_r('lib')"`, 'recursive-delete'],
    ['find src -type f -delete', 'recursive-delete'],
    ['find . -name "*.ts" -delete', 'recursive-delete'],
    ['find . -name "*.ts" -exec rm {} +', 'recursive-delete'],
    ['find . -execdir rm -f {} \\;', 'recursive-delete'],
    [`find . -name '*.log' -exec sh -c 'rm "$1"' _ {} \\;`, 'recursive-delete'],
    ['find node_modules/../src -delete', 'recursive-delete'],
    ['find src -type f | xargs rm -f', 'recursive-delete'],
    ['find . -name "*.orig" -print0 | xargs -0 rm', 'recursive-delete'],
    ['ls | xargs rm', 'recursive-delete'],
    ['git ls-files -z | xargs -0 rm', 'recursive-delete'],
    ['cat list.txt | xargs -I{} rm -rf {}', 'recursive-delete'],
    ['xargs rm -f < files.txt', 'recursive-delete'],
    ['echo src lib | xargs rm -rf', 'recursive-delete'],
    ['bash -c "find src -name x | xargs rm"', 'recursive-delete'],
  ])('%s needs %s', (cmd, kind) => {
    expect(consentNeeded(cmd)?.kind).toBe(kind as never)
  })

  test.each([
    'rm -rf node_modules/.cache', 'rm -rf dist/', 'rm -rf ./build', 'rm -rf node_modules/../node_modules', 'rm -f src/a.ts', 'rm src/a.ts',
    `python3 -c "import shutil; shutil.rmtree('build')"`, `python3 -c "print(1)"`, `node -e "require('fs').rmSync('a.txt')"`, `node -e "require('fs').rmSync('dist', { recursive: true })"`,
    'find build -delete', 'find node_modules -name "*.map" -delete', 'find dist -name "*.map" -exec rm {} +', 'find . -name "*.ts"', 'find . -type f -exec grep -l x {} +',
    'find dist -name "*.map" | xargs rm', 'find dist -name "*.map" -print0 | xargs -0 rm -f', 'echo dist build | xargs rm -rf', 'find . -type d -empty -exec rmdir {} +',
  ])('%s needs nothing', cmd => {
    expect(consentNeeded(cmd)).toBeUndefined()
  })

  test('a find -exec of another gated command is still judged on its own', () => {
    expect(consentNeeded('find dist -name x -exec git push origin feat \\;')?.kind).toBe('push')
  })
})

describe('grantsFromPrompt: everyday coding requests grant nothing', () => {
  test.each([
    'bu fonksiyonu kaldır', 'kullanılmayan importu sil', 'test yardımcılarını temizle', 'remove the unused import please', 'merge these two functions into one',
    'reset the form state after submit', 'please remove the unused import', 'merge these two functions please',
    'push the new item onto the stack in addItem()', 'sonucu listeye push et', "OrderCreated event'ini publish et", 'clean up the test helpers', "state'i resetle",
    'drop the unused column from the type', 'publish an event when the user logs in', 'bu iki fonksiyonu merge et', 'gereksiz dosyaları temizle', 'eski kodu sil',
    'git push --force failed with an error, why', 'rebase failed with conflicts, fix them', 'delete the unused branch coverage config', 'remove the release notes section',
    'tabloyu README\'den sil', 'push notification servisini düzelt', 'hard reset butonunu ekle', 'discard edilen kayıtları logla',
    '```\ngit push --force origin main\n```\nbu çıktıyı açıkla', '> git reset --hard\nbunu neden önerdin',
    'git push yapmadan önce testleri çalıştır', 'push etmeden önce lint çalıştır', 'run the tests before git push', 'node_modules klasörünü sil', 'dist klasörünü sil',
    'delete the dist folder', 'iki listeyi merge et', 'clean up the imports', 'reset the counter when the modal closes', 'rebase the docker image on alpine',
    'abort the fetch when the component unmounts', 'merge abort handling ekle', 'abort the merge of the two config objects',
  ])('%s grants nothing', p => {
    expect({ p, grants: grantsFromPrompt(p, undefined, NOW) }).toEqual({ p, grants: [] })
  })
})

describe('grantsFromPrompt: naming the gated operation grants its kind', () => {
  test.each([
    ['force push yap', ['force-push']],
    ['git push --force', ['force-push']],
    ['push et', ['push']],
    ['npm publish', ['publish']],
    ['git clean -fd çalıştır', ['discard-changes']],
    ['git reset --hard yap', ['history-rewrite']],
    ['drop table users', ['db-destroy']],
    ['rm -rf src/legacy sil', ['recursive-delete']],
    ['run `git push --force-with-lease origin feat`', ['force-push']],
    ['commit and push', ['push']],
    ['testleri düzelt, sonra push et', ['push']],
    ["PR'ı merge et", ['publish']],
    ['merge the PR', ['publish']],
    ['src/old klasörünü sil', ['recursive-delete']],
    ['eski klasörü sil', ['recursive-delete']],
    ['git checkout . yap', ['discard-changes']],
    ['run git restore . please', ['discard-changes']],
    ['delete the old folder', ['recursive-delete']],
    ['clean up the imports and push the changes', ['push']],
    ['delete the old feature branch', ['branch-delete']],
    ['hard reset at', ['history-rewrite']],
    ['force push to the feature branch', ['force-push']],
    ['you can force push', ['force-push']],
    ['rebase onto main', ['history-rewrite']],
    ['amend the last commit', ['history-rewrite']],
    ['squash the last 3 commits', ['history-rewrite']],
    ['discard my local changes', ['discard-changes']],
    ['yerel değişiklikleri at', ['discard-changes']],
    ['--no-verify ile commit et', ['skip-hooks']],
    ['commit with --no-verify', ['skip-hooks']],
    ['paketi npm\'e yayınla', ['publish']],
    ['veritabanını sıfırla', ['db-destroy']],
    ['migrate reset çalıştır', ['db-destroy']],
    ['pushlayabilirsin', ['push']],
    ["origin'e pushla", ['push']],
    ['force push\'a izin veriyorum', ['force-push']],
    ['abort the merge', ['discard-changes']],
    ['abort the current rebase', ['discard-changes']],
    ['git merge --abort', ['discard-changes']],
    ["rebase'i abort et", ['discard-changes']],
  ])('%s grants %p', (p, want) => {
    expect(grantsFromPrompt(p, undefined, NOW).map(g => g.kind).sort()).toEqual([...want].sort() as never)
  })

  test('stays bounded and never throws on hostile prompts', () => {
    const pending = { kind: 'push' as const, summary: 's', command: 'git push', at: NOW }
    for (const p of ['force push it to x '.repeat(4000) + '!x', 'force push origin it '.repeat(4000) + 'x', 'publish the release '.repeat(4000) + 'x', 'delete the '.repeat(8000) + 'x',
      'push et '.repeat(8000), 'a '.repeat(100_000), '```\n'.repeat(5000), 'git push --force '.repeat(3000) + 'calistir', 'degisiklik '.repeat(8000) + 'at x', '--no-verify '.repeat(8000) + 'x',
      undefined as unknown as string]) {
      const start = performance.now()
      expect(() => grantsFromPrompt(p, pending, NOW)).not.toThrow()
      expect(performance.now() - start).toBeLessThan(1500)
    }
  })

  test('rm -rf of build output asks for nothing, so naming it grants nothing', () => {
    expect(grantsFromPrompt('rm -rf build/ sil', undefined, NOW)).toEqual([])
  })

  test('a grant from named words has no command targets (it covers the kind)', () => {
    expect(grantsFromPrompt('push et', undefined, NOW)).toEqual([{ kind: 'push', until: NOW + GRANT_TTL_MS, uses: GRANT_USES, source: 'prompt' }])
  })
})

describe('a yes answers the command H20 held, and only the next prompt can give it', () => {
  test('the yes covers the held command, not another command of its kind', () => {
    const held = consentVerdict('git push origin feature', emptyConsent(), NOW)
    expect(held.allow).toBe(false)
    const s = applyPromptGrants(held.next, 'evet', NOW + 1_000)
    expect(s.pending).toBeUndefined()
    expect(consentVerdict('git push origin feature', s, NOW + 2_000).allow).toBe(true)
    expect(consentVerdict('git push origin main', s, NOW + 2_000).allow).toBe(false)
    expect(consentVerdict('git  push   origin feature ', s, NOW + 2_000).allow).toBe(true)
  })

  test('a yes to a held batch covers each of its commands of that kind', () => {
    const cmds = ['git push origin a', 'git status', 'git push origin b']
    const held = consentVerdictAll(cmds, emptyConsent(), NOW)
    expect(held.allow).toBe(false)
    const s = applyPromptGrants(held.next, 'yes', NOW + 1_000)
    expect(consentVerdictAll(cmds, s, NOW + 2_000).allow).toBe(true)
    expect(consentVerdict('git push origin c', s, NOW + 2_000).allow).toBe(false)
  })

  test('a prompt that does not approve settles the question: a later yes grants nothing', () => {
    const held = consentVerdict('git reset --hard HEAD~2', emptyConsent(), NOW)
    const other = applyPromptGrants(held.next, 'önce testleri düzelt', NOW + 1_000)
    expect(other.pending).toBeUndefined()
    const yes = applyPromptGrants(other, 'tamam', NOW + 2_000)
    expect(consentVerdict('git reset --hard HEAD~2', yes, NOW + 3_000).allow).toBe(false)
  })

  test('only an explicit approval answers; a question or a negation does not', () => {
    const pending = { kind: 'push' as const, summary: 's', command: 'git push', at: NOW - 1_000 }
    for (const p of ['evet', 'Evet, devam et', 'yes', 'onayla', 'onaylıyorum', 'tamam', 'ok', 'go ahead', 'devam et', 'izin veriyorum', 'lgtm', 'olur']) {
      expect({ p, kinds: grantsFromPrompt(p, pending, NOW).map(g => g.kind) }).toEqual({ p, kinds: ['push'] })
    }
    for (const p of ['evet mi?', 'yes?', 'hayır', 'no', 'bekle', 'neden?', 'push nedir', 'testleri çalıştır']) {
      expect({ p, kinds: grantsFromPrompt(p, pending, NOW).map(g => g.kind) }).toEqual({ p, kinds: [] })
    }
  })

  test('a reply in the held operation\'s own verb confirms that operation only', () => {
    const del = { kind: 'recursive-delete' as const, summary: 's', command: 'rm -rf src/old', at: NOW - 1_000, targets: ['t1'] }
    for (const p of ['delete it', 'sil', 'Silebilirsin', 'yes, delete it']) {
      expect({ p, grants: grantsFromPrompt(p, del, NOW) }).toEqual({ p, grants: [{ kind: 'recursive-delete', until: NOW + GRANT_TTL_MS, uses: GRANT_USES, source: 'prompt', targets: ['t1'] }] })
    }
    const push = { kind: 'push' as const, summary: 's', command: 'git push', at: NOW - 1_000, targets: ['t2'] }
    expect(grantsFromPrompt('delete it', push, NOW)).toEqual([])
    expect(grantsFromPrompt('push it', del, NOW).map(g => g.kind)).toEqual(['push'])
    expect(grantsFromPrompt('push it', push, NOW)).toEqual([{ kind: 'push', until: NOW + GRANT_TTL_MS, uses: GRANT_USES, source: 'prompt', targets: ['t2'] }])
    expect(grantsFromPrompt('delete it', undefined, NOW)).toEqual([])
    expect(grantsFromPrompt('sil', undefined, NOW)).toEqual([])
  })

  test('targets survive a round trip through the stored file', () => {
    const held = consentVerdict('git push origin feature', emptyConsent(), NOW)
    const s = parseConsent(JSON.parse(JSON.stringify(applyPromptGrants(parseConsent(JSON.parse(JSON.stringify(held.next))), 'evet', NOW + 1))))
    expect(consentVerdict('git push origin feature', s, NOW + 2).allow).toBe(true)
    expect(consentVerdict('git push origin main', s, NOW + 2).allow).toBe(false)
  })
})

describe('addConsentGrants: the dialog merges its grants into what is stored now', () => {
  test('keeps other live grants and consumed uses, replaces the same kind, settles that kind\'s pending question', () => {
    const stored: ConsentState = {
      v: 1,
      grants: [{ kind: 'push', until: NOW + 60_000, uses: 1, source: 'ask' }, { kind: 'history-rewrite', until: NOW + 60_000, uses: 2, source: 'prompt' }, { kind: 'publish', until: NOW - 1, uses: 3, source: 'prompt' }],
      pending: { kind: 'push', summary: 's', command: 'git push', at: NOW },
    }
    const out = addConsentGrants(stored, [{ kind: 'push', until: NOW + 300_000, uses: 2, source: 'ask' }], NOW)
    expect(out.grants).toEqual([{ kind: 'history-rewrite', until: NOW + 60_000, uses: 2, source: 'prompt' }, { kind: 'push', until: NOW + 300_000, uses: 2, source: 'ask' }])
    expect(out.pending).toBeUndefined()
    const other = addConsentGrants(stored, [{ kind: 'publish', until: NOW + 300_000, uses: 1, source: 'ask' }], NOW)
    expect(other.pending?.kind).toBe('push')
  })
})

describe('parseConsent', () => {
  test('drops unknown kinds and malformed entries', () => {
    const s = parseConsent({ v: 1, grants: [{ kind: 'push', until: 1, uses: 1 }, { kind: 'nope', until: 1, uses: 1 }, 'x'], pending: { kind: 'push', at: 5, command: 'git push' } })
    expect(s.grants.map(g => g.kind)).toEqual(['push'])
    expect(s.pending?.kind).toBe('push')
    expect(parseConsent('garbage')).toEqual(emptyConsent())
  })
})

describe('a command that needs several kinds needs each of them', () => {
  const grant = (kind: ConsentState['grants'][number]['kind'], uses = GRANT_USES): ConsentState['grants'][number] => ({ kind, until: NOW + GRANT_TTL_MS, uses, source: 'prompt' })

  test('consentNeeds lists every kind, the first one as consentNeeded names it', () => {
    expect(consentNeeds('git push --no-verify').map(n => n.kind)).toEqual(['skip-hooks', 'push'])
    expect(consentNeeds('git push -f --no-verify').map(n => n.kind)).toEqual(['force-push', 'skip-hooks'])
    expect(consentNeeds('git commit --amend --no-verify').map(n => n.kind)).toEqual(['skip-hooks', 'history-rewrite'])
    expect(consentNeeds('git push && git reset --hard HEAD~1').map(n => n.kind)).toEqual(['push', 'history-rewrite'])
    expect(consentNeeds('git push origin a && git push origin b').map(n => n.kind)).toEqual(['push'])
    expect(consentNeeds('git -c core.hooksPath=/dev/null push').map(n => n.kind)).toEqual(['skip-hooks', 'push'])
    expect(consentNeeds('ls')).toEqual([])
    for (const c of ['git push --no-verify', 'git push && git reset --hard HEAD~1', 'git commit --amend --no-verify']) expect(consentNeeded(c)?.kind).toBe(consentNeeds(c)[0]?.kind)
  })

  test('one grant is not enough; nothing is used up unless every kind may run', () => {
    const pushOnly: ConsentState = { v: 1, grants: [grant('push')] }
    const v = consentVerdict('git push && git reset --hard HEAD~1', pushOnly, NOW)
    expect(v.allow).toBe(false)
    expect(v.need?.kind).toBe('history-rewrite')
    expect(v.next.grants).toEqual(pushOnly.grants)
    expect(v.reason).toContain('rewrites git history')
    expect(consentVerdict('git push --no-verify', pushOnly, NOW).allow).toBe(false)
    const both = consentVerdict('git push && git reset --hard HEAD~1', { v: 1, grants: [grant('push'), grant('history-rewrite')] }, NOW)
    expect(both.allow).toBe(true)
    expect(both.next.grants.map(g => [g.kind, g.uses])).toEqual([['push', GRANT_USES - 1], ['history-rewrite', GRANT_USES - 1]])
    const any = consentVerdict('git push --no-verify', { v: 1, grants: [grant('any', 1)] }, NOW)
    expect(any.allow).toBe(true)
    expect(consentVerdict('git push -f --no-verify', { v: 1, grants: [grant('force-push')] }, NOW).need?.kind).toBe('skip-hooks')
  })

  test('the question names every missing kind, and a yes grants all of them for the held command', () => {
    const held = consentVerdict('git push --no-verify', emptyConsent(), NOW)
    expect(held.allow).toBe(false)
    expect(held.reason).toContain('skips the git hooks (--no-verify) and pushes to a remote')
    expect(held.reason).toContain('It will skip the git hooks (--no-verify) and push to a remote.')
    expect(held.next.pending).toMatchObject({ kind: 'skip-hooks', kinds: ['skip-hooks', 'push'] })
    const s = parseConsent(JSON.parse(JSON.stringify(applyPromptGrants(parseConsent(JSON.parse(JSON.stringify(held.next))), 'evet', NOW + 1_000))))
    expect(s.grants.map(g => g.kind).sort()).toEqual(['push', 'skip-hooks'])
    expect(consentVerdict('git push --no-verify', s, NOW + 2_000).allow).toBe(true)
    expect(consentVerdict('git push origin main --no-verify', s, NOW + 2_000).allow).toBe(false)
    const cmds = ['git push --no-verify', 'git status']
    const batch = consentVerdictAll(cmds, emptyConsent(), NOW)
    expect(batch.next.pending?.kinds).toEqual(['skip-hooks', 'push'])
    expect(consentVerdictAll(cmds, applyPromptGrants(batch.next, 'yes', NOW + 1_000), NOW + 2_000).allow).toBe(true)
  })

  test('a single-kind question reads as before', () => {
    const v = consentVerdict('git push --force', emptyConsent(), NOW)
    expect(v.next.pending?.kinds).toBeUndefined()
    expect(v.reason).toContain('(for example: "May I run `git push --force`? It will force push.")')
  })
})

describe('consentNeeded: PowerShell and cmd.exe forms hold for the same kinds', () => {
  const ps = { shell: 'powershell' as const }
  test('a recursive Remove-Item, rd /s and del /s need consent; disposable folders and single files do not', () => {
    for (const [cmd, opts] of [['Remove-Item src -Recurse -Force', ps], ['rm -r -fo src', ps], ['rd src -Recurse', ps], ['gci src | Remove-Item -Recurse', ps],
      ['Remove-Item src -Recurse -Force', undefined], ['cmd /c "rd /s /q src"', undefined], ['rd /s /q src', { shell: 'cmd' as const }], ['del /s /q docs\\*', { shell: 'cmd' as const }]] as const) {
      expect({ cmd, kinds: consentNeeds(cmd, opts).map(n => n.kind) }).toEqual({ cmd, kinds: ['recursive-delete'] })
    }
    for (const cmd of ['Remove-Item node_modules -Recurse -Force', 'Remove-Item .\\dist -Recurse', 'Remove-Item notes.txt', 'Remove-Item src -Recurse -WhatIf', 'Get-ChildItem -Recurse']) {
      expect({ cmd, need: consentNeeded(cmd, ps) }).toEqual({ cmd, need: undefined })
    }
  })

  test('git keeps its kinds in PowerShell; the dialect reaches consentVerdict', () => {
    expect(consentNeeded('git push --force origin feat', ps)?.kind).toBe('force-push')
    expect(consentNeeded('git reset --hard; Write-Host done', ps)?.kind).toBe('history-rewrite')
    const v = consentVerdict('Remove-Item C:\\work\\src -Recurse -Force', emptyConsent(), NOW, ps)
    expect(v.allow).toBe(false)
    expect(v.reason).toContain('`Remove-Item C:\\work\\src -Recurse -Force`')
    expect(v.reason).toContain('delete a folder tree')
  })
})
