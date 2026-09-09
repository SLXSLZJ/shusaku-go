import { describe, expect, it } from 'vitest'
import { BLACK, WHITE } from '../core/types'
import { describeLastMove, type MoveLite } from './commentary'

const B = (x: number, y: number): MoveLite => ({ player: BLACK, x, y })
const W = (x: number, y: number): MoveLite => ({ player: WHITE, x, y })

describe('describeLastMove', () => {
  it('空列表返回 null', () => {
    expect(describeLastMove(9, [], 0)).toBeNull()
  })

  it('提子描述', () => {
    // 黑(1,0) 后白(0,0)（剩一气(0,1)），黑(0,1) 提白一子
    const moves = [B(1, 0), W(0, 0), B(5, 5), W(8, 8), B(0, 1)]
    const r = describeLastMove(9, moves, 0)
    expect(r).toContain('提')
    expect(r).toContain('黑')
  })

  it('叫吃描述', () => {
    // 白(0,0) 被黑(1,0) 叫吃（(0,1) 仍空）
    const moves = [B(5, 5), W(0, 0), B(1, 0)]
    const r = describeLastMove(9, moves, 0)
    expect(r).toContain('打')
  })

  it('开局天元点命名', () => {
    const r = describeLastMove(9, [B(4, 4)], 0)
    expect(r).toContain('天元')
  })

  it('虚着描述', () => {
    const moves = [B(4, 4), W(-1, -1)]
    const r = describeLastMove(9, moves, 0)
    expect(r).toContain('虚着')
  })
})
