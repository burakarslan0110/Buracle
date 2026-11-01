import { basename, dirname } from 'node:path'
import { comparablePath, sha256 } from './fsx'
import { run } from './proc'

const GIT_TIMEOUT_MS = 5000

async function git(cwd: string, args: string[]): Promise<string | undefined> {
  const r = await run(['git', ...args], { cwd, timeoutMs: GIT_TIMEOUT_MS, env: { GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' } })
  return r.code === 0 ? r.stdout : undefined
}

export async function gitStatusPorcelainV2(cwd: string): Promise<string | undefined> {
  return git(cwd, ['status', '--porcelain=v2', '--branch', '--show-stash'])
}

export async function gitDiffShortstat(cwd: string): Promise<string | undefined> {
  return git(cwd, ['diff', 'HEAD', '--shortstat', '--no-color', '--no-ext-diff'])
}

export async function revParse(cwd: string, ...args: string[]): Promise<string | undefined> {
  const out = await git(cwd, ['rev-parse', ...args])
  return out === undefined ? undefined : out.trim()
}

export async function currentBranch(cwd: string): Promise<string | undefined> {
  const out = await git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
  const b = out?.trim()
  return b ? b : undefined
}

export async function isRepo(cwd: string): Promise<boolean> {
  return (await revParse(cwd, '--is-inside-work-tree')) === 'true'
}

export async function remoteUrl(cwd: string, name = 'origin'): Promise<string | undefined> {
  const out = await git(cwd, ['remote', 'get-url', name])
  const u = out?.trim()
  return u ? u : undefined
}

export async function commonDir(cwd: string): Promise<string | undefined> {
  const out = await revParse(cwd, '--git-common-dir')
  return out ? comparablePath(out, cwd) : undefined
}

export async function toplevel(cwd: string): Promise<string | undefined> {
  const out = await revParse(cwd, '--show-toplevel')
  return out ? comparablePath(out, cwd) : undefined
}

export function ownerRepoFromUrl(url: string): { owner?: string, repo: string } | undefined {
  let s = url.trim()
  if (s === '') return undefined
  s = s.replace(/[?#].*$/, '').replace(/\/+$/, '').replace(/\.git$/, '')
  let pathPart: string
  const scp = /^[^/@:]+@[^/:]+:(.+)$/.exec(s)
  if (scp && scp[1] !== undefined && !/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) pathPart = scp[1]
  else {
    const m = /^[a-z][a-z0-9+.-]*:\/\/[^/]*(\/.*)?$/i.exec(s)
    pathPart = m ? (m[1] ?? '') : s
  }
  const segs = pathPart.split('/').filter(x => x !== '' && x !== '.')
  const repo = segs[segs.length - 1]
  if (repo === undefined) return undefined
  const owner = segs.length >= 2 ? segs[segs.length - 2] : undefined
  return owner !== undefined ? { owner, repo } : { repo }
}

export function slugPart(s: string): string {
  const folded = s
    .replace(/İ/g, 'i').replace(/I/g, 'i').replace(/ı/g, 'i')
    .toLowerCase()
    .replace(/ğ/g, 'g').replace(/ü/g, 'u').replace(/ş/g, 's').replace(/ö/g, 'o').replace(/ç/g, 'c')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
  const slug = folded.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/g, '')
  return slug === '' ? 'project' : slug
}

export interface ProjectIdentity {
  slug: string
  ownerRepo?: string
  root: string
  commonDir?: string
  remote?: string
}

export async function projectIdentity(cwd: string): Promise<ProjectIdentity> {
  const abs = comparablePath(cwd)
  const common = await commonDir(abs)
  if (common === undefined) {
    return { slug: `${slugPart(basename(abs))}-${sha256(abs).slice(0, 6)}`, root: abs }
  }
  const root = basename(common) === '.git' ? dirname(common) : (await toplevel(abs)) ?? abs
  const remote = await remoteUrl(abs)
  const parsed = remote !== undefined ? ownerRepoFromUrl(remote) : undefined
  const name = parsed?.repo ?? basename(root).replace(/\.git$/, '')
  const id: ProjectIdentity = { slug: slugPart(name), root, commonDir: common }
  if (remote !== undefined) id.remote = remote
  if (parsed?.owner !== undefined) id.ownerRepo = `${parsed.owner}/${parsed.repo}`
  return id
}

export async function projectSlug(cwd: string): Promise<string> {
  return (await projectIdentity(cwd)).slug
}
