/**
 * 构建期下载模型文件（git 仓库不含 ~190MB 的 .bin.gz）。
 * 已存在的文件跳过；本地开发也用同一脚本补模型。
 *
 * 用法：node scripts/fetch-models.mjs
 */
import { createWriteStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import path from 'node:path'

const OUT_DIR = path.resolve('public/models')
const TFJS_DIR = path.resolve('public/tfjs')
const TFJS_VERSION = '4.22.0'
const TFJS_PKG = `https://cdn.jsdelivr.net/npm/@tensorflow/tfjs-backend-wasm@${TFJS_VERSION}`
const MODELS = [
  {
    file: 'kata1-b18c384nbt-s9996604416-d4316597426.bin.gz',
    url: 'https://media.katagotraining.org/uploaded/networks/models/kata1/kata1-b18c384nbt-s9996604416-d4316597426.bin.gz',
  },
  {
    file: 'b18c384nbt-humanv0.bin.gz',
    url: 'https://github.com/lightvector/KataGo/releases/download/v1.15.0/b18c384nbt-humanv0.bin.gz',
  },
  {
    file: 'g170-b6c96-s175395328-d26788732.bin.gz',
    url: 'https://raw.githubusercontent.com/lightvector/KataGo/master/cpp/tests/models/g170-b6c96-s175395328-d26788732.bin.gz',
  },
]
// 线程化 WASM：缺 threaded worker.js 时跨源隔离下的多线程不可用
// （worker.js 在包的 wasm-out/ 子目录，其余在 dist/）
const TFJS_FILES = [
  { file: 'tfjs-backend-wasm.wasm', url: `${TFJS_PKG}/dist/tfjs-backend-wasm.wasm` },
  { file: 'tfjs-backend-wasm-simd.wasm', url: `${TFJS_PKG}/dist/tfjs-backend-wasm-simd.wasm` },
  { file: 'tfjs-backend-wasm-threaded-simd.wasm', url: `${TFJS_PKG}/dist/tfjs-backend-wasm-threaded-simd.wasm` },
  { file: 'tfjs-backend-wasm-threaded-simd.worker.js', url: `${TFJS_PKG}/wasm-out/tfjs-backend-wasm-threaded-simd.worker.js` },
]

async function download(url, dest, retries = 2) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url)
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
      await pipeline(res.body, createWriteStream(dest))
      return
    } catch (err) {
      if (attempt >= retries) throw new Error(`${url} → ${err.message}`)
      process.stdout.write(` 重试(${attempt + 1})…`)
      await new Promise((r) => setTimeout(r, 3000))
    }
  }
}

async function main() {
  // CI 构建（Cloudflare Workers Builds 等）跳过大模型下载：
  // 模型由 worker.js 代理官方源 + 边缘缓存提供（Workers 资产单文件上限 25MiB）
  const skipModels = process.env.CI === 'true' || process.env.CI === '1'
  mkdirSync(OUT_DIR, { recursive: true })
  let fetched = 0
  if (skipModels) {
    console.log('CI 构建：跳过大模型下载（由 Worker 代理提供）。')
  }
  for (const m of skipModels ? [] : MODELS) {
    const dest = path.join(OUT_DIR, m.file)
    if (existsSync(dest) && statSync(dest).size > 1_000_000) {
      console.log(`已存在，跳过：${m.file}`)
      continue
    }
    process.stdout.write(`下载 ${m.file} …`)
    try {
      await download(m.url, dest, 4)
    } catch (err) {
      console.log(` 失败（${err.message}）`)
      process.exit(1)
    }
    console.log(` 完成（${Math.round(statSync(dest).size / 1e6)}MB）`)
    fetched++
  }

  mkdirSync(TFJS_DIR, { recursive: true })
  for (const m of TFJS_FILES) {
    const dest = path.join(TFJS_DIR, m.file)
    if (existsSync(dest) && statSync(dest).size > 10_000) {
      console.log(`已存在，跳过：tfjs/${m.file}`)
      continue
    }
    process.stdout.write(`下载 tfjs/${m.file} …`)
    try {
      await download(m.url, dest)
    } catch (err) {
      // tfjs 运行时文件缺失只影响多线程/加速，不阻断构建
      console.log(` 失败（${err.message}）——继续`)
      continue
    }
    // npm 包里 wasm-out 的 worker 文件是 Node 包装（module.exports.wasmWorkerContents
    // = `..."`，反引号模板串），浏览器不能直接 importScripts——解出内层纯 JS 再落盘
    if (m.file.endsWith('.worker.js')) {
      const wrapped = readFileSync(dest, 'utf8')
      if (!wrapped.startsWith('module.exports.wasmWorkerContents')) {
        throw new Error(`worker 文件格式异常：${m.file}`)
      }
      const mod = { exports: {} }
      new Function('module', `${wrapped}; return module.exports.wasmWorkerContents;`)(mod)
      const raw = mod.exports.wasmWorkerContents
      if (typeof raw !== 'string' || raw.length < 1000) throw new Error(`worker 解包失败：${m.file}`)
      writeFileSync(dest, raw)
      console.log(` 完成（解包 ${Math.round(statSync(dest).size / 1e3)}KB）`)
    } else {
      console.log(` 完成（${Math.round(statSync(dest).size / 1e3)}KB）`)
    }
    fetched++
  }

  console.log(fetched === 0 ? '资产齐全，无需下载。' : `共下载 ${fetched} 个文件。`)
}

main().catch((err) => {
  console.error('模型下载失败：', err.message)
  process.exit(1)
})
