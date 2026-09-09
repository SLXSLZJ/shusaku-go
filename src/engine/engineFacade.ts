import type { BoardSize } from '../core/types'
import type { EngineSettings, GamePosition, PositionResult } from './protocol'
import { EngineClient, type BenchmarkResult, type GenMoveResult } from './engineClient'
import {
  KATAGO_MODEL_NAME,
  isKatagoTsReady,
  katagoBenchmark,
  katagoEvaluate,
  katagoGenMove,
} from './katagoTsBackend'

export interface EngineBackend {
  readonly name: string
  genMove(position: GamePosition, settings: EngineSettings): Promise<GenMoveResult>
  evaluate(position: GamePosition, settings: EngineSettings): Promise<PositionResult>
  benchmark(size: BoardSize, playouts: number): Promise<BenchmarkResult>
}

let singleton: Promise<EngineBackend> | null = null

/**
 * 引擎选择：
 * - 首选 KataGo（web-katrain 移植版）：TFJS 网络推理 + PUCT 搜索运行在独立
 *   Worker，直接加载 KataGo 原生 .bin.gz 模型（public/models/kata1-b18c384nbt，
 *   19 路全棋盘），思考期间页面保持流畅。
 * - 模型加载失败 / 超时时回退内置 UCT Worker。
 *
 * 旧的 emscripten 方案（katago.js 直读 TFJS web_model）已废弃：上游无现成的
 * ≥19 路 web_model，官方 TF1 转换链难以在本地复现。详见 docs/kata-enable.md。
 */
const KATAGO_ENABLED = true

export function getEngineBackend(): Promise<EngineBackend> {
  if (!singleton) {
    singleton = (async () => {
      if (KATAGO_ENABLED) {
        try {
          // 首次加载需取回 93MB 模型并建图，就绪门控给足时间
          if (await isKatagoTsReady(120_000)) {
            return {
              name: KATAGO_MODEL_NAME,
              genMove: katagoGenMove,
              evaluate: katagoEvaluate,
              benchmark: katagoBenchmark,
            }
          }
        } catch {
          // 落入回退
        }
      }
      // 回退：内置 UCT Worker
      return EngineClient.create({ name: '内置 UCT' })
    })()
  }
  return singleton
}
