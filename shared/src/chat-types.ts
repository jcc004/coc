/**
 * The group chat. Text only, by design — there is no attachment field and the
 * server never accepts one, so nothing here can carry an image.
 */

export interface ChatMessage {
  id: number
  userId: number
  /** Author's display name, resolved server-side; the client never trusts a claim. */
  author: string
  body: string
  createdAt: string
}

export interface ChatResponse {
  messages: ChatMessage[]
}

/** Enforced by the server; exported so the composer can show the rule up front. */
export const MAX_CHAT_LENGTH = 500

/** Newest-first page size when the client asks without an `after` cursor. */
export const CHAT_PAGE_SIZE = 50
