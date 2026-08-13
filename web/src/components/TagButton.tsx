import { useEffect, useRef, useState } from 'react'

/** Shows a tag and copies it on click — tags are the app's primary key and are
 *  tedious to retype. */
export function TagButton({ tag }: { tag: string }) {
  const [copied, setCopied] = useState(false)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  // Cleared on unmount as well as before every new copy, so navigating away
  // within the 1200ms window cannot fire `setCopied` on an unmounted button.
  useEffect(() => () => clearTimeout(timeoutRef.current), [])

  return (
    <button
      type="button"
      className="profile__tag"
      title="Copy tag"
      onClick={() => {
        void navigator.clipboard.writeText(tag).then(() => {
          setCopied(true)
          clearTimeout(timeoutRef.current)
          timeoutRef.current = setTimeout(() => setCopied(false), 1200)
        })
      }}
    >
      {tag}{' '}
      {/* `aria-live="polite"` is `BaseCardEditor.tsx`'s own "Saving…" indicator's
          treatment (~line 691) — the only other transient-status text in the app —
          so a screen reader announces the copy confirmation instead of the button's
          label silently changing underneath it. */}
      <span aria-live="polite">{copied ? '· copied' : '· copy'}</span>
    </button>
  )
}
