import { describe, expect, it } from 'vitest'
import { bookCandidates, ensureShusakuBook, sgfCoordToXY, toSgfCoord, weightedBookCandidate } from './shusakuBook'

describe('秀策开局库', () => {
  it('根节点候选是秀策流的标志性起手（右上小目 qd 等）', async () => {
    await ensureShusakuBook()
    const root = bookCandidates([])
    expect(root).not.toBeNull()
    expect(Object.keys(root!).length).toBeGreaterThan(0)
    expect(root).toHaveProperty('qd') // 16之4 = 右上小目
  })

  it('不存在的路径返回 null', async () => {
    await ensureShusakuBook()
    // 两个天元起手不可能出现在任何谱中
    expect(bookCandidates([{ x: 9, y: 9 }, { x: 9, y: 9 }])).toBeNull()
  })

  it('加权抽样始终返回表内候选', () => {
    const table = { qd: 3, 'dd': 1 }
    const seen = new Set<string>()
    for (const r of [0, 0.1, 0.5, 0.99]) {
      const pick = weightedBookCandidate(table, () => r)
      expect(pick).not.toBeNull()
      expect(table).toHaveProperty(pick!)
      seen.add(pick!)
    }
    expect(seen.size).toBeGreaterThan(0)
    expect(weightedBookCandidate({}, () => 0.5)).toBeNull()
    expect(weightedBookCandidate({ qd: 0 }, () => 0.5)).toBeNull()
  })

  it('坐标转换与 SGF 规范一致', () => {
    expect(toSgfCoord(0, 0)).toBe('aa')
    expect(toSgfCoord(16, 3)).toBe('qd')
    expect(toSgfCoord(-1, -1)).toBe('pass')
    expect(sgfCoordToXY('qd')).toEqual({ x: 16, y: 3 })
    expect(sgfCoordToXY('pass')).toBeNull()
  })
})
