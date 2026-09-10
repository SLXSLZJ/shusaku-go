/**
 * 小棋盘胜率探针：用独立 Worker 评估若干开局局面，输出黑方胜率。
 * 用于验证「9/13 路黑方开局胜率极低」是数据事实还是管线偏差。
 */
import { spawn } from 'node:child_process'

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const PORT = 9333
const URL = process.argv[2] ?? 'http://localhost:5173/'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const proc = spawn(
  EDGE,
  [
    '--remote-debugging-port=' + PORT,
    '--headless=new',
    '--user-data-dir=C:/Users/NewUser/AppData/Local/Temp/edge-winrate-probe-' + Date.now(),
    '--disable-http-cache',
    '--no-first-run',
    URL,
  ],
  { stdio: 'ignore' },
)

let port = null
for (let i = 0; i < 40; i++) {
  try {
    await fetch('http://127.0.0.1:' + PORT + '/json/version')
    port = PORT
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
if (!target) throw new Error('未找到页面目标')

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
  return new Promise((resolve, reject) => {
    pending.set(id, (m) => (m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result)))
  })
}
const evalAwait = async (expr, timeoutMs = 180000) => {
  const r = await Promise.race([
    send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }),
    sleep(timeoutMs).then(() => null),
  ])
  if (r === null) return '<<超时>>'
  if (r.exceptionDetails) return '<<异常>> ' + String(r.exceptionDetails.exception?.description ?? '').slice(0, 200)
  return r.result?.value
}

// 等引擎就绪
for (let i = 0; i < 120; i++) {
  const eng = await evalAwait('window.__shusakuEngine ?? ""', 3000)
  if (eng && eng !== '<<异常>>') break
  await sleep(1000)
}
console.log('引擎:', await evalAwait('window.__shusakuEngine ?? ""'))

// 通过页面内动态 import 适配层，直接调用 katagoEvaluate 评估各开局局面
const results = await evalAwait(
  `(async () => {
    const mod = await import('/src/engine/katagoTsBackend.ts')
    const mk = (size, moves, komi) => ({ size, moves: moves.map(([p, x, y]) => ({ player: p, x, y })), handicapStones: 0, komi, rules: 'chinese', superko: true })
    const out = {}
    const cases = {
      '9路空盘 komi=6.5 (96访问)': mk(9, [], 6.5),
      '9路空盘 komi=6.5 (800访问)': mk(9, [], 6.5),
      '9路黑3-3 komi=6.5 (800访问)': mk(9, [[1, 2, 6]], 6.5),
    }
    const visitsFor = (name) => (name.includes('800') ? 800 : 96)
    for (const [name, pos] of Object.entries(cases)) {
      try {
        const r = await mod.katagoEvaluate(pos, { visits: visitsFor(name), maxTimeMs: 60000, pickMode: 'best' })
        out[name] = (r.blackWinrate * 100).toFixed(1) + '%'
      } catch (e) {
        out[name] = 'ERR ' + String(e).slice(0, 120)
      }
    }
    return JSON.stringify(out, null, 1)
  })()`,
  300000,
)
console.log('黑方胜率评估结果:')
console.log(results)

try {
  proc.kill()
} catch {}
process.exit(0)
