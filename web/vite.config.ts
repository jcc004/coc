import { execFileSync } from 'node:child_process'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'
import { rosetteFaviconSvg } from './src/rosette.ts'

const API_PORT = process.env.PORT ?? '8787'

const FAVICON_URL = '/favicon.svg'

/**
 * Serves and emits the tab icon, generated from `src/rosette.ts` — the same path
 * data the topbar's inline mark is drawn from.
 *
 * A plugin rather than a file in `public/`, because a file would be a *second* copy
 * of a hand-drawn path: the first nudge to the topbar mark would leave the tab
 * showing the old one, and nobody looks at a favicon while editing a component.
 * Generating it means the two cannot diverge, and it keeps the icon out of the
 * repository as an asset — there is no image file, only the geometry.
 *
 * It is a real URL rather than a `data:` URI in the `<link>` for two reasons: the
 * markup stays legible, and the icon can actually be fetched and inspected — mime
 * type, bytes and all — which is how it was verified.
 */
function rosetteFavicon(): Plugin {
  const svg = rosetteFaviconSvg()

  return {
    name: 'coc:rosette-favicon',

    configureServer(server) {
      server.middlewares.use(FAVICON_URL, (_request, response) => {
        response.setHeader('Content-Type', 'image/svg+xml')
        // Dev only, and the file is generated from source: never cache it, or an
        // edit to the rosette leaves the old mark in the tab until a hard reload.
        response.setHeader('Cache-Control', 'no-store')
        response.end(svg)
      })
    },

    generateBundle() {
      // Root of `dist`, so the `/favicon.svg` in index.html resolves in the built
      // app exactly as it does in dev. Unhashed, for the same reason.
      this.emitFile({ type: 'asset', fileName: 'favicon.svg', source: svg })
    },
  }
}

/**
 * What the running app knows about its own build: which commit it came from and when
 * that commit was made.
 *
 * Read here rather than fetched from the server, because it has to describe **this
 * bundle** — the question it answers is "is the code I am looking at current", and a
 * server endpoint would answer "what is checked out on the host", which is a different
 * thing whenever a build is stale. Baked in at build time, it cannot disagree with
 * itself.
 *
 * The commit *date* rather than the build date is the headline, because that is when
 * the code last changed; rebuilding the same commit does not make the app newer. The
 * build time is captured too, and shown only to admins, since "committed three days
 * ago, built ten minutes ago" is the pair that answers "did my deploy actually run".
 *
 * Every failure here is caught. A deploy from a tarball, a shallow clone with no
 * history, git missing from the image — none of those should fail a build over a line
 * in the footer, so each falls back to a value the UI is written to handle.
 */
function gitValue(args: readonly string[]): string {
  try {
    return execFileSync('git', [...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return ''
  }
}

const BUILD_INFO = {
  /** Short hash, e.g. `de7dd8d`. Empty when git cannot tell us. */
  commit: gitValue(['rev-parse', '--short', 'HEAD']),
  /** Committer date, ISO 8601. Empty when git cannot tell us. */
  commitDate: gitValue(['show', '-s', '--format=%cI', 'HEAD']),
  /** When this bundle was produced. Always available. */
  builtAt: new Date().toISOString(),
}

export default defineConfig({
  plugins: [react(), rosetteFavicon()],
  /*
   * Serialized as JSON so the values arrive as string literals rather than as
   * identifiers Vite would try to resolve.
   */
  define: {
    __BUILD_COMMIT__: JSON.stringify(BUILD_INFO.commit),
    __BUILD_COMMIT_DATE__: JSON.stringify(BUILD_INFO.commitDate),
    __BUILD_TIME__: JSON.stringify(BUILD_INFO.builtAt),
  },
  server: {
    port: 5173,
    // Keeps the API token server-side: the browser only ever talks to /api.
    proxy: {
      '/api': {
        target: `http://localhost:${API_PORT}`,
        changeOrigin: true,
      },
    },
  },
})
