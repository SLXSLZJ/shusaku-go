import type { EngineMove } from './protocol'
import type { BoardSize } from '../core/types'

const GTP_LETTERS = 'ABCDEFGHJKLMNOPQRST'

/** 把引擎着点（GTP 顶点，如 "Q16"、"pass"、"resign"）转换为内部着法 */
export function parseVertex(raw: string, size: BoardSize): EngineMove {
  const lower = raw.toLowerCase()
  if (lower === 'pass') return { kind: 'pass' }
  if (lower === 'resign') return { kind: 'resign' }
  const letter = raw.trim().charAt(0).toUpperCase()
  const x = GTP_LETTERS.indexOf(letter)
  const row = Number.parseInt(raw.trim().slice(1), 10)
  if (x < 0 || Number.isNaN(row)) return { kind: 'pass' }
  const y = size - row
  if (y < 0 || y >= size) return { kind: 'pass' }
  return { kind: 'place', x, y }
}
