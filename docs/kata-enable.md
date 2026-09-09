# KataGo 接入现状

最后更新：2026-09-09（web-katrain TS 引擎接入完成，19 路 b18 网络实跑通过）

## 当前架构

- 引擎：**web-katrain**（MIT，© 2026 Web KatRain Contributors）的 TypeScript
  引擎层，位于 `src/engine/katago/`。在独立 Worker 中用 TensorFlow.js
  直接构建并运行 KataGo v8+ 网络计算图，配 PUCT/MCTS 搜索；**直接解析
  KataGo 原生 `.bin.gz` 模型，无需任何 TFJS 转换**。
- 模型：`public/models/kata1-b18c384nbt-s9996604416-d4316597426.bin.gz`
  （约 93MB，19 路全棋盘，katagotraining.org，CC BY-NC 4.0）。
  另有 `g170-b6c96-*.bin.gz`（3.6MB）作小型测试网络。
- 适配层：`src/engine/katagoTsBackend.ts` 实现项目 EngineBackend 协议
  （genmove / evaluate / benchmark），含棋盘重放（当前/前两个局面快照）、
  pickMode 选点（best / narrow / wide 温度抽样）、搜索树复用（positionId
  父子关系驱动 re-root）。
- 门控：`engineFacade.ts` 就绪等待 120s（首次需下载 93MB 模型 + 建图），
  失败自动回退内置 UCT Worker，页面不受影响。
- 后端：TFJS wasm（`public/tfjs/` 内的 4.22 wasm）。跨源隔离（COOP/COEP）
  已由 vite dev server 配置；线程化 wasm 需要 threaded-simd worker.js，
  当前未随附（见 ASSETS.md），会自动用单线程 SIMD。
- 无头验证：`node scripts/kata-verify.mjs`（落子→AI 应答→解说→胜率条，
  2026-09-09 通过：b18 网络 11s 应答，解说「三之五」，黑 9%）。

## 已放弃的方案（存档）

emscripten 版 KataGo on Browser（`public/katago/`，y-ich/a_teacher_of_go）：
落子卡死的根因是嵌套 Worker 引导 bug（胶水拿不到自身 URL，pthread 子线程
重复引导引擎），已定位并修复（`Module['mainScriptUrlOrBlob']`），引擎可在
Worker 内正常启动；但上游没有 ≥19 路的现成 web_model（nnXLen 7 的演示模型
会使 boardsize 9 永久挂起），官方转换链为 TensorFlow 1.x 工具链，本地难以
复现，故整体弃用。该目录不再被 index.html 加载。

## 遗留事项

- 认真程度滑条已生效（映射到 visits / maxTimeMs / pickMode）。
- 人味 SL（「秀策流」棋风）已接入：`public/models/b18c384nbt-humanv0.bin.gz`
  （约 94MB）作为 policy 先验，`proyear_1850`（1850 年代日本职业）档位；
  选点复刻 KataGo 官方 human-bot 配置（chosenMove.ts 内置 imitate/search
  两套预设）。设置面板「秀策流 / 现代最强」切换；认真程度 ≥8 时自动从
  纯模仿切到「人形 + 搜索托底」。价值判断始终来自主力 b18 网络。
- 秀策开局库已建成（2026-09-09，479 局）：`data/sgf/shusaku/*.sgf` →
  `node scripts/build-shusaku-book.mjs [深度]` → `src/data/shusaku-book.json`
  （5736 手秀策着法 / 11472 节点，黑 1 右上小目 ×149 局）。引擎在路径命中
  时按秀策实际着法加权选点，合法性校验兜底；胜率照常来自搜索。
- 模型缓存：Worker 经 `katago/modelCache.ts` 走 IndexedDB（键=模型 URL），
  首次下载后不再重复拉取；隐私模式/配额不足自动回退网络。
- 推理后端：WebGPU 优先，引擎内置 webgpu→wasm→cpu 回退链（无头验证已
  走通回退路径）。threaded wasm worker.js 仍待补（复制曾被安全扫描器拦截）。
