/** 高强度落子耗时探针：提前落子收敛验证（只读页面 + 动态 import 适配层）。 */
import { spawn } from 'node:child_process'
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const proc = spawn(EDGE, ['--remote-debugging-port=9780','--headless=new','--user-data-dir=C:/Users/NewUser/AppData/Local/Temp/edge-perf2-'+Date.now(),'--disable-http-cache','--proxy-bypass-list=<-loopback>','--no-first-run','http://localhost:5173/'], { stdio: 'ignore' })
for (let i=0;i<30;i++){ try { await fetch('http://127.0.0.1:9780/json/version'); break } catch {} await sleep(500) }
let target
for (let i=0;i<20;i++){ const r = await fetch('http://127.0.0.1:9780/json'); const l = await r.json(); target = l.find(t=>t.type==='page'); if(target) break; await sleep(500) }
const ws = new WebSocket(target.webSocketDebuggerUrl)
let seq=0; const pending=new Map()
ws.onmessage=(ev)=>{const m=JSON.parse(ev.data); if(m.id&&pending.has(m.id)){pending.get(m.id)(m);pending.delete(m.id)}}
await new Promise(r=>ws.onopen=r)
const send=(method,params={})=>{const id=++seq;ws.send(JSON.stringify({id,method,params}));return new Promise(res=>pending.set(id,res))}
const evalAwait=async(e,t=180000)=>{const r=await Promise.race([send('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:true}),sleep(t).then(()=>null)]); if(!r) return 'TIMEOUT'; if(r.exceptionDetails) return 'EXC: '+String(r.exceptionDetails.exception?.description||'').slice(0,300); return r.result?.value}
for (let i=0;i<120;i++){ const e = await evalAwait('window.__shusakuEngine ?? ""',3000); if (e && e !== 'TIMEOUT' && !String(e).startsWith('<<')) { console.log('引擎:', e); break } await sleep(1000) }
console.log('STAGE1 import:')
console.log(await evalAwait(`(async () => {
  const mod = await import('/src/engine/katagoTsBackend.ts')
  window.__probeMod = mod
  return 'import-ok'
})()`, 30000))
console.log('STAGE2 小访问量 genmove (64v):')
console.log(await evalAwait(`(async () => {
  const mod = window.__probeMod
  const pos = { size: 9, moves: [], handicapStones: 0, komi: 6.5, rules: 'chinese', superko: true }
  const r = await mod.katagoGenMove(pos, { visits: 64, maxTimeMs: 20000, pickMode: 'best' })
  return JSON.stringify({ move: r.move, ms: Math.round(r.timeMs), visits: r.visits })
})()`, 60000))
console.log('STAGE3 32000v 无人味:')
console.log(await evalAwait(`(async () => {
  const mod = window.__probeMod
  const pos = { size: 9, moves: [], handicapStones: 0, komi: 6.5, rules: 'chinese', superko: true }
  const r = await mod.katagoGenMove(pos, { visits: 32000, maxTimeMs: 120000, pickMode: 'best' })
  return JSON.stringify({ move: r.move, ms: Math.round(r.timeMs), visits: r.visits })
})()`, 180000))
console.log('STAGE4 9路 秀策流 32000v:')
console.log(await evalAwait(`(async () => {
  const mod = window.__probeMod
  const pos = { size: 9, moves: [{player:1,x:2,y:6}], handicapStones: 0, komi: 6.5, rules: 'chinese', superko: true }
  const r = await mod.katagoGenMove(pos, { visits: 32000, maxTimeMs: 120000, pickMode: 'best', humanSl: { profile: 'proyear_1850', style: 'search' } })
  return JSON.stringify({ move: r.move, ms: Math.round(r.timeMs), visits: r.visits })
})()`, 180000))
try{proc.kill()}catch{}
process.exit(0)
