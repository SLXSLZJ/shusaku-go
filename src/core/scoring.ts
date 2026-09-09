import { BLACK, WHITE, type BoardSize, type Point, type Rules } from './types'

export interface ScoreInput {
  komi: number
  rules: Rules
  captures: { black: number; white: number }
  /** 判定为死子的棋子（从双方棋盘中移除后计算） */
  deadStones: Point[]
}

export interface ScoreDetail {
  rules: Rules
  blackStones: number
  whiteStones: number
  blackTerritory: number
  whiteTerritory: number
  /** 日本规则下的俘虏数（提子 + 对方死子） */
  blackPrisoners: number
  whitePrisoners: number
  /** 最终得分（白分已含贴目） */
  blackScore: number
  whiteScore: number
  winner: 'black' | 'white' | 'draw'
  margin: number
}

/**
 * 终局计分。死子先移除，空点洪泛归属：仅接触单一颜色的区域归该色，
 * 双色接触（公气 / 双活）为无主。
 */
export function computeScore(stones: Uint8Array, size: BoardSize, input: ScoreInput): ScoreDetail {
  const n = size * size
  const alive = Uint8Array.from(stones)
  for (const p of input.deadStones) {
    const i = p.y * size + p.x
    if (i >= 0 && i < n) alive[i] = 0
  }

  let blackStones = 0
  let whiteStones = 0
  for (let i = 0; i < n; i++) {
    if (alive[i] === BLACK) blackStones++
    else if (alive[i] === WHITE) whiteStones++
  }

  // 空点归属
  const visited = new Uint8Array(n)
  const stack: number[] = []
  let blackTerritory = 0
  let whiteTerritory = 0
  for (let s = 0; s < n; s++) {
    if (alive[s] !== 0 || visited[s]) continue
    stack.length = 0
    stack.push(s)
    visited[s] = 1
    const region: number[] = []
    let touch = 0 // bit1 = 黑，bit2 = 白
    while (stack.length > 0) {
      const cur = stack.pop()!
      region.push(cur)
      const x = cur % size
      const y = (cur - x) / size
      const check = (j: number): void => {
        if (visited[j]) return
        const c = alive[j]
        if (c === 0) {
          visited[j] = 1
          stack.push(j)
        } else {
          touch |= c === BLACK ? 1 : 2
        }
      }
      if (x > 0) check(cur - 1)
      if (x < size - 1) check(cur + 1)
      if (y > 0) check(cur - size)
      if (y < size - 1) check(cur + size)
    }
    if (touch === 1) blackTerritory += region.length
    else if (touch === 2) whiteTerritory += region.length
  }

  let blackScore: number
  let whiteScore: number
  let blackPrisoners: number
  let whitePrisoners: number
  if (input.rules === 'chinese') {
    blackScore = blackStones + blackTerritory
    whiteScore = whiteStones + whiteTerritory + input.komi
    blackPrisoners = 0
    whitePrisoners = 0
  } else {
    blackPrisoners = input.captures.black + (input.deadStones.filter((p) => stones[p.y * size + p.x] === WHITE).length)
    whitePrisoners = input.captures.white + (input.deadStones.filter((p) => stones[p.y * size + p.x] === BLACK).length)
    blackScore = blackTerritory + blackPrisoners
    whiteScore = whiteTerritory + whitePrisoners + input.komi
  }

  const margin = blackScore - whiteScore
  return {
    rules: input.rules,
    blackStones,
    whiteStones,
    blackTerritory,
    whiteTerritory,
    blackPrisoners,
    whitePrisoners,
    blackScore,
    whiteScore,
    winner: margin > 0 ? 'black' : margin < 0 ? 'white' : 'draw',
    margin: Math.abs(margin),
  }
}

/**
 * 用引擎的领地图估计死活：己方棋子落在对方 strongly-owned 的点上 → 判死。
 * ownership 取值 [-1, 1]，正为黑势。
 */
export function deadStonesFromOwnership(
  stones: Uint8Array,
  size: BoardSize,
  ownership: ArrayLike<number>,
  threshold = 0.3,
): Point[] {
  const out: Point[] = []
  for (let i = 0; i < stones.length; i++) {
    const s = stones[i]
    if (s === 0) continue
    const own = ownership[i]
    if (s === BLACK && own < -threshold) out.push({ x: i % size, y: Math.floor(i / size) })
    else if (s === WHITE && own > threshold) out.push({ x: i % size, y: Math.floor(i / size) })
  }
  return out
}
