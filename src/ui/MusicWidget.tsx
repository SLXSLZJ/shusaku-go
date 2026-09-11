import { useEffect, useRef, useState } from 'react'
import { musicPlayer } from '../music/musicPlayer'
import {
  AHEAD_TRACK_ID,
  BEHIND_TRACK_ID,
  INITIAL_TRACK_ID,
  NORMAL_TRACK_IDS,
  SERIOUS_TRACK_ID,
  TRACKS,
  trackById,
} from '../music/tracks'

interface MusicWidgetProps {
  /** 对局是否已经开始（开局前播初始曲） */
  started: boolean
  /** 认真程度 ≥8：整局固定曲目，不分胜率 */
  serious: boolean
  /** 人方视角胜率（0..1），null = 尚无数据 */
  winrate: number | null
}

const WINRATE_HISTORY_MAX = 8
/** 胜率「持续」判定所需的最少样本数 */
const SUSTAINED_SAMPLES = 3

export function MusicWidget({ started, serious, winrate }: MusicWidgetProps) {
  const [mode, setMode] = useState<'off' | 'auto'>('auto')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [playing, setPlaying] = useState(false)
  const [currentId, setCurrentId] = useState<string | null>(null)
  const winrateHistoryRef = useRef<number[]>([])
  const normalFlipRef = useRef(true)
  const modeRef = useRef(mode)
  const selectedRef = useRef(selectedId)
  modeRef.current = mode
  selectedRef.current = selectedId

  // 胜率历史：人方视角，随每手评估更新；开局前清空
  useEffect(() => {
    if (!started) {
      winrateHistoryRef.current = []
      return
    }
    if (winrate === null) return
    const hist = winrateHistoryRef.current
    hist.push(winrate)
    if (hist.length > WINRATE_HISTORY_MAX) hist.shift()
  }, [winrate, started])

  const computeDesired = (next: boolean): { id: string; loop: boolean } | null => {
    if (modeRef.current === 'off') return null
    const manual = selectedRef.current
    if (manual) return { id: manual, loop: true }
    if (!started) return { id: INITIAL_TRACK_ID, loop: true }
    if (serious) return { id: SERIOUS_TRACK_ID, loop: true }
    const last = winrateHistoryRef.current.slice(-SUSTAINED_SAMPLES)
    if (last.length >= SUSTAINED_SAMPLES && last.every((w) => w < 0.1)) {
      return { id: BEHIND_TRACK_ID, loop: true }
    }
    if (last.length >= SUSTAINED_SAMPLES && last.every((w) => w > 0.7)) {
      return { id: AHEAD_TRACK_ID, loop: true }
    }
    if (next) normalFlipRef.current = !normalFlipRef.current
    return { id: NORMAL_TRACK_IDS[normalFlipRef.current ? 1 : 0], loop: false }
  }

  // 状态变化 → 重新应用期望曲目
  useEffect(() => {
    musicPlayer.apply(computeDesired(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, selectedId, started, serious, winrate])

  // 播放器回调：状态上报 + 非循环曲目播完自动接续
  useEffect(() => {
    musicPlayer.setListeners(
      (isPlaying, trackId) => {
        setPlaying(isPlaying)
        setCurrentId(trackId)
      },
      () => musicPlayer.apply(computeDesired(true)),
    )
    // 任意首次点击解锁自动播放（浏览器策略）
    const unlock = (): void => musicPlayer.unlock()
    document.addEventListener('pointerdown', unlock, { once: true })
    return () => document.removeEventListener('pointerdown', unlock)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const currentTitle = currentId ? (trackById(currentId)?.title ?? '') : ''
  const modeLabel =
    mode === 'off'
      ? '音乐关'
      : selectedId
        ? `自选 · ${trackById(selectedId)?.title ?? ''}`
        : started
          ? serious
            ? '自动 · 对局（认真）'
            : '自动 · 随局势'
          : '自动 · 初始'

  return (
    <section className="panel music-panel">
      <div className="panel-title">背 景 音 乐</div>
      <div className="music-row">
        <button
          type="button"
          className={`vinyl-disc ${playing ? 'spinning' : ''}`}
          title={playing ? '暂停音乐' : '播放音乐'}
          aria-label={playing ? '暂停音乐' : '播放音乐'}
          onClick={() => {
            if (mode === 'off') setMode('auto')
            musicPlayer.toggle()
          }}
        >
          <span className="vinyl-label">
            <img src="/music/disc-label.jpg" alt="" draggable={false} />
          </span>
          <span className="vinyl-hole" aria-hidden />
        </button>
        <div className="music-meta">
          <div className="music-controls">
            <select
              className="music-select"
              value={selectedId ?? (mode === 'off' ? 'off' : 'auto')}
              onChange={(e) => {
                const v = e.target.value
                if (v === 'off') {
                  setMode('off')
                  setSelectedId(null)
                  musicPlayer.apply(null)
                } else if (v === 'auto') {
                  setSelectedId(null)
                  setMode('auto')
                } else {
                  setSelectedId(v)
                  setMode('auto')
                }
              }}
            >
              <option value="off">关闭音乐</option>
              <option value="auto">默认 · 随局势切换</option>
              {TRACKS.map((t) => (
                <option key={t.id} value={t.id}>
                  单曲循环 · {t.title}
                </option>
              ))}
            </select>
            {selectedId !== null && (
              <button
                type="button"
                className="btn btn-sm music-cancel"
                title="取消单曲选择，切回默认随局势切换"
                onClick={() => setSelectedId(null)}
              >
                取消
              </button>
            )}
          </div>
          <div className="music-now tiny dim">{playing ? `♪ ${currentTitle || modeLabel}` : modeLabel}</div>
        </div>
      </div>
    </section>
  )
}
