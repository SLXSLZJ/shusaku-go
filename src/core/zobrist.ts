import type { BoardSize, Player } from './types'

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return (t ^ (t >>> 14)) >>> 0
  }
}

/** 每个交叉点 × 颜色一个 32 位随机码，局面哈希 = 全部棋子码的异或。 */
export class ZobristTable {
  readonly size: BoardSize
  private readonly codes: Uint32Array

  constructor(size: BoardSize, seed = 0x9e3779b9) {
    this.size = size
    this.codes = new Uint32Array(size * size * 2)
    const rand = mulberry32(seed)
    for (let i = 0; i < this.codes.length; i++) this.codes[i] = rand()
  }

  code(index: number, player: Player): number {
    return this.codes[index * 2 + (player - 1)]
  }
}

const cache = new Map<BoardSize, ZobristTable>()

export function zobristFor(size: BoardSize): ZobristTable {
  let t = cache.get(size)
  if (!t) {
    t = new ZobristTable(size)
    cache.set(size, t)
  }
  return t
}
