import { TESTED_WITH as HARNESS_VERSIONS } from '../../engine/update/tested-with'

export const TESTED_WITH = HARNESS_VERSIONS.opencode.tested
export const MIN_VERSION = HARNESS_VERSIONS.opencode.min

export const PLUGIN_ID = 'buracle'
export const PLUGIN_DIR = `plugins/${PLUGIN_ID}`

export const CONFIG_SCHEMA_URL = 'https://opencode.ai/config.json'
export const CLI_SCHEMA_URL = 'https://opencode.ai/v2/cli.json'

export const AGENTS_BLOCK_ID = 'rules'

export const OWNER = 'opencode'

export const UTILITY_COMMANDS = ['remember', 'brain', 'aside', 'buracle-status', 'buracle', 'buracle-ping'] as const

export const PORTABLE_SHIM = '{env:HOME}/.buracle/bin/buracle'

export const MCP_STARTUP_TIMEOUT_MS = 60_000

export const GLOBAL_PERMISSIONS: ReadonlyArray<{ action: string, resource: string, effect: 'allow' | 'deny' | 'ask' }> = [
  { action: 'edit', resource: '*.env', effect: 'deny' },
  { action: 'edit', resource: '*.env.*', effect: 'deny' },
  { action: 'edit', resource: '*.env.example', effect: 'allow' },
  { action: 'shell', resource: 'rm -rf /', effect: 'deny' },
  { action: 'shell', resource: 'rm -rf /*', effect: 'deny' },
  { action: 'shell', resource: 'rm -rf ~', effect: 'deny' },
  { action: 'shell', resource: 'rm -rf ~/*', effect: 'deny' },
  { action: 'shell', resource: 'rm -rf $HOME', effect: 'deny' },
  { action: 'shell', resource: 'rm -rf $HOME/*', effect: 'deny' },
]

export const READONLY_SHELL_ALLOW: readonly string[] = [
  'git status *', 'git diff *', 'git log *', 'git show *', 'git ls-files *', 'git blame *',
  'git merge-base *', 'git rev-parse *', 'git branch --show-current *',
  'git -C * status *', 'git -C * diff *', 'git -C * log *', 'git -C * show *', 'git -C * ls-files *',
  'git -C * blame *', 'git -C * merge-base *', 'git -C * rev-parse *',
  'rg *', 'ast-grep *', 'sg *',
  'buracle review-scope *', 'buracle plan validate *', 'buracle plan status *',
  'buracle worktree detect *', 'buracle worktree status *', 'buracle worktree diff *',
  'buracle mem search *', 'buracle mem get *', 'buracle mem status *',
]

export const READONLY_SHELL_DENY: readonly string[] = [
  'ast-grep *--update-all*', 'ast-grep * -U*', 'ast-grep *--interactive*', 'ast-grep * -i*',
  'sg *--update-all*', 'sg * -U*', 'sg *--interactive*', 'sg * -i*',
  'rg *--pre*', 'rg *--hostname-bin*', 'git *--output*',
]
