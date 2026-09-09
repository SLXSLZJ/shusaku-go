import type { BoardSize, Stone } from '../core/types'

const WOOD_LIGHT = '#e6bd72'
const WOOD_DARK = '#c69a4f'
const LINE = '#54401f'
const STAR = '#3c2d13'
const COORD = '#7a5f33'

const HOSHI: Record<BoardSize, [number, number][]> = {
  9: [
    [2, 2],
    [6, 2],
    [2, 6],
    [6, 6],
    [4, 4],
  ],
  13: [
    [3, 3],
    [9, 3],
    [3, 9],
    [9, 9],
    [6, 6],
  ],
  19: [
    [3, 3],
    [9, 3],
    [15, 3],
    [3, 9],
    [9, 9],
    [15, 9],
    [3, 15],
    [9, 15],
    [15, 15],
  ],
}

/** SGF / 西式坐标列名（跳过 I）。 */
export const COLUMN_LETTERS = 'ABCDEFGHJKLMNOPQRST'

export interface BoardMetrics {
  margin: number
  cell: number
}

export function boardMetrics(cssSize: number, boardSize: BoardSize, withCoords: boolean): BoardMetrics {
  const coordPad = withCoords ? cssSize * 0.042 : 0
  const margin = cssSize * 0.036 + coordPad
  return { margin, cell: (cssSize - margin * 2) / (boardSize - 1) }
}

export interface DrawParams {
  ctx: CanvasRenderingContext2D
  boardSize: BoardSize
  stones: Uint8Array
  lastMove: { x: number; y: number } | null
  hover: { x: number; y: number; stone: Stone } | null
  /** 判死棋子（"x,y"），半透明绘制 */
  deadKeys?: Set<string>
  /** 落子涟漪强度 0..1（1 = 刚落子），用于最后一手的光圈动画 */
  pulse?: number
  cssSize: number
  dpr: number
  withCoordinates: boolean
}

export function drawBoard(p: DrawParams): void {
  const { ctx, boardSize, stones, cssSize, dpr } = p
  ctx.save()
  ctx.scale(dpr, dpr)

  // 榧木底色
  const grad = ctx.createLinearGradient(0, 0, cssSize, cssSize)
  grad.addColorStop(0, WOOD_LIGHT)
  grad.addColorStop(1, WOOD_DARK)
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, cssSize, cssSize)

  // 木纹：固定种子的伪随机，保证重绘稳定不闪
  let seed = 20260906
  const rnd = (): number => {
    seed = (seed * 48271) % 2147483647
    return seed / 2147483647
  }
  ctx.strokeStyle = 'rgba(122, 84, 30, 0.14)'
  for (let i = 0; i < 64; i++) {
    const y0 = rnd() * cssSize
    ctx.lineWidth = 0.5 + rnd() * 1.6
    ctx.beginPath()
    ctx.moveTo(-12, y0)
    ctx.bezierCurveTo(
      cssSize * 0.33,
      y0 + (rnd() - 0.5) * cssSize * 0.03,
      cssSize * 0.66,
      y0 + (rnd() - 0.5) * cssSize * 0.03,
      cssSize + 12,
      y0 + (rnd() - 0.5) * cssSize * 0.02,
    )
    ctx.stroke()
  }

  const { margin, cell } = boardMetrics(cssSize, boardSize, p.withCoordinates)
  const gx = (x: number): number => margin + x * cell
  const gy = (y: number): number => margin + y * cell

  // 网格
  ctx.strokeStyle = LINE
  ctx.lineWidth = Math.max(0.8, cssSize * 0.0012)
  ctx.beginPath()
  for (let i = 0; i < boardSize; i++) {
    ctx.moveTo(gx(i), gy(0))
    ctx.lineTo(gx(i), gy(boardSize - 1))
    ctx.moveTo(gx(0), gy(i))
    ctx.lineTo(gx(boardSize - 1), gy(i))
  }
  ctx.stroke()
  ctx.lineWidth = Math.max(1.4, cssSize * 0.0022)
  ctx.strokeRect(gx(0), gy(0), cell * (boardSize - 1), cell * (boardSize - 1))

  // 星位
  ctx.fillStyle = STAR
  const starR = Math.max(1.6, cell * 0.085)
  for (const [sx, sy] of HOSHI[boardSize]) {
    ctx.beginPath()
    ctx.arc(gx(sx), gy(sy), starR, 0, Math.PI * 2)
    ctx.fill()
  }

  // 坐标
  if (p.withCoordinates) {
    ctx.fillStyle = COORD
    ctx.font = `${Math.max(9, cssSize * 0.016)}px "Noto Serif SC", serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    for (let i = 0; i < boardSize; i++) {
      ctx.fillText(COLUMN_LETTERS[i], gx(i), margin * 0.42)
      ctx.fillText(String(boardSize - i), margin * 0.42, gy(i))
    }
  }

  // 棋子
  const r = cell * 0.47
  const drawStone = (x: number, y: number, stone: Stone, alpha = 1): void => {
    const cx = gx(x)
    const cy = gy(y)
    ctx.save()
    ctx.globalAlpha = alpha
    ctx.shadowColor = 'rgba(30, 18, 4, 0.45)'
    ctx.shadowBlur = r * 0.35
    ctx.shadowOffsetY = r * 0.12
    const g2 = ctx.createRadialGradient(cx - r * 0.35, cy - r * 0.4, r * 0.1, cx, cy, r)
    if (stone === 1) {
      g2.addColorStop(0, '#5c5c5c')
      g2.addColorStop(1, '#0c0c0c')
    } else {
      g2.addColorStop(0, '#ffffff')
      g2.addColorStop(1, '#c9c9c2')
    }
    ctx.fillStyle = g2
    ctx.beginPath()
    ctx.arc(cx, cy, r, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
  }

  for (let y = 0; y < boardSize; y++) {
    for (let x = 0; x < boardSize; x++) {
      const s = stones[y * boardSize + x]
      if (s === 0) continue
      const dead = p.deadKeys?.has(`${x},${y}`) ?? false
      drawStone(x, y, s as Stone, dead ? 0.35 : 1)
    }
  }

  // 最后一手标记
  if (p.lastMove) {
    const cx = gx(p.lastMove.x)
    const cy = gy(p.lastMove.y)
    const stone = stones[p.lastMove.y * boardSize + p.lastMove.x]
    ctx.strokeStyle = stone === 1 ? 'rgba(240, 230, 210, 0.9)' : 'rgba(30, 20, 10, 0.75)'
    ctx.lineWidth = Math.max(1.2, cell * 0.055)
    ctx.beginPath()
    ctx.arc(cx, cy, r * 0.45, 0, Math.PI * 2)
    ctx.stroke()
    // 落子涟漪：光圈扩散并淡出
    if (p.pulse !== undefined && p.pulse > 0.02) {
      ctx.save()
      ctx.globalAlpha = p.pulse * 0.55
      ctx.strokeStyle = '#f6ecd9'
      ctx.lineWidth = Math.max(1.5, cell * 0.09)
      ctx.beginPath()
      ctx.arc(cx, cy, r * (1 + 0.9 * (1 - p.pulse)), 0, Math.PI * 2)
      ctx.stroke()
      ctx.restore()
    }
  }

  // 悬停虚子
  if (p.hover) drawStone(p.hover.x, p.hover.y, p.hover.stone, 0.45)

  ctx.restore()
}
