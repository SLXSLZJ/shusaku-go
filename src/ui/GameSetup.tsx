import { AnimatePresence, motion } from 'motion/react'
import type { BoardSize, Rules } from '../core/types'
import { STRENGTH_LEVELS } from '../engine/strength'

export type AiSide = 'black' | 'white' | 'none'
export type AiStyle = 'shusaku' | 'modern'

export interface GameConfig {
  size: BoardSize
  rules: Rules
  komi: number
  handicap: number
  aiSide: AiSide
  /** 认真程度 1–10 */
  strength: number
  /** 棋风：秀策流（幕末职业人味）或现代最强 */
  aiStyle: AiStyle
}

export const DEFAULT_CONFIG: GameConfig = {
  size: 9,
  rules: 'chinese',
  komi: 6.5,
  handicap: 0,
  aiSide: 'black',
  strength: 5,
  aiStyle: 'shusaku',
}

/** 各棋盘尺寸的默认贴目：9/13 路沿用 7.5 会严重偏白（引擎实测黑胜率个位数） */
const DEFAULT_KOMI: Record<BoardSize, Record<Rules, number>> = {
  9: { chinese: 6.5, japanese: 6.5 },
  13: { chinese: 6.5, japanese: 6.5 },
  19: { chinese: 7.5, japanese: 6.5 },
}

function defaultKomiFor(size: BoardSize, rules: Rules): number {
  return DEFAULT_KOMI[size][rules]
}

const SIZES: { value: BoardSize; label: string }[] = [
  { value: 9, label: '九路' },
  { value: 13, label: '十三路' },
  { value: 19, label: '十九路' },
]

interface GameSetupProps {
  config: GameConfig
  disabled: boolean
  /** 面板展开状态（开局折叠、终局展开由外部控制） */
  open: boolean
  onToggle: () => void
  benchText: string | null
  onChange: (patch: Partial<GameConfig>) => void
  onStart: () => void
  onBenchmark: () => void
}

function btnCls(active: boolean): string {
  return active ? 'btn btn-sm active' : 'btn btn-sm'
}

export function GameSetup({ config, disabled, open, onToggle, benchText, onChange, onStart, onBenchmark }: GameSetupProps) {
  const setRules = (rules: Rules): void =>
    onChange({ rules, komi: config.handicap > 0 ? 0.5 : defaultKomiFor(config.size, rules) })

  const setSize = (size: BoardSize): void =>
    onChange({ size, komi: config.handicap > 0 ? 0.5 : defaultKomiFor(size, config.rules) })

  const setHandicap = (h: number): void =>
    onChange({
      handicap: h,
      komi: h > 0 ? 0.5 : defaultKomiFor(config.size, config.rules),
      // 让先/让子时白方为 AI；分先默认 AI 执黑先行
      aiSide: h > 0 ? 'white' : 'black',
    })

  return (
    <section className="panel setup-panel">
      <button
        type="button"
        className="panel-toggle"
        onClick={onToggle}
        aria-expanded={open}
      >
        <span className="panel-title">对 局 设 置</span>
        <span className="tiny dim">{open ? '收起 ▾' : '展开 ▸'}</span>
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            className="setup-body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.4, 0, 0.2, 1] }}
            style={{ overflow: 'hidden' }}
          >
          <div className="setup-row">
            <span className="setup-label">棋盘</span>
            {SIZES.map((s) => (
              <button
                key={s.value}
                type="button"
                className={btnCls(config.size === s.value)}
                disabled={disabled}
                onClick={() => setSize(s.value)}
              >
                {s.label}
              </button>
            ))}
          </div>

          <div className="setup-row">
            <span className="setup-label">规则</span>
            <button
              type="button"
              className={btnCls(config.rules === 'chinese')}
              disabled={disabled}
              onClick={() => setRules('chinese')}
            >
              中国规则
            </button>
            <button
              type="button"
              className={btnCls(config.rules === 'japanese')}
              disabled={disabled}
              onClick={() => setRules('japanese')}
            >
              日本规则
            </button>
            <input
              className="num-input"
              type="number"
              step={0.5}
              min={0}
              max={30}
              value={config.komi}
              disabled={config.handicap > 0 || disabled}
              onChange={(e) => {
                const v = Number(e.target.value)
                if (!Number.isNaN(v) && v >= 0) onChange({ komi: v })
              }}
            />
          </div>

          <div className="setup-row">
            <span className="setup-label">让子</span>
            {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((h) => (
              <button
                key={h}
                type="button"
                className={btnCls(config.handicap === h)}
                disabled={disabled}
                onClick={() => setHandicap(h)}
              >
                {h === 0 ? '无' : h === 1 ? '让先' : h}
              </button>
            ))}
          </div>

          <div className="setup-row">
            <span className="setup-label">先手</span>
            <button
              type="button"
              className={btnCls(config.aiSide === 'white')}
              disabled={disabled}
              onClick={() => onChange({ aiSide: 'white' })}
            >
              AI 执白
            </button>
            <button
              type="button"
              className={btnCls(config.aiSide === 'black')}
              disabled={disabled || config.handicap > 0}
              title={config.handicap > 0 ? '让先/让子对局中 AI 执白' : undefined}
              onClick={() => onChange({ aiSide: 'black' })}
            >
              AI 执黑
            </button>
            <button
              type="button"
              className={btnCls(config.aiSide === 'none')}
              disabled={disabled}
              onClick={() => onChange({ aiSide: 'none' })}
            >
              双人
            </button>
          </div>

          <div className="setup-row">
            <span className="setup-label">模式</span>
            <button
              type="button"
              className={btnCls(config.aiStyle === 'shusaku')}
              disabled={disabled}
              onClick={() => onChange({ aiStyle: 'shusaku' })}
            >
              秀策流
            </button>
            <button
              type="button"
              className={btnCls(config.aiStyle === 'modern')}
              disabled={disabled}
              onClick={() => onChange({ aiStyle: 'modern' })}
            >
              现代最强
            </button>
          </div>

          <div className="setup-row">
            <span className="setup-label">认真</span>
            <input
              className="range"
              type="range"
              min={1}
              max={10}
              step={1}
              value={config.strength}
              disabled={disabled}
              onChange={(e) => onChange({ strength: Number(e.target.value) })}
            />
            <span className="tiny dim">{STRENGTH_LEVELS[config.strength - 1]?.label ?? ''}</span>
          </div>

          <div className="btn-row">
            <button type="button" className="btn" disabled={disabled} onClick={onStart}>
              开始新局
            </button>
            <button type="button" className="btn" disabled={disabled} onClick={onBenchmark}>
              测速
            </button>
          </div>
          {benchText && <div className="tiny dim">{benchText}</div>}
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  )
}
