/** 背景音乐曲目清单与角色分工。 */

export type TrackRole = 'initial' | 'normal' | 'behind' | 'ahead' | 'serious' | 'menu'

export interface Track {
  id: string
  title: string
  file: string
  role: TrackRole
}

export const TRACKS: Track[] = [
  { id: 'wangchuan-calm', title: '忘川彼岸（舒缓）', file: 'wangchuan-calm.m4a', role: 'initial' },
  { id: 'mezame', title: '目覚め', file: 'mezame.m4a', role: 'normal' },
  { id: 'kawaru-michi', title: '交わる道', file: 'kawaru-michi.m4a', role: 'normal' },
  { id: 'mae-wo-muite', title: '前を向いて', file: 'mae-wo-muite.m4a', role: 'behind' },
  { id: 'shukuteki', title: '宿敵', file: 'shukuteki.m4a', role: 'ahead' },
  { id: 'tomo', title: '友', file: 'tomo.m4a', role: 'serious' },
  { id: 'wangchuan', title: '忘川彼岸', file: 'wangchuan.m4a', role: 'menu' },
  { id: 'get-over', title: 'Get Over - Dream', file: 'get-over.m4a', role: 'menu' },
  { id: 'ill-be-the-one', title: "I'll be the one - HΛL", file: 'ill-be-the-one.m4a', role: 'menu' },
  { id: 'bokura-kids', title: 'ボクらの冒険 - Kids Alive', file: 'bokura-kids.m4a', role: 'menu' },
]

export function trackById(id: string): Track | undefined {
  return TRACKS.find((t) => t.id === id)
}

export function trackUrl(t: Track): string {
  return `/music/${t.file}`
}

/** 自动模式的默认初始曲目（页面打开、未开始对局时）。 */
export const INITIAL_TRACK_ID = 'wangchuan-calm'
/** 认真及以上难度的整局曲目。 */
export const SERIOUS_TRACK_ID = 'tomo'
/** 劣势（胜率持续 <10%）曲目。 */
export const BEHIND_TRACK_ID = 'mae-wo-muite'
/** 优势（胜率持续 >70%）曲目。 */
export const AHEAD_TRACK_ID = 'shukuteki'
/** 普通状态下交替循环的两首。 */
export const NORMAL_TRACK_IDS = ['mezame', 'kawaru-michi'] as const
