import { useState } from 'react'

/** Shows a tag and copies it on click — tags are the app's primary key and are
 *  tedious to retype. */
export function TagButton({ tag }: { tag: string }) {
  const [copied, setCopied] = useState(false)

  return (
    <button
      type="button"
      className="profile__tag"
      title="Copy tag"
      onClick={() => {
        void navigator.clipboard.writeText(tag).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1200)
        })
      }}
    >
      {tag} {copied ? '· copied' : '· copy'}
    </button>
  )
}
