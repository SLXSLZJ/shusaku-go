/**
 * KataGo Worker 启动诊断：抓取页面 + Worker 会话的控制台输出与异常。
 * 用法：node scripts/kata-diag.mjs [等待秒数，默认 90]
 */
import { writeFileSync } from 'node:fs'

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const WAIT_S = parseInt(process.argv[2] ?? '90', 10)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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

function spawnEdgeOnPort(p) {
  return spawn(
    EDGE,
    [
      '--remote-debugging-port=' + p,
      '--headless=new',
      '--user-data-dir=C:/Users/NewUser/AppData/Local/Temp/edge-kata-diag-' + Date.now() + '-' + p,
      '--disable-http-cache',
      '--disable-features=BackForwardCache',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-hang-monitor',
      '--no-first-run',
      '--window-size=1400,1000',
      'http://localhost:5173/',
    ],
    { stdio: 'ignore' },
  )
}
function cdpReady(p) {
  return fetch('http://127.0.0.1:' + p + '/json/version')
    .then(() => true)
    .catch(() => false)
}

import { spawn } from 'node:child_process'

const target = await (async () => {
  for (let i = 0; i < 20; i++) {
    const r = await fetch('http://127.0.0.1:' + port + '/json')
    const list = await r.json()
    const page = list.find((t) => t.type === 'page' && t.url.includes('localhost'))
    if (page) return page
    await sleep(500)
  }
  throw new Error('未找到调试目标')
})()

const ws = new WebSocket(target.webSocketDebuggerUrl)
let seq = 0
const pending = new Map()
const logs = []
function logLine(tag, text) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${tag}: ${text}`
  logs.push(line)
  console.log(line)
}
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg)
    pending.delete(msg.id)
    return
  }
  const sid = msg.sessionId ? `worker#${msg.sessionId.slice(-4)}` : 'page'
  if (msg.method === 'Runtime.consoleAPICalled') {
    const text = (msg.params.args ?? []).map((a) => a.value ?? a.description ?? a.type).join(' ')
    logLine(sid + ' console.' + msg.params.type, String(text).slice(0, 300))
  } else if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails
    logLine(sid + ' EXCEPTION', String(d.exception?.description ?? d.text).slice(0, 400))
  } else if (msg.method === 'Log.entryAdded') {
    logLine(sid + ' log.' + msg.params.entry.level, String(msg.params.entry.text).slice(0, 300))
  } else if (msg.method === 'Target.attachedToTarget') {
    logLine('attach', `${msg.params.targetInfo.type} (sid ${msg.params.sessionId.slice(-4)})`)
  }
}
await new Promise((r) => (ws.onopen = r))

function send(method, params = {}, sessionId = undefined) {
  const id = ++seq
  const payload = { id, method, params }
  if (sessionId) payload.sessionId = sessionId
  ws.send(JSON.stringify(payload))
  return new Promise((resolve, reject) => {
    pending.set(id, (m) => (m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result)))
  })
}
async function evalJs(expr, sessionId = undefined) {
  const r = await Promise.race([
    send('Runtime.evaluate', { expression: expr, returnByValue: true }, sessionId),
    sleep(6000).then(() => null),
  ])
  if (r === null || r === undefined) return '<<超时或无响应>>'
  if (r.exceptionDetails) return '<<异常>> ' + String(r.exceptionDetails.exception?.description ?? '')
  return r?.result?.value
}
async function evalAwait(expr) {
  const r = await Promise.race([
    send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }),
    sleep(150000).then(() => null),
  ])
  if (r === null) return '<<超时>>'
  if (r.exceptionDetails) return '<<异常>> ' + String(r.exceptionDetails.exception?.description ?? '').slice(0, 300)
  return r?.result?.value
}

await send('Runtime.enable')
await send('Log.enable')
await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true })

// 资源可达性
for (const u of ['/katago/engine-worker.js', '/katago/katago.js', '/katago/katago.worker.js', '/katago/gtp_auto.cfg', '/katago/tf.min.js', '/katago/web_model/model.json']) {
  const s = await evalJs(`fetch('${u}').then(r => r.status).catch(e => 'ERR ' + e)`)
  console.log('HTTP', u, '→', s)
}

// 跨源隔离
const coi = await evalJs('(() => ({ sab: typeof SharedArrayBuffer !== "undefined", crossOriginIsolated: self.crossOriginIsolated }))()')
console.log('隔离状态:', JSON.stringify(coi))

logLine('diag', `开始等待 ${WAIT_S}s 观察 Worker 启动…`)

// 可选：引擎就绪后点击棋盘中心，触发一次 genmove 并观察 GTP 对话
const doClick = process.argv[3] === 'click'
let clicked = false
for (let i = 0; i < WAIT_S; i++) {
  await sleep(1000)
  if (doClick && !clicked) {
    const eng = await evalJs('window.__shusakuEngine ?? ""')
    if (eng === 'KataGo') {
      const dims = await evalJs(
        '(() => { const c = document.querySelector(".board-canvas"); if (!c) return null; const r = c.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()',
      )
      if (dims && dims.x) {
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: dims.x, y: dims.y, button: 'left', clickCount: 1 })
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: dims.x, y: dims.y, button: 'left', clickCount: 1 })
        clicked = true
        logLine('diag', `已点击棋盘中心 (${Math.round(dims.x)},${Math.round(dims.y)})，观察 genmove…`)
      }
    }
  }
  if (i % 15 === 14) {
    const eng = await evalJs('window.__shusakuEngine ?? ""')
    const mv = await evalJs('document.querySelectorAll(".log li").length')
    logLine('diag', `engine="${eng}" 手数=${mv}`)
  }
}

const final = await evalJs('window.__shusakuEngine ?? ""')
console.log('最终引擎:', final || '(空)')

// ── 模型能力探针：在独立 Worker 上分别对 7 路与 9 路做一次 genmove ──
if (process.argv[3] === 'click') {
  console.log('── 模型探针（独立 Worker，size 7 与 size 9）──')
  for (const size of [7, 9]) {
    const probe = await evalAwait(
      `(async () => {
        const w = new Worker('/katago/engine-worker.js')
        let seq = 0
        let waiters = []
        w.onmessage = (e) => { const ws = waiters; waiters = []; ws.forEach((res) => res(e.data)) }
        const ask = (msg) => new Promise((res) => { waiters.push(res); w.postMessage({ ...msg, id: ++seq }) })
        const ping = async () => { const r = await ask({ type: 'ping' }); return r.ready }
        for (let i = 0; i < 60; i++) { if (await ping()) break; await new Promise((r) => setTimeout(r, 500)) }
        const t0 = performance.now()
        const r = await ask({ type: 'genmove', position: { size: ${size}, moves: [], handicapStones: 0, komi: 7.5, rules: 'chinese', superko: true }, settings: { visits: 20, maxTimeMs: 8000, pickMode: 'best' } })
        return JSON.stringify({ type: r.type, move: r.move, wr: r.blackWinrate, ms: Math.round(performance.now() - t0) })
      })()`,
    )
    console.log(`size ${size}:`, probe)
  }
}
writeFileSync('C:/Users/NewUser/AppData/Local/Temp/kata-diag.log', logs.join('\n'))
console.log('完整日志: C:/Users/NewUser/AppData/Local/Temp/kata-diag.log')
try {
  proc.kill()
} catch {}
process.exit(0)
