import type { BoardSize } from '../core/types'
import type { EngineSettings, GamePosition, PositionResult } from './protocol'
import type { BenchmarkResult, GenMoveResult } from './engineClient'

/** 所有引擎后端（内置 UCT Worker / 页面内嵌 KataGo）的共同接口 */
export interface EngineBackend {
  readonly name: string
  genMove(position: GamePosition, settings: EngineSettings): Promise<GenMoveResult>
  evaluate(position: GamePosition, settings: EngineSettings): Promise<PositionResult>
  benchmark(size: BoardSize, playouts: number): Promise<BenchmarkResult>
}
