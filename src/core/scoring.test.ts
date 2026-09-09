import { describe, expect, it } from 'vitest'
import { BLACK, WHITE, type Point } from './types'
import { computeScore } from './scoring'

const pts = (list: [number, number][]): Point[] => list.map(([x, y]) => ({ x, y }))

function stonesOf(size: number, black: [number, number][], white: [number, number][]): Uint8Array {
  const s = new Uint8Array(size * size)
  for (const [x, y] of black) s[y * size + x] = BLACK as number
  for (const [x, y] of white) s[y * size + x] = WHITE as number
  return s
}

describe('computeScore', () => {
  it('空盘：白按贴目获胜', () => {
    const r = computeScore(stonesOf(9, [], []), 9, {
      komi: 7.5,
      rules: 'chinese',
      captures: { black: 0, white: 0 },
      deadStones: [],
    })
    expect(r.blackScore).toBe(0)
    expect(r.whiteScore).toBe(7.5)
    expect(r.winner).toBe('white')
    expect(r.margin).toBeCloseTo(7.5)
  })

  it('中国规则：数子 = 活子 + 空', () => {
    // 黑在左上围住 (1,1)；白在右下围住 (7,7)，其余为双方公气
    const s = stonesOf(
      9,
      [
        [0, 0],
        [1, 0],
        [2, 0],
        [0, 1],
        [2, 1],
        [0, 2],
        [1, 2],
        [2, 2],
      ],
      [
        [6, 6],
        [7, 6],
        [8, 6],
        [6, 7],
        [8, 7],
        [6, 8],
        [7, 8],
        [8, 8],
      ],
    )
    const r = computeScore(s, 9, {
      komi: 7.5,
      rules: 'chinese',
      captures: { black: 0, white: 0 },
      deadStones: [],
    })
    expect(r.blackStones).toBe(8)
    expect(r.blackTerritory).toBe(1)
    expect(r.blackScore).toBe(9)
    expect(r.whiteTerritory).toBe(1)
    expect(r.whiteScore).toBe(8 + 1 + 7.5)
  })

  it('死子移除后归对方地（中国规则）', () => {
    // 黑围住左上角，白一子在角内（已死）
    const s = stonesOf(
      9,
      [
        [1, 0],
        [0, 1],
        [2, 0],
        [2, 1],
        [0, 2],
        [1, 2],
        [2, 2],
      ],
      [
        [0, 0],
        [6, 6],
        [7, 6],
        [8, 6],
        [6, 7],
        [8, 7],
        [6, 8],
        [7, 8],
        [8, 8],
      ],
    )
    const base = { komi: 0.5, rules: 'chinese' as const, captures: { black: 0, white: 0 } }
    // 不判死：白子占住 (0,0)，黑只有 (1,1) 一点空
    const alive = computeScore(s, 9, { ...base, deadStones: [] })
    expect(alive.blackTerritory).toBe(1)
    // 判死：死子归对方地
    const dead = computeScore(s, 9, { ...base, deadStones: pts([[0, 0]]) })
    expect(dead.blackStones).toBe(7)
    expect(dead.blackTerritory).toBe(2) // (0,0) (1,1)
    expect(dead.blackScore).toBe(9)
  })

  it('日本规则：数目 + 提子俘虏', () => {
    // 黑围住左上 2 点空，白围住右下 1 点空，黑另有 3 个提子
    const s = stonesOf(
      9,
      [
        [1, 0],
        [2, 0],
        [0, 1],
        [2, 1],
        [0, 2],
        [1, 2],
        [2, 2],
      ],
      [
        [6, 6],
        [7, 6],
        [8, 6],
        [6, 7],
        [8, 7],
        [6, 8],
        [7, 8],
        [8, 8],
      ],
    )
    const r = computeScore(s, 9, {
      komi: 0.5,
      rules: 'japanese',
      captures: { black: 3, white: 0 },
      deadStones: [],
    })
    expect(r.blackTerritory).toBe(2) // (0,0) 与 (1,1)
    expect(r.whiteTerritory).toBe(1) // (7,7)
    expect(r.blackPrisoners).toBe(3)
    expect(r.blackScore).toBe(5)
    expect(r.whiteScore).toBe(1.5)
    expect(r.winner).toBe('black')
  })
})
