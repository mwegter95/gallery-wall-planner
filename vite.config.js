import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { execFile } from 'child_process'
import { tmpdir } from 'os'
import { join } from 'path'
import { writeFile, readFile, unlink } from 'fs/promises'
import { copyFileSync, existsSync } from 'fs'

/**
 * Copies @techstark/opencv-js to public/opencv.js so it can be loaded by the
 * seam-blend worker via importScripts('/opencv.js').  We serve it as a plain
 * static file to AVOID Vite/Rollup bundling it — bundling the 10 MB Emscripten
 * module corrupts the WASM init path in production worker chunks.
 */
function opencvPublicPlugin() {
  return {
    name: 'opencv-public',
    buildStart() {
      const src = join(process.cwd(), 'node_modules/@techstark/opencv-js/dist/opencv.js')
      const dst = join(process.cwd(), 'public/opencv.js')
      if (existsSync(src) && !existsSync(dst)) {
        copyFileSync(src, dst)
        console.log('[opencv-public] Copied opencv.js → public/opencv.js')
      }
    },
  }
}

/**
 * Adds a POST /api/heic-to-jpeg endpoint to the Vite dev server.
 * Pipes the raw file bytes through macOS `sips`, which uses the native
 * HEVC/HEIC codec — the same path that works in the terminal.
 */
function heicConvertPlugin() {
  return {
    name: 'heic-convert',
    configureServer(server) {
      server.middlewares.use('/api/heic-to-jpeg', (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; res.end('Method Not Allowed'); return }
        const chunks = []
        req.on('data', c => chunks.push(c))
        req.on('end', async () => {
          const tmpIn  = join(tmpdir(), `heic-in-${Date.now()}-${Math.random().toString(36).slice(2)}.heic`)
          const tmpOut = join(tmpdir(), `heic-out-${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`)
          try {
            await writeFile(tmpIn, Buffer.concat(chunks))
            await new Promise((resolve, reject) =>
              execFile('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '93', tmpIn, '--out', tmpOut],
                (err) => err ? reject(err) : resolve())
            )
            const jpg = await readFile(tmpOut)
            res.setHeader('Content-Type', 'image/jpeg')
            res.end(jpg)
          } catch (err) {
            console.error('[heic-convert] sips failed:', err.message)
            res.statusCode = 500
            res.end(err.message)
          } finally {
            unlink(tmpIn).catch(() => {})
            unlink(tmpOut).catch(() => {})
          }
        })
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  // base stays '/' when using a custom domain (gallery.michaelwegter.com).
  // Set VITE_BASE=/gallery-wall-planner/ in GitHub Actions variables if NOT
  // using a custom domain and the repo is not username.github.io.
  base: process.env.VITE_BASE || '/',

  plugins: [react(), heicConvertPlugin(), opencvPublicPlugin()],

  server: {
    proxy: {
      // heicConvertPlugin intercepts /api/heic-to-jpeg before this proxy runs.
      // Everything else goes to mw-backend (Flask, port 5050).
      '/api':     { target: 'http://localhost:5050', changeOrigin: true },
      '/auth':    { target: 'http://localhost:5050', changeOrigin: true },
      '/uploads': { target: 'http://localhost:5050', changeOrigin: true },
    },
  },

  optimizeDeps: {
    // These packages use WASM or dynamic loading that Vite's pre-bundler breaks.
    // @techstark/opencv-js is excluded because we load it via importScripts in
    // the seam-blend worker (bypassing Vite entirely) — not via import().
    exclude: ['@imgly/background-removal', 'onnxruntime-web', '@techstark/opencv-js'],
  },

  build: {
    chunkSizeWarningLimit: 2000,
  },

  test: {
    environment: 'jsdom',
    setupFiles: './src/test/setupTests.js',
    include: ['src/**/*.test.{js,jsx}'],
  },
})
