export type PatternToken = string | readonly string[] | { readonly set: string }
export interface PrefixRule {
  pattern: readonly PatternToken[]
  decision?: 'forbidden' | 'prompt'
  justification: string
  match: readonly string[]
  notMatch: readonly string[]
}
export type RuleSets = Readonly<Record<string, readonly string[]>>

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]]
  const out: T[][] = []
  items.forEach((x, i) => {
    for (const rest of permutations([...items.slice(0, i), ...items.slice(i + 1)])) out.push([x, ...rest])
  })
  return out
}

export function recursiveForceFlags(): string[] {
  const out = new Set<string>()
  for (const r of ['r', 'R']) {
    for (const extra of [[], ['v'], ['d'], ['v', 'd']]) {
      for (const p of permutations([r, 'f', ...extra])) out.add(`-${p.join('')}`)
    }
  }
  return [...out].sort()
}

const TOP_LEVEL = ['Applications', 'Library', 'System', 'Users', 'Volumes', 'bin', 'cores', 'etc', 'home', 'opt', 'private', 'root', 'sbin', 'tmp', 'usr', 'var']
const SECOND_LEVEL = ['/opt/homebrew', '/private/etc', '/private/var', '/usr/bin', '/usr/lib', '/usr/local', '/usr/sbin']
const HOME_FOLDERS = ['.aws', '.buracle', '.claude', '.codex', '.config', '.gnupg', '.ssh', 'Applications', 'Desktop', 'Documents', 'Downloads', 'Library', 'Movies', 'Music', 'Pictures', 'Public']
const HOME_SPELLINGS = ['~', '$HOME', '${HOME}']

function dirForms(dir: string): string[] {
  return dir === '/' ? ['/', '/*', '/.'] : [dir, `${dir}/`, `${dir}/*`]
}

export function catastrophicTargets(home?: string): string[] {
  const out = new Set<string>(dirForms('/'))
  for (const d of TOP_LEVEL) for (const f of dirForms(`/${d}`)) out.add(f)
  for (const d of SECOND_LEVEL) for (const f of dirForms(d)) out.add(f)
  const homes = [...HOME_SPELLINGS]
  if (home !== undefined && /^\/[^\s"\\]+$/.test(home) && home !== '/') homes.push(home.replace(/\/+$/, ''))
  for (const h of homes) {
    for (const f of dirForms(h)) out.add(f)
    for (const sub of HOME_FOLDERS) for (const f of dirForms(`${h}/${sub}`)) out.add(f)
  }
  return [...out].sort()
}

const ref = (set: string): { set: string } => ({ set })

export function longOptionPrefixes(option: string, shortest: string): string[] {
  const out: string[] = []
  for (let n = shortest.length; n <= option.length; n++) out.push(option.slice(0, n))
  return out
}

const RM_WHY = 'Recursive force delete of the filesystem root, a system directory, the home directory or one of its key folders. Delete the specific paths you mean instead, or ask the user.'
const GIT_WHY = 'Force-pushing the default branch (or every branch) rewrites shared history. Push a branch and open a pull request, or ask the user.'

export function catastrophicPolicy(opts: { home?: string } = {}): { sets: RuleSets, rules: PrefixRule[] } {
  const home = opts.home !== undefined && catastrophicTargets(opts.home).includes(opts.home.replace(/\/+$/, '')) ? opts.home.replace(/\/+$/, '') : undefined
  const sets: RuleSets = {
    RM: ['rm', '/bin/rm'],
    SUDO: ['sudo', '/usr/bin/sudo'],
    RECURSIVE_FORCE: recursiveForceFlags(),
    RECURSIVE: ['-r', '-R', '--recursive'],
    FORCE: ['-f', '--force'],
    END_OF_OPTIONS: ['--', '--no-preserve-root'],
    TARGETS: catastrophicTargets(home),
    GIT_DIR: ['.git', '.git/', './.git', './.git/'],
    GIT_FORCE: ['--force', '-f', '-fu', '-uf', '-fq', '-qf', '-fv', '-vf', ...longOptionPrefixes('--force-with-lease', '--force-w')],
    MIRROR: longOptionPrefixes('--mirror', '--m'),
    ALL: [...longOptionPrefixes('--all', '--al'), ...longOptionPrefixes('--branches', '--b')],
    REMOTES: ['origin', 'upstream'],
    DEFAULT_BRANCH: ['main', 'master', 'HEAD:main', 'HEAD:master', 'main:main', 'master:master', 'refs/heads/main', 'refs/heads/master', 'HEAD:refs/heads/main', 'HEAD:refs/heads/master'],
    FORCED_DEFAULT_BRANCH: ['+main', '+master', '+HEAD:main', '+HEAD:master', '+refs/heads/main', '+refs/heads/master', '+HEAD:refs/heads/main', '+HEAD:refs/heads/master', '+refs/heads/*:refs/heads/*'],
    EVERY_BRANCH: [...longOptionPrefixes('--all', '--al'), ...longOptionPrefixes('--branches', '--b'), 'refs/heads/*', 'refs/heads/*:refs/heads/*'],
  }
  const homeMatch = home !== undefined ? [`rm -rf ${home}`, `rm -rf -- ${home}/Documents`] : []
  const rm = (prefix: PatternToken[], extra: { match?: string[], notMatch?: string[] } = {}): PrefixRule[] => {
    const p = (...rest: PatternToken[]): PatternToken[] => [...prefix, ref('RM'), ...rest]
    const sudo = prefix.length > 0 ? 'sudo ' : ''
    return [
      { pattern: p(ref('RECURSIVE_FORCE'), ref('TARGETS')), justification: RM_WHY, match: [`${sudo}rm -rf /`, `${sudo}rm -fr ~`, `${sudo}rm -Rf /usr`, `${sudo}/bin/rm -rfv $HOME/`, `${sudo}rm -rf ~/Documents`, ...(sudo === '' ? homeMatch.slice(0, 1) : [])], notMatch: [`${sudo}rm -rf ./dist`, `${sudo}rm -rf /tmp/build-cache`, `${sudo}rm -rf node_modules`, ...(extra.notMatch ?? [])] },
      { pattern: p(ref('RECURSIVE_FORCE'), ref('END_OF_OPTIONS'), ref('TARGETS')), justification: RM_WHY, match: [`${sudo}rm -rf -- /`, `${sudo}rm -rf --no-preserve-root /`, ...(sudo === '' ? homeMatch.slice(1) : [])], notMatch: [`${sudo}rm -rf -- dist`] },
      { pattern: p(ref('RECURSIVE_FORCE'), '--no-preserve-root', '--', ref('TARGETS')), justification: RM_WHY, match: [`${sudo}rm -rf --no-preserve-root -- /`], notMatch: [`${sudo}rm -rf --no-preserve-root -- build`] },
      { pattern: p('--no-preserve-root', ref('RECURSIVE_FORCE'), ref('TARGETS')), justification: RM_WHY, match: [`${sudo}rm --no-preserve-root -rf /`], notMatch: [`${sudo}rm --no-preserve-root -rf build`] },
      { pattern: p(ref('RECURSIVE'), ref('FORCE'), ref('TARGETS')), justification: RM_WHY, match: [`${sudo}rm -r -f /`, `${sudo}rm --recursive --force ~`], notMatch: [`${sudo}rm -r -f ./build`] },
      { pattern: p(ref('FORCE'), ref('RECURSIVE'), ref('TARGETS')), justification: RM_WHY, match: [`${sudo}rm -f -r /`, `${sudo}rm --force --recursive ~/`], notMatch: [`${sudo}rm -f -r ./build`] },
      { pattern: p(ref('RECURSIVE'), ref('FORCE'), ref('END_OF_OPTIONS'), ref('TARGETS')), justification: RM_WHY, match: [`${sudo}rm -r -f -- ~`], notMatch: [`${sudo}rm -r -f -- ./build`] },
      { pattern: p(ref('FORCE'), ref('RECURSIVE'), ref('END_OF_OPTIONS'), ref('TARGETS')), justification: RM_WHY, match: [`${sudo}rm -f -r --no-preserve-root /`], notMatch: [`${sudo}rm -f -r -- ./build`] },
      { pattern: p(ref('RECURSIVE'), ref('TARGETS')), justification: RM_WHY, match: [`${sudo}rm -r ~`, `${sudo}rm -R /usr`], notMatch: [`${sudo}rm -r ./build`] },
    ]
  }
  const rules: PrefixRule[] = [
    ...rm([]),
    ...rm([ref('SUDO')]),
    {
      pattern: [ref('RM'), [...sets['RECURSIVE_FORCE'] as string[], ...sets['RECURSIVE'] as string[]], ref('GIT_DIR')],
      justification: 'Deleting .git destroys the repository history. Use git commands (reset, restore, worktree remove) instead.',
      match: ['rm -rf .git', 'rm -r ./.git', 'rm -rf .git/'],
      notMatch: ['rm -rf .github', 'rm -rf .gitignore'],
    },
    {
      pattern: [ref('RM'), [...sets['RECURSIVE_FORCE'] as string[], ...sets['RECURSIVE'] as string[]], '--', ref('GIT_DIR')],
      justification: 'Deleting .git destroys the repository history. Use git commands (reset, restore, worktree remove) instead.',
      match: ['rm -rf -- .git'],
      notMatch: ['rm -rf -- .github'],
    },
    { pattern: ['git', 'push', ref('GIT_FORCE'), ref('REMOTES'), ref('DEFAULT_BRANCH')], justification: GIT_WHY, match: ['git push --force origin main', 'git push -f upstream master', 'git push --force-with-lease origin main', 'git push -f origin HEAD:main', 'git push --force-w origin main', 'git push -fu origin main'], notMatch: ['git push --force origin feature/x', 'git push origin main'] },
    { pattern: ['git', 'push', ref('REMOTES'), ref('GIT_FORCE'), ref('DEFAULT_BRANCH')], justification: GIT_WHY, match: ['git push origin -f main', 'git push origin --force-with-lease HEAD:master'], notMatch: ['git push origin -f feature/x'] },
    { pattern: ['git', 'push', ref('REMOTES'), ref('DEFAULT_BRANCH'), ref('GIT_FORCE')], justification: GIT_WHY, match: ['git push origin main --force', 'git push upstream master -f', 'git push origin main:main --force-with-lease'], notMatch: ['git push origin main --tags'] },
    { pattern: ['git', 'push', ref('REMOTES'), ref('FORCED_DEFAULT_BRANCH')], justification: 'A "+" refspec force-pushes the default branch and rewrites shared history. Push a branch instead.', match: ['git push origin +main', 'git push origin +HEAD:master', 'git push origin +refs/heads/*:refs/heads/*'], notMatch: ['git push origin +feature'] },
    { pattern: ['git', 'push', ref('GIT_FORCE'), ref('REMOTES'), ref('EVERY_BRANCH')], justification: GIT_WHY, match: ['git push --force origin refs/heads/*', 'git push -f origin --all'], notMatch: ['git push --force origin refs/heads/feature'] },
    { pattern: ['git', 'push', ref('GIT_FORCE'), ref('ALL')], justification: GIT_WHY, match: ['git push --force --all origin', 'git push -f --branches origin'], notMatch: ['git push --force --tags origin'] },
    { pattern: ['git', 'push', ref('ALL'), ref('GIT_FORCE')], justification: GIT_WHY, match: ['git push --all --force origin', 'git push --al -f origin'], notMatch: ['git push --all origin'] },
    { pattern: ['git', 'push', ref('MIRROR')], justification: 'A mirror push force-updates and deletes every ref on the remote. Push the branch you mean instead, or ask the user.', match: ['git push --mirror origin', 'git push --mirr origin'], notMatch: ['git push origin main'] },
    { pattern: ['git', 'push', ref('REMOTES'), ref('MIRROR')], justification: 'A mirror push force-updates and deletes every ref on the remote. Push the branch you mean instead, or ask the user.', match: ['git push origin --mirror', 'git push origin --mi'], notMatch: ['git push origin --tags'] },
    {
      pattern: [['diskutil', '/usr/sbin/diskutil'], ['eraseDisk', 'eraseVolume', 'partitionDisk', 'secureErase', 'zeroDisk', 'randomDisk', 'reformat']],
      justification: 'Erasing or repartitioning a disk destroys data. Never run this from an agent.',
      match: ['diskutil eraseDisk APFS Untitled disk2', 'diskutil zeroDisk disk3'],
      notMatch: ['diskutil list', 'diskutil info disk0'],
    },
    {
      pattern: [ref('SUDO'), ['diskutil', '/usr/sbin/diskutil'], ['eraseDisk', 'eraseVolume', 'partitionDisk', 'secureErase', 'zeroDisk', 'randomDisk', 'reformat']],
      justification: 'Erasing or repartitioning a disk destroys data. Never run this from an agent.',
      match: ['sudo diskutil eraseDisk APFS x disk2'],
      notMatch: ['sudo diskutil list'],
    },
    {
      pattern: [['mkfs', 'mkfs.ext4', 'mkfs.ext3', 'mkfs.xfs', 'mkfs.btrfs', 'mkfs.vfat', 'mkfs.fat', 'mkfs.exfat', 'newfs_apfs', 'newfs_hfs', 'newfs_msdos']],
      justification: 'Creating a filesystem erases the target device. Never run this from an agent.',
      match: ['mkfs.ext4 /dev/sdb1', 'newfs_apfs /dev/disk4'],
      notMatch: ['mkdir build'],
    },
    {
      pattern: [ref('SUDO'), ['mkfs', 'mkfs.ext4', 'mkfs.ext3', 'mkfs.xfs', 'mkfs.btrfs', 'mkfs.vfat', 'mkfs.fat', 'mkfs.exfat', 'newfs_apfs', 'newfs_hfs', 'newfs_msdos']],
      justification: 'Creating a filesystem erases the target device. Never run this from an agent.',
      match: ['sudo mkfs.ext4 /dev/sdb1'],
      notMatch: ['sudo mkdir build'],
    },
    {
      pattern: [['chmod', '/bin/chmod'], '-R', ['777', '0777', '000', '0000', 'a+rwx', 'a-rwx', 'ugo+rwx'], ref('TARGETS')],
      justification: 'Recursively changing permissions of the root or home directory breaks the system and leaks secrets. Change the specific paths you mean instead.',
      match: ['chmod -R 777 /', 'chmod -R 000 ~'],
      notMatch: ['chmod -R 755 ./scripts'],
    },
    {
      pattern: [ref('SUDO'), ['chmod', '/bin/chmod'], '-R', ['777', '0777', '000', '0000', 'a+rwx', 'a-rwx', 'ugo+rwx'], ref('TARGETS')],
      justification: 'Recursively changing permissions of the root or home directory breaks the system and leaks secrets. Change the specific paths you mean instead.',
      match: ['sudo chmod -R 777 /'],
      notMatch: ['sudo chmod -R 755 ./scripts'],
    },
  ]
  return { sets, rules }
}

export const CATASTROPHIC_RULES: readonly PrefixRule[] = catastrophicPolicy().rules
export const CATASTROPHIC_SETS: RuleSets = catastrophicPolicy().sets

function starlarkString(s: string): string {
  return JSON.stringify(s)
}

function starlarkToken(t: PatternToken): string {
  if (typeof t === 'string') return starlarkString(t)
  if ('set' in t) return (t as { set: string }).set
  return `[${(t as readonly string[]).map(starlarkString).join(', ')}]`
}

function starlarkList(items: readonly string[]): string {
  const lines: string[] = []
  let line = ''
  for (const s of items.map(starlarkString)) {
    if (line !== '' && line.length + s.length + 2 > 100) { lines.push(`${line},`); line = '' }
    line = line === '' ? s : `${line}, ${s}`
  }
  if (line !== '') lines.push(`${line},`)
  return `[\n${lines.map(l => `    ${l}`).join('\n')}\n]`
}

export const CONSENT_RUN: readonly string[] = ['consent', 'run']

const LITERAL_PROGRAM = /^\/[A-Za-z0-9._+@%:,/-]+$/

export function literalProgram(path: string | undefined): path is string {
  return typeof path === 'string' && LITERAL_PROGRAM.test(path) && !path.split('/').includes('..')
}

export const CONSENT_RULE_WHY = 'Buracle H20: the command quoted after "consent run" is hard to undo or reaches outside this machine, and the user has not allowed it in this session. Approve to run it once; decline to refuse it.'

export function consentPromptRule(shim: string | undefined): PrefixRule | undefined {
  if (!literalProgram(shim)) return undefined
  return {
    pattern: [shim, ...CONSENT_RUN], decision: 'prompt', justification: CONSENT_RULE_WHY,
    match: [`${shim} consent run 0123456789ab 'git push origin main'`], notMatch: ['buracle consent run 0123456789ab git'],
  }
}

export function renderRulesFile(opts: { home?: string, shim?: string } = {}): string {
  const { sets, rules } = catastrophicPolicy(opts)
  const consent = consentPromptRule(opts.shim)
  const out = [
    ...(consent !== undefined
      ? ['# Buracle: catastrophic shell commands Codex must never run (execpolicy, decision "forbidden"),', '# and the H20 consent prompt (decision "prompt") for the commands Buracle holds for the user\'s say-so.']
      : ['# Buracle: catastrophic shell commands Codex must never run (execpolicy, decision "forbidden").']),
    '# Generated by Buracle from src/adapters/codex/execpolicy.ts; edits here are overwritten by `buracle install`.',
    '# Best effort: prefix rules see plain commands only, so the Buracle PreToolUse guard (H01) stays the broader net.',
    '# Check a command with: codex execpolicy check --rules ~/.codex/rules/buracle.rules -- <command…>',
    '',
  ]
  for (const name of Object.keys(sets)) out.push(`${name} = ${starlarkList(sets[name] as readonly string[])}`, '')
  for (const r of consent !== undefined ? [...rules, consent] : rules) {
    out.push(
      'prefix_rule(',
      `    pattern = [${r.pattern.map(starlarkToken).join(', ')}],`,
      `    decision = ${starlarkString(r.decision ?? 'forbidden')},`,
      `    justification = ${starlarkString(r.justification)},`,
      `    match = [${r.match.map(starlarkString).join(', ')}],`,
      `    not_match = [${r.notMatch.map(starlarkString).join(', ')}],`,
      ')',
      '',
    )
  }
  return out.join('\n')
}

export function matchesPrefixRule(tokens: readonly string[], rule: PrefixRule, sets: RuleSets = CATASTROPHIC_SETS): boolean {
  if (tokens.length < rule.pattern.length) return false
  return rule.pattern.every((p, i) => {
    const t = tokens[i] as string
    if (typeof p === 'string') return t === p
    if ('set' in p) return (sets[(p as { set: string }).set] ?? []).includes(t)
    return (p as readonly string[]).includes(t)
  })
}
