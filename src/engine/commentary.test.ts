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

  it('扳描述（己方与敌方分列落点两侧共线）', () => {
    // 黑(3,4) 为己方，白(5,4) 为敌方头，黑(4,4) 落下挡住 → 扳
    const moves = [B(3, 4), W(5, 4), W(7, 7), B(7, 6), B(4, 4)]
    const r = describeLastMove(9, moves, 0)
    expect(r).toContain('扳')
  })

  it('粘描述（贴着敌子把己方棋连回）', () => {
    // 黑(4,3) 与白(3,4) 相邻交错；黑(3,3) 落下：贴白(3,4) 且与黑(4,3) 连接 → 粘
    const moves = [B(4, 3), W(3, 4), W(6, 6), B(3, 3)]
    const r = describeLastMove(9, moves, 0)
    expect(r).toContain('粘')
  })

  it('拆二描述（三线沿边二间）', () => {
    // 黑(2,6)（三线），黑(4,6) 为三线二间 → 拆二
    const moves = [B(2, 6), W(5, 5), B(4, 6)]
    const r = describeLastMove(9, moves, 0)
    expect(r).toContain('拆二')
  })

  it('中腹二间仍为跳', () => {
    // 黑(3,4)，黑(5,4)（中腹二间直线）→ 跳
    const moves = [B(3, 4), W(6, 6), B(5, 4)]
    const r = describeLastMove(9, moves, 0)
    expect(r).toContain('跳')
  })
})
