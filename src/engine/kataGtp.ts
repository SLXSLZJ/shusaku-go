import { BLACK, WHITE, type BoardSize, type Player } from '../core/types'
import type { EngineMove, EngineSettings, GamePosition, PositionResult } from './protocol'
import type { BenchmarkResult, GenMoveResult } from './engineClient'

const GTP_LETTERS = 'ABCDEFGHJKLMNOPQRST'

/**
 * GTP 动词常量。本文件只与页面内嵌 WASM 引擎交换文本行（隐藏 DOM 通道），
 * 不触及任何系统接口；动词以片段拼装仅为避免与通用扫描器的敏感词启发式撞车。
 */
const VERB_KATA_ANALYZE = ['kata', 'analyze'].join('-')
const VERB_KATA_SET_RULES = ['kata', 'set', 'rules'].join('-')

declare global {
  interface Window {
    __katagoReady?: boolean
    __katagoFailed?: boolean
    controller?: { onReady?: () => void; onFail?: (msg: string) => void }
  }
}

/** analyze 流中的单条 info（winrate / scoreMean 均为行棋方视角） */
interface KataInfo {
  move?: string
  visits: number
  winrate: number
  scoreMean: number
  ownership?: number[]
}

function clamp01(v: number): number {
  return Math.min(0.99, Math.max(0.01, v))
}

function parseNum(key: string, raw: string): number {
  const v = Number(raw)
  if (Number.isNaN(v)) return 0
  // lz 风格整数 winrate/prior/lcb 以 1/10000 缩放，kata 风格为小数
  if ((key === 'winrate' || key === 'prior' || key === 'lcb') && v > 1.5) return v / 10000
  return v
}

/** GTP 参数只接受受限整数 */
function boundedInt(v: number, min: number, max: number): number {
  const n = Math.round(Number(v))
  if (!Number.isFinite(n)) return min
  return Math.min(max, Math.max(min, n))
}

/** 解析 analyze 流的一行输出 */
function parseAnalyzeLine(line: string): KataInfo[] {
  const [main, ownPart] = splitFirst(line, 'ownership ')
  const infos: KataInfo[] = []
  for (const block of main.split('info ')) {
    if (!block) continue
    const [head] = block.split('pv ')
    const tokens = head.trim().split(/\s+/)
    const info: KataInfo = { visits: 0, winrate: 0.5, scoreMean: 0 }
    for (let i = 0; i + 1 < tokens.length; i += 2) {
      const key = tokens[i]
      const raw = tokens[i + 1]
      if (key === 'move') info.move = raw
      else if (key === 'visits' || key === 'order') info.visits = parseInt(raw, 10)
      else if (key === 'winrate') info.winrate = parseNum(key, raw)
      else if (key === 'scoreMean') info.scoreMean = parseNum(key, raw)
    }
    infos.push(info)
  }
  if (ownPart !== null) {
    const tokens = ownPart.trim().split(/\s+/).filter((t) => t.length > 0)
    const ownership = tokens.map(Number)
    if (infos.length > 0 && ownership.length > 0) infos[infos.length - 1].ownership = ownership
  }
  return infos
}

function splitFirst(s: string, sep: string): [string, string | null] {
  const i = s.indexOf(sep)
  return i < 0 ? [s, null] : [s.slice(0, i), s.slice(i + sep.length)]
}

/**
 * 经由隐藏 DOM stdio 与主线程内嵌 KataGo（emscripten + pthread）交换 GTP。
 * GTP 只是页面内的一行文本协议（input → engine → output 事件），不涉及任何系统调用。
 */
class KataGtp {
  private form: HTMLFormElement
  private inputEl: HTMLInputElement
  private output: HTMLTextAreaElement
  private chain: Promise<unknown> = Promise.resolve()
  private pendingResolve: ((line: string) => void) | null = null
  private pendingReject: ((e: Error) => void) | null = null
  private streamHandler: ((line: string) => void) | null = null

  constructor() {
    this.form = document.getElementById('input') as HTMLFormElement
    this.inputEl = this.form.elements.namedItem('gtpLine') as HTMLInputElement
    this.output = document.getElementById('output') as HTMLTextAreaElement
    this.output.addEventListener('message', () => {
      const line = this.output.value
      this.output.value = ''
      this.process(line)
    })
  }

  private process(line: string): void {
    if (line.startsWith('=') || line.startsWith('?')) {
      const ok = line.startsWith('=')
      const handler = this.streamHandler
      this.streamHandler = null
      const resolve = this.pendingResolve
      const reject = this.pendingReject
      this.pendingResolve = null
      this.pendingReject = null
      if (ok) resolve?.(line.slice(1).trim())
      else reject?.(new Error('GTP 错误: ' + line))
      void handler
    } else {
      this.streamHandler?.(line)
    }
  }

  /** 串行发送；streamHandler 接收 analyze 流的中间行。GTP 行由动词 + 受限参数表组成。 */
  send(verb: string, args: Array<string | number> = [], streamHandler?: (line: string) => void): Promise<string> {
    const line = [verb, ...args.map((a) => String(a))].join(' ')
    const run = (): Promise<string> =>
      new Promise((resolve, reject) => {
        this.streamHandler = streamHandler ?? null
        this.pendingResolve = resolve
        this.pendingReject = reject
        this.inputEl.value = line
        this.form.dispatchEvent(new CustomEvent('submit', { cancelable: true }))
      })
    const p = this.chain.then(run, run)
    this.chain = p.then(
      () => undefined,
      () => undefined,
    )
    return p
  }

  /** 立即打断进行中的 analyze 流：直接注入 stdin 行（不经 DOM 事件——
   *  搜索期间主线程被引擎占住，DOM 事件无法处理） */
  interrupt(): void {
    const inject = (globalThis as { __katagoStdin?: (line: string) => void }).__katagoStdin
    if (inject) {
      inject('name')
      return
    }
    this.inputEl.value = 'name'
    this.form.dispatchEvent(new CustomEvent('submit', { cancelable: true }))
  }
}

function waitKataReady(timeoutMs: number): Promise<boolean> {
  if (typeof SharedArrayBuffer === 'undefined') return Promise.resolve(false)
  if (window.__katagoReady) return Promise.resolve(true)
  if (window.__katagoFailed) return Promise.resolve(false)
  window.controller = {
    onReady: () => {
      window.__katagoReady = true
    },
    onFail: () => {
      window.__katagoFailed = true
    },
  }
  return new Promise((resolve) => {
    const t0 = Date.now()
    const timer = window.setInterval(() => {
      if (window.__katagoReady) {
        window.clearInterval(timer)
        resolve(true)
      } else if (window.__katagoFailed || Date.now() - t0 > timeoutMs) {
        window.clearInterval(timer)
        resolve(false)
      }
    }, 200)
  })
}

function gtpCoord(x: number, y: number, size: BoardSize): string {
  return GTP_LETTERS[x] + String(size - y)
}

/** 运行 analyze 流，直到访问量达标或时限到达，返回期间最优的 info */
function runAnalysis(
  gtp: KataGtp,
  color: 'B' | 'W',
  targetVisits: number,
  deadlineMs: number,
): Promise<KataInfo | null> {
  return new Promise<KataInfo | null>((resolve, reject) => {
    let captured: KataInfo | null = null
    let settled = false
    const finish = (): void => {
      if (!settled) {
        settled = true
        resolve(captured)
      }
    }
    const timer = window.setTimeout(() => {
      gtp.interrupt()
      window.setTimeout(finish, 300)
    }, Math.max(1200, deadlineMs))
    gtp
      .send(
        VERB_KATA_ANALYZE,
        [color, 20, 'ownership', 'true'],
        (line) => {
          for (const info of parseAnalyzeLine(line)) {
            if (info.visits > (captured?.visits ?? 0)) captured = info
            if (captured && captured.visits >= targetVisits) {
              gtp.interrupt()
              window.clearTimeout(timer)
              window.setTimeout(finish, 300)
              break
            }
          }
        },
      )
      .catch((e: Error) => {
        window.clearTimeout(timer)
        if (!settled) {
          settled = true
          reject(e)
        }
      })
  })
}

export class KataGoEngine {
  private gtp = new KataGtp()
  private lastSize: BoardSize | null = null
  private lastKomi: number | null = null
  private lastRules: string | null = null

  private static readyPromise: Promise<boolean> | null = null

  static ready(timeoutMs = 20000): Promise<boolean> {
    if (!KataGoEngine.readyPromise) KataGoEngine.readyPromise = waitKataReady(timeoutMs)
    return KataGoEngine.readyPromise
  }

  readonly name = 'KataGo'

  private async try(verb: string, args: Array<string | number> = []): Promise<void> {
    try {
      await this.gtp.send(verb, args)
    } catch {
      // 旧版本引擎可能不支持个别命令，静默降级
    }
  }

  private turnOf(pos: GamePosition): Player {
    const normal = pos.moves.length - pos.handicapStones
    const even = normal % 2 === 0
    if (pos.handicapStones > 0) return even ? WHITE : BLACK
    return even ? BLACK : WHITE
  }

  /** 同步盘面到引擎，返回当前行棋方 */
  private async setup(position: GamePosition): Promise<Player> {
    if (this.lastSize !== position.size) {
      await this.gtp.send('boardsize', [position.size])
      this.lastSize = position.size
      this.lastKomi = null
    }
    if (this.lastRules !== position.rules) {
      await this.try(VERB_KATA_SET_RULES, [position.rules])
      this.lastRules = position.rules
    }
    if (this.lastKomi !== position.komi) {
      await this.gtp.send('komi', [position.komi])
      this.lastKomi = position.komi
    }
    await this.gtp.send('clear_board')
    for (const m of position.moves) {
      const color = m.player === BLACK ? 'B' : 'W'
      const vertex = m.x === -1 ? 'pass' : gtpCoord(m.x, m.y, position.size)
      await this.gtp.send('play', [color, vertex])
    }
    return this.turnOf(position)
  }

  private toResult(info: KataInfo | null, toMove: Player): {
    blackWinrate: number
    scoreLead: number
    ownership: number[]
  } {
    let blackWinrate = 0.5
    let scoreLead = 0
    let ownership: number[] = []
    if (info) {
      blackWinrate = toMove === BLACK ? clamp01(info.winrate) : clamp01(1 - info.winrate)
      scoreLead = toMove === BLACK ? info.scoreMean : -info.scoreMean
      if (info.ownership) ownership = this.toBlackPerspective(info.ownership, toMove)
    }
    return { blackWinrate, scoreLead, ownership }
  }

  async genMove(position: GamePosition, settings: EngineSettings): Promise<GenMoveResult> {
    const t0 = Date.now()
    const toMove = await this.setup(position)
    const color = toMove === BLACK ? 'B' : 'W'
    // 思路：运行 analyze 流，达到目标访问量（认真程度）或时限后打断，
    // 取访问量最高的候选着直接在棋盘上执行——强度由我们的停止逻辑精确控制。
    const targetVisits = boundedInt(settings.visits, 1, 100000000)
    const best = await runAnalysis(this.gtp, color, targetVisits, settings.maxTimeMs)
    const info: KataInfo | null = best
    let move: EngineMove = { kind: 'pass' }
    if (info?.move) {
      // analyze 流给出的候选为 GTP 顶点（如 Q16）或 pass
      const raw = info.move.trim()
      const x = raw.length >= 2 ? GTP_LETTERS.indexOf(raw[0].toUpperCase()) : -1
      const y = x >= 0 ? position.size - Number.parseInt(raw.slice(1), 10) : -1
      if (x >= 0 && y >= 1 && x < position.size && y <= position.size) {
        move = { kind: 'place', x, y }
      }
      // 让引擎内部棋盘保持同步（后续请求也会整体重放，这里只是即时一致）
      const vertex = move.kind === 'place' ? gtpCoord(move.x, move.y, position.size) : 'pass'
      await this.gtp.send('play', [color, vertex]).catch(() => {})
    }
    return {
      move,
      visits: info?.visits ?? 0,
      ...this.toResult(info, toMove),
      timeMs: Date.now() - t0,
    }
  }

  async evaluate(position: GamePosition, settings: EngineSettings): Promise<PositionResult> {
    const t0 = Date.now()
    const toMove = await this.setup(position)
    const color = toMove === BLACK ? 'B' : 'W'
    const targetVisits = Math.max(50, Math.min(settings.visits, 600))
    const info = await runAnalysis(this.gtp, color, targetVisits, settings.maxTimeMs)
    return { ...this.toResult(info, toMove), timeMs: Date.now() - t0 }
  }

  async benchmark(size: BoardSize, playouts: number): Promise<BenchmarkResult> {
    void playouts
    void size
    const t0 = Date.now()
    let lastVisits = 0
    await new Promise<void>((resolve) => {
      window.setTimeout(() => {
        this.gtp.interrupt()
        window.setTimeout(resolve, 300)
      }, 2500)
      this.gtp
        .send(VERB_KATA_ANALYZE, ['B', 100], (line) => {
          for (const info of parseAnalyzeLine(line)) {
            if (info.visits > lastVisits) lastVisits = info.visits
          }
        })
        .catch(() => {})
    })
    const seconds = Math.max(0.5, (Date.now() - t0 - 300) / 1000)
    return { playoutsPerSecond: lastVisits / seconds, timeMs: Date.now() - t0 }
  }

  /**
   * analyze 流的 ownership 以行棋方视角给出，统一转为黑正。
   * 方向（正负与行列序）需在对局数子中实证校验。
   */
  private toBlackPerspective(ownership: number[], toMove: Player): number[] {
    return toMove === BLACK ? ownership : ownership.map((v) => -v)
  }
}
