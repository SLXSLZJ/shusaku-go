import { describe, expect, it } from 'vitest'
import { GoGame, type GameSnapshot } from './game'
import { BLACK, WHITE, type PlayResult } from './types'

type XY = [number, number]

/** 依次落子，任何一手被拒即失败。 */
function expectPlayed(game: GoGame, moves: XY[]): void {
  for (const [x, y] of moves) {
    const r = game.play(x, y)
    if (!r.ok) {
      throw new Error(`落子 (${x},${y}) 被拒：${r.error}（第 ${game.moveNumber + 1} 手）`)
    }
  }
}

function snapshotsEqual(a: GameSnapshot, b: GameSnapshot): boolean {
  if (a.moveNumber !== b.moveNumber || a.turn !== b.turn || a.isOver !== b.isOver) return false
  if (a.captures.black !== b.captures.black || a.captures.white !== b.captures.white) return false
  const ka = a.koPoint
  const kb = b.koPoint
  if ((ka?.x ?? -1) !== (kb?.x ?? -1) || (ka?.y ?? -1) !== (kb?.y ?? -1)) return false
  if (a.stones.length !== b.stones.length) return false
  for (let i = 0; i < a.stones.length; i++) {
    if (a.stones[i] !== b.stones[i]) return false
  }
  return true
}

describe('GoGame 基础规则', () => {
  it('新局黑先，落子后轮白', () => {
    const g = new GoGame(9)
    expect(g.turn).toBe(BLACK)
    const r: PlayResult = g.play(4, 4)
    expect(r).toEqual({ ok: true, captured: [] })
    expect(g.turn).toBe(WHITE)
    expect(g.moveNumber).toBe(1)
  })

  it('不能下在已有棋子上，且状态不变', () => {
    const g = new GoGame(9)
    g.play(4, 4)
    expect(g.play(4, 4)).toEqual({ ok: false, error: 'occupied' })
    expect(g.turn).toBe(WHITE)
    expect(g.moveNumber).toBe(1)
  })

  it('边角提子并计入提子数', () => {
    const g = new GoGame(9)
    expectPlayed(g, [
      [1, 0],
      [0, 0],
      [0, 1],
    ])
    expect(g.stoneAt(0, 0)).toBe(0)
    expect(g.captures.black).toBe(1)
    expect(g.captures.white).toBe(0)
  })

  it('多子整体提吃', () => {
    const g = new GoGame(9)
    expectPlayed(g, [
      [1, 0],
      [0, 0],
      [1, 1],
      [0, 1],
      [0, 2],
    ])
    expect(g.stoneAt(0, 0)).toBe(0)
    expect(g.stoneAt(0, 1)).toBe(0)
    expect(g.captures.black).toBe(2)
  })

  it('禁着点：落子后无气（自杀）被拒，状态不变', () => {
    const g = new GoGame(9)
    expectPlayed(g, [
      [1, 0],
      [8, 8],
      [0, 1],
    ])
    expect(g.play(0, 0)).toEqual({ ok: false, error: 'self-capture' })
    expect(g.stoneAt(0, 0)).toBe(0)
    expect(g.turn).toBe(WHITE)
  })

  it('连接两组一口气棋的落子同样是禁着点', () => {
    const g = new GoGame(9)
    // 白 (0,0) 与 (0,2) 各只剩 (0,1) 一气，黑封住 (0,3)；
    // 白接 (0,1) 合并后整组无气且提不到黑子
    expectPlayed(g, [
      [1, 0],
      [0, 0],
      [1, 1],
      [0, 2],
      [1, 2],
      [3, 3],
      [0, 3],
    ])
    expect(g.play(0, 1)).toEqual({ ok: false, error: 'self-capture' })
    expect(g.stoneAt(0, 1)).toBe(0)
  })
})

describe('打劫', () => {
  function koShape(game: GoGame): void {
    // 摆出标准劫形：黑 (4,1) (5,2) (4,3)，白 (4,2) (3,1) (2,2) (3,3)
    expectPlayed(game, [
      [4, 1],
      [4, 2],
      [5, 2],
      [3, 1],
      [4, 3],
      [2, 2],
      [7, 7],
      [3, 3],
    ])
  }

  it('提劫后对方不得立即回提', () => {
    const g = new GoGame(9)
    koShape(g)
    const r = g.play(3, 2) // 黑提劫，吃白 (4,2)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.captured).toEqual([{ x: 4, y: 2 }])
    }
    expect(g.koPoint).toEqual({ x: 4, y: 2 })
    // 白立即回提 → 打劫禁着
    expect(g.play(4, 2)).toEqual({ ok: false, error: 'ko' })
    expect(g.turn).toBe(WHITE)
    // 白寻劫（他处落子）、黑应后，回提恢复合法
    expectPlayed(g, [
      [6, 6],
      [8, 8],
    ])
    const retake = g.play(4, 2)
    expect(retake.ok).toBe(true)
    expect(g.koPoint).toEqual({ x: 3, y: 2 })
    expect(g.captures.white).toBe(1)
    // 黑同样不得立即回提
    expect(g.play(3, 2)).toEqual({ ok: false, error: 'ko' })
  })

  it('悔棋完整恢复劫形、提子与棋盘', () => {
    const g = new GoGame(9)
    koShape(g)
    expectPlayed(g, [[3, 2]]) // 黑提劫
    const before = g.snapshot()
    expectPlayed(g, [
      [6, 6],
      [8, 8],
    ])
    g.undo()
    g.undo()
    const after = g.snapshot()
    expect(snapshotsEqual(before, after)).toBe(true)
  })
})

describe('虚着与终局', () => {
  it('连续两次虚着终局；终局后禁着；悔棋可恢复', () => {
    const g = new GoGame(13)
    expectPlayed(g, [
      [3, 3],
      [9, 9],
    ])
    g.pass()
    expect(g.isOver).toBe(false)
    g.pass()
    expect(g.isOver).toBe(true)
    expect(g.play(6, 6)).toEqual({ ok: false, error: 'game-over' })
    g.undo()
    expect(g.isOver).toBe(false)
    expect(g.moveNumber).toBe(3) // 2 手 + 1 次虚着
    g.pass()
    expect(g.isOver).toBe(true)
    g.undo()
    expect(g.isOver).toBe(false)
  })
})

describe('全局同形禁着（superko）', () => {
  /**
   * 在 19 路上摆出四个独立劫形（四劫循环）。
   * 每个劫带占三行，d 为该带首行行号；swap 为 true 时黑白互换
   * （三子一侧归白，嘴形变为白提黑）。
   */
  function quadKoSetup(): XY[] {
    const bands = [
      { d: 0, swap: false },
      { d: 3, swap: true },
      { d: 6, swap: false },
      { d: 9, swap: true },
    ]
    const black: XY[] = []
    const white: XY[] = []
    for (const { d, swap } of bands) {
      const three = swap ? white : black
      const four = swap ? black : white
      three.push([4, d], [5, d + 1], [4, d + 2])
      four.push([4, d + 1], [3, d], [2, d + 1], [3, d + 2])
    }
    // 黑 14、白 14，交替落子：黑先共 28 手，末手为白 → 轮黑
    const seq: XY[] = []
    let bi = 0
    let wi = 0
    for (let k = 0; k < 28; k++) {
      seq.push(k % 2 === 0 ? black[bi] : white[wi])
      if (k % 2 === 0) bi++
      else wi++
    }
    return seq
  }

  const CYCLE: XY[] = [
    [3, 1], // 黑提 A 劫（吃白 (4,1)）
    [3, 4], // 白提 B 劫（吃黑 (4,4)）
    [3, 7], // 黑提 C 劫
    [3, 10], // 白提 D 劫
    [4, 4], // 黑回提 B 劫
    [4, 1], // 白回提 A 劫
    [4, 10], // 黑回提 D 劫
    // 下一手白 (4,7) 回提 C 劫将令全局回到摆完后的局面
  ]

  it('开启 superko：循环回提不得重现原局面', () => {
    const g = new GoGame(19, { superko: true })
    expectPlayed(g, quadKoSetup())
    expect(g.turn).toBe(BLACK)
    expectPlayed(g, CYCLE)
    expect(g.play(4, 7)).toEqual({ ok: false, error: 'superko' })
    // 状态未变，白仍可他处落子
    expect(g.turn).toBe(WHITE)
    expect(g.play(10, 10)).toEqual({ ok: true, captured: [] })
  })

  it('不开启 superko（简单劫）：四劫循环合法', () => {
    const g = new GoGame(19)
    expectPlayed(g, quadKoSetup())
    expectPlayed(g, CYCLE)
    expect(g.play(4, 7).ok).toBe(true)
    expect(g.captures.black).toBe(4)
    expect(g.captures.white).toBe(4)
  })
})
