/// <reference lib="webworker" />

import * as tf from '@tensorflow/tfjs';
import { isGameRules } from '../../utils/goRules';
import '@tensorflow/tfjs-backend-webgpu';
import '@tensorflow/tfjs-backend-wasm';
import { setThreadsCount, setWasmPaths } from '@tensorflow/tfjs-backend-wasm';
import pako from 'pako';

import type { KataGoAnalyzeRequest, KataGoWorkerRequest, KataGoWorkerResponse } from './types';
import { looksLikeMarkup, modelResponseError } from './modelResponse';
import { collectAnalysisTransferables } from './analysisTransfer';
import type { GameRules, KataGoBackendPreference, Player, RegionOfInterest } from '../../types';
import { publicUrl } from '../../utils/publicUrl';
import { getAnimationNow } from '../../utils/animationFrame';
import { parseKataGoModelV8 } from './loadModelV8';
import { KataGoModelV8Tf } from './modelV8';
import { fetchModelWithCache } from './modelCache';
import { ENGINE_MAX_TIME_MS, ENGINE_MAX_VISITS } from './limits';
import { createAnalyzeAbortCheck } from './analyzeAbort';
import { MctsSearch, rootSymmetrySamplesForBackend, type OwnershipMode } from './analyzeMcts';
import { fillInputsV7FastForPosition } from './positionInputsV7';
import {
  getKataGoWarmupFallbackBackend,
  normalizeKataGoBackendPreference,
  shouldCacheKataGoFallbackForRequest,
} from './backendFallback';
import { BOARD_AREA, BOARD_SIZE, PASS_MOVE, setBoardSize } from './fastBoard';
import { postprocessKataGoV8 } from './evalV8';
import { humanSlMetadataRow } from './humanSlProfile';
import { detectSearchThreadCount } from '../../utils/workerThreads';

let model: KataGoModelV8Tf | null = null;
let loadedModelName: string | undefined;
let loadedModelUrl: string | null = null;
let humanModel: KataGoModelV8Tf | null = null;
let loadedHumanModelUrl: string | null = null;
let backendPromise: Promise<void> | null = null;
let backendPreference: KataGoBackendPreference | null = null;
/** WASM 搜索线程数上限（主线程经 init/analyze 消息下发；缺省 4） */
let threadsCap: number | null = null;
let prodModeEnabled = false;
let queue: Promise<void> = Promise.resolve();
/** 人味策略 logits 缓存（键：humanKey|positionKey），LRU 上限 8 局面 */
const humanLogitsCache = new Map<string, Float32Array>();
/** 已完成内核预热的棋盘尺寸（换尺寸后第一访的 JIT 尖峰消除） */
let lastWarmedSize = 0;

let V7_SPATIAL_STRIDE = BOARD_AREA * 22;
const V7_GLOBAL_STRIDE = 19;

let evalSpatialV7 = new Float32Array(V7_SPATIAL_STRIDE);
let evalGlobalV7 = new Float32Array(V7_GLOBAL_STRIDE);

let evalBatchCapacity = 0;
let evalBatchSpatialV7 = new Float32Array(0);
let evalBatchGlobalV7 = new Float32Array(0);
let scratchBoardSize = BOARD_SIZE;
type ParsedKataGoModelV8 = ReturnType<typeof parseKataGoModelV8>;

function regionKey(roi?: RegionOfInterest | null): string | null {
  if (!roi) return null;
  const xMin = Math.max(0, Math.min(BOARD_SIZE - 1, Math.min(roi.xMin, roi.xMax)));
  const xMax = Math.max(0, Math.min(BOARD_SIZE - 1, Math.max(roi.xMin, roi.xMax)));
  const yMin = Math.max(0, Math.min(BOARD_SIZE - 1, Math.min(roi.yMin, roi.yMax)));
  const yMax = Math.max(0, Math.min(BOARD_SIZE - 1, Math.max(roi.yMin, roi.yMax)));
  const isSinglePoint = xMin === xMax && yMin === yMax;
  const isWholeBoard = xMin === 0 && yMin === 0 && xMax === BOARD_SIZE - 1 && yMax === BOARD_SIZE - 1;
  if (isSinglePoint || isWholeBoard) return null;
  return `${xMin},${xMax},${yMin},${yMax}`;
}

function getEvalBatchBuffersV7(batch: number): { spatial: Float32Array; global: Float32Array } {
  if (batch > evalBatchCapacity) {
    evalBatchCapacity = batch;
    evalBatchSpatialV7 = new Float32Array(batch * V7_SPATIAL_STRIDE);
    evalBatchGlobalV7 = new Float32Array(batch * V7_GLOBAL_STRIDE);
  }
  return {
    spatial: evalBatchSpatialV7.subarray(0, batch * V7_SPATIAL_STRIDE),
    global: evalBatchGlobalV7.subarray(0, batch * V7_GLOBAL_STRIDE),
  };
}

let search: MctsSearch | null = null;
let searchKey: {
  positionId: string;
  positionKey: string | null;
  modelUrl: string;
  boardSize: number;
  maxChildren: number;
  ownershipMode: OwnershipMode;
  komi: number;
  currentPlayer: 'black' | 'white';
  wideRootNoise: number;
  rootPolicyTemperature: number;
  fillDameBeforePass: boolean;
  playoutDoublingAdvantage: number;
  playoutDoublingAdvantagePla: 'black' | 'white';
  rootSymmetrySamples: number;
  rules: GameRules;
  nnRandomize: boolean;
  conservativePass: boolean;
  roiKey: string | null;
  humanKey: string | null;
  avoidKey: string | null;
} | null = null;
const latestAnalyzeByGroup = new Map<string, number>();
let interactiveToken = 0;
const analyzeMeta = new WeakMap<KataGoAnalyzeRequest, { analysisGroup: 'interactive' | 'background'; interactiveToken: number }>();

function ensureBoardSizeForWorker(boardSize: number): void {
  if (boardSize === scratchBoardSize) return;
  setBoardSize(boardSize);
  scratchBoardSize = BOARD_SIZE;
  V7_SPATIAL_STRIDE = BOARD_AREA * 22;
  evalSpatialV7 = new Float32Array(V7_SPATIAL_STRIDE);
  evalGlobalV7 = new Float32Array(V7_GLOBAL_STRIDE);
  evalBatchCapacity = 0;
  evalBatchSpatialV7 = new Float32Array(0);
  evalBatchGlobalV7 = new Float32Array(0);
  search = null;
  searchKey = null;
}

/**
 * Why the engine is not on the backend it was asked for. A fallback used to
 * be silent: a browser whose WASM threads or WebGPU adapter failed to start
 * showed a small "CPU" chip and analysis that was ten times slower, with no
 * record anywhere of what had gone wrong.
 */
let backendNote: string | null = null;
let postedBackendNote: string | null = null;

/**
 * 真实生效的推理后端（而非请求偏好）：wasm 会标注二进制形态（多线程/SIMD）。
 * TFJS 按特性检测挑 .wasm 变体，加载失败会静默落到慢速变体——这里把真相亮出来。
 */
function describeTfBackend(): string {
  const name = tf.getBackend();
  if (name !== 'wasm') return name;
  try {
    const flag = (f: string): boolean | null => {
      try {
        return tf.env().getBool(f);
      } catch {
        return null; // 该旗标在此 TFJS 版本不存在
      }
    };
    const mt = flag('WASM_HAS_MULTITHREAD_SUPPORT');
    const simd = flag('WASM_HAS_SIMD_SUPPORT');
    if (mt === null && simd === null) return 'wasm';
    const parts: string[] = ['wasm'];
    parts.push(mt === true ? '多线程' : mt === false ? '单线程' : '线程?');
    if (simd === false) parts.push('无SIMD');
    return parts.join('·');
  } catch {
    return 'wasm';
  }
}

function postBackendNote(): void {
  if (!backendNote || backendNote === postedBackendNote) return;
  postedBackendNote = backendNote;
  post({ type: 'katago:notice', level: 'warn', message: backendNote });
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

async function initWasmBackend(): Promise<void> {
  setWasmPaths(publicUrl('tfjs/'));
  // Use a reasonable thread count for XNNPACK when cross-origin isolated (SharedArrayBuffer).
  // Without COOP/COEP headers, browsers disable threads and TFJS will fall back to single-threaded wasm.
  const isCrossOriginIsolated = (globalThis as unknown as { crossOriginIsolated?: boolean }).crossOriginIsolated === true;
  // 无头浏览器（CI/无头验证）里嵌套线程 Worker 会挂起——保持单线程
  const isHeadless = navigator.userAgent.includes('HeadlessChrome');
  // 线程数上限：默认 4。XNNPACK 线程自旋等待，超过 4 个后收益微弱，
  // 而在远程会话/串流主机的 CPU 争抢下大线程数反而会互相踩踏导致速度崩溃。
  const cap = Math.max(1, Math.min(threadsCap ?? 4, 4));
  const wantThreads = isCrossOriginIsolated && !isHeadless && cap > 1;
  // 线程化初始化失败/超时后，退回单线程再试一次（无嵌套 Worker，健壮得多）。
  // 绝不退到纯 JS 的 CPU 后端：它跑 b18 慢数百倍（实测 86 秒只搜出 18 个访问点），
  // 比「这手棋报错、交给上层重试」糟糕得多。
  const attempts: Array<{ threads: boolean; timeoutMs: number }> = [];
  if (wantThreads) attempts.push({ threads: true, timeoutMs: 20_000 });
  attempts.push({ threads: false, timeoutMs: 30_000 });

  let lastErr: unknown = null;
  for (const attempt of attempts) {
    try {
      setThreadsCount(attempt.threads ? Math.min(detectSearchThreadCount(), cap) : 1);
      // setBackend resolves false, without throwing, when the backend fails to
      // initialise; the old bare await treated that as success. 线程 Worker 万一
      // 挂起也不能卡死引擎：限时后换下一种形态重试。
      await withTimeout(
        (async () => {
          if (!(await tf.setBackend('wasm'))) throw new Error("tf.setBackend('wasm') returned false");
          await tf.ready();
        })(),
        attempt.timeoutMs,
        'wasm backend init timed out',
      );
      if (!attempt.threads && wantThreads) {
        backendNote = [backendNote, 'WASM threads failed to start; using single-threaded WASM']
          .filter(Boolean)
          .join('. ');
        postBackendNote();
      }
      return;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr ?? new Error('wasm backend init failed');
}

async function initBackend(preferredBackend: KataGoBackendPreference): Promise<void> {
  if (preferredBackend === 'cpu') {
    await tf.setBackend('cpu');
    await tf.ready();
    return;
  }

  if (preferredBackend === 'webgpu') {
    try {
      if (!(await tf.setBackend('webgpu'))) throw new Error('tf.setBackend(\'webgpu\') returned false');
      await tf.ready();
      return;
    } catch (err) {
      // Fall back to WASM/CPU if WebGPU isn't available or fails to initialize.
      backendNote = `WebGPU backend failed (${describeError(err)}); trying WASM`;
    }
  }

  await initWasmBackend();
}

function maybeUngzip(data: Uint8Array): Uint8Array {
  // gzip magic bytes 0x1f8b
  if (data.length >= 2 && data[0] === 0x1f && data[1] === 0x8b) return pako.ungzip(data);
  return data;
}


async function ensureBackend(backend?: KataGoBackendPreference): Promise<void> {
  const preferredBackend = normalizeKataGoBackendPreference(backend);
  if (backendPromise && backendPreference === preferredBackend) {
    await backendPromise;
    return;
  }

  model?.dispose();
  model = null;
  loadedModelName = undefined;
  loadedModelUrl = null;
  search = null;
  searchKey = null;

  backendPreference = preferredBackend;
  backendPromise = initBackend(preferredBackend)
      .then(() => {
        if (!prodModeEnabled) {
          tf.enableProdMode();
          prodModeEnabled = true;
        }
      })
      .catch((err) => {
        backendPromise = null;
        backendPreference = null;
        throw err;
      });
  await backendPromise;
}

async function warmupModel(candidate: KataGoModelV8Tf): Promise<void> {
  const spatial = tf.zeros([1, 19, 19, 22], 'float32') as tf.Tensor4D;
  const global = tf.zeros([1, 19], 'float32') as tf.Tensor2D;
  let out: ReturnType<KataGoModelV8Tf['forwardValueOnly']> | null = null;
  try {
    out = candidate.forwardValueOnly(spatial, global);
    const results = await Promise.allSettled([out.value.data(), out.scoreValue.data()]);
    for (const result of results) {
      if (result.status === 'rejected') throw result.reason;
    }
  } finally {
    spatial.dispose();
    global.dispose();
    out?.value.dispose();
    out?.scoreValue.dispose();
  }
}

async function createWarmedModel(parsed: ParsedKataGoModelV8): Promise<KataGoModelV8Tf> {
  const candidate = new KataGoModelV8Tf(parsed);
  try {
    await warmupModel(candidate);
    return candidate;
  } catch (err) {
    candidate.dispose();
    throw err;
  }
}

function installModel(nextModel: KataGoModelV8Tf, parsed: ParsedKataGoModelV8, modelUrl: string): void {
  model?.dispose();
  model = nextModel;
  loadedModelName = parsed.modelName;
  loadedModelUrl = modelUrl;
  search = null;
  searchKey = null;
}

async function switchToFallbackBackendForRequest(
  requestedBackend: KataGoBackendPreference,
  fallbackBackend: KataGoBackendPreference
): Promise<void> {
  backendPromise = null;
  backendPreference = null;
  await ensureBackend(fallbackBackend);
  if (shouldCacheKataGoFallbackForRequest({ requestedBackend, fallbackBackend: tf.getBackend() })) {
    backendPreference = requestedBackend;
  }
}

async function ensureModel(
  modelUrl: string,
  backend?: KataGoBackendPreference,
  onDownloadProgress?: (received: number, total: number) => void,
): Promise<void> {
  const requestedBackend = normalizeKataGoBackendPreference(backend);
  if (!backendPromise || backendPreference !== requestedBackend) backendNote = null;
  await ensureBackend(requestedBackend);
  if (model && loadedModelUrl === modelUrl) return;

  // IndexedDB 缓存优先：免去重复下载上百 MB 的模型
  const buf = await fetchModelWithCache(modelUrl, onDownloadProgress);
  if (looksLikeMarkup(buf)) throw modelResponseError(modelUrl);
  const data = maybeUngzip(buf);

  const parsed = parseKataGoModelV8(data);
  const attemptedFallbacks = new Set<KataGoBackendPreference>();
  while (true) {
    try {
      installModel(await createWarmedModel(parsed), parsed, modelUrl);
      postBackendNote();
      return;
    } catch (err) {
      const fallbackBackend = getKataGoWarmupFallbackBackend({
        requestedBackend,
        activeBackend: tf.getBackend(),
        stage: 'warmup',
      });
      if (!fallbackBackend || attemptedFallbacks.has(fallbackBackend)) {
        throw err;
      }

      attemptedFallbacks.add(fallbackBackend);
      backendNote = [
        backendNote,
        `Model warm-up failed on ${tf.getBackend()} (${describeError(err)}); switching to ${fallbackBackend}`,
      ]
        .filter(Boolean)
        .join('. ');
      await switchToFallbackBackendForRequest(requestedBackend, fallbackBackend);
    }
  }
}

/**
 * Loads KataGo's human SL net, which is a second network used only to predict how a
 * human of a given rank would move. It is kept separate from the main model: the
 * analysis itself always comes from the strong net.
 */
async function ensureHumanModel(
  modelUrl: string,
  onDownloadProgress?: (received: number, total: number) => void,
): Promise<KataGoModelV8Tf> {
  if (humanModel && loadedHumanModelUrl === modelUrl) return humanModel;

  const buf = await fetchModelWithCache(modelUrl, onDownloadProgress);
  if (looksLikeMarkup(buf)) throw modelResponseError(modelUrl);
  const parsed = parseKataGoModelV8(maybeUngzip(buf));
  if (parsed.metaEncoderVersion !== 1) {
    throw new Error('That model is not a human SL net (it has no metadata encoder)');
  }
  humanModel = new KataGoModelV8Tf(parsed);
  loadedHumanModelUrl = modelUrl;
  return humanModel;
}

/** Softmax over the board points of a logit array, ignoring the pass at the end. */
function softmaxOverBoard(logits: Float32Array): Float32Array {
  const out = new Float32Array(BOARD_AREA);
  let max = -Infinity;
  for (let p = 0; p < BOARD_AREA; p++) if (logits[p]! > max) max = logits[p]!;
  let sum = 0;
  for (let p = 0; p < BOARD_AREA; p++) {
    const v = Math.exp(logits[p]! - max);
    out[p] = v;
    sum += v;
  }
  if (sum > 0) for (let p = 0; p < BOARD_AREA; p++) out[p]! /= sum;
  return out;
}

/** Raw human-net policy logits for one position, including the pass at the end. */
async function computeHumanPolicyLogits(args: {
  modelUrl: string;
  profile: string;
  board: KataGoAnalyzeRequest['board'];
  previousBoard?: KataGoAnalyzeRequest['previousBoard'];
  previousPreviousBoard?: KataGoAnalyzeRequest['previousPreviousBoard'];
  currentPlayer: KataGoAnalyzeRequest['currentPlayer'];
  moveHistory: KataGoAnalyzeRequest['moveHistory'];
  komi: number;
  rules: GameRules;
  conservativePass: boolean;
}): Promise<Float32Array> {
  const net = await ensureHumanModel(args.modelUrl);
  const metaRow = humanSlMetadataRow({
    profile: args.profile,
    nextPlayer: args.currentPlayer,
    boardArea: BOARD_AREA,
  });
  if (!metaRow) throw new Error(`Unknown human profile "${args.profile}"`);

  fillInputsV7FastForPosition({
    board: args.board,
    previousBoard: args.previousBoard,
    previousPreviousBoard: args.previousPreviousBoard,
    currentPlayer: args.currentPlayer,
    moveHistory: args.moveHistory,
    komi: args.komi,
    rules: args.rules,
    conservativePassAndIsRoot: args.conservativePass,
    outSpatial: evalSpatialV7,
    outGlobal: evalGlobalV7,
  });

  const spatial = tf.tensor4d(evalSpatialV7, [1, BOARD_SIZE, BOARD_SIZE, 22]);
  const global = tf.tensor2d(evalGlobalV7, [1, 19]);
  const meta = tf.tensor2d(metaRow, [1, metaRow.length]);
  const out = net.forwardPolicyValue(spatial, global, meta);
  try {
    const [policyArr, passArr] = await Promise.all([out.policy.data(), out.policyPass.data()]);
    const channels = net.policyOutChannels;
    const logits = new Float32Array(BOARD_AREA + 1);
    for (let p = 0; p < BOARD_AREA; p++) logits[p] = (policyArr as Float32Array)[p * channels]!;
    logits[BOARD_AREA] = (passArr as Float32Array)[0]!;
    return logits;
  } finally {
    spatial.dispose();
    global.dispose();
    meta.dispose();
    out.policy.dispose();
    out.policyPass.dispose();
    out.value.dispose();
    out.scoreValue.dispose();
  }
}

/**
 * Turns raw human logits into a probability per legal move, using the search's own
 * policy array to say which moves are legal (illegal stays -1, as there).
 */
function humanPolicyFromLogits(logits: Float32Array, legality: ArrayLike<number>): Float32Array {
  const out = new Float32Array(BOARD_AREA + 1);
  let max = -Infinity;
  for (let p = 0; p <= BOARD_AREA; p++) {
    if (legality[p]! < 0) continue;
    if (logits[p]! > max) max = logits[p]!;
  }
  if (!Number.isFinite(max)) {
    out.fill(-1);
    return out;
  }
  let sum = 0;
  for (let p = 0; p <= BOARD_AREA; p++) {
    if (legality[p]! < 0) {
      out[p] = -1;
      continue;
    }
    const v = Math.exp(logits[p]! - max);
    out[p] = v;
    sum += v;
  }
  if (sum > 0) {
    for (let p = 0; p <= BOARD_AREA; p++) {
      if (out[p]! >= 0) out[p]! /= sum;
    }
  }
  return out;
}

function post(msg: KataGoWorkerResponse, transfer?: Transferable[]) {
  if (transfer && transfer.length > 0) self.postMessage(msg, transfer);
  else self.postMessage(msg);
}

async function handleMessage(msg: KataGoWorkerRequest): Promise<void> {
  if (msg.type === 'katago:init') {
    if (typeof msg.threadsCap === 'number') threadsCap = msg.threadsCap;
    await ensureModel(msg.modelUrl, msg.backend, (received, total) =>
      post({ type: 'katago:progress', stage: 'main', received, total }),
    );
    post({
      type: 'katago:init_result',
      ok: true,
      backend: describeTfBackend(),
      modelName: loadedModelName,
    });
    return;
  }

  if (msg.type === 'katago:warm_human') {
    try {
      await ensureHumanModel(msg.modelUrl, (received, total) =>
        post({ type: 'katago:progress', stage: 'human', received, total }),
      );
      post({ type: 'katago:warm_human_result', id: msg.id, ok: true });
    } catch (err) {
      post({
        type: 'katago:warm_human_result',
        id: msg.id,
        ok: false,
        error: describeError(err),
      });
    }
    return;
  }

  if (msg.type === 'katago:eval') {
    await ensureModel(msg.modelUrl, msg.backend);
    if (!model) throw new Error('Model not loaded');
    ensureBoardSizeForWorker(msg.board.length);
    if (lastWarmedSize !== BOARD_SIZE) {
      // 新棋盘尺寸的首批 TF 内核需要 JIT：零输入跑一次价值头预热，
      // 消除该尺寸第一手搜索的尖峰（~数百毫秒）
      lastWarmedSize = BOARD_SIZE;
      try {
        const wSpatial = tf.zeros([1, BOARD_SIZE, BOARD_SIZE, 22], 'float32') as tf.Tensor4D;
        const wGlobal = tf.zeros([1, 19], 'float32') as tf.Tensor2D;
        const wOut = model.forwardValueOnly(wSpatial, wGlobal);
        await Promise.allSettled([wOut.value.data(), wOut.scoreValue.data()]);
        wSpatial.dispose();
        wGlobal.dispose();
        wOut.value.dispose();
        wOut.scoreValue.dispose();
      } catch {
        // 预热失败不影响后续正式搜索
      }
    }
    const boardSize = BOARD_SIZE;

    const conservativePass = msg.conservativePass !== false;
    const rules: GameRules = isGameRules(msg.rules) ? msg.rules : 'japanese';

    fillInputsV7FastForPosition({
      board: msg.board,
      previousBoard: msg.previousBoard,
      previousPreviousBoard: msg.previousPreviousBoard,
      currentPlayer: msg.currentPlayer,
      moveHistory: msg.moveHistory,
      komi: msg.komi,
      rules,
      conservativePassAndIsRoot: conservativePass,
      outSpatial: evalSpatialV7,
      outGlobal: evalGlobalV7,
    });

    const spatial = tf.tensor4d(evalSpatialV7, [1, boardSize, boardSize, 22]);
    const global = tf.tensor2d(evalGlobalV7, [1, 19]);
    const out = model.forwardValueOnly(spatial, global);
    const [valueLogitsArr, scoreValueArr] = await Promise.all([out.value.data(), out.scoreValue.data()]);
    spatial.dispose();
    global.dispose();
    out.value.dispose();
    out.scoreValue.dispose();

    const evaled = postprocessKataGoV8({
      nextPlayer: msg.currentPlayer,
      valueLogits: valueLogitsArr,
      scoreValue: scoreValueArr,
      postProcessParams: model.postProcessParams,
      modelVersion: model.modelVersion,
    });

    post({
      type: 'katago:eval_result',
      id: msg.id,
      ok: true,
      backend: describeTfBackend(),
      modelName: loadedModelName,
      eval: {
        rootWinRate: evaled.blackWinProb,
        rootScoreLead: evaled.blackScoreLead,
        rootScoreSelfplay: evaled.blackScoreMean,
        rootScoreStdev: evaled.blackScoreStdev,
      },
    });
    return;
  }

  if (msg.type === 'katago:eval_batch') {
    await ensureModel(msg.modelUrl, msg.backend);
    if (!model) throw new Error('Model not loaded');

    const conservativePass = msg.conservativePass !== false;
    const rules: GameRules = isGameRules(msg.rules) ? msg.rules : 'japanese';

    const batch = msg.positions.length;
    if (batch <= 0) {
      post({
        type: 'katago:eval_batch_result',
        id: msg.id,
        ok: true,
        backend: describeTfBackend(),
        modelName: loadedModelName,
        evals: [],
      });
      return;
    }

    const boardSize = msg.positions[0] ? msg.positions[0].board.length : BOARD_SIZE;
    ensureBoardSizeForWorker(boardSize);
    const size = BOARD_SIZE;

    const { spatial: spatialBatch, global: globalBatch } = getEvalBatchBuffersV7(batch);

    for (let i = 0; i < batch; i++) {
      const pos = msg.positions[i]!;
      fillInputsV7FastForPosition({
        board: pos.board,
        previousBoard: pos.previousBoard,
        previousPreviousBoard: pos.previousPreviousBoard,
        currentPlayer: pos.currentPlayer,
        moveHistory: pos.moveHistory,
        komi: pos.komi,
        rules,
        conservativePassAndIsRoot: conservativePass,
        outSpatial: spatialBatch.subarray(i * V7_SPATIAL_STRIDE, (i + 1) * V7_SPATIAL_STRIDE),
        outGlobal: globalBatch.subarray(i * V7_GLOBAL_STRIDE, (i + 1) * V7_GLOBAL_STRIDE),
      });
    }

    const spatial = tf.tensor4d(spatialBatch, [batch, size, size, 22]);
    const global = tf.tensor2d(globalBatch, [batch, 19]);
    const out = model.forwardValueOnly(spatial, global);
    const [valueLogitsArr, scoreValueArr] = await Promise.all([out.value.data(), out.scoreValue.data()]);
    spatial.dispose();
    global.dispose();
    out.value.dispose();
    out.scoreValue.dispose();

    const scoreChannels = model.scoreValueChannels;
    const evals = new Array(batch);
    for (let i = 0; i < batch; i++) {
      const evaled = postprocessKataGoV8({
        nextPlayer: msg.positions[i]!.currentPlayer,
        valueLogits: valueLogitsArr.subarray(i * 3, i * 3 + 3),
        scoreValue: scoreValueArr.subarray(i * scoreChannels, i * scoreChannels + scoreChannels),
        postProcessParams: model.postProcessParams,
        modelVersion: model.modelVersion,
      });
      evals[i] = {
        rootWinRate: evaled.blackWinProb,
        rootScoreLead: evaled.blackScoreLead,
        rootScoreSelfplay: evaled.blackScoreMean,
        rootScoreStdev: evaled.blackScoreStdev,
      };
    }

    post({
      type: 'katago:eval_batch_result',
      id: msg.id,
      ok: true,
      backend: describeTfBackend(),
      modelName: loadedModelName,
      evals,
    });
    return;
  }

  if (msg.type === 'katago:analyze') {
    // 出队即回执：主线程的看门狗以此刻为「初始化阶段」起点（模型/预热/人味网前向），
    // 「搜索阶段」回执在真正开搜前发出；排队（如人味网预热）不计时
    post({ type: 'katago:analyze_ack', id: msg.id, phase: 'dequeue' });
    if (typeof msg.threadsCap === 'number') threadsCap = msg.threadsCap;
    const meta = analyzeMeta.get(msg);
    const analysisGroup = meta?.analysisGroup ?? msg.analysisGroup ?? 'background';
    const interactiveTokenAtEnqueue = meta?.interactiveToken ?? interactiveToken;
    const shouldAbort = createAnalyzeAbortCheck({
      analysisGroup,
      requestId: msg.id,
      interactiveTokenAtEnqueue,
      latestIdForGroup: () => latestAnalyzeByGroup.get(analysisGroup),
      currentInteractiveToken: () => interactiveToken,
    });
    const postCanceled = () =>
      post({
        type: 'katago:analyze_result',
        id: msg.id,
        ok: false,
        canceled: true,
        error: 'canceled',
      });

    if (shouldAbort()) {
      postCanceled();
      return;
    }

    await ensureModel(msg.modelUrl, msg.backend);
    if (!model) throw new Error('Model not loaded');
    if (shouldAbort()) {
      postCanceled();
      return;
    }

    ensureBoardSizeForWorker(msg.board.length);
    const boardSize = BOARD_SIZE;

    const maxVisits = Math.max(16, Math.min(msg.visits ?? 256, ENGINE_MAX_VISITS));
    const maxTimeMs = Math.max(25, Math.min(msg.maxTimeMs ?? 800, ENGINE_MAX_TIME_MS));
    const batchSize = Math.max(1, Math.min(msg.batchSize ?? (tf.getBackend() === 'webgpu' ? 16 : 8), 64));
    const maxChildren = Math.max(4, Math.min(msg.maxChildren ?? 64, BOARD_AREA));
    const topK = Math.max(1, Math.min(msg.topK ?? 10, 50));
    const includeMovesOwnership = msg.includeMovesOwnership === true;
    const requestedOwnershipMode: OwnershipMode = msg.ownershipMode ?? 'root';
    const ownershipMode: OwnershipMode = includeMovesOwnership ? 'tree' : requestedOwnershipMode;
    const analysisPvLen = Math.max(0, Math.min(msg.analysisPvLen ?? 15, 60));
    const wideRootNoise = Math.max(0, Math.min(msg.wideRootNoise ?? 0.04, 5));
    const rootPolicyTemperature = Math.max(0.01, Math.min(msg.rootPolicyTemperature ?? 1, 100));
    const fillDameBeforePass = msg.fillDameBeforePass !== false;
    // KataGo clamps playoutDoublingAdvantage to +/-3 in its own configs.
    const playoutDoublingAdvantage = Math.max(-3, Math.min(msg.playoutDoublingAdvantage ?? 0, 3));
    const playoutDoublingAdvantagePla = msg.playoutDoublingAdvantagePla === 'white' ? 'white' : 'black';
    const rules: GameRules = isGameRules(msg.rules) ? msg.rules : 'japanese';
    const nnRandomize = msg.nnRandomize !== false;
    const rootSymmetrySamples = rootSymmetrySamplesForBackend(tf.getBackend());
    const conservativePass = msg.conservativePass !== false;
    const roiKey = regionKey(msg.regionOfInterest);
    const reportEveryMsRaw = msg.reportDuringSearchEveryMs;
    const reportEveryMs =
      typeof reportEveryMsRaw === 'number' && Number.isFinite(reportEveryMsRaw)
        ? Math.max(0, reportEveryMsRaw)
        : 0;
    const shouldReport = reportEveryMs > 0;
    const cloneBuffers = msg.reuseTree === true || shouldReport;
    const humanSlRootExploreProb = Math.max(0, Math.min(1, msg.humanSlRootExploreProb ?? 0));
    const humanKey =
      msg.humanModelUrl && msg.humanSlProfile
        ? `${msg.humanSlProfile}@${msg.humanModelUrl}#${humanSlRootExploreProb}`
        : null;

    // KataGo avoidMoveUntilByLoc: how deep into the search each move stays off
    // limits for each player, which is how an analysis answers "and if that move
    // were not available?". An untilDepth of 1 bans it at the root alone.
    const avoidParts: string[] = [];
    let avoidMoveUntilBlack: Int32Array | null = null;
    let avoidMoveUntilWhite: Int32Array | null = null;
    const avoidArrayFor = (player: Player): Int32Array => {
      if (player === 'black') return (avoidMoveUntilBlack ??= new Int32Array(BOARD_AREA + 1));
      return (avoidMoveUntilWhite ??= new Int32Array(BOARD_AREA + 1));
    };
    const moveIndexOf = (move: { x: number; y: number }): number => {
      if (move.x < 0 || move.y < 0) return BOARD_AREA;
      if (move.x >= BOARD_SIZE || move.y >= BOARD_SIZE) return -1;
      return move.y * BOARD_SIZE + move.x;
    };
    for (const move of msg.avoidMoves ?? []) {
      const idx = moveIndexOf(move);
      if (idx < 0) continue;
      const untilDepth = Math.max(1, Math.min(Math.floor(move.untilDepth ?? 1), 1000));
      const player: Player = move.player ?? msg.currentPlayer;
      avoidArrayFor(player)[idx] = untilDepth;
      avoidParts.push(`a${player[0]}${idx}:${untilDepth}`);
    }
    // allowMoves is the complement: everything else is off limits for that player.
    for (const allow of msg.allowMoves ?? []) {
      const player: Player = allow.player ?? msg.currentPlayer;
      const untilDepth = Math.max(1, Math.min(Math.floor(allow.untilDepth ?? 1), 1000));
      const allowed = new Set<number>();
      for (const move of allow.moves) {
        const idx = moveIndexOf(move);
        if (idx >= 0) allowed.add(idx);
      }
      if (allowed.size === 0) continue;
      const array = avoidArrayFor(player);
      for (let p = 0; p <= BOARD_AREA; p++) {
        if (!allowed.has(p)) array[p] = untilDepth;
      }
      avoidParts.push(`l${player[0]}${[...allowed].sort((x, y) => x - y).join(',')}:${untilDepth}`);
    }
    const avoidKey = avoidParts.length > 0 ? avoidParts.sort().join(' ') : null;

    // The human policy is about the position, not the search, so it is computed up
    // front: its favourite moves are added to the root so the report says what they
    // are worth, and the same numbers are reported alongside the analysis.
    // 结果按 humanKey+positionKey 缓存：搜索树复用命中时不再重算人味网前向。
    let humanLogits: Float32Array | null = null;
    let humanPolicyError: string | undefined;
    if (msg.humanModelUrl && msg.humanSlProfile) {
      const cacheKey = `${humanKey}|${msg.positionKey ?? msg.positionId ?? ''}`;
      const cached = humanLogitsCache.get(cacheKey);
      if (cached) {
        humanLogits = cached;
      } else {
        try {
          humanLogits = await computeHumanPolicyLogits({
            modelUrl: msg.humanModelUrl,
            profile: msg.humanSlProfile,
            board: msg.board,
            previousBoard: msg.previousBoard,
            previousPreviousBoard: msg.previousPreviousBoard,
            currentPlayer: msg.currentPlayer,
            moveHistory: msg.moveHistory,
            komi: msg.komi,
            rules,
            conservativePass,
          });
          humanLogitsCache.set(cacheKey, humanLogits);
          if (humanLogitsCache.size > 8) {
            const oldest = humanLogitsCache.keys().next().value;
            if (oldest !== undefined) humanLogitsCache.delete(oldest);
          }
        } catch (err) {
          // A missing or broken human net must not take the real analysis down with it.
          humanPolicyError = err instanceof Error ? err.message : String(err);
        }
      }
    }
    const humanMovePriors = humanLogits ? softmaxOverBoard(humanLogits) : null;

    const canReuse =
      msg.reuseTree === true &&
      typeof msg.positionId === 'string' &&
      !!search &&
      !!searchKey &&
      searchKey.positionId === msg.positionId &&
      searchKey.positionKey === (msg.positionKey ?? null) &&
      searchKey.modelUrl === msg.modelUrl &&
      searchKey.boardSize === boardSize &&
      searchKey.maxChildren === maxChildren &&
      searchKey.ownershipMode === ownershipMode &&
      searchKey.komi === msg.komi &&
      searchKey.currentPlayer === msg.currentPlayer &&
      searchKey.wideRootNoise === wideRootNoise &&
      searchKey.rootPolicyTemperature === rootPolicyTemperature &&
      searchKey.fillDameBeforePass === fillDameBeforePass &&
      searchKey.playoutDoublingAdvantage === playoutDoublingAdvantage &&
      searchKey.playoutDoublingAdvantagePla === playoutDoublingAdvantagePla &&
      searchKey.rootSymmetrySamples === rootSymmetrySamples &&
      searchKey.rules === rules &&
      searchKey.nnRandomize === nnRandomize &&
      searchKey.conservativePass === conservativePass &&
      searchKey.roiKey === roiKey &&
      searchKey.humanKey === humanKey &&
      searchKey.avoidKey === avoidKey;

    let reusedSearch = canReuse;

    // Re-root the existing search when the new position is a direct child of the current root.
    if (
      !reusedSearch &&
      msg.reuseTree === true &&
      search &&
      searchKey &&
      typeof msg.positionId === 'string' &&
      typeof msg.parentPositionId === 'string'
    ) {
      const canReRoot =
        searchKey.positionId === msg.parentPositionId &&
        searchKey.positionKey === (msg.parentPositionKey ?? null) &&
        searchKey.modelUrl === msg.modelUrl &&
        searchKey.maxChildren === maxChildren &&
        searchKey.ownershipMode === ownershipMode &&
        searchKey.komi === msg.komi &&
        searchKey.wideRootNoise === wideRootNoise &&
        searchKey.rootPolicyTemperature === rootPolicyTemperature &&
        searchKey.fillDameBeforePass === fillDameBeforePass &&
        searchKey.playoutDoublingAdvantage === playoutDoublingAdvantage &&
        searchKey.playoutDoublingAdvantagePla === playoutDoublingAdvantagePla &&
        searchKey.rootSymmetrySamples === rootSymmetrySamples &&
        searchKey.rules === rules &&
        searchKey.nnRandomize === nnRandomize &&
        searchKey.conservativePass === conservativePass &&
        searchKey.roiKey === roiKey &&
        searchKey.humanKey === humanKey &&
        searchKey.avoidKey === avoidKey;

      if (canReRoot) {
        const lastMove = msg.moveHistory[msg.moveHistory.length - 1] ?? null;
        const move =
          lastMove && lastMove.x >= 0 && lastMove.y >= 0 ? lastMove.y * BOARD_SIZE + lastMove.x : PASS_MOVE;
        if (lastMove) {
          const reRooted = await search.reRootToChild({
            move,
            board: msg.board,
            previousBoard: msg.previousBoard,
            previousPreviousBoard: msg.previousPreviousBoard,
            currentPlayer: msg.currentPlayer,
            moveHistory: msg.moveHistory,
            komi: msg.komi,
            rules,
            regionOfInterest: msg.regionOfInterest,
          });
          if (reRooted) {
            reusedSearch = true;
            searchKey = {
              positionId: msg.positionId,
              positionKey: msg.positionKey ?? null,
              modelUrl: msg.modelUrl,
              boardSize,
              maxChildren,
              ownershipMode,
              komi: msg.komi,
              currentPlayer: msg.currentPlayer,
              wideRootNoise,
              rootPolicyTemperature,
              fillDameBeforePass,
              playoutDoublingAdvantage,
              playoutDoublingAdvantagePla,
              rootSymmetrySamples,
              rules,
              nnRandomize,
              conservativePass,
              roiKey,
              humanKey,
              avoidKey,
            };
          }
        }
      }
    }

    if (!reusedSearch) {
      search = await MctsSearch.create({
        model,
        board: msg.board,
        previousBoard: msg.previousBoard,
        previousPreviousBoard: msg.previousPreviousBoard,
        currentPlayer: msg.currentPlayer,
        moveHistory: msg.moveHistory,
        komi: msg.komi,
        rules,
        nnRandomize,
        conservativePass,
        maxChildren,
        ownershipMode,
        wideRootNoise,
        rootPolicyTemperature,
        fillDameBeforePass,
        playoutDoublingAdvantage,
        playoutDoublingAdvantagePla,
        rootSymmetrySamples,
        regionOfInterest: msg.regionOfInterest,
        humanPolicy: humanMovePriors,
        humanSlRootExploreProbWeightless: humanSlRootExploreProb,
        avoidMoveUntilBlack,
        avoidMoveUntilWhite,
      });
      if (typeof msg.positionId === 'string') {
        searchKey = {
          positionId: msg.positionId,
          positionKey: msg.positionKey ?? null,
          modelUrl: msg.modelUrl,
          boardSize,
          maxChildren,
          ownershipMode,
          komi: msg.komi,
          currentPlayer: msg.currentPlayer,
          wideRootNoise,
          rootPolicyTemperature,
          fillDameBeforePass,
          playoutDoublingAdvantage,
          playoutDoublingAdvantagePla,
          rootSymmetrySamples,
          rules,
          nnRandomize,
          conservativePass,
          roiKey,
          humanKey,
          avoidKey,
        };
      } else {
        searchKey = null;
      }
    }

    const postAnalysis = (analysis: ReturnType<MctsSearch['getAnalysis']>, type: 'katago:analyze_update' | 'katago:analyze_result') => {
      if (humanLogits) {
        const humanPolicy = humanPolicyFromLogits(humanLogits, analysis.policy);
        analysis.humanPolicy = humanPolicy;
        for (const move of analysis.moves) {
          const pos = move.x < 0 || move.y < 0 ? BOARD_AREA : move.y * BOARD_SIZE + move.x;
          const prior = humanPolicy[pos] ?? -1;
          if (prior >= 0) move.humanPrior = prior;
        }
      }
      post(
        {
          type,
          id: msg.id,
          ok: true,
          backend: describeTfBackend(),
          modelName: loadedModelName,
          analysis,
          humanPolicyError,
        },
        collectAnalysisTransferables(analysis)
      );
    };

    const buildAnalysis = () =>
      search!.getAnalysis({
        topK,
        includeMovesOwnership,
        analysisPvLen,
        cloneBuffers,
        ownershipRefreshIntervalMs: msg.ownershipRefreshIntervalMs,
      });

    if (!shouldReport) {
      // 所有前置工作（模型初始化/换尺寸预热/人味网前向）已就绪，即将开搜：
      // 主线程看门狗据此切换到「预算+宽限」阶段
      post({ type: 'katago:analyze_ack', id: msg.id, phase: 'search' });
      const deadline0 = getAnimationNow() + maxTimeMs;
      // 高访问量档（认真度高档）走时间片收敛循环：每 800ms 检查一次，
      // 最佳点连续两轮稳定且胜率波动极小时提前落子；低档单次搜满
      let converged = false;
      if (maxVisits >= 2000) {
        const deadline2 = getAnimationNow() + maxTimeMs;
        let slices = 0;
        let prevBest: string | null = null;
        let prevWr = NaN;
        while (true) {
          if (shouldAbort()) {
            postCanceled();
            if (msg.reuseTree !== true) {
              search = null;
              searchKey = null;
            }
            return;
          }
          const remainingMs = deadline2 - getAnimationNow();
          if (remainingMs <= 0) break;
          const aborted = await search!.run({
            visits: maxVisits,
            maxTimeMs: Math.min(800, remainingMs),
            batchSize,
            shouldAbort,
          });
          if (aborted || shouldAbort()) {
            postCanceled();
            if (msg.reuseTree !== true) {
              search = null;
              searchKey = null;
            }
            return;
          }
          slices++;
          const snapAnalysis0 = search!.getAnalysis({
            topK: 1,
            includeMovesOwnership: false,
            analysisPvLen: 0,
            cloneBuffers: false,
            ownershipRefreshIntervalMs: 1e9,
          });
          if (snapAnalysis0.rootVisits >= maxVisits) break;
          // 轻量快照：只看最佳点稳定性（不做 ownership/PV 的完整构建）
          const snapAnalysis = snapAnalysis0;
          const best = snapAnalysis.moves.find((m) => m.order === 0) ?? snapAnalysis.moves[0];
          if (!best) break;
          const bestKey = best.x < 0 || best.y < 0 ? 'pass' : `${best.x},${best.y}`;
          if (
            slices >= 3 &&
            snapAnalysis0.rootVisits >= maxVisits * 0.25 &&
            getAnimationNow() - (deadline2 - maxTimeMs) >= 1200 &&
            prevBest === bestKey &&
            Math.abs(snapAnalysis.rootWinRate - prevWr) < 0.005
          ) {
            converged = true;
            break;
          }
          prevBest = bestKey;
          prevWr = snapAnalysis.rootWinRate;
        }
      }
      if (!converged) {
        const remainingMs = Math.max(0, maxTimeMs - (getAnimationNow() - (deadline0 ?? getAnimationNow())));
        const aborted = await search!.run({ visits: maxVisits, maxTimeMs: remainingMs, batchSize, shouldAbort });
        if (aborted || shouldAbort()) {
          postCanceled();
          if (msg.reuseTree !== true) {
            search = null;
            searchKey = null;
          }
          return;
        }
      }
      postAnalysis(buildAnalysis(), 'katago:analyze_result');
      if (msg.reuseTree !== true) {
        search = null;
        searchKey = null;
      }
      return;
    }

    // 上面的非报告路径未走时（报告模式），同样在开搜前发出 search 阶段回执
    if (shouldReport) {
      post({ type: 'katago:analyze_ack', id: msg.id, phase: 'search' });
    }
    const deadline = getAnimationNow() + maxTimeMs;
    let lastReportVisits = -1;
    while (true) {
      if (shouldAbort()) {
        postCanceled();
        if (msg.reuseTree !== true) {
          search = null;
          searchKey = null;
        }
        return;
      }
      const now = getAnimationNow();
      const remaining = deadline - now;
      if (remaining <= 0) break;
      const sliceMs = Math.min(reportEveryMs, remaining);
      const aborted = await search!.run({ visits: maxVisits, maxTimeMs: sliceMs, batchSize, shouldAbort });
      if (aborted || shouldAbort()) {
        postCanceled();
        if (msg.reuseTree !== true) {
          search = null;
          searchKey = null;
        }
        return;
      }
      const analysis = buildAnalysis();
      const done = analysis.rootVisits >= maxVisits || getAnimationNow() >= deadline;
      if (done) {
        postAnalysis(analysis, 'katago:analyze_result');
        if (msg.reuseTree !== true) {
          search = null;
          searchKey = null;
        }
        return;
      }
      if (analysis.rootVisits > lastReportVisits) {
        lastReportVisits = analysis.rootVisits;
        postAnalysis(analysis, 'katago:analyze_update');
      }
    }

    postAnalysis(buildAnalysis(), 'katago:analyze_result');
    if (msg.reuseTree !== true) {
      search = null;
      searchKey = null;
    }
  }
}

self.onmessage = (ev: MessageEvent<KataGoWorkerRequest>) => {
  const msg = ev.data;
  if (msg.type === 'katago:analyze') {
    const analysisGroup = msg.analysisGroup ?? 'background';
    latestAnalyzeByGroup.set(analysisGroup, msg.id);
    if (analysisGroup === 'interactive') interactiveToken++;
    analyzeMeta.set(msg, { analysisGroup, interactiveToken });
  }
  queue = queue
    .then(() => handleMessage(msg))
    .catch((err: unknown) => {
      if (msg.type === 'katago:init') {
        post({
          type: 'katago:init_result',
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
        return;
      }
      if (msg.type === 'katago:warm_human') {
        post({
          type: 'katago:warm_human_result',
          id: msg.id,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
        return;
      }
      if (msg.type === 'katago:eval') {
        post({
          type: 'katago:eval_result',
          id: msg.id,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
        return;
      }
      if (msg.type === 'katago:eval_batch') {
        post({
          type: 'katago:eval_batch_result',
          id: msg.id,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
        return;
      }
      if (msg.type === 'katago:analyze') {
        post({
          type: 'katago:analyze_result',
          id: msg.id,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
        return;
      }
    });
};
