import { LocalGoEngine } from './localEngine'
import type { EngineRequest, EngineResponse } from './protocol'

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<EngineRequest>) => void) | null
  postMessage(msg: EngineResponse): void
}

const engine = new LocalGoEngine()

ctx.onmessage = (e: MessageEvent<EngineRequest>) => {
  const req = e.data
  try {
    let resp: EngineResponse
    switch (req.type) {
      case 'genmove': {
        const r = engine.genMove(req.position, req.settings)
        resp = { id: req.id, type: 'genmove', ...r }
        break
      }
      case 'evaluate': {
        const r = engine.evaluate(req.position, req.settings)
        resp = { id: req.id, type: 'evaluate', ...r }
        break
      }
      case 'benchmark': {
        const r = engine.benchmark(req.size, req.playouts)
        resp = { id: req.id, type: 'benchmark', ...r }
        break
      }
    }
    ctx.postMessage(resp)
  } catch (err) {
    ctx.postMessage({ id: req.id, type: 'error', message: String(err) })
  }
}
