import { nativePath, pathRoot } from '../events'

// Windows spellings of the places the shell guard protects. Paths reach these helpers normalized
// (forward slashes, an uppercase drive root, a `\\srv\share` UNC root).

const TOP_LEVEL = new Set(['windows', 'program files', 'program files (x86)', 'programdata', 'users', 'documents and settings', 'system volume information', 'recovery', '$recycle.bin', 'boot', 'perflogs'])
const CRITICAL_SECOND_LEVEL = new Set(['windows/system32', 'windows/syswow64', 'windows/winsxs', 'users/public', 'users/default', 'programdata/microsoft'])
const HOME_FOLDERS = new Set(['applications', 'desktop', 'documents', 'downloads', 'library', 'movies', 'music', 'pictures', 'public', '.config', '.ssh', '.gnupg', '.aws',
  'appdata', 'onedrive', 'videos', 'favorites', 'contacts', 'links', 'saved games', 'searches'])
const RAW_DEVICE = /^[\\/]{2}[.?][\\/](?:physicaldrive\d|harddisk\d|cdrom\d|tape\d|[a-z]:(?:$|[\\/])|volume\{|globalroot)/i

// Git Bash spells C:\x as /c/x (Cygwin as /cygdrive/c/x); no POSIX system keeps a one-letter
// top-level folder, so reading it as a drive only adds denials there.
export function msysPath(t: string): string {
  const m = /^\/(?:cygdrive\/)?([A-Za-z])(?=\/|$)/.exec(t)
  return m ? `${(m[1] as string).toUpperCase()}:${t.slice(m[0].length) || '/'}` : t
}

export function windowsRawDevice(p: string): boolean {
  return RAW_DEVICE.test(p)
}

export function windowsTarget(p: string, glob: boolean, what: (s: string) => string): string | undefined {
  const root = pathRoot(p)
  const shown = nativePath(p)
  if (p === root) return glob ? `everything under ${shown}` : root.endsWith('/') ? `the drive root ${shown}` : `the network share ${shown}`
  const segs = p.slice(root.length).split('/').filter(x => x !== '').map(x => x.toLowerCase())
  const first = segs[0] ?? ''
  if (segs.length === 1 && TOP_LEVEL.has(first)) return what(`the system directory ${shown}`)
  if (segs.length === 2 && first === 'users') return what(`the home directory ${shown}`)
  if (segs.length === 2 && CRITICAL_SECOND_LEVEL.has(segs.join('/'))) return what(`the system directory ${shown}`)
  if (first === 'users' || first === 'documents and settings') {
    if (segs.length === 3 && HOME_FOLDERS.has(segs[2] as string)) return what(`the home folder ${shown}`)
    if (segs.length === 4 && segs[2] === 'appdata' && ['local', 'locallow', 'roaming'].includes(segs[3] as string)) return what(`the home folder ${shown}`)
    if (segs.length === 4 && segs[2] === 'documents' && segs[3] === 'buracle') return what(`the Buracle memory vault ${shown}`)
  }
  return undefined
}
