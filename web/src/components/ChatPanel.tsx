import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { MAX_CHAT_LENGTH, type ChatMessage } from '@coc/shared'
import { ApiError, api } from '../api.ts'
import { useChatDraft } from '../chat-draft.ts'
import { formatRelative } from '../format.ts'

/**
 * Group chat for the sidebar. Text only — there is no file input and the server
 * has no field to put one in.
 *
 * Polling rather than a socket: at ten users the traffic is trivial, and it
 * survives the reverse proxy and process restarts a deployment will involve
 * without any reconnect logic. Requests are incremental (`after` the newest id
 * we hold), so a poll that finds nothing new transfers almost nothing.
 */

const POLL_MS = 5_000

function Message({ message, mine }: { message: ChatMessage; mine: boolean }) {
  const sentAt = new Date(message.createdAt)

  return (
    <li className={mine ? 'chat__msg chat__msg--mine' : 'chat__msg'}>
      <div className="chat__meta">
        <span className="chat__author">{mine ? 'You' : message.author}</span>
        <time dateTime={message.createdAt} title={sentAt.toLocaleString()}>
          {formatRelative(sentAt)}
        </time>
      </div>
      {/* Interpolated as text, never as markup — React escapes it, which is what
          keeps a pasted <script> or an <img> tag inert. */}
      <p className="chat__body">{message.body}</p>
    </li>
  )
}

export function ChatPanel({ currentUserId }: { currentUserId: number }) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  const logRef = useRef<HTMLOListElement>(null)
  const draftRef = useRef<HTMLTextAreaElement>(null)
  // Read inside the poll without making it a dependency, which would tear down
  // and rebuild the interval on every new message.
  const newestId = useRef(0)

  /*
   * A message offered by another part of the app — today, "Propose in chat" on a
   * trade suggestion. It fills the box and focuses it; it never sends, so the
   * wording is the user's to edit and Send is theirs to press.
   *
   * Keyed on the serial rather than the text so re-proposing the same trade
   * re-fills a box the user has since cleared. It deliberately replaces whatever
   * is in the box: clicking Propose is an explicit request for this text.
   */
  const offered = useChatDraft()
  const appliedSerial = useRef(0)

  useEffect(() => {
    if (offered.serial === 0 || offered.serial === appliedSerial.current) return
    appliedSerial.current = offered.serial
    setDraft(offered.text)
    const box = draftRef.current
    box?.focus()
    // The panel is in the other column and may be off-screen on a narrow window.
    box?.scrollIntoView({ block: 'nearest' })
  }, [offered])

  const absorb = useCallback((incoming: ChatMessage[]) => {
    if (incoming.length === 0) return
    setMessages((current) => {
      const seen = new Set(current.map((message) => message.id))
      const fresh = incoming.filter((message) => !seen.has(message.id))
      if (fresh.length === 0) return current
      return [...current, ...fresh]
    })
    const highest = incoming.reduce((max, message) => Math.max(max, message.id), newestId.current)
    newestId.current = highest
  }, [])

  useEffect(() => {
    let cancelled = false
    const controller = new AbortController()

    const poll = async () => {
      // A backgrounded tab does not need to keep asking.
      if (document.visibilityState === 'hidden') return
      try {
        const { messages: incoming } = await api.chat(
          newestId.current === 0 ? undefined : newestId.current,
          controller.signal,
        )
        if (!cancelled) absorb(incoming)
      } catch (cause) {
        // A 401 is already handled globally; anything else here is transient and
        // the next tick will retry, so it stays out of the user's way.
        if (cause instanceof ApiError && cause.status === 401) return
      }
    }

    void poll()
    const timer = setInterval(() => void poll(), POLL_MS)
    const onVisible = () => void poll()
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      cancelled = true
      controller.abort()
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [absorb])

  // Pin to the newest message. The log is short and the panel narrow, so there
  // is no value in preserving a scroll position further up.
  useEffect(() => {
    const log = logRef.current
    if (log) log.scrollTop = log.scrollHeight
  }, [messages])

  async function submit(event: FormEvent) {
    event.preventDefault()
    const body = draft.trim()
    if (!body || sending) return

    setSending(true)
    setProblem(null)
    try {
      const { message } = await api.sendChat(body)
      // Shown immediately rather than waiting for the next poll.
      absorb([message])
      setDraft('')
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : 'Could not send that message.')
    } finally {
      setSending(false)
    }
  }

  const remaining = MAX_CHAT_LENGTH - draft.trim().length

  return (
    <section className="card chat">
      <h2 className="section-title">Chat</h2>

      {messages.length === 0 ? (
        <p className="empty-hint">No messages yet. Say something.</p>
      ) : (
        <ol className="chat__log" ref={logRef}>
          {messages.map((message) => (
            <Message
              key={message.id}
              message={message}
              mine={message.userId === currentUserId}
            />
          ))}
        </ol>
      )}

      <form className="chat__form" onSubmit={submit}>
        <label className="visually-hidden" htmlFor="chat-draft">
          Message
        </label>
        <textarea
          id="chat-draft"
          ref={draftRef}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            // Enter sends, Shift+Enter makes a new line — the convention every
            // other chat box uses.
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              void submit(event)
            }
          }}
          placeholder="Message the group…"
          rows={2}
          maxLength={MAX_CHAT_LENGTH}
          spellCheck
        />
        <div className="chat__actions">
          <span className="chat__count">{remaining}</span>
          <button type="submit" disabled={sending || draft.trim().length === 0}>
            {sending ? 'Sending…' : 'Send'}
          </button>
        </div>
      </form>

      {problem ? (
        <p className="notice__hint" style={{ borderTop: 'none', paddingTop: 8 }}>
          {problem}
        </p>
      ) : null}
    </section>
  )
}
