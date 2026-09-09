import { describe, expect, it } from 'vitest'
import { GoGame } from '../core/game'
import { BLACK, WHITE, type Player } from '../core/types'
import { LocalGoEngine } from './localEngine'
import type { GamePosition } from './protocol'

const engine = new LocalGoEngine()

function pos(size: 9 | 13 | 19, moves: { p: Player; x: number; y: number }[], komi = 7.5): GamePosition {
  return {
    size,
    moves: moves.map((m) => ({ player: m.p, x: m.x, y: m.y })),
    handicapStones: 0,
    komi,
    rules: 'chinese',
    superko: false,
  }
}

describe('LocalGoEngine', () => {
  it('空盘 genmove 返回合法着点', () => {
    // 贴 0.5 目让黑白胜率接近五五开，便于断言区间
    const r = engine.genMove(pos(9, [], 0.5), { visits: 300, maxTimeMs: 5000, pickMode: 'best', seed: 42 })
    if (r.move.kind !== 'place') throw new Error('应返回落子而非虚着')
    expect(r.move.x).toBeGreaterThanOrEqual(0)
    expect(r.move.x).toBeLessThan(9)
    expect(r.move.y).toBeGreaterThanOrEqual(0)
    expect(r.move.y).toBeLessThan(9)
    expect(r.visits).toBeGreaterThan(0)
    expect(r.blackWinrate).toBeGreaterThan(0)
    expect(r.blackWinrate).toBeLessThan(1)
  })

  it('能发现边角的提子手段', () => {
    // 白 (0,0) 只剩 (0,1) 一气，黑 (1,0) 已在位；轮黑 → 应提 (0,1)
    const p = pos(9, [
      { p: BLACK, x: 1, y: 0 },
      { p: WHITE, x: 0, y: 0 },
      { p: BLACK, x: 5, y: 5 },
      { p: WHITE, x: 8, y: 8 },
    ])
    const r = engine.genMove(p, { visits: 500, maxTimeMs: 8000, pickMode: 'best', seed: 7 })
    expect(r.move).toEqual({ kind: 'place', x: 0, y: 1 })
  })

  it('双方引擎对弈全程合法（经 GoGame 逐步校验）', () => {
    const game = new GoGame(9)
    const position = (): GamePosition => ({
      size: 9,
      moves: game.history.map((m) => ({ player: m.player, x: m.x, y: m.y })),
      handicapStones: 0,
      komi: 7.5,
      rules: 'chinese',
      superko: false,
    })
    for (let i = 0; i < 60 && !game.isOver; i++) {
      const r = engine.genMove(position(), {
        visits: 30,
        maxTimeMs: 2000,
        pickMode: 'best',
        seed: i + 1,
      })
      if (r.move.kind === 'pass') {
        game.pass()
      } else if (r.move.kind === 'place') {
        const res = game.play(r.move.x, r.move.y)
        if (!res.ok) throw new Error(`引擎第 ${i + 1} 手下了不合法的 (${r.move.x},${r.move.y})：${res.error}`)
      }
    }
    expect(game.moveNumber).toBeGreaterThan(10)
    const ev = engine.evaluate(position(), {
      visits: 100,
      maxTimeMs: 3000,
      pickMode: 'best',
      seed: 1,
    })
    expect(ev.ownership).toHaveLength(81)
    expect(ev.blackWinrate).toBeGreaterThanOrEqual(0)
    expect(ev.blackWinrate).toBeLessThanOrEqual(1)
  })

  it('benchmark 返回正的每秒对局数', () => {
    const r = engine.benchmark(9, 200)
    expect(r.playoutsPerSecond).toBeGreaterThan(0)
  })
})
