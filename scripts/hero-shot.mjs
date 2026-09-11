/** Hero 首屏截图：node scripts/hero-shot.mjs [url] */
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const URL = process.argv[2] ?? 'http://localhost:5173/'
const OUT = process.argv[3] ?? 'C:/Users/NewUser/AppData/Local/Temp/hero-shot.png'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const proc = spawn(
  EDGE,
  [
    '--remote-debugging-port=9527',
    '--headless=new',
    '--user-data-dir=C:/Users/NewUser/AppData/Local/Temp/edge-hero-shot-' + Date.now(),
    '--disable-http-cache',
    '--no-first-run',
    '--window-size=1400,900',
    URL,
  ],
  { stdio: 'ignore' },
)

let port = null
for (let i = 0; i < 30; i++) {
  try {
    await fetch('http://127.0.0.1:9527/json/version')
    port = 9527
    break
  } catch {}
  await sleep(500)
}
if (!port) throw new Error('CDP 未就绪')

let target = null
for (let i = 0; i < 20; i++) {
  const r = await fetch('http://127.0.0.1:' + port + '/json')
  const list = await r.json()
  target = list.find((t) => t.type === 'page')
  if (target) break
  await sleep(500)
}
const ws = new WebSocket(target.webSocketDebuggerUrl)
let seq = 0
const pending = new Map()
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg)
    pending.delete(msg.id)
  }
}
await new Promise((r) => (ws.onopen = r))
const send = (method, params = {}) => {
  const id = ++seq
  ws.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve) => pending.set(id, resolve))
}

await send('Page.enable')
await send('Runtime.enable')

await sleep(4000)
// Hero 首屏
const shot1 = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync(OUT, Buffer.from(shot1.result.data, 'base64'))
console.log('Hero 首屏:', OUT)

// 滚动中部（渐变过渡状态）
await send('Runtime.evaluate', { expression: 'window.scrollTo({ top: window.innerHeight * 0.5 })' })
await sleep(1200)
const shot2 = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync(OUT.replace('.png', '-mid.png'), Buffer.from(shot2.result.data, 'base64'))
console.log('滚动中段:', OUT.replace('.png', '-mid.png'))

try { proc.kill() } catch {}
process.exit(0)
