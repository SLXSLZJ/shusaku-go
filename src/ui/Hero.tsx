import { motion } from 'motion/react'
import { useEffect, useRef, useState } from 'react'

/**
 * 首屏 Hero：光与佐为视频背景 + 「SAI之棋」标题。
 * 滚动耦合：视频轻微视差下沉、内容渐隐（scroll-driven，降级 JS）。
 */
export function Hero() {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const heroRef = useRef<HTMLDivElement | null>(null)
  const [isMobile, setIsMobile] = useState(false)

  // 移动端换低码率视频
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 860px)')
    const update = (): void => setIsMobile(mq.matches)
    update()
    mq.addEventListener('change', update)
    return () => mq.removeEventListener('change', update)
  }, [])

  // 滚动渐变：现代浏览器用 CSS scroll timeline（见 styles.css）；
  // 不支持时用 JS 同步 scroll 位置驱动视差与渐隐
  useEffect(() => {
    if (typeof CSS !== 'undefined' && 'animationTimeline' in document.documentElement.style) return
    const onScroll = (): void => {
      const hero = heroRef.current
      const video = videoRef.current
      if (!hero || !video) return
      const vh = window.innerHeight
      const p = Math.min(1, Math.max(0, window.scrollY / vh))
      video.style.transform = `translateY(${p * 12}%) scale(${1 + p * 0.04})`
      hero.style.setProperty('--hero-fade', String(1 - p * 1.4))
    }
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  return (
    <header className="hero" ref={heroRef} data-testid="hero">
      <div className="hero-media" aria-hidden>
        <video
          ref={videoRef}
          className="hero-video"
          src={isMobile ? '/assets/hero-mobile.mp4' : '/assets/hero-desktop.mp4'}
          poster="/assets/hero-poster.jpg"
          autoPlay
          muted
          loop
          playsInline
        />
        <div className="hero-vignette" />
      </div>
      <div className="hero-content">
        <motion.h1
          className="hero-title"
          initial={{ opacity: 0, y: 24, letterSpacing: '0.6em' }}
          animate={{ opacity: 1, y: 0, letterSpacing: '0.22em' }}
          transition={{ duration: 1.6, ease: [0.22, 1, 0.36, 1] }}
        >
          SAI之棋
        </motion.h1>
        <motion.p
          className="hero-sub"
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 1.2, delay: 0.7, ease: 'easeOut' }}
        >
          棋魂 · 本因坊秀策的 AI 对弈
        </motion.p>
        <motion.button
          type="button"
          className="hero-cta"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 1, delay: 1.4 }}
          onClick={() => {
            document.querySelector('.game-section')?.scrollIntoView({ behavior: 'smooth' })
          }}
        >
          开始对局
        </motion.button>
      </div>
      <motion.div
        className="hero-scroll-hint"
        aria-hidden
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 2.2, duration: 1 }}
      >
        <span className="hero-scroll-arrow">▾</span>
      </motion.div>
    </header>
  )
}
