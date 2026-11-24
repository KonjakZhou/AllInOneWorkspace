import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
import { randomBytes } from 'node:crypto'

const devNonce = randomBytes(16).toString('base64')

export default defineConfig(({ command }) => ({
  main: {
    build: {
      rollupOptions: { input: resolve('electron/main.ts'), output: { entryFileNames: 'index.js' } },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        input: resolve('electron/preload.ts'),
        output: { format: 'cjs', entryFileNames: 'index.cjs' },
      },
    },
  },
  renderer: {
    root: '.',
    html: command === 'serve' ? { cspNonce: devNonce } : undefined,
    plugins: [
      react(),
      {
        name: 'development-csp-nonce',
        apply: 'serve',
        transformIndexHtml: (html) =>
          html.replace("script-src 'self'", `script-src 'self' 'nonce-${devNonce}'`),
      },
    ],
    build: { minify: true, rollupOptions: { input: resolve('index.html') } },
  },
}))
