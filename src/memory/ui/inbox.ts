import { tilde } from '../../engine/update/output'
import { NOTIFICATIONS_KEEP } from '../../workflow/notify'
import { markNotificationsRead, readNotifications, type NotificationEntry } from '../../workflow/notify-inbox'
import { docId } from '../../workflow/review-notes'
import { UiApiError } from './api'

export const INBOX_MAX = NOTIFICATIONS_KEEP
const ID_RE = /^[a-z0-9-]{4,40}$/

function listed(): NotificationEntry[] {
  return readNotifications().slice(0, INBOX_MAX)
}

export function notificationsPayload(): Record<string, unknown> {
  const shown = listed()
  return {
    unread: shown.filter(e => !e.read).length,
    total: shown.length,
    items: shown.map(e => ({
      id: e.id, ts: e.ts, type: e.type, title: e.title, message: e.message, read: e.read,
      ...(e.plan !== undefined ? { plan: tilde(e.plan), planPath: e.plan, reviewDoc: docId(e.plan) } : {}),
      ...(e.cwd !== undefined ? { folder: tilde(e.cwd) } : {}),
      ...(e.harness !== undefined ? { harness: e.harness } : {}),
    })),
  }
}

export function markRead(body: Record<string, unknown>): Record<string, unknown> {
  const all = body['all'] === true
  const ids = body['ids']
  if (all && ids !== undefined) throw new UiApiError(400, 'bad_ids', 'send ids or all, not both')
  if (!all && (!Array.isArray(ids) || ids.length === 0 || ids.length > INBOX_MAX || !ids.every(id => typeof id === 'string' && ID_RE.test(id)))) {
    throw new UiApiError(400, 'bad_ids', `ids must be a list of 1 to ${INBOX_MAX} notification ids, or all: true`)
  }
  const r = markNotificationsRead(all ? 'all' : ids as string[])
  return { ok: true, marked: r.marked, unread: listed().filter(e => !e.read).length }
}
