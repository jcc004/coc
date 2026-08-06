import { Component, type ErrorInfo, type ReactNode } from 'react'

type Props = {
  children: ReactNode
  /** Overridable so a test can assert on it without fighting jsdom's read-only `location`. */
  onReload?: () => void
}
type State = { error: Error | null }

/**
 * The backstop for any throw not caught closer to its source. Without this, React
 * unmounts the whole tree on an unhandled error and the page goes blank — how both
 * `hooks.ts` incidents in `CLAUDE.md` presented before their specific causes were
 * found and patched (a truncated `decodeURIComponent` escape, a loader throwing
 * before returning a promise). Fixing a throw at its source is still the real fix;
 * this exists for the next one nobody has found yet.
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null }

  static getDerivedStateFromError(error: unknown): State {
    return { error: error instanceof Error ? error : new Error(String(error)) }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Unhandled error in the app tree', error, info.componentStack)
  }

  override render(): ReactNode {
    const { error } = this.state
    if (error === null) return this.props.children

    return (
      <div className="auth-screen">
        <div className="notice notice--error">
          <p className="notice__title">Something went wrong</p>
          <p className="notice__body">
            {error.message || 'The page hit an error it could not recover from.'}
          </p>
          <p className="notice__hint">
            Reloading usually fixes it. If it keeps happening, the site has a bug — try again
            later.
          </p>
        </div>
        <button
          type="button"
          className="icon-button"
          style={{ marginTop: 16 }}
          onClick={this.props.onReload ?? (() => location.reload())}
        >
          Reload
        </button>
      </div>
    )
  }
}
