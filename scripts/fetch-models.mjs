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

async function download(url, dest) {
  const res = await fetch(url)
  if (!res.ok || !res.body) throw new Error(`${url} → HTTP ${res.status}`)
  await pipeline(res.body, createWriteStream(dest))
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true })
  let fetched = 0
  for (const m of MODELS) {
    const dest = path.join(OUT_DIR, m.file)
    if (existsSync(dest) && statSync(dest).size > 1_000_000) {
      console.log(`已存在，跳过：${m.file}`)
      continue
    }
    process.stdout.write(`下载 ${m.file} …`)
    await download(m.url, dest)
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
    await download(m.url, dest)
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
