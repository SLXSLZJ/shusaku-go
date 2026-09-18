/**
 * KataGo（web-katrain 移植版）后端适配层。
 *
 * 引擎本体（TFJS 网络 + PUCT 搜索）在 src/engine/katago/，运行于独立 Worker，
 * 直接解析 KataGo 原生 .bin.gz 模型（kata1-b18c384nbt 等），无需 TFJS 转换。
 * 本文件把项目的 EngineBackend 协议（genmove / evaluate / benchmark）翻译成
 * 引擎的 analyze / eval 调用。
 *
 * 引擎来源：Sir-Teo/web-katrain（MIT License, © 2026 Web KatRain Contributors）。
 */
import { GoGame } from '../core/game'
import { BLACK, WHITE, type BoardSize } from '../core/types'
import type { BoardState, GameRules, Move as KMove, Player as KPlayer } from '../types'
import { publicUrl } from '../utils/publicUrl'
import type { BenchmarkResult, GenMoveResult } from './engineClient'
import type { EngineMove, EngineSettings, GamePosition, PositionResult } from './protocol'
import { getKataGoEngineClient, resetKataGoEngineClient } from './katago/client'
import {
  blendHumanChosenMove,
  chooseIndexWithTemperature,
  humanBotPresets,
  interpolateEarly,
  type HumanChosenCandidate,
} from './katago/chosenMove'
import { bookCandidates, ensureShusakuBook, sgfCoordToXY, weightedBookCandidate } from './shusakuBook'

/** 主力网络：KataGo 官方 b18c384nbt 人味 SL 网（19 路全棋盘，CC BY-NC 4.0）。 */
export const KATAGO_MODEL_URL = publicUrl('models/kata1-b18c384nbt-s9996604416-d4316597426.bin.gz')
/** 人味 SL 网：按段位/年代预测人类着法（policy 专用，价值仍来自主力网）。 */
export const KATAGO_HUMAN_MODEL_URL = publicUrl('models/b18c384nbt-humanv0.bin.gz')
export const KATAGO_MODEL_NAME = 'KataGo'

function toKPlayer(player: number): KPlayer {
  return player === BLACK ? 'black' : 'white'
}

function toKRules(rules: GamePosition['rules']): GameRules {
  return rules === 'chinese' ? 'chinese' : 'japanese'
}

/** 用 GoGame 重放手顺，导出最近三个局面（当前 / 上一手前 / 上上手前）。 */
function replayBoards(position: GamePosition): {
  boards: BoardState[]
  currentPlayer: KPlayer
  kMoves: KMove[]
} {
  const size = position.size
  const game = new GoGame(size as BoardSize, { superko: position.superko })
  const boards: BoardState[] = []
  const snapshot = (): BoardState => {
    const rows: BoardState = []
    for (let y = 0; y < size; y++) {
      const row: BoardState[number] = []
      for (let x = 0; x < size; x++) {
        const s = game.stoneAt(x, y)
        row.push(s === BLACK ? 'black' : s === WHITE ? 'white' : null)
      }
      rows.push(row)
    }
    return rows
  }
  const kMoves: KMove[] = []
  for (const m of position.moves) {
    if (m.x === -1) game.pass()
    else game.play(m.x, m.y)
    kMoves.push({ x: m.x, y: m.y, player: toKPlayer(m.player) })
    boards.push(snapshot())
  }
  if (boards.length === 0) boards.push(snapshot())
  const currentPlayer: KPlayer = game.turn === BLACK ? 'black' : 'white'
  return { boards, currentPlayer, kMoves }
}

interface AnalyzeOutcome {
  blackWinrate: number
  scoreLead: number
  ownership: number[]
  visits: number
  size: number
  moveNumber: number
  currentPlayer: KPlayer
  moves: Array<{
    x: number
    y: number
    visits: number
    order: number
    playSelectionValue?: number
    humanPrior?: number
    utility?: number
  }>
}

/** 推理后端偏好：WebGPU 优先；对局中途故障则永久降级 WASM（本会话内） */
let backendPref: 'webgpu' | 'wasm' = 'webgpu'

/** 低配设备（少核/低内存）自动降档：换更快应答，强度封顶 */
const lowEndDevice = (() => {
  try {
    const nav = navigator as { hardwareConcurrency?: number; deviceMemory?: number };
    const cores = nav.hardwareConcurrency ?? 8
    const mem = nav.deviceMemory ?? 8
    return cores <= 4 || mem <= 4
  } catch {
    return false
  }
})()

/** 访问量随棋盘尺寸缩放：小棋盘分支数少，同档位等效棋力所需搜索量更低 */
const SIZE_FACTOR: Record<number, number> = { 9: 0.35, 13: 0.55, 19: 1 }

async function analyzePosition(
  position: GamePosition,
  settings: EngineSettings,
  ownershipMode: 'none' | 'root' | 'tree',
  group: 'interactive' | 'background' = 'interactive',
): Promise<AnalyzeOutcome> {
  // 尺寸缩放 + 低配降档
  const factor = SIZE_FACTOR[position.size] ?? 1
  let visits = Math.max(32, Math.round(settings.visits * factor))
  let maxTimeMs = Math.max(800, Math.round(settings.maxTimeMs * Math.max(factor, 0.4)))
  if (lowEndDevice) {
    visits = Math.min(visits, 1500)
    maxTimeMs = Math.min(maxTimeMs, 8000)
  }
  const scaled: EngineSettings = { ...settings, visits, maxTimeMs }

  const attempt = (budgetMs: number, onAck: (phase: 'dequeue' | 'search') => void): Promise<AnalyzeOutcome> => {
    const { boards, currentPlayer, kMoves } = replayBoards(position)
    const humanSl = settings.humanSl
    const analysis = getKataGoEngineClient().analyze({
      analysisGroup: group,
      positionId: `p${position.moves.length}`,
      parentPositionId: position.moves.length > 0 ? `p${position.moves.length - 1}` : undefined,
      positionKey: position.moves.map((m) => (m.x < 0 ? 'pass' : `${m.x}${m.y}`)).join(';'),
      modelUrl: KATAGO_MODEL_URL,
      backend: backendPref,
      board: boards[boards.length - 1]!,
      previousBoard: boards.length >= 2 ? boards[boards.length - 2] : undefined,
      previousPreviousBoard: boards.length >= 3 ? boards[boards.length - 3] : undefined,
      currentPlayer,
      moveHistory: kMoves,
      komi: position.komi,
      rules: toKRules(position.rules),
      visits: scaled.visits,
      maxTimeMs: budgetMs,
      ownershipMode,
      reuseTree: true,
      humanModelUrl: humanSl ? KATAGO_HUMAN_MODEL_URL : undefined,
      humanSlProfile: humanSl?.profile,
      humanSlRootExploreProb: humanSl ? humanBotPresets[humanSl.style].rootExploreProbWeightless : undefined,
      onStart: (phase) => {
        if (phase === 'search' && startedAt === 0) startedAt = Date.now()
        onAck(phase)
      },
    })
    return analysis.then((analysis) => ({
      blackWinrate: analysis.rootWinRate,
      scoreLead: analysis.rootScoreLead,
      ownership: Array.from(analysis.ownership),
      visits: analysis.rootVisits,
      size: position.size,
      moveNumber: position.moves.length,
      currentPlayer,
      moves: analysis.moves.map((m) => ({
        x: m.x,
        y: m.y,
        visits: m.visits,
        order: m.order,
        playSelectionValue: m.playSelectionValue,
        humanPrior: m.humanPrior,
        utility: m.utility,
      })),
    }))
  }

  /**
   * 带看门狗的尝试，分三个阶段计时（挂起的推理无法从内部中断——批次内的
   * mapAsync await 不会返回，shouldAbort 没有机会执行——只能销毁重建 Worker）：
   * - 出队前：可能排在人味网预热等任务后面，用宽裕的排队上限；
   * - 出队后→开搜前：初始化阶段（Worker 重建时要解析 93MB 模型、换尺寸预热、
   *   人味网前向），同样远超预算，不能用预算计时；
   * - 开搜后：预算 + 宽限（覆盖搜索收尾与 ownership 构建）。
   */
  const attemptWithWatchdog = (budgetMs: number): Promise<AnalyzeOutcome> =>
    new Promise((resolve, reject) => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | null = null
      const arm = (ms: number, cause: string) => {
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => {
          if (settled) return
          settled = true
          reject(new Error(`watchdog: ${cause}`))
        }, ms)
      }
      const finish = (fn: () => void) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        fn()
      }
      arm(QUEUE_LIMIT_MS, `请求排队 ${Math.round(QUEUE_LIMIT_MS / 1000)}s 未见 Worker 出队（疑似挂起）`)
      attempt(budgetMs, (phase: 'dequeue' | 'search') => {
        if (phase === 'dequeue') {
          arm(INIT_LIMIT_MS, `初始化 ${Math.round(INIT_LIMIT_MS / 1000)}s 未完成（疑似挂起）`)
        } else {
          const graceMs = Math.max(10_000, Math.round(budgetMs * 0.5))
          arm(budgetMs + graceMs, `搜索 ${Math.round((budgetMs + graceMs) / 1000)}s 无响应（疑似挂起）`)
        }
      }).then(
        (outcome) => finish(() => resolve(outcome)),
        (err) => finish(() => reject(err instanceof Error ? err : new Error(String(err)))),
      )
    })

  const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
  // 整手棋共享时间预算：时钟从「开搜回执」（Worker 真正开始搜索）起算，
  // 重试按剩余预算分配——否则 WebGPU 尝试烧满预算后失败、WASM 重试又拿
  // 全新预算，一手棋要等两份时间。下限 25% 预算，保证降级后仍能给出可用的选点。
  const QUEUE_LIMIT_MS = 240_000
  const INIT_LIMIT_MS = 120_000
  let startedAt = 0
  let watchdogRetries = 0
  // WebGPU 对局中途故障（设备重置/缓冲区失败）→ 永久降级 WASM；
  // WASM 偶发失败也给予有限重试
  for (let attemptNo = 1; ; attemptNo++) {
    const budgetMs =
      startedAt === 0
        ? scaled.maxTimeMs
        : Math.max(
            Math.round(scaled.maxTimeMs * 0.25),
            800,
            Math.min(scaled.maxTimeMs, scaled.maxTimeMs - (Date.now() - startedAt)),
          )
    try {
      return await attemptWithWatchdog(budgetMs)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.startsWith('watchdog:')) {
        // 第二次挂起：放弃正常搜索，用极小预算做最后一搏（出一步快棋也比报错好）
        if (watchdogRetries >= 2) throw err
        watchdogRetries++
        backendPref = 'wasm'
        startedAt = 0
        resetKataGoEngineClient()
        const tiny = watchdogRetries >= 2
        if (tiny) {
          scaled.visits = Math.min(scaled.visits, 256)
          scaled.maxTimeMs = Math.min(scaled.maxTimeMs, 4000)
        }
        console.warn(`[katago] ${msg}；销毁重建 Worker${tiny ? '，以极小预算做最后一次尝试' : '，以 WASM 重试'}`)
        await settle(300)
        continue
      }
      if (backendPref === 'webgpu') {
        backendPref = 'wasm'
        console.warn('[katago] WebGPU 推理失败，已降级 WASM 并重试：', err)
        await settle(300)
        continue
      }
      if (attemptNo >= 3) throw err
      console.warn(`[katago] 推理失败（第 ${attemptNo} 次），重试：`, err)
      await settle(300)
    }
  }
}

/** 最近一次分析实际使用的推理后端（webgpu / wasm），用于对局遥测显示。 */
export function katagoBackendLabel(): string {
  try {
    return getKataGoEngineClient().getEngineInfo().backend ?? '未知'
  } catch {
    return '未知'
  }
}

/** pickMode → 选点：best 取 order 最小者；narrow/wide 按访问量加权抽样。 */
function pickMove(outcome: AnalyzeOutcome, pickMode: EngineSettings['pickMode']): EngineMove {
  const candidates = outcome.moves
  if (candidates.length === 0) return { kind: 'pass' }
  const toMove = (m: (typeof candidates)[number]): EngineMove =>
    m.x < 0 || m.y < 0 ? { kind: 'pass' } : { kind: 'place', x: m.x, y: m.y }
  if (pickMode === 'best') {
    let best = candidates[0]!
    for (const m of candidates) if (m.order < best.order) best = m
    return toMove(best)
  }
  // narrow 集中于头部，wide 更随机；以访问量为权重做温度抽样
  const temperature = pickMode === 'narrow' ? 0.3 : 1.0
  const probs = candidates.map((m) => Math.max(0, m.visits))
  const idx = chooseIndexWithTemperature(probs, temperature, 1.0)
  return toMove(candidates[idx >= 0 ? idx : 0]!)
}

/**
 * 秀策流选点：复刻 KataGo 官方 human-bot 配置——human SL 先验与搜索选点值
 * 按 PIKL 融合（blendHumanChosenMove），再按随手数衰减的温度抽样。
 * imitate = 忠实模仿该年代棋手（有时代局限）；search = 人形招法 + 搜索托底。
 */
function pickHumanStyleMove(outcome: AnalyzeOutcome, style: 'imitate' | 'search'): EngineMove {
  const preset = humanBotPresets[style]
  const candidates: HumanChosenCandidate[] = outcome.moves.map((m) => ({
    playSelectionValue: Math.max(0, m.playSelectionValue ?? m.visits),
    humanProb: Math.max(0, m.humanPrior ?? 0),
    utility: m.utility ?? null,
    isPass: m.x < 0 || m.y < 0,
  }))
  const values = blendHumanChosenMove({
    candidates,
    playerToMove: outcome.currentPlayer,
    params: preset,
  })
  const temperature = interpolateEarly({
    halflife: preset.temperatureHalflife,
    earlyValue: preset.temperatureEarly,
    value: preset.temperature,
    turnNumber: outcome.moveNumber,
    boardWidth: outcome.size,
    boardHeight: outcome.size,
  })
  const idx = chooseIndexWithTemperature(values, temperature, preset.temperatureOnlyBelowProb)
  const chosen = outcome.moves[idx >= 0 ? idx : 0]
  if (!chosen) return { kind: 'pass' }
  return chosen.x < 0 || chosen.y < 0 ? { kind: 'pass' } : { kind: 'place', x: chosen.x, y: chosen.y }
}

export async function isKatagoTsReady(
  timeoutMs: number,
  onProgress?: (received: number, total: number) => void,
): Promise<boolean> {
  try {
    const init = getKataGoEngineClient().init(KATAGO_MODEL_URL, 'webgpu', onProgress)
    let timer: ReturnType<typeof setTimeout> | null = null
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('KataGo 初始化超时')), timeoutMs)
    })
    try {
      await Promise.race([init, timeout])
      return true
    } finally {
      if (timer) clearTimeout(timer)
    }
  } catch {
    return false
  }
}

/** 后台预热人味 SL 网（秀策流棋风专用）：主网就绪后调用，不阻塞对弈。 */
export function warmHumanModel(
  onProgress?: (received: number, total: number) => void,
): Promise<boolean> {
  return getKataGoEngineClient()
    .warmHuman(KATAGO_HUMAN_MODEL_URL, onProgress)
    .then(() => true)
    .catch(() => false)
}

export async function katagoGenMove(position: GamePosition, settings: EngineSettings): Promise<GenMoveResult> {
  const t0 = Date.now()
  const outcome = await analyzePosition(position, settings, 'root')
  let move = settings.humanSl
    ? pickHumanStyleMove(outcome, settings.humanSl.style)
    : pickMove(outcome, settings.pickMode)
  // 秀策流专属：开局路径命中棋谱库时，按秀策本人在该局面的实际着法加权选点。
  // 仍照常执行搜索，胜率/目差显示不受影响。
  if (settings.humanSl) {
    await ensureShusakuBook()
    const board = replayBoards(position).boards.at(-1)
    const candidates = bookCandidates(position.moves.map((m) => ({ x: m.x, y: m.y })))
    if (board && candidates) {
      for (let attempt = 0; attempt < 8; attempt++) {
        const coord = weightedBookCandidate(candidates)
        const xy = coord ? sgfCoordToXY(coord) : null
        if (xy && board[xy.y]?.[xy.x] == null) {
          move = { kind: 'place', x: xy.x, y: xy.y }
          break
        }
      }
    }
  }
  return {
    move,
    blackWinrate: Math.min(0.99, Math.max(0.01, outcome.blackWinrate)),
    scoreLead: outcome.scoreLead,
    ownership: outcome.ownership,
    visits: outcome.visits,
    timeMs: Date.now() - t0,
  }
}

export async function katagoEvaluate(position: GamePosition, settings: EngineSettings): Promise<PositionResult> {
  const t0 = Date.now()
  // background 组：胜率探测 / 形势判断不得抢占（取消）AI 正在进行的行棋搜索
  const outcome = await analyzePosition(position, settings, 'root', 'background')
  return {
    blackWinrate: Math.min(0.99, Math.max(0.01, outcome.blackWinrate)),
    scoreLead: outcome.scoreLead,
    ownership: outcome.ownership,
    timeMs: Date.now() - t0,
  }
}

export async function katagoBenchmark(size: BoardSize, playouts: number): Promise<BenchmarkResult> {
  const t0 = Date.now()
  await analyzePosition(
    { size, moves: [], handicapStones: 0, komi: 7.5, rules: 'chinese', superko: true },
    { visits: Math.max(16, playouts), maxTimeMs: 60_000, pickMode: 'best' },
    'none',
    'background',
  )
  const seconds = Math.max(0.5, (Date.now() - t0) / 1000)
  return { playoutsPerSecond: Math.round(playouts / seconds), timeMs: Date.now() - t0 }
}
