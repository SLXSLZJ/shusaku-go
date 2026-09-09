/**
 * 构建期下载模型文件（git 仓库不含 ~190MB 的 .bin.gz）。
 * 已存在的文件跳过；本地开发也用同一脚本补模型。
 *
 * 用法：node scripts/fetch-models.mjs
 */
import { createWriteStream, existsSync, mkdirSync, statSync } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import path from 'node:path'

const OUT_DIR = path.resolve('public/models')
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
  console.log(fetched === 0 ? '模型齐全，无需下载。' : `共下载 ${fetched} 个模型。`)
}

main().catch((err) => {
  console.error('模型下载失败：', err.message)
  process.exit(1)
})
