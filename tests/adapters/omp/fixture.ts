import type { CanonicalBundle } from '../../../src/core/catalog'
import { defaultConfig } from '../../../src/core/config'

export function fixtureCanonical(): CanonicalBundle {
  return {
    root: '/fixture/canonical',
    config: defaultConfig(),
    mcp: {
      servers: {
        context7: {
          description: 'Up-to-date library docs', transport: 'stdio',
          package: { registry: 'npm', name: '@upstash/context7-mcp', version: '4.2.0' },
          command: 'npx', args: ['-y', '@upstash/context7-mcp@{version}'],
          harnesses: ['claude', 'codex', 'opencode', 'omp'], pin: 'hard', critical: true, routing: ['library-docs'],
        },
        'buracle-memory': {
          description: 'Buracle memory vault', transport: 'stdio', command: '{buracle}', args: ['mcp', 'memory'],
          harnesses: ['claude', 'codex', 'opencode', 'omp'], pin: 'hard', critical: true, routing: ['memory'],
        },
        grep: {
          description: 'GitHub code examples', transport: 'http', url: 'https://mcp.grep.app',
          harnesses: ['claude', 'codex', 'opencode', 'omp'], pin: 'monitor', critical: false, routing: ['code-examples'],
        },
        secretive: {
          description: 'Needs a token', transport: 'stdio', package: { registry: 'npm', name: 'secretive-mcp', version: '1.0.0' },
          command: 'npx', args: ['-y', 'secretive-mcp@{version}'], env: { TOKEN: '${ENV:SECRETIVE_TOKEN}', MODE: 'stdio' },
          harnesses: ['omp'], pin: 'hard', critical: false, routing: ['web-search'],
        },
        'chrome-devtools': {
          description: 'Chrome', transport: 'stdio', package: { registry: 'npm', name: 'chrome-devtools-mcp', version: '1.10.1' },
          command: 'npx', args: ['-y', 'chrome-devtools-mcp@{version}'],
          harnesses: ['claude', 'codex', 'opencode'], pin: 'hard', critical: false, routing: ['browser'],
        },
        playwright: {
          description: 'Browser', transport: 'stdio', package: { registry: 'npm', name: '@playwright/mcp', version: '1.0.0' },
          command: 'npx', args: ['-y', '@playwright/mcp@{version}'],
          harnesses: ['omp'], pin: 'hard', critical: false, routing: ['browser'],
        },
      },
    },
    plugins: { claude: { marketplaces: [], plugins: [] }, omp: { plugins: [{ id: 'omp-extra', enabled: true }, { id: 'omp-off', enabled: false }] }, opencode: { plugins: [] } },
    tools: { tools: [] },
    hooks: { hooks: [] },
    routing: { strictness: 'enforce', categories: [] },
    statusline: {},
    pricing: {},
    rules: [
      { id: 'core', scope: 'always', file: 'rules/always/core.md', frontmatter: {}, body: '# Core working rules\n\nAsk with {{ask_user}} only when blocked.\n<!-- harness:claude -->\nClaude only.\n<!-- /harness -->\n<!-- harness:omp -->\nomp only.\n<!-- /harness -->\n' },
      { id: 'python', scope: 'paths', file: 'rules/paths/python.md', frontmatter: { paths: ['**/*.py', '**/pyproject.toml'] }, body: '# Python\n\n- Use uv.\n' },
      { id: 'docker', scope: 'paths', file: 'rules/paths/docker.md', frontmatter: { paths: ['Dockerfile', '**/compose.yaml'] }, body: '# Docker\n\n- Pin images.\n' },
    ],
    skills: [
      { id: 'plan-build', dir: 'skills/plan-build', frontmatter: { name: 'plan-build', description: 'Spec workflow.', 'short-description': 'Plan, approve, implement, verify', 'argument-hint': '<task>', invocation: 'explicit' }, body: '', files: [] },
      { id: 'memory', dir: 'skills/memory', frontmatter: { name: 'memory', description: 'Memory protocol.', 'user-invocable': false }, body: '', files: [] },
      { id: 'research', dir: 'skills/research', frontmatter: { name: 'research', description: 'Research with MCP\n  tools.' }, body: '', files: [] },
    ],
    agents: [
      {
        id: 'changes-review', file: 'agents/changes-review.md',
        frontmatter: { name: 'changes-review', description: 'Read-only reviewer\nfor changes.', access: 'read-only', tools: ['read', 'search', 'bash-readonly', 'mcp:codegraph', 'edit'], model: { claude: 'sonnet', omp: 'inherit' }, output: 'json' },
        body: '\nYou review changes. Launch {{agent:plan-build-review}} with {{spawn_agent}}.\n\n```text\n{{agent:plan-build-review}}\n```\n',
      },
    ],
    missing: [],
    warnings: [],
  }
}
