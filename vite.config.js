import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { execFile } from 'child_process'
import { tmpdir } from 'os'
import { join } from 'path'
import { writeFile, readFile, unlink } from 'fs/promises'

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
  plugins: [react(), heicConvertPlugin()],
  optimizeDeps: {
    // These packages bundle their own WASM loaders and internal dynamic imports.
    // Vite's pre-bundler breaks those paths, so we exclude them and let them
    // load their own assets at runtime as intended.
    // @imgly/background-removal and onnxruntime-web bundle their own WASM
    // loaders and internal dynamic imports — Vite's pre-bundler breaks those
    // paths, so we exclude them and let them load their own assets at runtime.
    // heic2any is a plain UMD/CJS bundle with no dynamic internal imports, so
    // we let Vite pre-bundle it so ESM interop (.default) works correctly.
    exclude: ['@imgly/background-removal', 'onnxruntime-web'],
  },
  build: {
    // heic2any's WASM makes the bundle large; suppress the size warning.
    chunkSizeWarningLimit: 2000,
  },
})
