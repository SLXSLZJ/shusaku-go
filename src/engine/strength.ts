import type { EngineSettings } from './protocol'

export interface StrengthLevel {
  label: string
  visits: number
  maxTimeMs: number
  pickMode: EngineSettings['pickMode']
}

/** 认真程度 1–10 档：低档在近似候选中抽签（会下出人味的缓手），高档永远最强手。 */
export const STRENGTH_LEVELS: StrengthLevel[] = [
  { label: '入门', visits: 60, maxTimeMs: 1500, pickMode: 'wide' },
  { label: '初学', visits: 120, maxTimeMs: 2000, pickMode: 'wide' },
  { label: '业余低段', visits: 250, maxTimeMs: 3000, pickMode: 'wide' },
  { label: '业余', visits: 500, maxTimeMs: 5000, pickMode: 'narrow' },
  { label: '业余中段', visits: 1000, maxTimeMs: 8000, pickMode: 'narrow' },
  { label: '业余高段', visits: 2000, maxTimeMs: 12000, pickMode: 'narrow' },
  { label: '强业余', visits: 4000, maxTimeMs: 20000, pickMode: 'best' },
  { label: '认真', visits: 8000, maxTimeMs: 30000, pickMode: 'best' },
  { label: '非常认真', visits: 16000, maxTimeMs: 45000, pickMode: 'best' },
  { label: '全力', visits: 32000, maxTimeMs: 90000, pickMode: 'best' },
]

export function strengthLevel(level: number): StrengthLevel {
  const i = Math.max(1, Math.min(STRENGTH_LEVELS.length, Math.round(level)))
  return STRENGTH_LEVELS[i - 1]
}
