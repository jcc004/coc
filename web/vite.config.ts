import { execFileSync } from 'node:child_process'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'
import { GIT_LOG_ARGS, parseGitLog } from './src/changelog.ts'
import { rosetteFaviconSvg } from './src/rosette.ts'

const API_PORT = process.env.PORT ?? '5311'

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
 *
 * The buffer is raised well past `execFileSync`'s 1MB default, which is ample for a
 * hash and a date but not for the whole message history below — 179KB today and
 * growing by every commit. Overrunning it is a throw, and the `catch` here would turn
 * that into a silently empty page rather than into anything anybody would notice.
 */
const GIT_OUTPUT_LIMIT = 64 * 1024 * 1024

function gitValue(args: readonly string[]): string {
  try {
    return execFileSync('git', [...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: GIT_OUTPUT_LIMIT,
    }).trim()
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

/**
 * What the running app can say about how it got this way: the commits behind it, for
 * the `#/whats-new` page the footer's "Updated …" stamp links to.
 *
 * Baked in for the same reason `BUILD_INFO` is — the browser cannot read git, and an
 * endpoint would answer for whatever is checked out on the host rather than for this
 * bundle. It rides on the same `gitValue`, so it degrades the same way: a tarball
 * deploy or a shallow clone yields `''`, `parseGitLog` yields `[]`, and the page says
 * it has no history rather than failing the build over it.
 *
 * **The format, the filter and the ordering are all in `src/changelog.ts`**, imported
 * here rather than restated. That module is the one the browser reads the result back
 * with, and it is the one with the tests; a parser living in this file would be half a
 * format with nothing checking the halves agree.
 *
 * Parsed and filtered *here*, not in the browser, so what ships is the kept entries
 * alone — the changed-path lists the filter runs on stay on the build machine.
 *
 * The value lands in `src/changelog-data.ts`, which names the identifier and is
 * imported by nothing statically, so it becomes a chunk of its own. See the note
 * there: held in the main bundle this added 133KB to a download the droplet reissues
 * on every deploy.
 */
const BUILD_CHANGES = parseGitLog(gitValue(GIT_LOG_ARGS))

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
    /*
     * Stringified twice on purpose. The inner call is the payload; the outer one
     * makes it a *string literal* in the source, which `readChanges` then parses.
     * Substituting the array literal directly would work too, but it would put
     * eighty commit messages through the JavaScript parser on every load, and it
     * would hand a raw fragment of source to a text substitution — a string
     * literal is the shape the three defines above already take.
     */
    __BUILD_CHANGES__: JSON.stringify(JSON.stringify(BUILD_CHANGES)),
  },
  server: {
    port: 5310,
    // Keeps the API token server-side: the browser only ever talks to /api.
    proxy: {
      '/api': {
        target: `http://localhost:${API_PORT}`,
        changeOrigin: true,
      },
    },
  },
})
