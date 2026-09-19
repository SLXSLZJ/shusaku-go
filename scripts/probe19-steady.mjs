/** 稳态每手耗时：19路×L7，等 AI 空闲再落白子，验证手数推进，抓 console/横幅。 */
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const SHOT = 'C:/Users/NewUser/AppData/Local/Temp/probe19-steady.png'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const PORT = process.env.PORT ?? '4173'
const CDP_PORT = process.env.CDP_PORT ?? '9227'
const FORCE_LEVEL = process.env.FORCE_LEVEL ?? '7'
const staticSrv = spawn('node', ['scripts/preview-coi.mjs', PORT], { stdio: 'ignore', shell: true })
for (let i = 0; i < 20; i++) { try { await fetch('http://127.0.0.1:' + PORT + '/'); break } catch {} await sleep(400) }
const proc = spawn(EDGE, [
  '--remote-debugging-port=' + CDP_PORT, '--headless=new', '--mute-audio',
  '--user-data-dir=C:/Users/NewUser/AppData/Local/Temp/edge-steady19-' + Date.now(),
  '--disable-http-cache', '--proxy-bypass-list=<-loopback>', '--no-first-run',
  '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding', '--disable-hang-monitor',
  '--disable-features=IntensiveWakeUpThrottling',
  'http://127.0.0.1:' + (process.env.PORT ?? '4173') + '/',
], { stdio: 'ignore' })
// proc.kill() 杀不掉 Edge 的子进程树，会留下占着调试端口的僵尸——用 taskkill 强杀整棵树
const cleanup = () => {
  try { spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }) } catch {}
  try { spawn('taskkill', ['/PID', String(staticSrv.pid), '/T', '/F'], { stdio: 'ignore' }) } catch {}
}
process.on('exit', cleanup)
process.on('uncaughtException', () => { cleanup(); process.exit(1) })

let port = null
for (let i = 0; i < 30; i++) { try { const r = await fetch('http://127.0.0.1:' + CDP_PORT + '/json/version'); if (r.ok) { port = CDP_PORT; break } } catch {} await sleep(500) }
let target
for (let i = 0; i < 20; i++) { const r = await fetch(`http://127.0.0.1:${port}/json`); const l = await r.json(); target = l.find((t) => t.type === 'page' && t.url.includes(process.env.PORT ?? '4173')); if (target) break; await sleep(500) }
const ws = new WebSocket(target.webSocketDebuggerUrl)
let seq = 0; const pending = new Map()
let rawHandler = null
ws.onmessage = (ev) => { rawHandler?.(ev); const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
await new Promise((r) => (ws.onopen = r))
const consoleLogs = []
rawHandler = (ev) => {
  try {
    const msg = JSON.parse(ev.data)
    if (msg.method === 'Runtime.consoleAPICalled') {
      const txt = msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ')
      consoleLogs.push(`[${msg.params.type}] ${txt.slice(0, 200)}`)
      if (txt.includes('katago')) console.log(`[console.${msg.params.type}]`, txt.slice(0, 200))
    } else if (msg.method === 'Runtime.exceptionThrown') {
      consoleLogs.push(`[异常] ${JSON.stringify(msg.params.exceptionDetails).slice(0, 200)}`)
    }
  } catch {}
}
await send('Runtime.enable')
function send(method, params = {}) {
  const id = ++seq
  ws.send(JSON.stringify({ id, method, params }))
  return new Promise((res, rej) => pending.set(id, (m) => (m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result))))
}
const evalJs = async (expr, t = 6000) => {
  const r = await Promise.race([send('Runtime.evaluate', { expression: expr, returnByValue: true }), sleep(t).then(() => null)])
  if (!r) return null
  if (r.exceptionDetails) return '<<异常>>'
  return r.result?.value
}
const click = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
}

await sleep(1500)
for (let i = 0; i < 150; i++) { const e = await evalJs('window.__shusakuEngine ?? ""'); if (e) { console.log('引擎:', e); break } await sleep(1000) }
console.log('环境:', await evalJs('JSON.stringify({ isolated: crossOriginIsolated, cores: navigator.hardwareConcurrency, webgpu: !!navigator.gpu })'))
// 等人味网预热完成（横幅消失 = 预热结束），再开始对局——排除首手排队的干扰
console.log('等待人味网预热（横幅消失）…')
for (let i = 0; i < 180; i++) {
  const b = await evalJs('document.querySelector(".engine-banner")?.textContent?.replace(/\\s+/g," ").trim() ?? ""')
  if (!b) { console.log(`预热结束（${i}s）`); break }
  if (i % 10 === 0) console.log(`  ${i}s 横幅: ${b.slice(0, 80)}`)
  await sleep(1000)
}
await evalJs('(() => { if (document.querySelector(".setup-body")) return 1; document.querySelector(".setup-panel .panel-toggle")?.click(); return 2 })()')
await sleep(300)
await evalJs(`(() => { const row = [...document.querySelectorAll('.setup-row')].find((r) => r.querySelector('.setup-label')?.textContent === '棋盘'); const btn = [...(row?.querySelectorAll('button') ?? [])].find((b) => b.textContent.includes('十九路')); btn?.click(); return 1 })()`)
await evalJs(`(() => { const i = document.querySelector('.range'); const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; set.call(i, '$FORCE_LEVEL'); i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); return 1 })()`)
const tStart = Date.now()
await evalJs('(() => { const b = [...document.querySelectorAll(".btn")].find((x) => x.textContent === "开始新局"); b?.click(); return 1 })()')
await sleep(500)
await evalJs('(() => { document.querySelector(".log-panel .panel-toggle")?.click(); return 1 })()')
const liCount = () => evalJs(`document.querySelectorAll('.log-panel .log li').length`)
const thinking = () => evalJs(`!!document.querySelector('.state-row')?.textContent.includes('思考')`)
// 棋盘滚进视口（否则 100vh Hero 把棋盘顶出屏幕，点击落在视口外）
await evalJs('document.querySelector(".game-section")?.scrollIntoView({ block: "start", behavior: "instant" })')
await sleep(800)
console.log('棋盘位置:', await evalJs('(() => { const r = document.querySelector(".board-canvas")?.getBoundingClientRect(); return r ? JSON.stringify({ top: Math.round(r.top), h: Math.round(r.height) }) : "无" })()'))

// AI 首手（观察 400s，让 240s 排队看门狗有机会触发）
let first = -1
for (let i = 0; i < 500; i++) {
  const n = await liCount()
  if (n !== null && n >= 1) { first = Date.now() - tStart; break }
  if (i > 0 && i % 50 === 0) {
    const rows = await evalJs('[...document.querySelectorAll(".state-row")].map((r) => r.textContent.trim()).filter(Boolean).join(" | ")')
    console.log(`  …${Math.round((Date.now() - tStart) / 1000)}s 状态行: ${rows}`)
  }
  await sleep(800)
}
console.log(`AI首手: ${first >= 0 ? first + 'ms' : '超时'}`)
if (first < 0) {
  console.log('—— 超时诊断：最近 console/异常 ——')
  for (const line of consoleLogs.slice(-25)) console.log('  ', line)
}

// 4 个白手交换
const verts = [[3, 3], [15, 3], [3, 15], [9, 9]]
for (let k = 0; k < verts.length; k++) {
  for (let i = 0; i < 50; i++) { const t = await thinking(); if (t === false) break; await sleep(400) }
  await sleep(600)
  const before = await liCount()
  const px = await evalJs(`(() => { const c = document.querySelector('.board-canvas'); const r = c.getBoundingClientRect(); const margin = r.width * 0.036 + r.width * 0.042; const cell = (r.width - margin * 2) / 18; return JSON.stringify({ x: r.left + margin + ${verts[k][0]} * cell, y: r.top + margin + ${verts[k][1]} * cell }) })()`)
  const p = JSON.parse(px)
  const tc = Date.now()
  await click(p.x, p.y)
  let placed = -1
  for (let i = 0; i < 8; i++) { const n = await liCount(); if (n !== null && n >= before + 1) { placed = Date.now() - tc; break } await sleep(300) }
  if (placed < 0) { console.log(`白第${k + 1}手(${verts[k]}): 落子失败（li=${before}），重试点其他点`); continue }
  let done = -1
  for (let i = 0; i < 300; i++) { const n = await liCount(); if (n !== null && n >= before + 2) { done = Date.now() - tc; break } await sleep(400) }
  const rows = await evalJs('[...document.querySelectorAll(".state-row")].map((r) => r.textContent.trim()).filter(Boolean).join(" | ")')
  console.log(`白第${k + 1}手(${verts[k]}): 落子+${placed}ms, AI应答总耗时 ${done >= 0 ? done + 'ms' : '超时'}（手数 ${before}→${await liCount()}）`)
  console.log(`  状态行: ${rows}`)
}
console.log('最终横幅:', await evalJs('document.querySelector(".engine-banner")?.textContent?.replace(/\\s+/g," ").trim() ?? "(无)"'))
const shot = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync(SHOT, Buffer.from(shot.data, 'base64'))
console.log('截图:', SHOT)
cleanup()
process.exit(0)
