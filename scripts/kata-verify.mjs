/**
 * KataGo 浏览器引擎验证脚本（开发工具）。
 * 启动无头 Edge（跨源隔离环境）→ 等引擎初始化 → 模拟落子 → 等 AI 应答 → 截图。
 * Windows 会把部分端口列入排除段，因此依次尝试候选调试端口。
 * 用法：node scripts/kata-verify.mjs [url]
 */
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const URL = process.argv[2] ?? 'http://localhost:5173/'
const SHOT = 'C:/Users/NewUser/AppData/Local/Temp/kata-verify.png'
const DEBUG_LOG = 'C:/Users/NewUser/AppData/Local/Temp/kata-console.log'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function spawnEdgeOnPort(port) {
  const proc = spawn(
    EDGE,
    [
      '--remote-debugging-port=' + port,
      '--headless=new',
      '--user-data-dir=C:/Users/NewUser/AppData/Local/Temp/edge-kata-verify-' + Date.now() + '-' + port,
      '--disable-http-cache',
      '--disable-features=BackForwardCache',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-hang-monitor',
      '--no-first-run',
      '--window-size=1400,1000',
      URL,
    ],
    { stdio: 'ignore' },
  )
  return proc
}

async function cdpReady(port) {
  try {
    const r = await fetch('http://127.0.0.1:' + port + '/json/version')
    return r.ok
  } catch {
    return false
  }
}

// 依次尝试候选端口：启动 Edge → 等 CDP → 就绪即选定
let proc = null
let port = null
outer: for (const p of [9223, 9224, 9333, 9527, 9789]) {
  proc = spawnEdgeOnPort(p)
  for (let i = 0; i < 30; i++) {
    if (await cdpReady(p)) {
      port = p
      break outer
    }
    await sleep(500)
  }
  try {
    proc.kill()
  } catch {}
}
if (!port) throw new Error('所有候选端口的 CDP 均未就绪')

async function findTarget() {
  for (let i = 0; i < 20; i++) {
    const r = await fetch('http://127.0.0.1:' + port + '/json')
    const list = await r.json()
    const page = list.find((t) => t.type === 'page')
    if (page) return page
    await sleep(500)
  }
  throw new Error('未找到调试目标')
}

const target = await findTarget()
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

// 抓取页面异常与 console.error
ws.onmessage = wrap(ws.onmessage)
function wrap(orig) {
  return (ev) => {
    try {
      const msg = JSON.parse(ev.data)
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails
        console.log('!! 页面异常:', String(d.exception?.description ?? d.text).slice(0, 300))
      } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        console.log('!! console.error:', msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300))
      }
    } catch {}
    if (orig) orig(ev)
  }
}

await send('Runtime.enable')

function send(method, params = {}) {
  const id = ++seq
  ws.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve, reject) => {
    pending.set(id, (m) => (m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result)))
  })
}

async function evalJs(expr) {
  const r = await Promise.race([
    send('Runtime.evaluate', { expression: expr, returnByValue: true }),
    sleep(6000).then(() => null),
  ])
  if (r === null) return null
  if (r.exceptionDetails) return '<<页面异常>>'
  return r.result?.value
}

async function evalAwait(expr, timeoutMs = 8000) {
  const r = await Promise.race([
    send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }),
    sleep(timeoutMs).then(() => null),
  ])
  if (r === null) return null
  if (r.exceptionDetails) return '<<页面异常>>'
  return r.result?.value
}

await sleep(2000)

// 等引擎就绪（App 挂载后暴露 window.__shusakuEngine）
let engine = ''
for (let i = 0; i < 90; i++) {
  engine = (await evalJs('window.__shusakuEngine ?? ""')) ?? ''
  if (engine) break
  await sleep(1000)
}
console.log('引擎:', engine || '(未就绪)')

// Hero 占首屏 + 开始前隐藏棋盘：滚到对局区、点「开始新局」、展开棋谱
await evalJs('document.querySelector(".game-section")?.scrollIntoView({ behavior: "instant" })')
await sleep(600)
const clickStart = await evalJs(
  '(() => { const b = [...document.querySelectorAll(".btn")].find((x) => x.textContent === "开始新局"); if (!b) return "no-btn"; b.click(); return "clicked" })()',
)
console.log('开始新局:', clickStart)
await sleep(300)
console.log(
  '棋谱展开:',
  await evalJs(
    '(() => { const t = document.querySelector(".log-panel .panel-toggle"); if (!t) return "no-toggle"; t.click(); return "ok" })()',
  ),
)
await sleep(500)
console.log(
  '点击后:',
  await evalJs(
    'JSON.stringify({ side: !!document.querySelector(".side"), area: !!document.querySelector(".board-area"), canvas: !!document.querySelector(".board-canvas"), setupOpen: !!document.querySelector(".setup-body"), mainCount: document.querySelectorAll("main").length })',
  ),
)
await sleep(400)

// 黑方落子（棋盘中心）
const dims = await evalJs(
  '(() => { const c = document.querySelector(".board-canvas"); if (!c) return null; const r = c.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, top: r.top, h: r.height } })()',
)
console.log('棋盘位置:', JSON.stringify(dims))
if (!dims || !dims.x) throw new Error('未找到棋盘画布')
if (dims.top < 0 || dims.top > 900) {
  await evalJs('document.querySelector(".game-section")?.scrollIntoView({ block: "start" })')
  await sleep(800)
}
// AI 执黑时先等 AI 的自动首手，再在空点落白子（逐个偏移试）
let moveBefore = -1
for (const off of [0, 0.18, -0.18, 0.3]) {
  for (let i = 0; i < 30; i++) {
    const s = await evalJs('document.querySelectorAll(".log li").length')
    if (s !== null && s > moveBefore) { moveBefore = s; break }
    await sleep(1000)
  }
  const d2 = await evalJs(
    '(() => { const c = document.querySelector(".board-canvas"); const r = c.getBoundingClientRect(); const off = ' + off + ' * r.width; return { x: r.x + r.width / 2 + off, y: r.y + r.height / 2 - off * 0.6 } })()',
  )
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: d2.x, y: d2.y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: d2.x, y: d2.y, button: 'left', clickCount: 1 })
  await sleep(3000)
  const now = await evalJs('document.querySelectorAll(".log li").length')
  console.log(`落子尝试(offset=${off}): 手数 ${moveBefore} → ${now}`)
  if (now !== null && now >= moveBefore + 1) break
}
console.log('已落黑子于棋盘中心，等待 AI 应答……')

// 等 AI 应答（手数 ≥ 2），最多 4 分钟
let moves = 0
let announceText = ''
let bannerSeen = ''
const t0 = Date.now()
for (let i = 0; i < 480; i++) {
  if (i > 0 && i % 40 === 0) console.log(`  …等待中 ${Math.round((Date.now() - t0) / 1000)}s，手数 ${moves}`)
  const s = await evalJs(
    '(() => ({ moves: document.querySelectorAll(".log li").length, announce: document.querySelector(".announce")?.textContent ?? "", banner: document.querySelector(".engine-banner")?.textContent ?? "" }))()',
  )
  if (s === null) {
    await sleep(500)
    continue
  }
  moves = s.moves
  announceText = s.announce
  if (!bannerSeen && s.banner) {
    bannerSeen = s.banner
    console.log('横幅出现:', s.banner.replace(/\s+/g, ' ').trim())
  }
  if (moves >= 2) break
  await sleep(500)
}
console.log('手数:', moves, `（耗时 ${Math.round((Date.now() - t0) / 1000)}s）`)
console.log('解说:', announceText || '(无)')

const st = await evalJs(
  '(() => ({ engine: window.__shusakuEngine ?? "", thinking: !!document.querySelector(".state-row")?.textContent.includes("思考"), winrate: document.querySelector(".wr-bar") ? "有" : "无" }))()',
)
console.log('状态:', JSON.stringify(st))
if (moves >= 2) {
  // 音乐播放器探针：src 应为完整文件名（.m4a），无错误码，音量 0.8
  const audio = await evalJs(
    '(() => [...document.querySelectorAll("audio")].map(a => ({ src: (a.src || "").split("/").pop(), err: a.error ? a.error.code : 0, paused: a.paused, vol: Number(a.volume.toFixed(2)), network: a.networkState })) )()',
  )
  console.log('音频探针:', JSON.stringify(audio))
}

// 形势判断：点开开关，等评估完成后截图核验势力方块
const tb = await evalJs(
  '(() => { const b = document.querySelector(".board-toolbar .btn"); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()',
)
if (tb && tb.x) {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: tb.x, y: tb.y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: tb.x, y: tb.y, button: 'left', clickCount: 1 })
  await sleep(4000)
  const tbState = await evalJs(
    'document.querySelector(".board-toolbar .btn")?.className ?? ""',
  )
  console.log('形势判断按钮:', tbState)
}
if (moves >= 2) {
  // 实证 IndexedDB 模型缓存已写入
  const idb = await evalAwait(
    `(async () => {
      const db = await new Promise((res, rej) => {
        const r = indexedDB.open('shusaku-models', 1)
        r.onsuccess = () => res(r.result)
        r.onerror = () => rej(r.error)
      })
      const keys = await new Promise((res, rej) => {
        const tx = db.transaction('models', 'readonly')
        const rq = tx.objectStore('models').getAllKeys()
        rq.onsuccess = () => res(rq.result)
        rq.onerror = () => rej(rq.error)
      })
      db.close()
      return JSON.stringify(keys)
    })()`,
    8000,
  )
  console.log('IDB 模型缓存:', idb)
}
if (moves < 2) {
  const diag = await evalJs(
    '(() => ({ out: document.querySelector("#output")?.value?.slice(-800) ?? "", log: document.querySelector("#log")?.textContent?.slice(-800) ?? "" }))()',
  )
  console.log('诊断:', JSON.stringify(diag))
}

const shot = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync(SHOT, Buffer.from(shot.data, 'base64'))
console.log('截图:', SHOT)

proc.kill()
process.exit(0)
