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

export default defineConfig({
  plugins: [react(), rosetteFavicon()],
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
