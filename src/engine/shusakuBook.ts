/**
 * 秀策开局库查表。
 *
 * 数据由 scripts/build-shusaku-book.mjs 从 data/sgf/shusaku/*.sgf 生成：
 * 树节点按「双方着法的 SGF 坐标路径」组织，每个节点记录该局面下
 * 秀策本人的实际着法计数。路径键如 "qd;pd;qd;pc"（"" 为根）。
 *
 * 数据（约 840KB）按需加载：主包不含开局库，首次查表前先 ensureShusakuBook()。
 */

interface BookNode {
  moves?: Record<string, number>
  [path: string]: unknown
}

let root: BookNode | null = null
let rootPromise: Promise<void> | null = null

/** 按需加载开局库数据（幂等；加载完成前查表一律返回 null）。 */
export function ensureShusakuBook(): Promise<void> {
  if (!rootPromise) {
    rootPromise = import('../data/shusaku-book.json').then((m) => {
      root = (m.default as { root: BookNode }).root
    })
  }
  return rootPromise
}

/** 坐标 → SGF 字母对（我们的 y=0 为上边，与 SGF 一致；pass 以 "pass" 表示）。 */
export function toSgfCoord(x: number, y: number): string {
  if (x < 0 || y < 0) return 'pass'
  return String.fromCharCode(97 + x) + String.fromCharCode(97 + y)
}

export function sgfCoordToXY(coord: string): { x: number; y: number } | null {
  if (coord === 'pass' || coord.length !== 2) return null
  const x = coord.charCodeAt(0) - 97
  const y = coord.charCodeAt(1) - 97
  if (x < 0 || y < 0 || x > 18 || y > 18) return null
  return { x, y }
}

/** 沿着手顺走树；返回当前局面的候选着法计数表（未命中返回 null）。 */
export function bookCandidates(path: Array<{ x: number; y: number }>): Record<string, number> | null {
  let node: BookNode | undefined | null = root
  for (const m of path) {
    node = node?.[toSgfCoord(m.x, m.y)] as BookNode | undefined
    if (!node) return null
  }
  const moves = node?.moves
  return moves && Object.keys(moves).length > 0 ? moves : null
}

/** 按计数加权随机挑一个候选（空表返回 null）。 */
export function weightedBookCandidate(candidates: Record<string, number>, random: () => number = Math.random): string | null {
  let total = 0
  for (const key of Object.keys(candidates)) total += Math.max(0, candidates[key] ?? 0)
  if (!(total > 0)) return null
  let r = random() * total
  for (const key of Object.keys(candidates)) {
    r -= Math.max(0, candidates[key] ?? 0)
    if (r < 0) return key
  }
  return null
}
