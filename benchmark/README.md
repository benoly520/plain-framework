# Plain 基准（benchmark）

企业选型时最常被问的两个硬指标：**包体积**与**运行时性能**。本目录给出起步件。

## 包体积（已可用）

`size.mjs` 把「一个最小计数器应用 + 框架」分别用 Plain 与 React 打包，对比 minify + gzip 后的体积：

```bash
pnpm run build        # 先把框架编译进 dist/
node benchmark/size.mjs
```

它反映的是「应用产物里要带多少框架运行时」——Plain 编译到 DOM、零虚拟 DOM，
运行时极小；React 需要带上 react + react-dom。数字说话，不靠口号。

## 运行时性能（待补）

运行时渲染 / 更新性能必须在**真实浏览器**里测（jsdom 不具代表性）。
框架已有 `test/browser.mjs`（Playwright + 真实 Chromium）走完整应用，
可以作为运行时基准的母版：在其基础上加「N 个节点批量更新」与「首屏 TTI」两类测量即可。
这条路待补，欢迎 PR。

## 约定

所有数字都要**可复现**：跑之前先 `pnpm run build`，写明运行环境（Node 版本、OS、CPU），
不要拿 dev 模式的数字当生产数字。
