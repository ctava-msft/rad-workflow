import { defineConfig } from 'vite'

// https://vitejs.dev/config/
export default defineConfig({
  server: {
    port: 5174,
    strictPort: true,
    proxy: {
      '/api': 'http://localhost:8000',
    },
  },
  preview: { port: 5174, strictPort: true },
})
