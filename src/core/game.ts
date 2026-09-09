import {
  BLACK,
  WHITE,
  type BoardSize,
  type MoveRecord,
  type OverReason,
  type PlayResult,
  type Player,
  type Point,
  type Stone,
} from './types'
import { zobristFor, type ZobristTable } from './zobrist'

export interface GameOptions {
  /** 全局同形禁着（positional superko，中国规则风格）。默认仅简单劫。 */
  superko?: boolean
}

export interface GameSnapshot {
  size: BoardSize
  stones: Uint8Array
  turn: Player
  moveNumber: number
  isOver: boolean
  overReason: OverReason | null
  captures: { black: number; white: number }
  koPoint: Point | null
  lastMove: MoveRecord | null
  history: readonly MoveRecord[]
  handicapStones: number
}

const toIndex = (size: number, x: number, y: number): number => y * size + x

/** 各路数的固定让子星位表（小 / 中 / 大三个基准坐标）。 */
const HANDICAP_ANCHORS: Record<BoardSize, { small: number; mid: number; big: number }> = {
  9: { small: 2, mid: 4, big: 6 },
  13: { small: 3, mid: 6, big: 9 },
  19: { small: 3, mid: 9, big: 15 },
}

function handicapPoints(size: BoardSize, count: number): Point[] {
  const { small, mid, big } = HANDICAP_ANCHORS[size]
  const pts: Point[] = []
  const add = (x: number, y: number): void => {
    pts.push({ x, y })
  }
  if (count >= 2) {
    add(big, small)
    add(small, big)
  }
  if (count >= 3) add(small, small)
  if (count >= 4) add(big, big)
  if (count >= 6) {
    add(big, mid)
    add(small, mid)
  }
  if (count >= 8) {
    add(mid, small)
    add(mid, big)
  }
  // 5 / 7 / 9 手加天元
  if (count === 5 || count === 7 || count === 9) add(mid, mid)
  return pts
}

export class GoGame {
  readonly size: BoardSize

  private readonly z: ZobristTable
  private readonly useSuperko: boolean
  private stones: Uint8Array
  private moves: MoveRecord[] = []
  private hashes: number[] = [0]
  private koIndex = -1
  private passesInRow = 0
  private over = false
  private reason: OverReason | null = null
  private capturedByBlack = 0
  private capturedByWhite = 0
  private handicap = 0

  constructor(size: BoardSize, options: GameOptions = {}) {
    this.size = size
    this.z = zobristFor(size)
    this.useSuperko = options.superko ?? false
    this.stones = new Uint8Array(size * size)
  }

  get turn(): Player {
    const normal = this.moves.length - this.handicap
    const even = normal % 2 === 0
    // 让子局摆完让子石后由白先行
    if (this.handicap > 0) return even ? WHITE : BLACK
    return even ? BLACK : WHITE
  }

  get moveNumber(): number {
    return this.moves.length
  }

  get isOver(): boolean {
    return this.over
  }

  get overReason(): OverReason | null {
    return this.reason
  }

  get captures(): { black: number; white: number } {
    return { black: this.capturedByBlack, white: this.capturedByWhite }
  }

  get koPoint(): Point | null {
    return this.koIndex >= 0 ? this.toPoint(this.koIndex) : null
  }

  get lastMove(): MoveRecord | null {
    return this.moves.length > 0 ? this.moves[this.moves.length - 1] : null
  }

  get history(): readonly MoveRecord[] {
    return this.moves
  }

  get handicapStones(): number {
    return this.handicap
  }

  stoneAt(x: number, y: number): Stone {
    if (!this.inBounds(x, y)) return 0
    return this.stones[toIndex(this.size, x, y)] as Stone
  }

  /** 摆放固定让子（星位表）。须在新局上调用一次。 */
  placeFixedHandicap(count: number): Point[] {
    if (this.moves.length > 0 || count <= 0) return []
    const clamped = Math.min(9, count)
    const pts = handicapPoints(this.size, clamped)
    for (const p of pts) this.forcePlace(p.x, p.y, BLACK)
    this.handicap = pts.length
    return pts
  }

  /** 绕过行棋顺序直接放置（让子 / 引擎重建局面用）。 */
  forcePlace(x: number, y: number, player: Player): void {
    if (!this.inBounds(x, y) || this.stones[toIndex(this.size, x, y)] !== 0) return
    const i = toIndex(this.size, x, y)
    this.stones[i] = player
    this.moves.push({ kind: 'place', player, x, y, captured: [], isKo: false })
    this.hashes.push(this.hashes[this.hashes.length - 1] ^ this.z.code(i, player))
  }

  /** 落子。不合法时返回错误，棋盘状态保持不变。 */
  play(x: number, y: number): PlayResult {
    if (this.over) return { ok: false, error: 'game-over' }
    if (!this.inBounds(x, y)) return { ok: false, error: 'out-of-bounds' }
    const i = toIndex(this.size, x, y)
    if (this.stones[i] !== 0) return { ok: false, error: 'occupied' }
    if (i === this.koIndex) return { ok: false, error: 'ko' }

    const player = this.turn
    const opponent = (3 - player) as Player
    this.stones[i] = player

    const captured = this.collectCaptures(i, opponent)
    for (const c of captured) this.stones[c] = 0

    if (captured.length === 0) {
      const group = this.collectGroup(i, player)
      if (group.liberties === 0) {
        this.stones[i] = 0
        return { ok: false, error: 'self-capture' }
      }
    }

    let hash = this.hashes[this.hashes.length - 1] ^ this.z.code(i, player)
    for (const c of captured) hash ^= this.z.code(c, opponent)
    if (this.useSuperko && this.hashes.includes(hash)) {
      this.stones[i] = 0
      for (const c of captured) this.stones[c] = opponent
      return { ok: false, error: 'superko' }
    }

    // 简单劫：提一子且新落的独子只剩一气 → 对方下一手不得立即回提
    let isKo = false
    let koAfter = -1
    if (captured.length === 1) {
      const group = this.collectGroup(i, player)
      if (group.stones.length === 1 && group.liberties === 1) {
        isKo = true
        koAfter = captured[0]
      }
    }

    const record: MoveRecord = {
      kind: 'place',
      player,
      x,
      y,
      captured: captured.map((c) => this.toPoint(c)),
      isKo,
    }
    this.push(record, hash, koAfter)
    return { ok: true, captured: record.captured }
  }

  pass(): void {
    if (this.over) return
    const record: MoveRecord = {
      kind: 'pass',
      player: this.turn,
      x: -1,
      y: -1,
      captured: [],
      isKo: false,
    }
    this.push(record, this.hashes[this.hashes.length - 1], -1)
  }

  resign(): void {
    if (this.over) return
    this.over = true
    this.reason = 'resign'
  }

  undo(): boolean {
    // 让子石是对局前提，不允许悔掉
    if (this.moves.length <= this.handicap) return false
    const kept = this.moves.slice(0, -1)
    this.stones.fill(0)
    this.moves = []
    this.hashes = [0]
    this.koIndex = -1
    this.passesInRow = 0
    this.over = false
    this.reason = null
    this.capturedByBlack = 0
    this.capturedByWhite = 0
    for (const m of kept) this.reapply(m)
    return true
  }

  snapshot(): GameSnapshot {
    return {
      size: this.size,
      stones: Uint8Array.from(this.stones),
      turn: this.turn,
      moveNumber: this.moveNumber,
      isOver: this.over,
      overReason: this.reason,
      captures: this.captures,
      koPoint: this.koPoint,
      lastMove: this.lastMove,
      history: this.history,
      handicapStones: this.handicap,
    }
  }

  private push(record: MoveRecord, hash: number, koAfter: number): void {
    this.moves.push(record)
    this.hashes.push(hash)
    this.koIndex = koAfter
    if (record.kind === 'pass') {
      this.passesInRow += 1
      if (this.passesInRow >= 2) {
        this.over = true
        this.reason = 'passes'
      }
    } else {
      this.passesInRow = 0
      if (record.player === BLACK) this.capturedByBlack += record.captured.length
      else this.capturedByWhite += record.captured.length
    }
  }

  private reapply(m: MoveRecord): void {
    if (m.kind === 'pass') {
      this.push(m, this.hashes[this.hashes.length - 1], -1)
      return
    }
    const i = toIndex(this.size, m.x, m.y)
    const opponent = (3 - m.player) as Player
    this.stones[i] = m.player
    let hash = this.hashes[this.hashes.length - 1] ^ this.z.code(i, m.player)
    let koAfter = -1
    for (const p of m.captured) {
      const c = toIndex(this.size, p.x, p.y)
      this.stones[c] = 0
      hash ^= this.z.code(c, opponent)
    }
    if (m.isKo) {
      const first = m.captured[0]
      koAfter = toIndex(this.size, first.x, first.y)
    }
    this.push(m, hash, koAfter)
  }

  private collectCaptures(i: number, opponent: Player): number[] {
    const out: number[] = []
    const seen = new Set<number>()
    for (const n of this.neighbors(i)) {
      if (this.stones[n] === opponent && !seen.has(n)) {
        const group = this.collectGroup(n, opponent)
        for (const s of group.stones) seen.add(s)
        if (group.liberties === 0) out.push(...group.stones)
      }
    }
    return out
  }

  private collectGroup(start: number, color: Player): { stones: number[]; liberties: number } {
    const stonesList: number[] = [start]
    const visited = new Set<number>([start])
    const liberties = new Set<number>()
    const queue = [start]
    while (queue.length > 0) {
      const cur = queue.pop()!
      for (const n of this.neighbors(cur)) {        const v = this.stones[n]
        if (v === 0) {
          liberties.add(n)
        } else if (v === color && !visited.has(n)) {
          visited.add(n)
          stonesList.push(n)
          queue.push(n)
        }
      }
    }
    return { stones: stonesList, liberties: liberties.size }
  }

  private *neighbors(i: number): Generator<number> {
    const size = this.size
    const x = i % size
    const y = (i - x) / size
    if (x > 0) yield i - 1
    if (x < size - 1) yield i + 1
    if (y > 0) yield i - size
    if (y < size - 1) yield i + size
  }

  private inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.size && y < this.size
  }

  private toPoint(i: number): Point {
    return { x: i % this.size, y: Math.floor(i / this.size) }
  }
}
