import { useEffect, useRef } from 'react'

interface Petal {
  x: number
  y: number
  size: number
  vy: number
  vx: number
  rot: number
  vr: number
  kind: 'sakura' | 'dust'
  alpha: number
}

/**
 * 全站氛围粒子：樱瓣（上/暖侧偏粉）与光尘（冷侧微光）缓缓飘落。
 * 数量随设备自适应；prefers-reduced-motion 时完全不启动。
 * fixed 定位铺满视口、pointer-events:none，不与界面抢事件。
 */
export function AmbientParticles() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const mobile = window.matchMedia('(max-width: 860px)').matches
    const count = mobile ? 14 : 36
    let w = 0
    let h = 0
    let raf = 0
    const dpr = Math.min(window.devicePixelRatio || 1, 2)

    const resize = (): void => {
      w = window.innerWidth
      h = window.innerHeight
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    resize()

    const spawn = (anywhere: boolean): Petal => {
      const kind: Petal['kind'] = Math.random() < 0.55 ? 'sakura' : 'dust'
      return {
        x: Math.random() * w,
        y: anywhere ? Math.random() * h : -12,
        size: kind === 'sakura' ? 2.5 + Math.random() * 3.5 : 0.8 + Math.random() * 1.6,
        vy: kind === 'sakura' ? 12 + Math.random() * 18 : 4 + Math.random() * 8,
        vx: kind === 'sakura' ? (Math.random() - 0.5) * 14 : (Math.random() - 0.5) * 6,
        rot: Math.random() * Math.PI * 2,
        vr: (Math.random() - 0.5) * 1.6,
        kind,
        alpha: kind === 'sakura' ? 0.35 + Math.random() * 0.35 : 0.15 + Math.random() * 0.3,
      }
    }

    const petals: Petal[] = Array.from({ length: count }, () => spawn(true))

    let last = performance.now()
    const tick = (now: number): void => {
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      ctx.clearRect(0, 0, w, h)
      for (const p of petals) {
        p.x += p.vx * dt
        p.y += p.vy * dt
        p.rot += p.vr * dt
        if (p.y > h + 14 || p.x < -14 || p.x > w + 14) Object.assign(p, spawn(false))
        ctx.save()
        ctx.globalAlpha = p.alpha
        if (p.kind === 'sakura') {
          ctx.translate(p.x, p.y)
          ctx.rotate(p.rot)
          ctx.fillStyle = '#f6b8c8'
          ctx.beginPath()
          ctx.ellipse(0, 0, p.size, p.size * 0.55, 0, 0, Math.PI * 2)
          ctx.fill()
        } else {
          ctx.fillStyle = '#d9e6ff'
          ctx.beginPath()
          ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2)
          ctx.fill()
        }
        ctx.restore()
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    window.addEventListener('resize', resize)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', resize)
    }
  }, [])

  return <canvas ref={canvasRef} className="ambient-particles" aria-hidden />
}
