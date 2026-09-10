import { useCallback, useEffect, useRef, useState } from 'react'
import type { BoardSize, Player } from '../core/types'
import { boardMetrics, drawBoard } from '../render/boardRenderer'

interface BoardCanvasProps {
  boardSize: BoardSize
  stones: Uint8Array
  lastMove: { x: number; y: number } | null
  turn: Player
  interactive: boolean
  /** 终局数子时判死的棋子（"x,y" 集合），半透明显示 */
  deadKeys?: Set<string>
  /** 形势判断：ownership 势力图（+黑 -白），非空时在空点画势力小方块 */
  territory?: number[] | null
  onPlay: (x: number, y: number) => void
}

interface HoverPoint {
  x: number
  y: number
}

export function BoardCanvas({ boardSize, stones, lastMove, turn, interactive, deadKeys, territory, onPlay }: BoardCanvasProps) {
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [cssSize, setCssSize] = useState(0)
  const [hover, setHover] = useState<HoverPoint | null>(null)
  const [pulse, setPulse] = useState(0)
  const lastMoveKey = lastMove ? `${lastMove.x},${lastMove.y}` : ''

  // 落子涟漪：最后一手的光圈扩散动画（尊重系统减动效设置）
  useEffect(() => {
    if (!lastMove) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    let raf = 0
    const start = performance.now()
    const tick = () => {
      const t = Math.min(1, (performance.now() - start) / 500)
      setPulse(1 - t)
      if (t < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [lastMoveKey])

  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap) return
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0
      setCssSize(w)
    })
    ro.observe(wrap)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || cssSize <= 0) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5)
    canvas.width = Math.round(cssSize * dpr)
    canvas.height = Math.round(cssSize * dpr)
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    drawBoard({
      ctx,
      boardSize,
      stones,
      lastMove,
      hover: interactive && !deadKeys && hover ? { x: hover.x, y: hover.y, stone: turn } : null,
      deadKeys,
      territory,
      pulse,
      cssSize,
      dpr,
      withCoordinates: true,
    })
  }, [boardSize, stones, lastMove, hover, cssSize, turn, interactive, deadKeys, territory, pulse])

  const pointFromEvent = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>): HoverPoint | null => {
      const canvas = canvasRef.current
      if (!canvas) return null
      const rect = canvas.getBoundingClientRect()
      const { margin, cell } = boardMetrics(rect.width, boardSize, true)
      const x = Math.round((e.clientX - rect.left - margin) / cell)
      const y = Math.round((e.clientY - rect.top - margin) / cell)
      if (x < 0 || y < 0 || x >= boardSize || y >= boardSize) return null
      return { x, y }
    },
    [boardSize],
  )

  return (
    <div className="board-wrap" ref={wrapRef}>
      <canvas
        ref={canvasRef}
        className="board-canvas"
        onMouseMove={(e) => {
          if (!interactive) return
          const pt = pointFromEvent(e)
          setHover((prev) => (prev?.x === pt?.x && prev?.y === pt?.y ? prev : pt))
        }}
        onMouseLeave={() => setHover(null)}
        onClick={(e) => {
          if (!interactive) return
          const pt = pointFromEvent(e)
          if (pt) onPlay(pt.x, pt.y)
        }}
      />
    </div>
  )
}
