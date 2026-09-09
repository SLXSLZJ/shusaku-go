export type BoardSize = 9 | 13 | 19

/** 1 = 黑，2 = 白 */
export type Player = 1 | 2
export const BLACK: Player = 1
export const WHITE: Player = 2

export type Stone = 0 | Player

/** 计子规则：中国数子 / 日本数目 */
export type Rules = 'chinese' | 'japanese'

export type OverReason = 'passes' | 'resign'

export interface Point {
  x: number
  y: number
}

export interface MoveRecord {
  kind: 'place' | 'pass'
  player: Player
  /** pass 时为 -1 */
  x: number
  y: number
  /** 该手提掉的对方棋子 */
  captured: Point[]
  /** 该手是否形成打劫（对方下一手不得立即回提） */
  isKo: boolean
}

export type PlayError =
  | 'out-of-bounds'
  | 'occupied'
  | 'ko'
  | 'self-capture'
  | 'superko'
  | 'game-over'

export type PlayResult =
  | { ok: true; captured: Point[] }
  | { ok: false; error: PlayError }
