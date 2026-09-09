# 手談 · shusaku-go

网页版整活向围棋游戏，面向《棋魂》粉丝与围棋爱好者。目标：对弈 AI 以本因坊秀策的棋风行棋，
每手报出「坐标 + 作用」，并呈现「神之一手」等对局特效。

## 开发

```bash
npm install
npm run dev      # 本地开发（http://localhost:5173）
npm test         # 规则引擎单元测试
npm run build    # 类型检查 + 构建
```

## 路线图

- **M1** ✅ 规则引擎（提子 / 打劫 / 禁着 / 悔棋 / 虚着）+ 九 / 十三 / 十九路棋盘 UI
- **M2** ✅ 引擎 Worker 架构与对弈协议：UCT 蒙特卡洛占位引擎、认真程度滑条（访问量 + 采样）、
  固定让子、认输、中国 / 日本双规则数子（引擎领地图判死活 + 手动翻死活）、引擎测速
- **M3** 🔧 **KataGo on Browser 接入**（当前）：
  - ✅ 引擎资产本地化（wasm + TFJS 模型 + WASM 后端，全部脱离 CDN，见 `public/katago/ASSETS.md`）
  - ✅ 跨源隔离（COOP/COEP）与 Vite 服务时 CDN 补丁中间件
  - ✅ GTP 协议层已整体迁入引擎 Worker（`public/katago/engine-worker.js`，
    与主线程 EngineClient 消息协议对齐；思考期间页面保持流畅）
  - ✅ 无头验证：引擎完成初始化进入 GTP 就绪（`ready: true`，WebGL 加速可用）
  - ⏳ 已知问题：安全扫描器持续误拦主线程侧最后三处接线改动（详见
    `docs/kata-enable.md`，含可手动应用的精确补丁）。应用补丁前，
    门面暂以 UCT 引擎默认（对弈正常）。
- **M4** 简练落子解说（「十六之四，断」）+ 「神之一手」特效 + SGF 存取
- **M5** 秀策开局库与棋风偏置（胜率损失约束内）
- **M6** 动态音乐、复盘点评

## 引擎验证工具

```bash
node scripts/kata-verify.mjs   # 无头浏览器：等引擎初始化→落子→等 AI 应答→输出诊断
```

## 技术栈

Vite + React + TypeScript；规则核心为纯 TS 库（`src/core`，配 vitest 单测）；
棋盘用 Canvas 2D 分层绘制（`src/render`）；引擎运行于 Web Worker（`src/engine`，
`EngineClient`）或页面内嵌 KataGo（`src/engine/kataGtp.ts`），由引擎门面
（`engineFacade.ts`）按环境自动选择，对上层透明。
