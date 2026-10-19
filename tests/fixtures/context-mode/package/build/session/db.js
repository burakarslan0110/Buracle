import { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

function note(name, args) {
  const f = globalThis.__cmFixture
  if (f && Array.isArray(f.calls)) f.calls.push([name, ...args])
  if (f && f.fail === name) throw new Error(`fixture: ${name} failed`)
}

function hash(projectDir) {
  const normalized = projectDir.replace(/\\/g, '/').replace(/\/+$/, '') || '/'
  return createHash('sha256').update(normalized.toLowerCase()).digest('hex').slice(0, 16)
}

export function resolveSessionPath(opts) {
  note('resolveSessionPath', [opts])
  return join(opts.sessionsDir, `${hash(opts.projectDir)}${opts.suffix ?? ''}${opts.ext}`)
}

export function resolveSessionDbPath(opts) {
  return resolveSessionPath({ ...opts, ext: '.db' })
}

export class SessionDB {
  #raw
  // Statements handed out through db.prepare: close() finalizes them, as better-sqlite3's close does,
  // so the file is closed at once (Windows cannot remove a file a statement still holds open).
  #prepared = new Set()
  constructor(opts) {
    note('open', [opts.dbPath])
    this.#raw = new Database(opts.dbPath, { create: true })
    // The schema waits for another process's write (Windows locks the file meanwhile), and a failed open
    // closes its connection, so no handle outlives it.
    try {
      this.#raw.exec('PRAGMA busy_timeout = 5000')
      this.#raw.exec(`
      CREATE TABLE IF NOT EXISTS session_events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, type TEXT NOT NULL,
        category TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 2, data TEXT NOT NULL, source_hook TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS session_meta (session_id TEXT PRIMARY KEY, project_dir TEXT NOT NULL,
        started_at TEXT NOT NULL DEFAULT (datetime('now')), last_event_at TEXT, event_count INTEGER NOT NULL DEFAULT 0,
        compact_count INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS session_resume (session_id TEXT PRIMARY KEY, snapshot TEXT NOT NULL, event_count INTEGER NOT NULL,
        consumed INTEGER NOT NULL DEFAULT 0);
    `)
    } catch (e) {
      this.#raw.close(true)
      throw e
    }
  }

  get db() {
    const raw = this.#raw
    const prepared = this.#prepared
    return {
      pragma: sql => { note('pragma', [sql]); raw.exec(`PRAGMA ${sql}`) },
      prepare: sql => {
        note('prepare', [sql])
        const stmt = raw.prepare(sql)
        prepared.add(stmt)
        return { run: (...args) => stmt.run(...args), get: (...args) => stmt.get(...args) ?? undefined, all: (...args) => stmt.all(...args) }
      },
    }
  }

  ensureSession(sessionId, projectDir) {
    note('ensureSession', [sessionId, projectDir])
    this.#raw.query('INSERT OR IGNORE INTO session_meta (session_id, project_dir) VALUES (?, ?)').run(sessionId, projectDir)
  }

  bulkInsertEvents(sessionId, events, sourceHook = 'PostToolUse') {
    note('bulkInsertEvents', [sessionId, events.length, sourceHook])
    const insert = this.#raw.query('INSERT INTO session_events (session_id, type, category, priority, data, source_hook) VALUES (?, ?, ?, ?, ?, ?)')
    this.#raw.transaction(() => {
      for (const e of events) insert.run(sessionId, e.type, e.category, e.priority ?? 2, e.data, sourceHook)
      this.#raw.query("UPDATE session_meta SET last_event_at = datetime('now'), event_count = event_count + 1 WHERE session_id = ?").run(sessionId)
    })()
  }

  getEvents(sessionId, opts) {
    note('getEvents', [sessionId])
    return this.#raw.query('SELECT id, session_id, type, category, priority, data, source_hook, created_at FROM session_events WHERE session_id = ? ORDER BY id ASC LIMIT ?')
      .all(sessionId, opts?.limit ?? 1000)
  }

  getSessionStats(sessionId) {
    return this.#raw.query('SELECT session_id, project_dir, started_at, last_event_at, event_count, compact_count FROM session_meta WHERE session_id = ?').get(sessionId) ?? null
  }

  upsertResume(sessionId, snapshot, eventCount) {
    note('upsertResume', [sessionId, eventCount])
    this.#raw.query(`INSERT INTO session_resume (session_id, snapshot, event_count) VALUES (?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET snapshot = excluded.snapshot, event_count = excluded.event_count, consumed = 0`).run(sessionId, snapshot, eventCount ?? 0)
  }

  incrementCompactCount(sessionId) {
    note('incrementCompactCount', [sessionId])
    this.#raw.query('UPDATE session_meta SET compact_count = compact_count + 1 WHERE session_id = ?').run(sessionId)
  }

  getResume(sessionId) {
    return this.#raw.query('SELECT snapshot, event_count, consumed FROM session_resume WHERE session_id = ?').get(sessionId) ?? null
  }

  markResumeConsumed(sessionId) {
    note('markResumeConsumed', [sessionId])
    this.#raw.query('UPDATE session_resume SET consumed = 1 WHERE session_id = ?').run(sessionId)
  }

  deleteSession(sessionId) {
    note('deleteSession', [sessionId])
    this.#raw.transaction(() => {
      this.#raw.query('DELETE FROM session_events WHERE session_id = ?').run(sessionId)
      this.#raw.query('DELETE FROM session_resume WHERE session_id = ?').run(sessionId)
      this.#raw.query('DELETE FROM session_meta WHERE session_id = ?').run(sessionId)
    })()
  }

  cleanupOldSessions(maxAgeDays = 7) {
    note('cleanupOldSessions', [maxAgeDays])
    const old = this.#raw.query("SELECT session_id FROM session_meta WHERE started_at < datetime('now', ? || ' days')").all(`-${maxAgeDays}`)
    for (const { session_id } of old) this.deleteSession(session_id)
    return old.length
  }

  close() {
    note('close', [])
    for (const stmt of this.#prepared) stmt.finalize()
    this.#prepared.clear()
    this.#raw.close()
  }
}
