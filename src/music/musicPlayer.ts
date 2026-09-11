/**
 * 背景音乐播放器：双 <audio> 交叉淡入淡出，切换曲目不生硬。
 *
 * 生命周期：MusicWidget 通过 apply() 下发期望曲目（null = 停止）；
 * 浏览器自动播放策略要求首次 play() 出自用户手势——unlock() 由
 * widget 的任意一次点击调用，解锁前 apply 只暂存期望。
 */

export interface DesiredTrack {
  id: string
  loop: boolean
}

const FADE_MS = 2500
const FADE_STEP_MS = 60

class MusicPlayer {
  private els: [HTMLAudioElement, HTMLAudioElement]
  private activeIdx = 0
  private currentId: string | null = null
  private desired: DesiredTrack | null = null
  private unlocked = false
  private fading: number | null = null
  private paused = false
  private onStateChange: ((playing: boolean, trackId: string | null) => void) | null = null
  private onEnded: (() => void) | null = null

  constructor() {
    const make = (): HTMLAudioElement => {
      const el = new Audio()
      el.preload = 'auto'
      return el
    }
    this.els = [make(), make()]
    this.els.forEach((el) => {
      el.addEventListener('ended', () => {
        if (el !== this.els[this.activeIdx]) return
        this.onEnded?.()
      })
      el.addEventListener('play', () => this.emitState())
      el.addEventListener('pause', () => this.emitState())
    })
  }

  setListeners(onStateChange: (playing: boolean, trackId: string | null) => void, onEnded: () => void): void {
    this.onStateChange = onStateChange
    this.onEnded = onEnded
  }

  /** 首次用户手势后解锁（自动播放策略）。 */
  unlock(): void {
    if (this.unlocked) return
    this.unlocked = true
    this.applyCurrent()
  }

  apply(desired: DesiredTrack | null): void {
    this.desired = desired
    this.applyCurrent()
  }

  /** 播放/暂停切换；返回切换后的播放状态。 */
  toggle(): boolean {
    if (this.paused) {
      this.paused = false
      void this.els[this.activeIdx].play().catch(() => {})
      this.emitState()
      return true
    }
    if (this.els[this.activeIdx].src && !this.els[this.activeIdx].paused) {
      this.paused = true
      this.els[this.activeIdx].pause()
      this.emitState()
      return false
    }
    // 尚无任何曲目：解锁并从期望曲目开始
    this.paused = false
    this.unlock()
    this.emitState()
    return true
  }

  private activeEl(): HTMLAudioElement {
    return this.els[this.activeIdx]
  }

  private applyCurrent(): void {
    if (!this.unlocked) return
    const d = this.desired
    if (!d) {
      this.stopAll()
      return
    }
    if (this.paused) {
      // 暂停状态下换了期望曲目：换源后保持暂停，待用户恢复
      if (d.id !== this.currentId) this.loadInto(this.els[this.activeIdx], d)
      return
    }
    if (d.id === this.currentId) {
      const el = this.activeEl()
      if (el.paused) void el.play().catch(() => {})
      return
    }
    this.crossfadeTo(d)
  }

  private loadInto(el: HTMLAudioElement, d: DesiredTrack): void {
    const track = d.id
    el.src = `/music/${track}`
    el.loop = d.loop
  }

  private crossfadeTo(d: DesiredTrack): void {
    const cur = this.els[this.activeIdx]
    const nextIdx = (this.activeIdx + 1) % 2
    const next = this.els[nextIdx]
    this.loadInto(next, d)
    next.volume = 0
    const startVol = cur.src ? cur.volume : 0
    void next.play().catch(() => {})
    this.startFade(cur, startVol, 0, next, 0, 0.8)
    this.activeIdx = nextIdx
    this.currentId = d.id
    this.emitState()
  }

  private stopAll(): void {
    this.startFade(this.activeEl(), this.activeEl().volume, 0, null, 0, 0)
    this.currentId = null
    this.emitState()
  }

  /** 同步渐变：cur 音量 from→to，next 音量 0→toVol（next 为 null 时只降 cur）。 */
  private startFade(
    cur: HTMLAudioElement,
    from: number,
    to: number,
    next: HTMLAudioElement | null,
    nextFrom: number,
    nextTo: number,
  ): void {
    if (this.fading !== null) {
      clearInterval(this.fading)
      this.fading = null
    }
    const t0 = performance.now()
    this.fading = window.setInterval(() => {
      const k = Math.min(1, (performance.now() - t0) / FADE_MS)
      if (!cur.paused) cur.volume = from + (to - from) * k
      if (next) {
        next.volume = nextFrom + (nextTo - nextFrom) * k
        if (k >= 1 && cur !== next && to <= 0) {
          cur.pause()
          cur.removeAttribute('src')
          cur.src = ''
        }
      }
      if (k >= 1) {
        if (this.fading !== null) clearInterval(this.fading)
        this.fading = null
      }
    }, FADE_STEP_MS)
  }

  private emitState(): void {
    const el = this.activeEl()
    this.onStateChange?.(!el.paused && !!el.src, this.currentId)
  }
}

export const musicPlayer = new MusicPlayer()
