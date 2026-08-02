import { useSyncExternalStore } from 'react'

/**
 * A message the app wants to *offer* the user in the chat composer.
 *
 * The card page and the chat panel are in different columns of the layout, with
 * no component between them to pass a prop through, so this is the same
 * module-level external store the shared lists use — the smallest thing that
 * lets "Propose in chat" over on the left fill the composer on the right.
 *
 * It **never sends**. Posting on somebody's behalf, to a group channel, from a
 * button labelled "propose" would be a nasty surprise; and a suggestion is a
 * draft by definition — the point is that a human reads it, edits the wording,
 * and decides. So this fills the box and focuses it, and Send stays the user's.
 *
 * `serial` exists because the same text can be requested twice: clicking the same
 * trade again after clearing the box must re-fill it, which a bare string
 * comparison would swallow.
 */

export interface ChatDraftRequest {
  text: string
  /** Increments on every request. 0 means nothing has been offered yet. */
  serial: number
}

const EMPTY: ChatDraftRequest = { text: '', serial: 0 }

let request: ChatDraftRequest = EMPTY
const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Offers `text` to the composer. Returns the serial, for tests and callers. */
export function requestChatDraft(text: string): number {
  request = { text, serial: request.serial + 1 }
  for (const listener of listeners) listener()
  return request.serial
}

export function useChatDraft(): ChatDraftRequest {
  return useSyncExternalStore(
    subscribe,
    () => request,
    () => request,
  )
}

/** Dropped on sign-out, so nothing is offered to the next person at this machine. */
export function resetChatDraft(): void {
  request = EMPTY
  for (const listener of listeners) listener()
}
