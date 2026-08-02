import { useState, type FormEvent } from 'react'
import { isValidTag, normalizeTag, usesCanonicalAlphabet } from '@coc/shared'
import { navigate, type Recent, type Route } from '../hooks.ts'

const TAG_SHAPE = 'Tags are 3–12 letters and digits, e.g. #2PP0JCCLV.'

/**
 * Advisory only — the API answers 404 for a malformed tag and an unknown one
 * alike, so it is the only authority on whether a tag exists. Warn, then go.
 */
const OFF_ALPHABET =
  'Heads up: that tag uses letters outside the usual set (0289 PYLQGRJCUV), so it may be a typo. Looking it up anyway.'

/** The minimum the server enforces on `GET /api/clans?name=…`. */
const MIN_NAME_LENGTH = 3

function Problem({ text }: { text: string }) {
  return (
    <p className="notice__hint" style={{ borderTop: 'none', paddingTop: 8 }}>
      {text}
    </p>
  )
}

function PlayerLookup() {
  const [query, setQuery] = useState('')
  const [problem, setProblem] = useState<string | null>(null)

  function submit(event: FormEvent) {
    event.preventDefault()
    const value = query.trim()
    if (!value) return

    if (!isValidTag(value)) {
      setProblem(TAG_SHAPE)
      return
    }

    setProblem(usesCanonicalAlphabet(value) ? null : OFF_ALPHABET)
    navigate({ view: 'player', tag: value })
  }

  return (
    <section className="card">
      <h2 className="section-title">Find player</h2>
      <form className="search search--stacked" onSubmit={submit}>
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Player tag, e.g. #2PP0JCCLV"
          aria-label="Player tag"
          autoComplete="off"
          spellCheck={false}
        />
        <button type="submit">Look up player</button>
      </form>
      {problem ? <Problem text={problem} /> : null}
    </section>
  )
}

function ClanLookup() {
  const [query, setQuery] = useState('')
  const [problem, setProblem] = useState<string | null>(null)

  const value = query.trim()
  /* Tag and name share one input, and the two are genuinely ambiguous — a short
     alphanumeric name like "Reddit" is a structurally valid tag — so say which
     branch will run before the user commits to it. */
  const preview = !value
    ? null
    : isValidTag(value)
      ? `Opens clan ${normalizeTag(value)}`
      : value.length < MIN_NAME_LENGTH
        ? `Name search needs at least ${MIN_NAME_LENGTH} characters`
        : `Searches clan names for “${value}”`

  function submit(event: FormEvent) {
    event.preventDefault()
    if (!value) return

    if (isValidTag(value)) {
      setProblem(usesCanonicalAlphabet(value) ? null : OFF_ALPHABET)
      navigate({ view: 'clan', tag: value })
      return
    }

    if (value.length < MIN_NAME_LENGTH) {
      setProblem(`Clan name search needs at least ${MIN_NAME_LENGTH} characters.`)
      return
    }

    setProblem(null)
    navigate({ view: 'search', name: value })
  }

  return (
    <section className="card">
      <h2 className="section-title">Find clan</h2>
      <form className="search search--stacked" onSubmit={submit}>
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Clan tag or name"
          aria-label="Clan tag or clan name"
          autoComplete="off"
          spellCheck={false}
        />
        <button type="submit">Look up clan</button>
      </form>
      {problem ? <Problem text={problem} /> : null}
      {preview ? <p className="lookup-preview">{preview}</p> : null}
    </section>
  )
}

export function SearchBar({ recents }: { recents: Recent[] }) {
  return (
    <>
      <PlayerLookup />
      <ClanLookup />

      {recents.length > 0 ? (
        <section className="card">
          <h2 className="section-title">Recent</h2>
          <div className="recents recents--stacked">
            {recents.map((recent) => (
              <button
                key={recent.tag}
                type="button"
                className="chip"
                onClick={() => navigate({ view: recent.kind, tag: recent.tag } as Route)}
              >
                {recent.name}
              </button>
            ))}
          </div>
        </section>
      ) : null}
    </>
  )
}
