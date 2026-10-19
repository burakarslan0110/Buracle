export type PrefixToken = string | readonly string[]

export interface CatastrophicRule {
  id: string
  pattern: readonly PrefixToken[]
  justification: string
  match: readonly string[]
  notMatch: readonly string[]
}

const RF = ['-rf', '-fr', '-Rf', '-fR', '-rF', '-Fr', '-RF', '-FR', '-rfv', '-rvf', '-vrf', '-frv', '-fvr', '-vfr']
const R = ['-r', '-R', '--recursive']
const F = ['-f', '--force']
const SYSTEM = ['/', '/*', '//', '/.', '/Users', '/System', '/Library', '/Applications', '/usr', '/usr/local', '/usr/bin', '/etc', '/var', '/bin', '/sbin',
  '/opt', '/opt/homebrew', '/private', '/tmp', '/home', '/Volumes']
const HOME_FORMS = ['~', '~/', '~/*', '$HOME', '$HOME/', '$HOME/*', '${HOME}', '${HOME}/', '${HOME}/*']
const HOME_FOLDERS = ['Documents', 'Desktop', 'Downloads', 'Library', 'Pictures', 'Movies', 'Music', 'Applications', 'Public', '.ssh', '.aws', '.gnupg', '.config', 'Documents/Buracle']

const REMOTES = ['origin', 'upstream']
const MAIN_NAMES = ['main', 'master', 'refs/heads/main', 'refs/heads/master']
const MAIN_REFSPECS = [...MAIN_NAMES, 'HEAD:main', 'HEAD:master', 'HEAD:refs/heads/main', 'HEAD:refs/heads/master', '@:main', '@:master', 'main:main', 'master:master']
function prefixes(option: string, from: string): string[] {
  const out: string[] = []
  for (let n = from.length; n <= option.length; n++) out.push(option.slice(0, n))
  return out
}
const FORCE = ['--force', '-f', '-fu', '-uf', '-fq', '-qf', '-fv', '-vf', ...prefixes('--force-with-lease', '--force-w')]
const FORCE_SHORT = ['--force', '-f', '--force-with-lease']
const MIRROR = prefixes('--mirror', '--m')
const DELETE = ['-d', ...prefixes('--delete', '--de')]
const ALL = [...prefixes('--all', '--al'), ...prefixes('--branches', '--b')]

function targetsFor(home: string | undefined): string[] {
  const out = [...SYSTEM, ...HOME_FORMS]
  for (const f of HOME_FOLDERS) out.push(`~/${f}`, `$HOME/${f}`)
  const h = typeof home === 'string' ? home.replace(/\/+$/, '') : ''
  if (/^\/(?:Users|home)\/[^/\s]+$/.test(h)) {
    out.push(h, `${h}/`, `${h}/*`)
    for (const f of HOME_FOLDERS) out.push(`${h}/${f}`)
  }
  return [...new Set(out)]
}

const DELETE_WHY = 'Recursive force delete of the filesystem root, a system directory, the home directory or a home folder. Delete the specific paths you mean instead.'
const PUSH_WHY = 'Force-pushing the default branch rewrites shared history. Push a feature branch and open a pull request, or ask the user.'

export function catastrophicCommandRules(opts?: { home?: string }): CatastrophicRule[] {
  const T = targetsFor(opts?.home)
  const homeExample = T.find(t => /^\/(?:Users|home)\/[^/]+$/.test(t))
  const rules: CatastrophicRule[] = [
    {
      id: 'rm-recursive-force',
      pattern: ['rm', RF, T],
      justification: DELETE_WHY,
      match: ['rm -rf /', 'rm -fr ~', 'rm -Rf /usr', 'rm -rf ~/Documents', ...(homeExample !== undefined ? [`rm -rf ${homeExample}`] : [])],
      notMatch: ['rm -rf ./dist', 'rm -rf /tmp/build-cache', 'rm -rf node_modules'],
    },
    {
      id: 'rm-recursive-force-end-of-options',
      pattern: ['rm', RF, '--', T],
      justification: DELETE_WHY,
      match: ['rm -rf -- /', 'rm -fr -- ~'],
      notMatch: ['rm -rf -- ./build'],
    },
    {
      id: 'rm-recursive-force-no-preserve-root',
      pattern: ['rm', RF, '--no-preserve-root', T],
      justification: DELETE_WHY,
      match: ['rm -rf --no-preserve-root /'],
      notMatch: ['rm -rf --no-preserve-root ./build'],
    },
    {
      id: 'rm-no-preserve-root-recursive-force',
      pattern: ['rm', '--no-preserve-root', RF, T],
      justification: DELETE_WHY,
      match: ['rm --no-preserve-root -rf /'],
      notMatch: ['rm --no-preserve-root -rf ./build'],
    },
    {
      id: 'rm-recursive-then-force',
      pattern: ['rm', R, F, T],
      justification: DELETE_WHY,
      match: ['rm -r -f /', 'rm --recursive --force ~'],
      notMatch: ['rm -r -f ./build'],
    },
    {
      id: 'rm-force-then-recursive',
      pattern: ['rm', F, R, T],
      justification: DELETE_WHY,
      match: ['rm -f -r /', 'rm --force --recursive ~/'],
      notMatch: ['rm -f -r ./build'],
    },
    {
      id: 'sudo-rm-recursive',
      pattern: ['sudo', 'rm', [...RF, ...R], T],
      justification: 'Privileged recursive delete of the filesystem root, a system directory or the home directory. Never run this.',
      match: ['sudo rm -rf /', 'sudo rm -r ~'],
      notMatch: ['sudo rm -rf /tmp/x'],
    },
    {
      id: 'sudo-rm-recursive-end-of-options',
      pattern: ['sudo', 'rm', RF, ['--', '--no-preserve-root'], T],
      justification: 'Privileged recursive delete of the filesystem root, a system directory or the home directory. Never run this.',
      match: ['sudo rm -rf -- /', 'sudo rm -rf --no-preserve-root /'],
      notMatch: ['sudo rm -rf -- /tmp/x'],
    },
    {
      id: 'rm-git-directory',
      pattern: ['rm', [...RF, ...R], ['.git', './.git', '.git/']],
      justification: 'Deleting .git destroys the repository history. Use git commands (reset, restore, worktree remove) instead.',
      match: ['rm -rf .git', 'rm -r ./.git'],
      notMatch: ['rm -rf .github', 'rm -rf .gitignore'],
    },
    {
      id: 'git-push-force-main',
      pattern: ['git', 'push', FORCE, REMOTES, MAIN_REFSPECS],
      justification: PUSH_WHY,
      match: ['git push --force origin main', 'git push -f upstream master', 'git push --force-with-lease origin main', 'git push -f origin HEAD:main', 'git push --force-w origin main'],
      notMatch: ['git push --force origin feature/x', 'git push origin main'],
    },
    {
      id: 'git-push-main-force',
      pattern: ['git', 'push', REMOTES, MAIN_REFSPECS, FORCE],
      justification: PUSH_WHY,
      match: ['git push origin main --force', 'git push upstream master -f', 'git push origin HEAD:main --force-with-lease'],
      notMatch: ['git push origin main --tags'],
    },
    {
      id: 'git-push-remote-force-main',
      pattern: ['git', 'push', REMOTES, FORCE, MAIN_REFSPECS],
      justification: PUSH_WHY,
      match: ['git push origin --force main', 'git push origin -f HEAD:master'],
      notMatch: ['git push origin --force feature/x'],
    },
    {
      id: 'git-push-plus-main',
      pattern: ['git', 'push', REMOTES, MAIN_REFSPECS.map(m => `+${m}`)],
      justification: 'A "+" refspec force-pushes the default branch and rewrites shared history. Push a feature branch instead.',
      match: ['git push origin +main', 'git push origin +HEAD:master', 'git push origin +refs/heads/main'],
      notMatch: ['git push origin +feature'],
    },
    {
      id: 'git-push-mirror',
      pattern: ['git', 'push', MIRROR],
      justification: '`git push --mirror` overwrites and deletes every branch on the remote, main included. Push the specific branch instead.',
      match: ['git push --mirror', 'git push --mirr origin'],
      notMatch: ['git push --tags'],
    },
    {
      id: 'git-push-remote-mirror',
      pattern: ['git', 'push', REMOTES, MIRROR],
      justification: '`git push --mirror` overwrites and deletes every branch on the remote, main included. Push the specific branch instead.',
      match: ['git push origin --mirror'],
      notMatch: ['git push origin --tags'],
    },
    {
      id: 'git-push-delete-main',
      pattern: ['git', 'push', REMOTES, DELETE, MAIN_NAMES],
      justification: 'Deleting the remote default branch cannot be undone from here. Ask the user to do it.',
      match: ['git push origin --delete main', 'git push origin -d master', 'git push origin --delet main'],
      notMatch: ['git push origin --delete feature/old'],
    },
    {
      id: 'git-push-delete-flag-main',
      pattern: ['git', 'push', DELETE, REMOTES, MAIN_NAMES],
      justification: 'Deleting the remote default branch cannot be undone from here. Ask the user to do it.',
      match: ['git push --delete origin main', 'git push -d origin master'],
      notMatch: ['git push --delete origin feature/old'],
    },
    {
      id: 'git-push-empty-source-main',
      pattern: ['git', 'push', REMOTES, MAIN_NAMES.map(m => `:${m}`)],
      justification: 'Pushing an empty source deletes the remote default branch. Ask the user to do it.',
      match: ['git push origin :main', 'git push origin :refs/heads/master'],
      notMatch: ['git push origin :feature/old'],
    },
    {
      id: 'git-push-force-all',
      pattern: ['git', 'push', ALL, FORCE_SHORT],
      justification: 'Force-pushing every branch rewrites the remote default branch too. Force-push only your feature branch.',
      match: ['git push --all --force', 'git push --branches -f'],
      notMatch: ['git push --all'],
    },
    {
      id: 'git-push-force-then-all',
      pattern: ['git', 'push', FORCE_SHORT, ALL],
      justification: 'Force-pushing every branch rewrites the remote default branch too. Force-push only your feature branch.',
      match: ['git push --force --all', 'git push -f --branches'],
      notMatch: ['git push --force origin feature/x'],
    },
    {
      id: 'git-push-force-wildcard',
      pattern: ['git', 'push', FORCE_SHORT, REMOTES, ['refs/heads/*', 'refs/heads/*:refs/heads/*', ':', '*', '*:*']],
      justification: 'A wildcard or matching refspec force-pushes every branch, main included. Push the specific feature branch instead.',
      match: ['git push --force origin refs/heads/*', 'git push -f origin :'],
      notMatch: ['git push --force origin refs/heads/feature/x'],
    },
    {
      id: 'git-push-plus-wildcard',
      pattern: ['git', 'push', REMOTES, ['+refs/heads/*:refs/heads/*', '+refs/heads/*', '+:', '+*', '+*:*']],
      justification: 'A "+" wildcard or matching refspec force-pushes every branch, main included. Push the specific feature branch instead.',
      match: ['git push origin +refs/heads/*:refs/heads/*', 'git push origin +:'],
      notMatch: ['git push origin +feature'],
    },
    {
      id: 'diskutil-erase',
      pattern: ['diskutil', ['eraseDisk', 'eraseVolume', 'partitionDisk', 'secureErase', 'zeroDisk', 'randomDisk', 'reformat']],
      justification: 'Erasing or repartitioning a disk destroys data. Never run this from an agent.',
      match: ['diskutil eraseDisk APFS Untitled disk2', 'diskutil zeroDisk disk3'],
      notMatch: ['diskutil list', 'diskutil info disk0'],
    },
    {
      id: 'diskutil-apfs-delete',
      pattern: ['diskutil', 'apfs', ['deleteContainer', 'deleteVolume', 'eraseVolume']],
      justification: 'Deleting an APFS container or volume destroys its data. Never run this from an agent.',
      match: ['diskutil apfs deleteContainer disk3'],
      notMatch: ['diskutil apfs list'],
    },
    {
      id: 'make-filesystem',
      pattern: [['mkfs', 'mkfs.ext4', 'mkfs.ext3', 'mkfs.xfs', 'mkfs.btrfs', 'mkfs.vfat', 'mkfs.fat', 'mkfs.exfat', 'newfs_apfs', 'newfs_hfs', 'newfs_msdos', 'newfs_exfat']],
      justification: 'Creating a filesystem erases the target device. Never run this from an agent.',
      match: ['mkfs.ext4 /dev/sdb1', 'newfs_apfs /dev/disk4'],
      notMatch: ['mkdir build'],
    },
    {
      id: 'chmod-recursive-root-home',
      pattern: ['chmod', ['-R', '--recursive'], ['777', '0777', '000', '0000', 'a+rwx', 'a-rwx', 'ugo+rwx', 'ugo-rwx', '666', '0666'], T],
      justification: 'Recursively changing permissions of the root or home directory breaks the system and leaks secrets. Change the specific paths you mean instead.',
      match: ['chmod -R 777 /', 'chmod -R 000 ~'],
      notMatch: ['chmod -R 755 ./scripts'],
    },
    {
      id: 'power-off',
      pattern: [['shutdown', 'reboot', 'halt', 'poweroff']],
      justification: 'Turning off or restarting the machine ends the user\'s session. Ask the user to do it.',
      match: ['shutdown -h now', 'reboot'],
      notMatch: ['uptime'],
    },
    {
      id: 'sudo-power-off',
      pattern: ['sudo', ['shutdown', 'reboot', 'halt', 'poweroff']],
      justification: 'Turning off or restarting the machine ends the user\'s session. Ask the user to do it.',
      match: ['sudo shutdown -r now', 'sudo reboot'],
      notMatch: ['sudo ls'],
    },
    {
      id: 'kill-every-process',
      pattern: ['kill', ['-9', '-KILL', '-SIGKILL', '-15', '-TERM', '-SIGTERM', '--'], '-1'],
      justification: 'Signalling pid -1 kills every process the user owns, the agent included. Kill specific process ids instead.',
      match: ['kill -9 -1', 'kill -- -1'],
      notMatch: ['kill -9 1234'],
    },
    {
      id: 'kill-every-process-named-signal',
      pattern: ['kill', '-s', ['KILL', 'TERM', '9', '15'], '-1'],
      justification: 'Signalling pid -1 kills every process the user owns, the agent included. Kill specific process ids instead.',
      match: ['kill -s KILL -1'],
      notMatch: ['kill -s KILL 1234'],
    },
    {
      id: 'killall5',
      pattern: ['killall5'],
      justification: 'killall5 signals every process on the machine. Kill specific process ids instead.',
      match: ['killall5 -9'],
      notMatch: ['killall node'],
    },
    {
      id: 'crontab-remove',
      pattern: ['crontab', ['-r', '-ri', '-ir']],
      justification: '`crontab -r` deletes all of the user\'s cron jobs. Edit the specific entry with `crontab -e` instead.',
      match: ['crontab -r'],
      notMatch: ['crontab -l'],
    },
    {
      id: 'gh-repo-delete',
      pattern: ['gh', 'repo', 'delete'],
      justification: 'Deleting a GitHub repository cannot be undone. Ask the user to do it.',
      match: ['gh repo delete me/project --yes'],
      notMatch: ['gh repo view'],
    },
    {
      id: 'keychain-delete',
      pattern: ['security', ['delete-keychain', 'delete-generic-password', 'delete-internet-password', 'delete-certificate', 'delete-identity']],
      justification: 'Deleting keychain items removes the user\'s credentials. Ask the user to do it.',
      match: ['security delete-generic-password -s foo'],
      notMatch: ['security find-generic-password -s foo'],
    },
  ]
  return rules
}

export const CATASTROPHIC_COMMAND_RULES: readonly CatastrophicRule[] = catastrophicCommandRules()

export function matchesCatastrophicRule(tokens: readonly string[], rule: CatastrophicRule): boolean {
  if (!Array.isArray(tokens) || tokens.length < rule.pattern.length) return false
  return rule.pattern.every((p, i) => (typeof p === 'string' ? tokens[i] === p : p.includes(tokens[i] as string)))
}
