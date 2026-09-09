/**
 * 生产构建预览（带跨源隔离响应头），模拟 Netlify 的下发方式。
 * 用法：node scripts/preview-coi.mjs [端口，默认 4173]
 */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'

const ROOT = join(process.cwd(), 'dist')
const PORT = parseInt(process.argv[2] ?? '4173', 10)

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm',
  '.bin.gz': 'application/octet-stream',
  '.gz': 'application/octet-stream',
}

const server = createServer(async (req, res) => {
  try {
    const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0])
    let rel = normalize(urlPath).replace(/^([/\\]|\.\.)+/, '')
    if (rel === '' || rel === '.') rel = 'index.html'
    let file = join(ROOT, rel)
    if (!file.startsWith(ROOT)) {
      res.writeHead(403).end()
      return
    }
    let body
    try {
      body = await readFile(file)
    } catch {
      body = await readFile(join(ROOT, 'index.html'))
      file = join(ROOT, 'index.html')
    }
    const ext = extname(file) === '.gz' ? '.bin.gz' : extname(file)
    res.writeHead(200, {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cache-Control':
        rel.startsWith('models/') || rel.startsWith('tfjs/')
          ? 'public, max-age=31536000, immutable'
          : 'no-cache',
    })
    res.end(body)
  } catch {
    res.writeHead(500).end()
  }
})

server.listen(PORT, () => {
  console.log(`preview(COI): http://localhost:${PORT}/  ← ${ROOT}`)
})
