项目第三方资产说明
==================

## 当前引擎：web-katrain（src/engine/katago/）

- 来源：https://github.com/Sir-Teo/web-katrain
- 许可：MIT License（© 2026 Web KatRain Contributors，全文见
  src/engine/katago/LICENSE-web-katrain.txt）
- 组成：KataGo v8+ 二进制模型解析、TFJS 计算图构建、v7 特征提取、
  PUCT/MCTS 搜索、Worker 封装。TypeScript 实现，运行于浏览器 Worker。
- 本地适配（本项目）：src/engine/katagoTsBackend.ts 把引擎接到项目的
  EngineBackend 协议；src/types.ts 与 src/utils/ 下的六个小工具取自同仓库。

## 模型文件（public/models/）

- kata1-b18c384nbt-s9996604416-d4316597426.bin.gz（约 93MB，主力网络）
  - 来源：https://media.katagotraining.org/uploaded/networks/models/kata1/kata1-b18c384nbt-s9996604416-d4316597426.bin.gz
  - 许可：CC BY-NC 4.0（katagotraining.org kata1 系列；本项目为非商业
    爱好项目）。19 路全棋盘，含人味 SL 元数据。
- b18c384nbt-humanv0.bin.gz（约 94MB，人味 SL 网）
  - 来源：https://github.com/lightvector/KataGo/releases/download/v1.15.0/b18c384nbt-humanv0.bin.gz
  - 许可：CC BY-NC 4.0（KataGo 官方 release；本项目为非商业爱好项目）。
    按段位/年代预测人类着法（policy 专用），「秀策流」棋风的数据来源，
    使用 proyear_1850（1850 年代日本职业）档位。
- g170-b6c96-s175395328-d26788732.bin.gz（约 3.6MB，小型测试网络）
  - 来源：https://github.com/lightvector/KataGo（cpp/tests/models）
  - 用途：开发调试。与主力网络同格式。

## TFJS 运行时（public/tfjs/）

- tfjs-backend-wasm*.wasm：@tensorflow/tfjs-backend-wasm 4.22.x
  （Apache-2.0），由 node_modules 复制，供 Worker 内 wasm 后端使用。
  注意：threaded-simd 的 worker.js 未随附（安全扫描器拦截复制），
  跨源隔离下线程化不可用时会自动回退单线程 SIMD。

## 已移除：旧 emscripten 方案（原 public/katago/）

2026-09-09 起整体移除（不再被任何代码加载，安全扫描器对其 GTP 文本协议存在误报）。
当时的内容为 katago.js / katago.wasm / katago.worker.js / pre_pre.js / gtp_auto.cfg
/ 7×7 演示 web_model 及 TFJS 3.0 副本，均来自：

- https://github.com/new3Rs/a_teacher_of_go （MIT License, © 2020 ICHIKAWA, Yuji / New 3 Rs）
- 上游项目：https://github.com/y-ich/KataGo （KataGo on Browser，Apache-2.0）

如需查阅或复用，请从上述上游仓库重新获取；历史记录见 docs/kata-enable.md。
另：public/gtp_auto.cfg 为该方案残留的配置文件，当前引擎不使用。
