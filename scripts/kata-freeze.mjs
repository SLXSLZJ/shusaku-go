/**
 * 冻结诊断脚本：复现「AI 思考期主线程阻塞」，用 CDP Debugger 暂停主线程，
 * 抓取阻塞时的 JS/wasm 调用栈与 GTP 输出缓冲，定位死循环位置。
 * 用法：node scripts/kata-freeze.mjs [url]
 */
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const PORT = 9224
const URL = process.argv[2] ?? 'http://localhost:5173/'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const consoleLogs = []
const failedRequests = []
let pausedEvent = null
let pausedWaiter = null

// 内部硬超时：到时转储已收集的诊断信息并退出（避免外部强杀丢输出）
setTimeout(() => {
  console.log('=== 内部超时 200s，转储状态 ===')
  console.log('引擎事件数:', consoleLogs.length)
  for (const line of consoleLogs.slice(-30)) console.log(line)
  try {
    proc.kill()
  } catch {}
  process.exit(2)
}, 200000)

const proc = spawn(
  EDGE,
  [
    '--remote-debugging-port=' + PORT,
    '--headless=new',
    '--user-data-dir=C:/Users/NewUser/AppData/Local/Temp/edge-kata-freeze-' + Date.now(),
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

async function findTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch('http://127.0.0.1:' + PORT + '/json')
      const list = await r.json()
      const page = list.find((t) => t.type === 'page' && t.url.includes('localhost'))
      if (page) return page
    } catch {}
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
    return
  }
  if (msg.method === 'Debugger.paused') {
    pausedEvent = msg.params
    if (pausedWaiter) {
      pausedWaiter()
      pausedWaiter = null
    }
  }
}
await new Promise((r) => (ws.onopen = r))

function send(method, params = {}) {
  const id = ++seq
  ws.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve, reject) => {
    pending.set(id, (m) => (m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result)))
  })
}

async function evalJs(expr, timeoutMs = 5000) {
  const payload = send('Runtime.evaluate', { expression: expr, returnByValue: true })
  const res = await Promise.race([payload, sleep(timeoutMs).then(() => null)])
  if (res === null) return '<<主线程阻塞>>'
  if (res.exceptionDetails) return '<<页面异常>> ' + (res.exceptionDetails.exception?.description ?? '').slice(0, 200)
  return res.result?.value
}

await send('Runtime.enable')
await send('Debugger.enable', { maxScriptsCacheSize: 1e7 })
await sleep(3000)

// 等引擎就绪
let ready = false
for (let i = 0; i < 100; i++) {
  const s = await evalJs('!!window.__katagoReady')
  if (s === true) {
    ready = true
    break
  }
  if (s === '<<主线程阻塞>>') {
    console.log('引擎初始化期间主线程即已阻塞，直接抓栈')
    break
  }
  await sleep(500)
}
console.log('引擎就绪:', ready)

// 页内埋点：观测引擎 stdin 泵的行为
const instrument = await evalJs(
  `(() => {
    const inp = window.Module && Module["input"]
    if (!inp) return 'no Module.input'
    window.__dbg = { waits: 0, submits: 0, responses: 0, bufLen: -1 }
    const ow = inp.wait.bind(inp)
    inp.wait = function () { window.__dbg.waits++; return ow() }
    const form = document.getElementById('input')
    form.addEventListener('submit', () => { window.__dbg.submits++ })
    const out = document.getElementById('output')
    out.addEventListener('message', () => { window.__dbg.responses++ })
    window.__dbg.inp = inp
    return 'instrumented, bufLen=' + inp.buffer.length
  })()`,
)
console.log('埋点:', instrument)

const dims = await evalJs(
  '(() => { const c = document.querySelector(".board-canvas"); const r = c.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()',
)
console.log('点击棋盘中心:', JSON.stringify(dims))
// 点击派发也可能因主线程阻塞而无响应，加超时不阻塞诊断流程
await Promise.race([
  send('Input.dispatchMouseEvent', { type: 'mousePressed', x: dims.x, y: dims.y, button: 'left', clickCount: 1 }),
  sleep(3000),
])
await Promise.race([
  send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: dims.x, y: dims.y, button: 'left', clickCount: 1 }),
  sleep(3000),
])

// 观察落子是否生效（黑应立即 +1 手）
let moves = 0
for (let i = 0; i < 12; i++) {
  await sleep(1000)
  moves = await evalJs('document.querySelectorAll(".log li").length', 2000)
  if (moves === '<<主线程阻塞>>') break
  if (moves >= 1) {
    console.log('黑子已落（' + moves + ' 手）')
    break
  }
}
console.log('落子后手数:', moves)

// 若 20 秒内没有第 2 手（AI 未应答），暂停主线程抓栈
const t0 = Date.now()
let aiReplied = false
for (let i = 0; i < 40; i++) {
  await sleep(500)
  moves = await evalJs('document.querySelectorAll(".log li").length', 2000)
  if (moves === '<<主线程阻塞>>') break
  if (moves >= 2) {
    aiReplied = true
    break
  }
}
console.log('AI 应答:', aiReplied, '耗时(ms):', Date.now() - t0)

if (!aiReplied) {
  // 长观察：每 5 秒读一次埋点，共 3 分钟
  for (let i = 0; i < 36; i++) {
    await sleep(5000)
    const dbg = await evalJs(
      '(() => { const d = window.__dbg; if (!d) return "no dbg"; return { waits: d.waits, submits: d.submits, responses: d.responses, bufLen: d.inp.buffer.length, buf: d.inp.buffer.slice(0, 80), moves: document.querySelectorAll(".log li").length } })()',
      4000,
    )
    console.log('[t+' + Math.round((Date.now() - t0) / 1000) + 's]', JSON.stringify(dbg))
    if (typeof dbg === 'object' && dbg !== null && dbg.moves >= 2) {
      console.log('AI 已应答！')
      break
    }
  }
}

if (!aiReplied) {
  await Promise.race([send('Debugger.enable', { maxScriptsCacheSize: 1e7 }), sleep(2000)])
  await Promise.race([send('Debugger.pause'), sleep(3000)])
  const gotStack = await Promise.race([
    new Promise((r) => (pausedWaiter = r)),
    sleep(5000).then(() => null),
  ])
  if (gotStack && pausedEvent) {
    const frames = pausedEvent.callFrames.slice(0, 20)
    console.log('暂停原因:', pausedEvent.reason, '栈深:', pausedEvent.callFrames.length)
    for (const f of frames) {
      console.log(
        '  ' + (f.functionName || '(anonymous)') + ' @ ' + (f.url || f.location?.scriptId) + ':' +
          (f.location?.lineNumber ?? '?') + ':' + (f.location?.columnNumber ?? '?'),
      )
    }
    // 暂停状态下读取 GTP 输出与输入缓冲
    try {
      const out = await evalJs(
        '({ out: document.getElementById("output").value.slice(0, 500), log: document.getElementById("log").value.slice(-800) })',
        5000,
      )
      console.log('GTP 输出缓冲:', JSON.stringify(out))
    } catch (e) {
      console.log('暂停期求值失败:', String(e))
    }
    await send('Debugger.resume').catch(() => {})
  } else {
    console.log('Debugger.pause 未能在 5 秒内暂停（可能卡在 wasm/原生循环，或主线程并未忙）')
    const out = await evalJs(
      '({ moves: document.querySelectorAll(".log li").length, out: document.getElementById("output").value.slice(0, 300), turn: document.querySelector(".state-row")?.textContent })',
      5000,
    )
    console.log('恢复观察:', JSON.stringify(out))
  }
}

const foot = await evalJs('document.querySelector(".foot")?.textContent ?? ""', 3000)
console.log('页脚:', foot)
proc.kill()
process.exit(0)
