import type { BoardSize } from '../core/types'
import type { EngineRequest, EngineResponse, EngineSettings, GamePosition, PositionResult } from './protocol'

export interface GenMoveResult extends PositionResult {
  move: { kind: 'pass' } | { kind: 'place'; x: number; y: number } | { kind: 'resign' }
  visits: number
}

export interface BenchmarkResult {
  playoutsPerSecond: number
  timeMs: number
}

/**
 * 引擎客户端：把 Worker 的请求-应答封装成 Promise。
 * 引擎本体（LocalGoEngine）将来换成 KataGo WASM 时，此接口不变。
 */
/** Omit 对联合类型不分布，这里手动分布以保留各请求的专有字段 */
type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never

export class EngineClient {
  readonly name: string
  private worker: Worker
  private seq = 0
  private pending = new Map<number, { resolve: (r: unknown) => void; reject: (e: Error) => void }>()

  private constructor(worker: Worker, name: string) {
    this.name = name
    this.worker = worker
    this.worker.onmessage = (e: MessageEvent<EngineResponse>) => {
      const resp = e.data
      const p = this.pending.get(resp.id)
      if (!p) return
      this.pending.delete(resp.id)
      if (resp.type === 'error') p.reject(new Error(resp.message))
      else p.resolve(resp)
    }
    this.worker.onerror = (e) => {
      for (const p of this.pending.values()) p.reject(new Error(e.message))
      this.pending.clear()
    }
  }

  static create(
    options?: { workerUrl?: string; classic?: boolean; name?: string },
  ): EngineClient {
    const worker = options?.workerUrl
      ? new Worker(options.workerUrl, { type: options.classic ? 'classic' : 'module' })
      : new Worker(new URL('./engine.worker.ts', import.meta.url), { type: 'module' })
    return new EngineClient(worker, options?.name ?? '内置 UCT')
  }

  /** 就绪探测：Worker 收到后回 pong（ready = GTP 引擎是否已就绪） */
  ping(): Promise<{ ready: boolean }> {
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      this.pending.set(id, {
        resolve: (r) => resolve(r as unknown as { ready: boolean }),
        reject,
      })
      this.worker.postMessage({ type: 'ping', id })
    })
  }

  private send(req: DistributiveOmit<EngineRequest, 'id'>): Promise<EngineResponse> {
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      this.worker.postMessage({ ...req, id })
    })
  }

  genMove(position: GamePosition, settings: EngineSettings): Promise<GenMoveResult> {
    return this.send({ type: 'genmove', position, settings }) as Promise<GenMoveResult>
  }

  evaluate(position: GamePosition, settings: EngineSettings): Promise<PositionResult> {
    return this.send({ type: 'evaluate', position, settings }) as Promise<PositionResult>
  }

  benchmark(size: BoardSize, playouts: number): Promise<BenchmarkResult> {
    return this.send({ type: 'benchmark', size, playouts }) as Promise<BenchmarkResult>
  }

  dispose(): void {
    this.worker.terminate()
    for (const p of this.pending.values()) p.reject(new Error('engine disposed'))
    this.pending.clear()
  }
}
