# 构建产物与分发：`dist/` 的形状、为什么不压缩

> 目的：把 `dist/` 长什么样、**为什么不做压缩 / 混淆**、发布前该收敛什么，一次讲清。
> 以后再有人问「包还能不能更小」「为什么不 minify」，答案有唯一锚点，不必重新推导。
>
> 与其它文档的分工：
> - [`README.md`](../README.md)：框架怎么用（英文，面向使用者）。
> - [`CONTRIBUTING.md`](../CONTRIBUTING.md)：进仓后怎么干活（环境 / 锁文件 / 提交 / 改动要求）。
> - [`benchmark/README.md`](../benchmark/README.md)：体积与运行性能怎么量。
> - **本文件**：构建产物长什么样、为什么长这样、发布要收什么。
>
> 纪律：**不压缩、不混淆、不预打包**是当前约定。要改先读 §5 的连带影响。

---

## 1. `dist/` 是怎么来的

`package.json` 里 `"build": "tsc"` —— 整条链路只有 TypeScript 编译器，没有 bundler，
没有 terser，没有 esbuild 压缩步骤。关键 `compilerOptions`（[`tsconfig.json`](../tsconfig.json)）：

| 选项 | 值 | 直接后果 |
| --- | --- | --- |
| `target` / `module` | `ES2022` / `NodeNext` | 输出原生 ESM，保留 `import` 语句 |
| `declaration` | `true` | 每个 `.js` 旁边有 `.d.ts` |
| `declarationMap` | `true` | 编辑器「跳转到源码」落到 `src/`，不是 `.d.ts` |
| `sourceMap` | `true` | 每个 `.js` 旁边有 `.js.map` |
| `outDir` / `rootDir` | `dist` / `src` | **逐文件一一对应**，不合并、不重排 |

所以产物是「**`src/` 的 ESM 镜像**」：`src/runtime/dom.ts` → `dist/runtime/dom.js` + `.d.ts` + `.js.map`。
当前规模：128 个文件 / 约 1.0 MB，其中 `*.map` 约 448 KB（≈45%）。

消费入口由 `exports` 映射（[`package.json`](../package.json#L25-L47)）：

| 子路径 | 指向 |
| --- | --- |
| `plain` | `dist/runtime/index.js` |
| `plain/vite` | `dist/vite/index.js` |
| `plain/server` | `dist/server/index.js` |
| `plain/router` | `dist/runtime/router.js` |
| `plain/testing` | `dist/testing/index.js` |

`dist/` 在 [`.gitignore`](../.gitignore) 里，**不进版本库**：本地或 CI 跑 `pnpm run build` 生成，
`files` 字段决定发布时只带 `dist` 与几份 md。

---

## 2. 为什么运行时不做预压缩

### 2.1 压缩发生在「使用者那一侧」，而且一定会发生

`plain` 被 `exports` 直接指到逐文件 ESM，使用者的 Vite / Rollup 把它当普通依赖：
dev 阶段 esbuild `optimizeDeps` 预打包到 `node_modules/.vite`（本地读写，无网络成本），
build 阶段 Rollup 合并 + esbuild minify。**框架先压缩一遍，等于同一件事做两遍，终端体积一分不省。**

想验证「压缩能省多少」见 §3 —— 那 3.5 KB 是使用者构建里本来就会拿到的收益。

### 2.2 预压缩会主动放弃 tree-shaking

`"sideEffects": false` + 逐文件模块结构，是「只用到 `signal` 的应用能甩掉 SSR / hydrate / router」的前提。
把 `dist` 揉成压缩后的单文件，等于把模块边界交给压缩器猜 —— 与 `ROADMAP.md` 里
「稳定小核心 / 按需进产物」的取舍直接冲突。

### 2.3 `sourceMap` / `declarationMap` 是给使用者 debug **框架本身**用的

报错栈落在 `src/runtime/dom.ts:317` 还是 `dist/dom.js:1`，是库的可用性差别。
压缩会拉断这条链路，同时让编译期诊断的行列精度变差（`PLAIN_Exxxx` 定位、`lint` 提示都依赖源码位置）——
而「报错精确到行」正是这个框架对 AI 友好的核心卖点之一。

### 2.4 混淆在这类项目里是纯负收益

MIT 许可、`src/` 全公开、`dist/` 不进 git。混淆既保护不了任何东西，
又让「用户可以进来读实现」这一条消失。**不做。**

---

## 3. 实测：预压缩到底能省多少

把整个运行时打成一个包后，minify 开关的差别如下（0.3.0 + esbuild 0.28.2 的读数）：

| 产物 | raw | gzip |
| --- | --- | --- |
| 未压缩 | 39.9 KB | **11.5 KB** |
| minify | 20.5 KB | **8.0 KB** |

即：gzip 只省约 3.5 KB，**且这部分在 `vite build` 里本来就会被压掉**。
反过来，真实应用只会用到其中一部分（tree-shaking 之后通常更小），预压缩的边际收益更低。

复现（只读，不写文件）：

```bash
pnpm run build   # 先确保 dist/ 是最新的

node -e "
const esbuild = require('esbuild'), zlib = require('zlib');
(async () => {
  for (const minify of [false, true]) {
    const out = await esbuild.build({
      entryPoints: ['dist/runtime/index.js'], bundle: true, minify,
      format: 'esm', write: false, logLevel: 'silent'
    });
    const code = out.outputFiles[0].text;
    console.log((minify ? 'minify' : 'raw   '),
      (Buffer.byteLength(code) / 1024).toFixed(1) + ' KB raw',
      (zlib.gzipSync(code).length / 1024).toFixed(1) + ' KB gzip');
  }
})();
"
```

数字会随版本漂移：**看趋势，别背具体值**；口径以 [`benchmark/size.mjs`](../benchmark/size.mjs)
（minify + gzip，Plain vs React）为准。

---

## 4. 唯一真实的收益是「分发足迹」，正确做法不是 minify

`dist` 里 45% 是 map。真要瘦身，动的是**什么进包**，不是**包里的代码压不压**：

| 做法 | 效果 | 代价 | 判断 |
| --- | --- | --- | --- |
| 发布时排除 `**/*.map` | 立刻减约一半体积 | 使用者失去源码级 debug | 权衡后再定，**默认先不排** |
| 发布前用 esbuild 打成少量文件 | 安装体积与冷启动更好 | 需另开产物目录 / 与 `tsc` 双轨 | 只在安装体积成为问题时做 |
| `prepublishOnly` 做发布前校验 | 防止把脏产物推上去 | 无 | 值得做 |
| 加 terser / obfuscator | 终端体积几乎不变 | 丢 tree-shaking、丢 map、丢可读性 | **不做** |

CLI / 编译期那部分（`compiler` / `lint` / `cli`）只在 Node 侧跑，逐文件 ESM 的 per-file 加载
开销是毫秒级，不值得为它引入打包器。

> 边缘场景：直接用 `unpkg` / `jsdelivr` 以 `<script type="module">` 引 `dist` 才会暴露未压缩体积。
> 走 `esm.sh` 或任何打包器都会自动压缩 —— 不为了这一条牺牲其余所有收益。

---

## 5. 改这里要连带改什么

动 `build` 之前，确认下面几处一起改，否则文档与口径会失真：

1. [`package.json`](../package.json) 的 `build` / `files` / `prepublishOnly`；
2. [`benchmark/size.mjs`](../benchmark/size.mjs) 的度量口径（它读的就是 `dist/runtime/index.js`）；
3. [`CONTRIBUTING.md`](../CONTRIBUTING.md) 第 6 条（本节的一行版约定）；
4. `README.md` 的 *Deliberate design trade-offs* 与 `ROADMAP.md` 的「非目标」里的交叉引用；
5. 本文 §1 的表格与 §3 的读数。

要引入压缩，必须**同时**回答：map 还发布吗？编译期诊断的行列精度怎么保？与 `sideEffects: false`
和逐文件模块边界怎么共处？答不上来就别合。

---

## 6. 非目标（明确不做）

- 对 `dist/` 做压缩 / 混淆后发布（压缩是使用者打包器的职责）；
- 把运行时预打包成单文件作为默认产物（会削弱 tree-shaking 与可读性）；
- 为「unpkg 直引」这一场景单独出一份压缩产物。

相关：[`ROADMAP.md`](../ROADMAP.md)「非目标」、[`benchmark/README.md`](../benchmark/README.md)。
