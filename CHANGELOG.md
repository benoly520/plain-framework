# 更新日志

本项目遵循[语义化版本](https://semver.org/lang/zh-CN/)；提交信息遵循
[Conventional Commits](https://www.conventionalcommits.org/zh-hans/)。

## [Unreleased]

### 新增

- **列表 keyed 复用**：`arr.map(x => <li key={x.id}>…)` 现在按 key 认领行，
  头部插入 / 重排不会重建已有节点（关闭 `SPEC.md` §4 里 `each(..., keyFn, ...)` 的欠账）。
  `each()` 新增可选的第 4 个参数 `keyFn`；不传时行为与之前完全一致。
- **契约检查接进构建链路（默认开启）**：vite 插件 `transform` 第一步就跑 `lint`，
  失败抛 `PLAIN_E2001`（带规则码、位置、可自动修提示）。
  此前 `lint` 只在 `plaindev check` 里跑，写得不对照样构建成功、语义静默出错。
  新增选项 `plainPlugin({ lint: "warn" | false })`。
- **新增契约规则 `plain/no-props-destructure`**：解构 props（`const { title } = props`）
  会拿到 getter 本身并丢失响应性 —— 这是 AI 从 React / Solid 带过来的头号反模式。
- **`server()` 自包含校验**：新增编译错误 `PLAIN_E1006`。`server()` 的函数体会被物理搬到
  `.plain/server.mjs`，那个文件里没有 import、也没有模块作用域，所以引用「本文件里绑定了、
  却不在函数体内」的名字（模块变量 / import / 外层参数）到了服务端必然 ReferenceError。
  此前要等运行时才炸，现在编译期就报出来。
  实现上**只报确知被文件绑定的名字**，不去猜全局变量 —— 避免误报，误报会毁掉免疫系统的可信度。
- **结构化编译错误**：`PlainCompileError` 带
  `code`（`PLAIN_E1001`–`PLAIN_E1006`、`PLAIN_E2001`）/ `file` / `line` / `column` / `hint`，
  可 `JSON.stringify`，供 IDE / CI / AI 直接消费（`SPEC.md` §7「自解释错误」）。
- **编译产物 sourcemap**：`compile()` 返回 line 级 `map`，vite 插件会链式回传给 devtools，
  断点与堆栈可定位回 `.tsx` 源文件。
- **`AGENTS.md` + 反模式目录**：10 条反模式逐条标注「是否已被静态检查覆盖」，
  未覆盖的明确写「自己保证」，避免代理把「不报错」当成「是对的」。
- **AI 正确率评测骨架 `eval/`**：7 个任务（计数器 / keyed 列表 / 服务端边界 / 服务端读配置 /
  不可变更新 / props 取值快照 / 服务端自校验）+ 验收断言 + 指标口径
  （首次通过率 / 平均轮次 / 拦截率）+ 公平性与自欺清单。
  harness 新增 `evalServerFn()`：把物理剥离出来的服务端函数单独执行（与 dev 的 `evalFn` 同路径），
  从而能断言 `server()` 的真实行为。7 个 reference 全过；6 个「直觉但错」的实现全部按设计失败。
- 覆盖率度量与门禁：`pnpm run coverage`（c8 + `src` 级 sourcemap 映射），门槛写在 `.c8rc.json`。
- GitHub Actions 工作流（`.github/workflows/ci.yml`）：构建 + 内核/单元测试 + 覆盖率门禁；
  真实浏览器端到端改为手动触发。
- 单元测试套件 `test/*.test.mjs`（`node:test`）：覆盖 `lint` 规则与自动修复、`schema` 契约提取、
  `compiler` 报错兜底与 sourcemap、`cli` 子命令、`vite` 插件的编译/剥离/契约拦截、
  `keyed` 列表语义、`server`（静态托管/目录穿越/RPC/起服）、SSR 序列化、运行时边界分支。
- `ROADMAP.md`（分阶段计划与验收标准，含「为什么先做免疫系统与评测」的排序原则）、
  `CONTRIBUTING.md`（环境、提交信息与改动要求）。

### 修复

- `lint`：JSX 属性里的 signal 漏调用会被重复报错，且两条 `fix` 区间重叠会让 `autofix`
  把源码改坏（`checked={done}` → `checked={done()()}`）。现在同一标识符只报一次，
  重叠的 fix 会被安全跳过。
- `compiler/manifest`：dev 增量更新时会把 `__plainHandlers` 当成用户函数再写一遍，
  产出重复 `const` 声明，导致多文件场景下 `/_plain/rpc` 直接加载失败。
- `test/browser.mjs`：不再硬编码 `/usr/bin/chromium`，改为环境变量
  （`PLAIN_CHROMIUM_PATH` / `CHROMIUM_PATH` / `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`）
  加常见路径探测，失败时给出可操作的提示。

### 变更（含 breaking）

- **`key` 与 index 同时使用现在是编译错误 `PLAIN_E1005`**（此前是静默丢掉 key、退回按位置复用）。
  keyed 复用下行只构建一次，回调捕获的 index 无法随位置更新，两者同时生效必然有一个语义是错的；
  静默的语义降级正是本框架最该消灭的失败模式。
  受影响的写法：`arr.map((x, i) => <li key={x.id}>…</li>)`。修法：删掉 `key` 或删掉 index 参数。
- 统一包管理器为 pnpm，移除 `package-lock.json`。
- `tsconfig`：打开 `noImplicitAny`，开启 `sourceMap` / `declarationMap`。
- `package.json`：新增 `engines`、`packageManager`、`sideEffects`。
- 从仓库移除构建产物 `plain-deliverable.zip`；`coverage/` 加入 `.gitignore`。

## [0.3.0]

TypeScript 源码 + tsc 构建；signals 响应式内核、编译到 DOM、`server()` 编译期物理剥离、
SSR 输出、路由与 ErrorBoundary、`plaindev` CLI 与 Vite 插件。
