/**
 * Cloudflare Worker：静态资产 + 模型代理。
 *
 * dist 内的静态文件由 wrangler assets 直接服务；/models/* 的大文件
 * （超出 Workers 单文件 25MiB 上限）代理自官方源并做边缘缓存。
 */

const MODEL_UPSTREAM = {
  '/models/kata1-b18c384nbt-s9996604416-d4316597426.bin.gz':
    'https://media.katagotraining.org/uploaded/networks/models/kata1/kata1-b18c384nbt-s9996604416-d4316597426.bin.gz',
  '/models/b18c384nbt-humanv0.bin.gz':
    'https://github.com/lightvector/KataGo/releases/download/v1.15.0/b18c384nbt-humanv0.bin.gz',
  '/models/g170-b6c96-s175395328-d26788732.bin.gz':
    'https://raw.githubusercontent.com/lightvector/KataGo/master/cpp/tests/models/g170-b6c96-s175395328-d26788732.bin.gz',
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)
    const upstream = MODEL_UPSTREAM[url.pathname]
    if (!upstream) return env.ASSETS.fetch(request)

    const cache = caches.default
    const cached = await cache.match(request)
    if (cached) return cached

    const upstreamRes = await fetch(upstream, { redirect: 'follow' })
    if (!upstreamRes.ok) {
      return new Response(`Model upstream error: ${upstreamRes.status}`, { status: 502 })
    }
    const res = new Response(upstreamRes.body, upstreamRes)
    res.headers.set('Cache-Control', 'public, max-age=31536000, immutable')
    res.headers.set('Access-Control-Allow-Origin', '*')
    ctx.waitUntil(cache.put(request, res.clone()))
    return res
  },
}
