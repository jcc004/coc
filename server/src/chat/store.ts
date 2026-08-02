import type { DatabaseSync } from 'node:sqlite'
import { CHAT_PAGE_SIZE, type ChatMessage } from '@coc/shared'

/**
 * Group chat, stored in the same SQLite file as the accounts.
 *
 * The author's name is joined in on read rather than copied onto the row, so a
 * rename can never leave old messages attributed to a stale name.
 */

/** Smallest gap between two messages from one account. */
export const CHAT_COOLDOWN_MS = 1_000

interface ChatRow {
  id: number
  user_id: number
  body: string
  created_at: string
  display_name: string
}

const SELECT = `
  SELECT m.id, m.user_id, m.body, m.created_at, u.display_name
  FROM chat_messages m
  JOIN users u ON u.id = m.user_id
`

function toMessage(row: ChatRow): ChatMessage {
  return {
    id: row.id,
    userId: row.user_id,
    author: row.display_name,
    body: row.body,
    createdAt: row.created_at,
  }
}

export interface ChatStore {
  /**
   * Oldest-first. With `afterId` returns only newer messages, which is what the
   * client polls with; without it returns the most recent page.
   */
  list(afterId?: number, limit?: number): ChatMessage[]
  post(userId: number, body: string, now?: Date): ChatMessage
  /** Milliseconds since this account's last message, or `undefined` if it has none. */
  msSinceLastMessage(userId: number, now?: Date): number | undefined
}

export function createChatStore(db: DatabaseSync): ChatStore {
  const insert = db.prepare('INSERT INTO chat_messages (user_id, body, created_at) VALUES (?, ?, ?)')
  const selectOne = db.prepare(`${SELECT} WHERE m.id = ?`)
  const selectAfter = db.prepare(`${SELECT} WHERE m.id > ? ORDER BY m.id ASC LIMIT ?`)
  // Newest-first here, reversed below: the tail is the interesting end, but the
  // client wants it in reading order.
  const selectLatest = db.prepare(`${SELECT} ORDER BY m.id DESC LIMIT ?`)
  const selectLastAt = db.prepare(
    'SELECT created_at FROM chat_messages WHERE user_id = ? ORDER BY id DESC LIMIT 1',
  )

  return {
    list(afterId, limit = CHAT_PAGE_SIZE) {
      if (afterId !== undefined) {
        return (selectAfter.all(afterId, limit) as unknown as ChatRow[]).map(toMessage)
      }
      return (selectLatest.all(limit) as unknown as ChatRow[]).map(toMessage).reverse()
    },

    post(userId, body, now = new Date()) {
      const { lastInsertRowid } = insert.run(userId, body, now.toISOString())
      const row = selectOne.get(Number(lastInsertRowid)) as unknown as ChatRow
      return toMessage(row)
    },

    msSinceLastMessage(userId, now = new Date()) {
      const row = selectLastAt.get(userId) as unknown as { created_at: string } | undefined
      if (!row) return undefined
      return now.getTime() - Date.parse(row.created_at)
    },
  }
}
