import { BLACK, WHITE, type BoardSize, type Player } from '../core/types'
import { GoGame } from '../core/game'

/**
 * 落子解说：为最后一手生成「坐标 + 作用」的简练描述（如「十六之四，断」）。
 * 纯规则判定，不依赖具体引擎。
 */

const CN = [
  '一', '二', '三', '四', '五', '六', '七', '八', '九', '十',
  '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八', '十九',
]

const ORTH: ReadonlyArray<readonly [number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1]]

/** 星位/天元（0 基坐标），用于开局点命名 */
const NAMED: Record<number, Record<string, string>> = {
  9: { '2-2': '星位', '6-2': '星位', '2-6': '星位', '6-6': '星位', '4-4': '天元' },
  13: {
    '3-3': '星位', '9-3': '星位', '3-9': '星位', '9-9': '星位',
    '6-3': '星位', '3-6': '星位', '9-6': '星位', '6-9': '星位', '6-6': '天元',
  },
  19: {
    '3-3': '星位', '15-3': '星位', '3-15': '星位', '15-15': '星位',
    '9-3': '星位', '3-9': '星位', '9-15': '星位', '15-9': '星位', '9-9': '天元',
    '2-2': '三三', '16-2': '三三', '2-16': '三三', '16-16': '三三',
  },
}

export interface MoveLite {
  player: Player
  x: number
  y: number
}

interface GroupInfo {
  stones: number[]
  libs: number
  libPos: number
}

function floodGroup(
  stoneAt: (x: number, y: number) => number,
  size: number,
  sx: number,
  sy: number,
): GroupInfo {
  const color = stoneAt(sx, sy)
  const seen = new Set<number>([sy * size + sx])
  const stack = [sy * size + sx]
  const libs = new Set<number>()
  const stones: number[] = []
  while (stack.length > 0) {
    const cur = stack.pop()!
    const cx = cur % size
    const cy = Math.floor(cur / size)
    stones.push(cur)
    for (const [dx, dy] of ORTH) {
      const nx = cx + dx
      const ny = cy + dy
      if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue
      const j = ny * size + nx
      const s = stoneAt(nx, ny)
      if (s === 0) libs.add(j)
      else if (s === color && !seen.has(j)) {
        seen.add(j)
        stack.push(j)
      }
    }
  }
  return { stones, libs: libs.size, libPos: libs.size > 0 ? [...libs][0] : -1 }
}

function cnVertex(x: number, y: number, size: number): string {
  return `${CN[x]}之${CN[size - y - 1]}`
}

/**
 * 描述 moves 中的最后一手。返回如「白 十六之四，断」；无着可述时返回坐标，
 * 空手列表返回 null。
 */
export interface MoveAnnounce {
  who: '黑' | '白'
  point: string
  reason: string
}

export function describeLastMoveParts(
  size: number,
  moves: MoveLite[],
  handicapStones: number,
): MoveAnnounce | null {
  if (moves.length === 0) return null
  const last = moves[moves.length - 1]
  const who: '黑' | '白' = last.player === BLACK ? '黑' : '白'
  if (last.x === -1) return { who, point: '虚着', reason: '' }

  // 重建「落子前」局面
  const game = new GoGame(size as BoardSize, { superko: false })
  const at = (x: number, y: number): number => game.stoneAt(x, y)
  moves.slice(0, -1).forEach((m, i) => {
    if (i < handicapStones) game.forcePlace(m.x, m.y, m.player)
    else if (m.x === -1) game.pass()
    else game.play(m.x, m.y)
  })

  // 落子前分析：相邻己方/敌方棋组
  const ownAdj = new Set<number>() // 己方邻组代表点
  const enemyAdj = new Set<number>() // 敌方邻组代表点
  const preOwnAtari = new Set<number>() // 落子前已处于叫吃的己方邻组
  const seen = new Set<number>()
  const ownStones: number[] = []
  for (let i = 0; i < size * size; i++) {
    if (at(i % size, Math.floor(i / size)) === last.player) ownStones.push(i)
  }
  for (const [dx, dy] of ORTH) {
    const nx = last.x + dx
    const ny = last.y + dy
    if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue
    const j = ny * size + nx
    const s = at(nx, ny)
    if (s === 0 || seen.has(j)) continue
    const g = floodGroup(at, size, nx, ny)
    for (const st of g.stones) seen.add(st)
    const key = Math.min(...g.stones)
    if (s === last.player) {
      ownAdj.add(key)
      if (g.libs === 1) preOwnAtari.add(key)
    } else {
      enemyAdj.add(key)
    }
  }

  // 落子
  const res = game.play(last.x, last.y)
  if (!res.ok) return { who, point: cnVertex(last.x, last.y, size), reason: '' }

  // 落子后分析
  const own = floodGroup(at, size, last.x, last.y)
  const enemy: Player = last.player === BLACK ? WHITE : BLACK
  let atariAfter = false
  for (const [dx, dy] of ORTH) {
    const nx = last.x + dx
    const ny = last.y + dy
    if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue
    if (at(nx, ny) !== enemy) continue
    if (floodGroup(at, size, nx, ny).libs === 1) atariAfter = true
  }

  // 作用判定（按优先级取第一个命中）
  // 顺序：提 → 打 → 扳 → 粘 → 接 → 长 → 断 → 几何（尖/跳/飞/拆）
  let reason = ''
  if (res.captured.length > 0) {
    reason = res.captured.length > 1 ? `提${res.captured.length}子` : '提'
  } else if (atariAfter) {
    reason = '打'
  } else {
    // 扳：落点两侧共线地「己方一侧、敌方一侧」——挡住对方往此方向的头
    let ban = false
    const orthAt = (x: number, y: number): number => {
      if (x < 0 || y < 0 || x >= size || y >= size) return -1
      return at(x, y)
    }
    const px = last.x
    const py = last.y
    const pairs: Array<[readonly [number, number], readonly [number, number]]> = [
      [[1, 0], [-1, 0]],
      [[0, 1], [0, -1]],
    ]
    for (const [d1, d2] of pairs) {
      const ca = orthAt(px + d1[0], py + d1[1])
      const cb = orthAt(px + d2[0], py + d2[1])
      const enemy = last.player === BLACK ? WHITE : BLACK
      if ((ca === last.player && cb === enemy) || (ca === enemy && cb === last.player)) {
        ban = true
        break
      }
    }
    if (ban) {
      reason = '扳'
    } else if (enemyAdj.size >= 1 && ownAdj.size >= 1) {
      // 粘：贴着对方棋子把己方棋连接回去
      reason = '粘'
    } else if (ownAdj.size >= 2) {
      reason = '接'
    } else if (preOwnAtari.size > 0 && own.libs >= 2) {
      reason = '长'
    } else if (enemyAdj.size >= 2) {
      reason = '断'
    }
  }

  // 点名（开局阶段、孤立着点）
  const totalStones = moves.filter((m) => m.x !== -1).length
  let point = cnVertex(last.x, last.y, size)
  if (reason === '' && totalStones <= 10) {
    const named = NAMED[size]?.[`${last.x}-${last.y}`]
    if (named) point = named
    else if (ownStones.length > 0) {
      // 与最近己子的几何关系（尖 / 飞 / 跳 / 拆）
      let bd = 99
      let bx = 0
      let by = 0
      for (const idx of ownStones) {
        const sx = idx % size
        const sy = Math.floor(idx / size)
        const dx = sx - last.x
        const dy = sy - last.y
        const d = Math.max(Math.abs(dx), Math.abs(dy))
        if (d < bd) {
          bd = d
          bx = dx
          by = dy
        }
      }
      const ax = Math.abs(bx)
      const ay = Math.abs(by)
      if (bd === 1 && ax === 1 && ay === 1) reason = '尖'
      else if (bd === 2 && ((ax === 2 && ay === 0) || (ax === 0 && ay === 2))) {
        // 二间直线：沿边线为拆二（横向拆看行号、纵向拆看列号），中腹为跳
        const onLine = (v: number): boolean => v === 2 || v === 3 || v === size - 3 || v === size - 4
        const nearSide = (ax === 2 && onLine(last.y)) || (ay === 2 && onLine(last.x))
        reason = nearSide ? '拆二' : '跳'
      } else if (bd === 2 && ax === 1 && ay === 1) reason = '小飞'
      else if (bd === 3 && ((ax === 3 && ay === 0) || (ax === 0 && ay === 3))) reason = '拆三'
      else if (bd === 3 && ax === 2 && ay === 1) reason = '大飞'
    }
  }

  return { who, point, reason }
}

/** 字符串版（拼接格式：「白 十六之四，断」） */
export function describeLastMove(
  size: number,
  moves: MoveLite[],
  handicapStones: number,
): string | null {
  const p = describeLastMoveParts(size, moves, handicapStones)
  if (!p) return null
  return `${p.who} ${p.point}${p.reason ? '，' + p.reason : ''}`
}
