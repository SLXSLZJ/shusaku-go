import { BLACK, WHITE, type BoardSize, type Player } from '../core/types'
import { GoGame } from '../core/game'
import type { EngineMove, EngineSettings, GamePosition, PositionResult } from './protocol'

// ─────────────────────────── 基础设施 ───────────────────────────

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    // 归一化到 [0, 1)：调用方（洗牌 / 随机选点 / 概率判定）都按概率使用
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface NeighborTable {
  data: Int32Array
  counts: Int8Array
}

const neighborCache = new Map<number, NeighborTable>()

/** 标准正态分布 CDF（Abramowitz–Stegun 26.2.17 近似，显示级精度足够） */
function normalCdf(z: number): number {
  const az = Math.abs(z)
  const t = 1 / (1 + 0.2316419 * az)
  const poly = t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))))
  const cdfPos = 1 - 0.3989422804014327 * Math.exp(-(z * z) / 2) * poly
  return z >= 0 ? cdfPos : 1 - cdfPos
}

/** 由目差样本的均值/方差估计黑方胜率：P(目差 > 0) = Φ(μ/σ)，比胜场计数平滑 */
function winrateBlackFromMoments(scoreLeadSum: number, scoreSqSum: number, playouts: number): number {
  if (playouts <= 0) return 0.5
  const mean = scoreLeadSum / playouts
  const variance = Math.max(0, scoreSqSum / playouts - mean * mean)
  const sigma = Math.max(Math.sqrt(variance), 0.5)
  return Math.min(0.99, Math.max(0.01, normalCdf(mean / sigma)))
}

function neighborsFor(size: number): NeighborTable {
  let t = neighborCache.get(size)
  if (t) return t
  const n = size * size
  const data = new Int32Array(n * 4)
  const counts = new Int8Array(n)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x
      let k = 0
      if (x > 0) data[i * 4 + k++] = i - 1
      if (x < size - 1) data[i * 4 + k++] = i + 1
      if (y > 0) data[i * 4 + k++] = i - size
      if (y < size - 1) data[i * 4 + k++] = i + size
      counts[i] = k
    }
  }
  t = { data, counts }
  neighborCache.set(size, t)
  return t
}

// ─────────────────────────── 推演棋盘 ───────────────────────────

interface PlaceInfo {
  ok: boolean
  /** 本次落子位置（失败 / 尚无时为 -1） */
  pos: number
  captured: number[]
  /** 因本次落子而进入叫吃状态的对方棋组（以最后一气位置表示） */
  atariLibs: number[]
}

/**
 * 快速推演棋盘：洪泛判气，正确性优先。供 UCT 叶节点之后的随机对局使用，
 * 战术上带有「提吃 / 逃叫吃」的局部应手启发。
 */
class PlayoutBoard {
  readonly size: number
  readonly n: number
  color: Int8Array
  koPoint = -1
  private readonly nb: NeighborTable
  private readonly stamp: Int32Array
  private gen = 0
  private readonly stack: Int32Array
  private empties: Int32Array
  private emptySlot: Int32Array
  emptyCount = 0

  constructor(size: number) {
    this.size = size
    this.n = size * size
    this.color = new Int8Array(this.n)
    this.nb = neighborsFor(size)
    this.stamp = new Int32Array(this.n)
    this.stack = new Int32Array(this.n)
    this.empties = new Int32Array(this.n)
    this.emptySlot = new Int32Array(this.n)
    this.resetEmpties()
  }

  private resetEmpties(): void {
    this.emptyCount = this.n
    for (let i = 0; i < this.n; i++) {
      this.empties[i] = i
      this.emptySlot[i] = i
    }
  }

  /** 从局面数组初始化（0 空 / 1 黑 / 2 白），并重建空点表。 */
  setFrom(colors: Int8Array | Uint8Array): void {
    this.color.set(colors)
    this.resetEmpties()
    for (let i = 0; i < this.n; i++) {
      if (this.color[i] !== 0) this.removeEmpty(i)
    }
  }

  copy(): PlayoutBoard {
    const b = new PlayoutBoard(this.size)
    b.color.set(this.color)
    b.koPoint = this.koPoint
    b.empties.set(this.empties.subarray(0, this.emptyCount))
    for (let k = 0; k < this.emptyCount; k++) b.emptySlot[b.empties[k]] = k
    b.emptyCount = this.emptyCount
    return b
  }

  private removeEmpty(pos: number): void {
    const slot = this.emptySlot[pos]
    const last = this.empties[--this.emptyCount]
    this.empties[slot] = last
    this.emptySlot[last] = slot
  }

  private addEmpty(pos: number): void {
    this.empties[this.emptyCount] = pos
    this.emptySlot[pos] = this.emptyCount
    this.emptyCount++
  }

  /** 洪泛统计棋组：子数、气数、其中一气的位置。 */
  private groupInfo(root: number): { count: number; libs: number; libPos: number } {
    const color0 = this.color[root]
    const gen = ++this.gen
    const stack = this.stack
    let sp = 0
    stack[sp++] = root
    this.stamp[root] = gen
    let count = 0
    let libs = 0
    let libPos = -1
    while (sp > 0) {
      const cur = stack[--sp]
      count++
      const base = cur * 4
      const cnt = this.nb.counts[cur]
      for (let k = 0; k < cnt; k++) {
        const j = this.nb.data[base + k]
        if (this.stamp[j] === gen) continue
        const c = this.color[j]
        if (c === 0) {
          this.stamp[j] = gen
          libs++
          if (libPos < 0) libPos = j
        } else if (c === color0) {
          this.stamp[j] = gen
          stack[sp++] = j
        }
      }
    }
    return { count, libs, libPos }
  }

  private removeGroup(root: number): number[] {
    const gen = ++this.gen
    const stack = this.stack
    let sp = 0
    stack[sp++] = root
    this.stamp[root] = gen
    const out: number[] = []
    while (sp > 0) {
      const cur = stack[--sp]
      out.push(cur)
      const base = cur * 4
      const cnt = this.nb.counts[cur]
      for (let k = 0; k < cnt; k++) {
        const j = this.nb.data[base + k]
        if (this.stamp[j] !== gen && this.color[j] === this.color[root]) {
          this.stamp[j] = gen
          stack[sp++] = j
        }
      }
    }
    for (const s of out) {
      this.color[s] = 0
      this.addEmpty(s)
    }
    return out
  }

  private fillsOwnEye(idx: number, player: Player): boolean {
    const base = idx * 4
    const cnt = this.nb.counts[idx]
    for (let k = 0; k < cnt; k++) {
      if (this.color[this.nb.data[base + k]] !== player) return false
    }
    const size = this.size
    const x = idx % size
    const y = (idx - x) / size
    let diagEnemy = 0
    for (const [dx, dy] of DIAGONALS) {
      const dxn = x + dx
      const dyn = y + dy
      if (dxn < 0 || dyn < 0 || dxn >= size || dyn >= size) continue
      if (this.color[dyn * size + dxn] === (3 - player) as Player) diagEnemy++
    }
    // 边角不允许斜上有敌子，中腹允许一处（防假眼的标准近似）
    const onEdge = cnt < 4
    return onEdge ? diagEnemy === 0 : diagEnemy <= 1
  }

  /**
   * 落子尝试；失败（打劫 / 自杀 / 占用）时棋盘状态不变并返回 false。
   * 成功时把提子与对方新叫吃组写入 out。
   */
  tryPlace(idx: number, player: Player, out: PlaceInfo): boolean {
    if (this.color[idx] !== 0 || idx === this.koPoint) {
      out.ok = false
      out.pos = -1
      return false
    }
    const prevKo = this.koPoint
    this.color[idx] = player
    this.removeEmpty(idx)
    const opponent = (3 - player) as Player
    out.captured.length = 0
    out.atariLibs.length = 0
    const base = idx * 4
    const cnt = this.nb.counts[idx]
    for (let k = 0; k < cnt; k++) {
      const j = this.nb.data[base + k]
      if (this.color[j] !== opponent) continue
      const g = this.groupInfo(j)
      if (g.libs === 0) {
        out.captured.push(...this.removeGroup(j))
      } else if (g.libs === 1 && !out.atariLibs.includes(g.libPos)) {
        out.atariLibs.push(g.libPos)
      }
    }
    if (out.captured.length > 0) {
      for (const c of out.captured) this.color[c] = 0
      const own = this.groupInfo(idx)
      if (out.captured.length === 1 && own.count === 1 && own.libs === 1) {
        this.koPoint = out.captured[0]
      } else {
        this.koPoint = -1
      }
    } else {
      const own = this.groupInfo(idx)
      if (own.libs === 0) {
        // 自杀：回滚
        this.color[idx] = 0
        this.addEmpty(idx)
        this.koPoint = prevKo
        out.ok = false
        out.pos = -1
        return false
      }
      this.koPoint = -1
    }
    out.ok = true
    out.pos = idx
    return true
  }

  /** 终局数子（Tromp-Taylor 式区域计分），并把每点归属写入 ownerBuf（+1 黑 / -1 白 / 0 无主）。 */
  scoreArea(ownerBuf: Int8Array): { black: number; white: number } {
    const n = this.n
    let black = 0
    let white = 0
    const gen0 = ++this.gen
    for (let i = 0; i < n; i++) {
      if (this.color[i] === BLACK) {
        black++
        ownerBuf[i] = 1
        this.stamp[i] = gen0
      } else if (this.color[i] === WHITE) {
        white++
        ownerBuf[i] = -1
        this.stamp[i] = gen0
      } else {
        ownerBuf[i] = 0
      }
    }
    const stack = this.stack
    const region: number[] = []
    for (let s = 0; s < n; s++) {
      if (this.color[s] !== 0 || this.stamp[s] === gen0) continue
      region.length = 0
      let sp = 0
      stack[sp++] = s
      this.stamp[s] = gen0
      let touch = 0
      while (sp > 0) {
        const cur = stack[--sp]
        region.push(cur)
        const base = cur * 4
        const cnt = this.nb.counts[cur]
        for (let k = 0; k < cnt; k++) {
          const j = this.nb.data[base + k]
          if (this.stamp[j] === gen0) continue
          const c = this.color[j]
          if (c === 0) {
            this.stamp[j] = gen0
            stack[sp++] = j
          } else {
            touch |= c === BLACK ? 1 : 2
          }
        }
      }
      if (touch === 1) {
        black += region.length
        for (const r of region) ownerBuf[r] = 1
      } else if (touch === 2) {
        white += region.length
        for (const r of region) ownerBuf[r] = -1
      }
    }
    return { black, white }
  }

  /**
   * 随机对局至双方虚着。返回（黑 - 白 - 贴目）外的原始黑白地分。
   */
  playout(
    rng: () => number,
    toMove: Player,
    lastA: PlaceInfo,
    lastB: PlaceInfo,
    ownerBuf: Int8Array,
  ): { black: number; white: number } {
    lastA.ok = false
    lastB.ok = false
    let passes = 0
    let moves = 0
    let useA = false // 上一次着手信息存放在哪个 holder
    const maxMoves = this.n * 3
    while (passes < 2 && moves < maxMoves) {
      const last = useA ? lastA : lastB
      const info = useA ? lastB : lastA
      const mv = this.chooseMove(toMove, last, info, rng)
      if (mv < 0) {
        passes++
      } else {
        passes = 0
        useA = !useA
      }
      toMove = (3 - toMove) as Player
      moves++
    }
    return this.scoreArea(ownerBuf)
  }

  private chooseMove(player: Player, last: PlaceInfo, info: PlaceInfo, rng: () => number): number {
    if (last.ok) {
      // 战术应手：提吃对方叫吃组 / 逃自己叫吃组
      if (last.atariLibs.length > 0 && rng() < 0.85) {
        for (const lib of last.atariLibs) {
          if (this.color[lib] === 0 && this.tryPlace(lib, player, info)) return lib
        }
      }
      if (last.pos >= 0 && rng() < 0.6) {
        const base = last.pos * 4
        const cnt = this.nb.counts[last.pos]
        for (let k = 0; k < cnt; k++) {
          const j = this.nb.data[base + k]
          if (this.color[j] !== player) continue
          const g = this.groupInfo(j)
          if (g.libs === 1 && this.color[g.libPos] === 0 && this.tryPlace(g.libPos, player, info)) {
            return g.libPos
          }
        }
      }
    }
    for (let tries = 0; tries < 24; tries++) {
      if (this.emptyCount === 0) return -1
      const pos = this.empties[(rng() * this.emptyCount) | 0]
      if (this.fillsOwnEye(pos, player)) continue
      if (this.tryPlace(pos, player, info)) return pos
    }
    return -1
  }
}

const DIAGONALS: [number, number][] = [
  [-1, -1],
  [1, -1],
  [-1, 1],
  [1, 1],
]

// ─────────────────────────── UCT 搜索 ───────────────────────────

class SearchNode {
  move: number
  lastMover: Player | 0
  parent: SearchNode | null
  children: SearchNode[] = []
  untried: number[]
  wins = 0
  visits = 0

  constructor(move: number, parent: SearchNode | null, lastMover: Player | 0, untried: number[]) {
    this.move = move
    this.parent = parent
    this.lastMover = lastMover
    this.untried = untried
  }
}

export interface RootChild {
  move: number
  visits: number
  /** 行棋方视角胜率 */
  winrate: number
}

const UCB_C = 0.85

function runSearch(
  board0: PlayoutBoard,
  toMove: Player,
  komi: number,
  visits: number,
  maxTimeMs: number,
  rng: () => number,
  ownerSum: Float32Array,
): { children: RootChild[]; playouts: number; scoreLeadSum: number; scoreSqSum: number } {
  const n = board0.n
  const untried: number[] = []
  for (let i = 0; i < n; i++) if (board0.color[i] === 0) untried.push(i)
  // 洗牌：避免并列访问量时的系统性选点偏置
  for (let i = untried.length - 1; i > 0; i--) {
    const j = (rng() * (i + 1)) | 0
    const t = untried[i]
    untried[i] = untried[j]
    untried[j] = t
  }
  untried.unshift(-1) // pass 放最前（pop 取尾），保证先探索实际着点
  const root = new SearchNode(-1, null, 0, untried)

  const infoA: PlaceInfo = { ok: false, pos: -1, captured: [], atariLibs: [] }
  const infoB: PlaceInfo = { ok: false, pos: -1, captured: [], atariLibs: [] }
  const ownerBuf = new Int8Array(n)
  const board = board0.copy()
  let playouts = 0
  let scoreLeadSum = 0
  let scoreSqSum = 0
  const t0 = Date.now()
  ;(globalThis as { __kataLog?: (s: string) => void }).__kataLog?.(
    'runSearch: enter, untried=' + untried.length,
  )

  while (playouts < visits) {
    if ((playouts & 63) === 63 && Date.now() - t0 > maxTimeMs) break

    // 1. 选择 + 2. 扩展
    board.setFrom(board0.color)
    board.koPoint = board0.koPoint
    let node = root
    let mover = toMove
    while (node.untried.length === 0 && node.children.length > 0) {
      const logN = Math.log(node.visits)
      let best: SearchNode = node.children[0]
      let bestVal = -Infinity
      for (const c of node.children) {
        const v = c.wins / c.visits + UCB_C * Math.sqrt(logN / c.visits)
        if (v > bestVal) {
          bestVal = v
          best = c
        }
      }
      node = best
      if (!board.tryPlace(node.move, mover, infoA)) break
      mover = (3 - mover) as Player
    }
    while (node.untried.length === 0 && node.children.length > 0) {
      const logN = Math.log(node.visits)
      let best: SearchNode = node.children[0]
      let bestVal = -Infinity
      for (const c of node.children) {
        const v = c.wins / c.visits + UCB_C * Math.sqrt(logN / c.visits)
        if (v > bestVal) {
          bestVal = v
          best = c
        }
      }
      node = best
      if (!board.tryPlace(node.move, mover, infoA)) break
      mover = (3 - mover) as Player
    }
    while (node.untried.length > 0) {
      const mv = node.untried.pop()!
      if (mv === -1) {
        const child = new SearchNode(-1, node, mover, [])
        node.children.push(child)
        node = child
        mover = (3 - mover) as Player
        break
      }
      if (board.tryPlace(mv, mover, infoA)) {
        const child = new SearchNode(mv, node, mover, [])
        node.children.push(child)
        node = child
        mover = (3 - mover) as Player
        // 战术先验：提子 / 叫吃是明显的好手，给虚拟访问量让 UCT 优先深挖
        if (infoA.captured.length > 0) {
          child.visits += 16
          child.wins += 12
        } else if (infoA.atariLibs.length > 0) {
          child.visits += 6
          child.wins += 4
        }
        break
      }
    }
    const r = board.playout(rng, mover, infoA, infoB, ownerBuf)
    for (let i = 0; i < n; i++) ownerSum[i] += ownerBuf[i]
    const margin = r.black - r.white - komi
    const winner = margin > 0 ? BLACK : WHITE
    scoreLeadSum += margin
    scoreSqSum += margin * margin

    // 4. 回传
    let back: SearchNode | null = node
    while (back !== null) {
      back.visits++
      if (back.lastMover === winner) back.wins++
      back = back.parent
    }
    playouts++
  }

  const children = root.children.map((c) => ({
    move: c.move,
    visits: c.visits,
    winrate: c.visits > 0 ? c.wins / c.visits : 0,
  }))
  children.sort((a, b) => b.visits - a.visits)
  return { children, playouts, scoreLeadSum, scoreSqSum }
}

// ─────────────────────────── 对外接口 ───────────────────────────

/** 找「对方只剩一口气的棋组」的可提吃点；返回该气点坐标，找不到返回 null */
function findAtariCapture(position: GamePosition, color: Player): { x: number; y: number } | null {
  const size = position.size
  const game = new GoGame(position.size, { superko: position.superko })
  position.moves.forEach((m, i) => {
    if (i < position.handicapStones) game.forcePlace(m.x, m.y, m.player)
    else if (m.x === -1) game.pass()
    else game.play(m.x, m.y)
  })
  const enemy: Player = color === BLACK ? WHITE : BLACK
  const seen = new Set<number>()
  for (let i = 0; i < size * size; i++) {
    const x = i % size
    const y = Math.floor(i / size)
    if (game.stoneAt(x, y) !== enemy) continue
    if (seen.has(i)) continue
    const stack = [i]
    seen.add(i)
    const libs = new Set<number>()
    while (stack.length > 0) {
      const cur = stack.pop()!
      const cx = cur % size
      const cy = Math.floor(cur / size)
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = cx + dx
        const ny = cy + dy
        if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue
        const j = ny * size + nx
        const s = game.stoneAt(nx, ny)
        if (s === 0) libs.add(j)
        else if (s === enemy && !seen.has(j)) {
          seen.add(j)
          stack.push(j)
        }
      }
    }
    if (libs.size === 1) {
      const lib = [...libs][0]
      const lx = lib % size
      const ly = Math.floor(lib / size)
      // 打劫禁着：ko 点上不可立即回提
      const ko = game.koPoint
      if (ko && ko.x === lx && ko.y === ly) return null
      return { x: lx, y: ly }
    }
  }
  return null
}

function buildBoard(pos: GamePosition): { game: GoGame; board: PlayoutBoard } {
  const game = new GoGame(pos.size, { superko: pos.superko })
  pos.moves.forEach((m, i) => {
    if (i < pos.handicapStones) {
      game.forcePlace(m.x, m.y, m.player)
    } else if (m.x === -1) {
      game.pass()
    } else {
      game.play(m.x, m.y)
    }
  })
  const board = new PlayoutBoard(pos.size)
  const stones = new Uint8Array(pos.size * pos.size)
  for (let y = 0; y < pos.size; y++) {
    for (let x = 0; x < pos.size; x++) {
      stones[y * pos.size + x] = game.stoneAt(x, y)
    }
  }
  board.setFrom(stones)
  const ko = game.koPoint
  board.koPoint = ko ? ko.y * pos.size + ko.x : -1
  return { game, board }
}

export class LocalGoEngine {
  genMove(position: GamePosition, settings: EngineSettings): { move: EngineMove; visits: number } & PositionResult {
    const t0 = Date.now()
    const rng = mulberry32(settings.seed ?? (Math.random() * 0xffffffff) >>> 0)
    const { game, board } = buildBoard(position)
    const toMove = game.turn
    // 战术优先：对方有只剩一口气的组时直接提吃（低访问量下也不漏提）
    const atariCapture = findAtariCapture(position, toMove)
    const ownerSum = new Float32Array(board.n)
    const { children, playouts, scoreLeadSum, scoreSqSum } = runSearch(
      board.copy(),
      toMove,
      position.komi,
      atariCapture ? Math.min(settings.visits, 120) : settings.visits,
      settings.maxTimeMs,
      rng,
      ownerSum,
    )
    const ownership = Array.from(ownerSum, (v) => (playouts > 0 ? v / playouts : 0))
    const blackWinrate = winrateBlackFromMoments(scoreLeadSum, scoreSqSum, playouts)
    let move = this.pickMove(children, settings.pickMode, rng)
    if (atariCapture) {
      // 有提吃机会时强制选提吃点（先验之外的双保险）
      const capIdx = atariCapture.y * position.size + atariCapture.x
      if (children.length === 0 || children[0].move !== capIdx) move = capIdx
    }
    return {
      move: move === -1 ? { kind: 'pass' } : { kind: 'place', x: move % position.size, y: Math.floor(move / position.size) },
      visits: playouts,
      blackWinrate,
      scoreLead: playouts > 0 ? scoreLeadSum / playouts : 0,
      ownership,
      timeMs: Date.now() - t0,
    }
  }

  evaluate(position: GamePosition, settings: EngineSettings): PositionResult {
    const t0 = Date.now()
    const rng = mulberry32(settings.seed ?? (Math.random() * 0xffffffff) >>> 0)
    const { board } = buildBoard(position)
    const ownerSum = new Float32Array(board.n)
    const infoA: PlaceInfo = { ok: false, pos: -1, captured: [], atariLibs: [] }
    const infoB: PlaceInfo = { ok: false, pos: -1, captured: [], atariLibs: [] }
    const ownerBuf = new Int8Array(board.n)
    const toMove = this.turnOf(position)
    let scoreLeadSum = 0
    let scoreSqSum = 0
    let done = 0
    while (done < settings.visits) {
      if ((done & 63) === 63 && Date.now() - t0 > settings.maxTimeMs) break
      const b = board.copy()
      const r = b.playout(rng, toMove, infoA, infoB, ownerBuf)
      for (let i = 0; i < board.n; i++) ownerSum[i] += ownerBuf[i]
      const margin = r.black - r.white - position.komi
      scoreLeadSum += margin
      scoreSqSum += margin * margin
      done++
    }
    return {
      blackWinrate: winrateBlackFromMoments(scoreLeadSum, scoreSqSum, done),
      scoreLead: done > 0 ? scoreLeadSum / done : 0,
      ownership: Array.from(ownerSum, (v) => (done > 0 ? v / done : 0)),
      timeMs: Date.now() - t0,
    }
  }

  benchmark(size: BoardSize, playouts: number): { playoutsPerSecond: number; timeMs: number } {
    const board = new PlayoutBoard(size)
    const rng = mulberry32(12345)
    const infoA: PlaceInfo = { ok: false, pos: -1, captured: [], atariLibs: [] }
    const infoB: PlaceInfo = { ok: false, pos: -1, captured: [], atariLibs: [] }
    const ownerBuf = new Int8Array(board.n)
    const t0 = Date.now()
    for (let i = 0; i < playouts; i++) {
      const b = board.copy()
      b.playout(rng, BLACK, infoA, infoB, ownerBuf)
    }
    const timeMs = Math.max(1, Date.now() - t0)
    return { playoutsPerSecond: (playouts / timeMs) * 1000, timeMs }
  }

  private turnOf(pos: GamePosition): Player {
    const normal = pos.moves.length - pos.handicapStones
    const even = normal % 2 === 0
    if (pos.handicapStones > 0) return even ? WHITE : BLACK
    return even ? BLACK : WHITE
  }

  private pickMove(children: RootChild[], pickMode: EngineSettings['pickMode'], rng: () => number): number {
    if (children.length === 0) return -1
    const best = children[0]
    if (pickMode === 'best' || best.visits <= 2) return best.move
    const fraction = pickMode === 'narrow' ? 0.6 : 0.3
    const pool = children.filter((c) => c.visits >= best.visits * fraction && c.winrate > 0.08)
    if (pool.length === 0) return best.move
    let total = 0
    for (const c of pool) total += c.visits
    let pick = rng() * total
    for (const c of pool) {
      pick -= c.visits
      if (pick <= 0) return c.move
    }
    return best.move
  }
}
