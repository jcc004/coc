import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const API_PORT = process.env.PORT ?? '8787'

export default defineConfig({
  plugins: [react()],
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
