/** 落子音效：轻量短音，独立于背景音乐系统。 */

let el: HTMLAudioElement | null = null

export function playStoneSound(): void {
  if (!el) {
    el = new Audio('/assets/stone.mp3')
    el.volume = 0.55
    el.preload = 'auto'
  }
  try {
    el.currentTime = 0
  } catch {
    // 某些浏览器在未加载完成时设置 currentTime 会抛错，忽略即可
  }
  void el.play().catch(() => {})
}
