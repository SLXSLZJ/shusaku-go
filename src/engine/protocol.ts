import type { BoardSize, Player, Rules } from '../core/types'

export type EngineMove =
  | { kind: 'place'; x: number; y: number }
  | { kind: 'pass' }
  | { kind: 'resign' }

export interface GamePosition {
  size: BoardSize
  /** 全部着手（含让子石，均为黑）；pass 以 x = -1 表示 */
  moves: { player: Player; x: number; y: number }[]
  handicapStones: number
  komi: number
  rules: Rules
  superko: boolean
}

export interface EngineSettings {
  /** 每手搜索量（playouts / visits） */
  visits: number
  /** 单手时间上限（毫秒），到时即返回当前最优 */
  maxTimeMs: number
  /** 选点方式：best = 永远最优；narrow / wide = 在近似候选中按访问量加权抽取 */
  pickMode: 'best' | 'narrow' | 'wide'
  seed?: number
  /**
   * 人味 SL：加载 KataGo human SL 网作为选点先验，按段位/年代行棋。
   * 仅 KataGo 后端支持；省略时用主力网络正常行棋。
   */
  humanSl?: { profile: string; style: 'imitate' | 'search' }
}

export interface PositionResult {
  blackWinrate: number
  scoreLead: number
  ownership: number[]
  timeMs: number
}

export type EngineRequest =
  | { id: number; type: 'genmove'; position: GamePosition; settings: EngineSettings }
  | { id: number; type: 'evaluate'; position: GamePosition; settings: EngineSettings }
  | { id: number; type: 'benchmark'; size: BoardSize; playouts: number }

export type EngineResponse =
  | ({
      id: number
      type: 'genmove'
      move: EngineMove
      visits: number
    } & PositionResult)
  | ({ id: number; type: 'evaluate' } & PositionResult)
  | { id: number; type: 'benchmark'; playoutsPerSecond: number; timeMs: number }
  | { id: number; type: 'error'; message: string }
