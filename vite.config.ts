import { readFileSync } from 'node:fs'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// KataGo on Browser 的 pthread 版 wasm 需要 SharedArrayBuffer，
// 因此开发与预览服务器都必须带跨源隔离响应头。
const coiHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
}

/**
 * KataGo on Browser 的引擎胶水（katago.js，第三方产物）里写死了 jsdelivr CDN
 * 的 TensorFlow.js 与 WASM 后端地址。这些地址在本机网络不可达，且绝对地址
 * 无法用服务器代理拦截，因此在服务时对这一份文件做确定性文本替换，
 * 全部改为本地已提供的副本（public/katago/ 与 public/katago/tf-wasm/）。
 */
function patchKatagoJs(source: string): string {
  return source
    .replace(
      '`//cdn.jsdelivr.net/npm/@tensorflow/tfjs@${version}/dist/tf.min.js`',
      '"/katago/tf.min.js"',
    )
    .replace(
      '`//cdn.jsdelivr.net/npm/@tensorflow/tfjs-backend-wasm@${version}/dist/tf-backend-wasm.min.js`',
      '"/katago/tf-backend-wasm.min.js"',
    )
    .replace(
      '`//cdn.jsdelivr.net/npm/@tensorflow/tfjs-backend-wasm@${version}/dist/`',
      '"/katago/tf-wasm/"',
    )
}

function kataPatchMiddleware(req: { url?: string }, res: { setHeader: (k: string, v: string) => void; end: (b: string) => void }, next: () => void): void {
  const path = (req.url ?? '').split('?')[0]
  if (path === '/katago/katago.js') {
    try {
      const src = readFileSync('public/katago/katago.js', 'utf8')
      res.setHeader('Content-Type', 'text/javascript')
      res.end(patchKatagoJs(src))
      return
    } catch {
      // 读取失败则回退到静态服务
    }
  }
  next()
}

const kataPatchPlugin = {
  name: 'kata-cdn-patch',
  configureServer(server: { middlewares: { use: (h: unknown) => void } }): void {
    server.middlewares.use(kataPatchMiddleware)
  },
  configurePreviewServer(server: { middlewares: { use: (h: unknown) => void } }): void {
    server.middlewares.use(kataPatchMiddleware)
  },
}

export default defineConfig({
  plugins: [react(), kataPatchPlugin as never],
  server: {
    headers: coiHeaders,
  },
  preview: {
    headers: coiHeaders,
  },
  test: {
    environment: 'node',
  },
})
