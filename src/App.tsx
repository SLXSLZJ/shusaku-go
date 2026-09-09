import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useRef, useState } from 'react'
import { GoGame } from './core/game'
import { computeScore, deadStonesFromOwnership, type ScoreDetail } from './core/scoring'
import { BLACK, WHITE, type BoardSize, type PlayError, type Point } from './core/types'
import { describeLastMoveParts, type MoveAnnounce } from './engine/commentary'
import { getEngineBackend, type EngineBackend } from './engine/engineFacade'
import type { GamePosition } from './engine/protocol'
import { strengthLevel } from './engine/strength'
import { COLUMN_LETTERS } from './render/boardRenderer'
import { BoardCanvas } from './ui/BoardCanvas'
import { DEFAULT_CONFIG, GameSetup, type GameConfig } from './ui/GameSetup'

declare global {
  interface Window {
    /** 当前引擎名（供无头验证与调试读取） */
    __shusakuEngine?: string
  }
}

const ERROR_TEXT: Record<PlayError, string> = {
  'out-of-bounds': '超出棋盘范围',
  occupied: '此处已有棋子',
  ko: '打劫 —— 需先在他处寻劫',
  'self-capture': '禁着点：落子后无气',
  superko: '全局同形禁着',
  'game-over': '对局已终了',
}

const SIZE_LABEL: Record<BoardSize, string> = { 9: '九路', 13: '十三路', 19: '十九路' }

function coordText(size: BoardSize, x: number, y: number): string {
  return `${COLUMN_LETTERS[x]}${size - y}`
}

function ptKey(p: Point): string {
  return `${p.x},${p.y}`
}

interface Status {
  kind: 'error' | 'info'
  text: string
}

interface ScoringState {
  autoDead: Point[]
  overrides: Record<string, boolean>
  result: ScoreDetail
}

export default function App() {
  const gameRef = useRef<GoGame>(new GoGame(9, { superko: DEFAULT_CONFIG.rules === 'chinese' }))
  const backendRef = useRef<Promise<EngineBackend> | null>(null)
  const thinkingRef = useRef(false)
  const lowStreakRef = useRef(0)
  const scoringRequestedRef = useRef(false)

  const [snap, setSnap] = useState(gameRef.current.snapshot())
  const [applied, setApplied] = useState<GameConfig>(DEFAULT_CONFIG)
  const [draft, setDraft] = useState<GameConfig>(DEFAULT_CONFIG)
  const [status, setStatus] = useState<Status | null>(null)
  const [thinking, setThinking] = useState(false)
  const [blackWinrate, setBlackWinrate] = useState<number | null>(null)
  const [scoring, setScoring] = useState<ScoringState | null>(null)
  const [resignSide, setResignSide] = useState<'black' | 'white' | null>(null)
  const [benchText, setBenchText] = useState<string | null>(null)
  const [engineName, setEngineName] = useState<string | null>(null)
  const [setupOpen, setSetupOpen] = useState(true)
  const [announce, setAnnounce] = useState<MoveAnnounce | null>(null)
  const [announceKey, setAnnounceKey] = useState(0)

  const aiPlayerNum: 0 | 1 | 2 = applied.aiSide === 'black' ? BLACK : applied.aiSide === 'white' ? WHITE : 0
  const humanTurn = !snap.isOver && !thinking && (applied.aiSide === 'none' || snap.turn !== aiPlayerNum)

  function getBackend(): Promise<EngineBackend> {
    if (!backendRef.current) {
      backendRef.current = getEngineBackend().then((b) => {
        setEngineName(b.name)
        window.__shusakuEngine = b.name
        return b
      })
    }
    return backendRef.current
  }

  const sync = (): void => setSnap(gameRef.current.snapshot())

  function positionFromGame(): GamePosition {
    const g = gameRef.current
    return {
      size: g.size,
      moves: g.history.map((m) => ({ player: m.player, x: m.x, y: m.y })),
      handicapStones: g.handicapStones,
      komi: applied.komi,
      rules: applied.rules,
      superko: applied.rules === 'chinese',
    }
  }

  function effectiveDead(sc: ScoringState): Set<string> {
    const autoSet = new Set(sc.autoDead.map(ptKey))
    const keys = new Set<string>()
    const size = gameRef.current.size
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (gameRef.current.stoneAt(x, y) === 0) continue
        const k = `${x},${y}`
        const o = sc.overrides[k]
        if (o !== undefined ? o : autoSet.has(k)) keys.add(k)
      }
    }
    return keys
  }

  function scoreNow(sc: ScoringState): ScoreDetail {
    const g = gameRef.current
    const dead: Point[] = [...effectiveDead(sc)].map((k) => {
      const [x, y] = k.split(',').map(Number)
      return { x, y }
    })
    return computeScore(g.snapshot().stones, g.size, {
      komi: applied.komi,
      rules: applied.rules,
      captures: g.captures,
      deadStones: dead,
    })
  }

  // ── 页面打开即预热引擎（KataGo 初始化需要数秒，提前加载）──
  useEffect(() => {
    getBackend()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── 开局折叠设置面板，终局自动展开 ──
  useEffect(() => {
    if (snap.isOver) setSetupOpen(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snap.isOver])

  // ── AI 行棋 ──
  useEffect(() => {
    if (applied.aiSide === 'none') return
    if (snap.isOver || snap.turn !== aiPlayerNum || thinkingRef.current) return
    thinkingRef.current = true
    setThinking(true)
    const lvl = strengthLevel(applied.strength)
    const aiSettings = {
      visits: lvl.visits,
      maxTimeMs: lvl.maxTimeMs,
      pickMode: lvl.pickMode,
      // 秀策流：1850 年代日本职业棋手的行棋分布；高强度档改用「人形 + 搜索托底」
      humanSl:
        applied.aiStyle === 'shusaku'
          ? { profile: 'proyear_1850', style: applied.strength >= 8 ? ('search' as const) : ('imitate' as const) }
          : undefined,
    }
    const run = (): void => {
      getBackend()
        .then((b) => b.genMove(positionFromGame(), aiSettings))
        .then((res) => {
          const g = gameRef.current
          const announceLast = (): void => {
            setAnnounce(describeLastMoveParts(g.size, g.history.map((m) => ({ player: m.player, x: m.x, y: m.y })), g.handicapStones))
            setAnnounceKey((k) => k + 1)
          }
          if (g.isOver) return
          const aiWinrate = aiPlayerNum === BLACK ? res.blackWinrate : 1 - res.blackWinrate
          lowStreakRef.current = aiWinrate < 0.08 ? lowStreakRef.current + 1 : 0
          if (res.move.kind === 'resign' || lowStreakRef.current >= 2) {
            g.resign()
            setResignSide(aiPlayerNum === BLACK ? 'black' : 'white')
            setAnnounce(null)
          } else if (res.move.kind === 'pass') {
            g.pass()
            announceLast()
          } else {
            g.play(res.move.x, res.move.y)
            announceLast()
          }
          setBlackWinrate(res.blackWinrate)
        })
        .catch((e) => setStatus({ kind: 'error', text: `引擎出错：${String(e)}` }))
        .finally(() => {
          thinkingRef.current = false
          setThinking(false)
          sync()
        })
    }
    // KataGo 在主线程搜索时会冻结页面；先让「思考中」渲染出一帧再开跑
    let fired = false
    const timer = window.setTimeout(() => {
      fired = true
      run()
    }, 80)
    return () => {
      window.clearTimeout(timer)
      if (!fired) thinkingRef.current = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snap])

  // ── 双虚着终局后自动数子 ──
  useEffect(() => {
    if (!snap.isOver || snap.overReason !== 'passes' || scoring || scoringRequestedRef.current) return
    scoringRequestedRef.current = true
    getBackend()
      .then((b) => b.evaluate(positionFromGame(), { visits: 1200, maxTimeMs: 8000, pickMode: 'best' }))
      .then((res) => {
        const auto = deadStonesFromOwnership(snap.stones, snap.size, res.ownership)
        const sc: ScoringState = { autoDead: auto, overrides: {}, result: computeScore(snap.stones, snap.size, {
          komi: applied.komi,
          rules: applied.rules,
          captures: gameRef.current.captures,
          deadStones: auto,
        }) }
        setScoring(sc)
      })
      .catch((e) => setStatus({ kind: 'error', text: `数子失败：${String(e)}` }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snap])

  const handlePlay = (x: number, y: number): void => {
    if (scoring) {
      if (gameRef.current.stoneAt(x, y) === 0) return
      const k = `${x},${y}`
      const autoSet = new Set(scoring.autoDead.map(ptKey))
      const current = scoring.overrides[k] ?? autoSet.has(k)
      const next: ScoringState = { ...scoring, overrides: { ...scoring.overrides, [k]: !current } }
      next.result = scoreNow(next)
      setScoring(next)
      return
    }
    if (!humanTurn) return
    const r = gameRef.current.play(x, y)
    if (r.ok) {
      setStatus(null)
      if (applied.aiSide !== 'none' && !gameRef.current.isOver) {
        getBackend()
          .then((b) => b.evaluate(positionFromGame(), { visits: 220, maxTimeMs: 2500, pickMode: 'best' }))
          .then((res) => setBlackWinrate(res.blackWinrate))
          .catch(() => {})
      }
    } else {
      setStatus({ kind: 'error', text: ERROR_TEXT[r.error] })
    }
    sync()
  }

  const handlePass = (): void => {
    if (!humanTurn) return
    const who = snap.turn === BLACK ? '黑方' : '白方'
    gameRef.current.pass()
    setStatus({ kind: 'info', text: `${who}虚着` })
    sync()
  }

  const handleUndo = (): void => {
    if (thinking || scoring) return
    const g = gameRef.current
    if (!g.undo()) return
    if (applied.aiSide !== 'none') {
      while (!g.isOver && g.turn === aiPlayerNum && g.moveNumber > g.handicapStones) {
        if (!g.undo()) break
      }
    }
    scoringRequestedRef.current = false
    setStatus(null)
    sync()
  }

  const handleResign = (): void => {
    if (snap.isOver || thinking || scoring) return
    const side = snap.turn === BLACK ? 'black' : 'white'
    gameRef.current.resign()
    setResignSide(side)
    sync()
  }

  const handleStart = (): void => {
    const g = new GoGame(draft.size, { superko: draft.rules === 'chinese' })
    if (draft.handicap > 0) g.placeFixedHandicap(draft.handicap)
    gameRef.current = g
    setApplied(draft)
    setStatus(null)
    setBlackWinrate(null)
    setScoring(null)
    setResignSide(null)
    setSetupOpen(false)
    setAnnounce(null)
    scoringRequestedRef.current = false
    lowStreakRef.current = 0
    sync()
  }

  const handleBenchmark = (): void => {
    const playouts = draft.size === 9 ? 400 : draft.size === 13 ? 200 : 80
    setBenchText('测速中……')
    getBackend()
      .then((b) => b.benchmark(draft.size, playouts))
      .then((r) =>
        setBenchText(
          `${SIZE_LABEL[draft.size]} 引擎测速（${engineName ?? '引擎'}）：约 ${Math.round(r.playoutsPerSecond).toLocaleString()} 访问量/秒`,
        ),
      )
      .catch((e) => setBenchText(`测速失败：${String(e)}`))
  }

  const deadKeys = scoring ? effectiveDead(scoring) : undefined
  const log = snap.history.slice(-40)
  const logOffset = snap.history.length - log.length

  let scoreTexts: { headline: string; result: string } | null = null
  if (scoring) {
    const r = scoring.result
    const who = r.winner === 'draw' ? '和棋' : r.winner === 'black' ? '黑胜' : '白胜'
    const margin = r.rules === 'chinese' ? `${r.margin / 2} 子` : `${r.margin} 目`
    scoreTexts = {
      headline: `黑 ${r.blackScore} · 白 ${r.whiteScore}（${r.rules === 'chinese' ? '数子' : '数目'}，贴 ${applied.komi}）`,
      result: r.winner === 'draw' ? who : `${who} ${margin}`,
    }
  }

  return (
    <div className="app">
      <aside className="side">
        <div className="brand-block">
          <h1 className="brand">手談</h1>
          <div className="brand-meta">
            <span className="seal">弈</span>
            <span className="brand-sub">秀策 · shusaku-go</span>
          </div>
        </div>

        <section className="panel">
          <div className="state-row">
            <span className={`stone-dot ${snap.turn === BLACK ? 'black' : 'white'}`} aria-hidden />
            <span>
              {snap.isOver
                ? '终局'
                : thinking
                  ? 'AI 思考中……'
                  : snap.turn === BLACK
                    ? '黑方行棋'
                    : '白方行棋'}
            </span>
            <span className="dim">第 {snap.moveNumber} 手</span>
          </div>
          <div className="state-row dim">
            黑提 {snap.captures.black} · 白提 {snap.captures.white}
          </div>
          <AnimatePresence>
            {snap.isOver && snap.overReason === 'resign' && (
              <motion.div
                className="banner"
                initial={{ opacity: 0, y: -6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.25 }}
              >
                {resignSide === 'black' ? '黑方中盘认输，白方胜' : resignSide === 'white' ? '白方中盘认输，黑方胜' : '一方中盘认输'}
              </motion.div>
            )}
          </AnimatePresence>
          {snap.isOver && snap.overReason === 'passes' && !scoring && <div className="tiny dim">双方连续虚着，数子中……</div>}
        </section>

        {scoring && scoreTexts && (
          <motion.section
            className="panel"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3 }}
          >
            <div className="panel-title">终 局 数 子</div>
            <div className="score-line">{scoreTexts.headline}</div>
            <div className="banner">{scoreTexts.result}</div>
            <div className="score-hint">半透明棋子为判死；点击棋子可翻转死活判定。</div>
          </motion.section>
        )}

        <GameSetup
          config={draft}
          disabled={thinking}
          open={setupOpen}
          onToggle={() => setSetupOpen((o) => !o)}
          benchText={benchText}
          onChange={(patch) => setDraft({ ...draft, ...patch })}
          onStart={handleStart}
          onBenchmark={handleBenchmark}
        />

        <div className={status ? (status.kind === 'error' ? 'status error' : 'status') : 'status empty'}>
          {status ? status.text : '　'}
        </div>

        <section className="panel">
          <div className="btn-row">
            <button className="btn" onClick={handlePass} disabled={!humanTurn || !!scoring}>
              虚着
            </button>
            <button
              className="btn"
              onClick={handleUndo}
              disabled={thinking || !!scoring || snap.moveNumber <= snap.handicapStones}
            >
              悔棋
            </button>
            <button className="btn" onClick={handleResign} disabled={snap.isOver || thinking || !!scoring}>
              认输
            </button>
          </div>
        </section>

        <section className="panel log-panel">
          <div className="panel-title">棋 谱</div>
          {log.length === 0 ? (
            <div className="dim log-empty">{applied.aiSide === 'black' ? 'AI 执黑先行。' : '黑先行。点击棋盘落子。'}</div>
          ) : (
            <ol className="log">
              {log.map((m, i) => (
                <li key={logOffset + i}>
                  <span className="log-n dim">{logOffset + i + 1}</span>
                  <span>{m.player === BLACK ? '黑' : '白'}</span>
                  <span>{m.kind === 'pass' ? '虚着' : coordText(snap.size, m.x, m.y)}</span>
                  <span className="dim">{m.captured.length > 0 ? `提${m.captured.length}` : ''}</span>
                </li>
              ))}
            </ol>
          )}
        </section>

        {blackWinrate !== null && !snap.isOver && (
          <section className="panel wr-panel">
            <div className="panel-title">胜 率 估 算</div>
            <div
              className="wr-bar"
              role="img"
              aria-label={`黑方胜率约 ${Math.round(blackWinrate * 100)}%`}
            >
              <div
                className="wr-black"
                style={{ transform: `scaleX(${blackWinrate})` }}
              />
            </div>
            <div className="wr-labels">
              <span>黑 {Math.round(blackWinrate * 100)}%</span>
              <span>白 {100 - Math.round(blackWinrate * 100)}%</span>
            </div>
          </section>
        )}
      </aside>

      <main className="board-area">
        <div className="announce-slot">
          <AnimatePresence mode="wait">
            {announce && (
              <motion.div
                key={announceKey}
                className="announce"
                role="status"
                aria-atomic="true"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.22, ease: 'easeOut' }}
              >
                <span className={`stone-dot ${announce.who === '黑' ? 'black' : 'white'}`} aria-hidden />
                <span>{announce.point}</span>
                {announce.reason && <span className="announce-action">，{announce.reason}</span>}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
        <BoardCanvas
          boardSize={snap.size}
          stones={snap.stones}
          lastMove={
            snap.lastMove && snap.lastMove.kind === 'place'
              ? { x: snap.lastMove.x, y: snap.lastMove.y }
              : null
          }
          turn={snap.turn}
          interactive={!snap.isOver && (!!scoring || humanTurn)}
          deadKeys={deadKeys}
          onPlay={handlePlay}
        />
      </main>
    </div>
  )
}
