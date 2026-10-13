# 更新日志

本项目遵循[语义化版本](https://semver.org/lang/zh-CN/)；提交信息遵循
[Conventional Commits](https://www.conventionalcommits.org/zh-hans/)。

## [Unreleased]

### 新增

- **契约规则 `plain/no-signal-mutate`**：就地改 signal 持有值（`items().push(x)` /
  `items()[0] = x`）不会触发更新。构建期报错，不自动修。
  覆盖面按「源码上看得出的可变操作」铺开：深层路径（`todos()[0].done = true`、
  `user().profile.name = "x"`、`todos()[0].tags.push(x)`）与**先存后改**
  （`const arr = items(); arr.push(x)`，按函数作用域解析别名）都拦；
  `items().filter(f).push(x)`（改的是新数组副本）不报。
- **契约规则 `plain/no-props-snapshot`**：把动态 props 的 getter 存进变量
  （`const t = props.title` / `const t = resolve(props.title)`）、赋值形态（`let t; t = props.title`，
  只报组件函数体顶层的赋值，写在 `effect` / 回调里的会重跑、不报）或 JSX 里忘了 `resolve`
  （`{props.title}`）。`on*` 事件 prop 编译器不包 getter（存进变量、透传都合法）与 thunk 写法不报；
  动态下标（`props[key]`）看不出来，仍按 getter 报。
- **`server()` 参数与返回值可序列化校验**：新增编译错误 `PLAIN_E1007`。调用 `server()` 产物时
  传入字面量函数、本文件的类实例、或 `ReadableStream` / `FormData` 等，编译期失败；
  `server(() => …)` 的**返回值**同样要能序列化（`return () => {}`、`return new ReadableStream()`、
  对象里夹函数、返回函数体内自产的 helper 都会报）—— 此前这类返回值会被 RPC 的
  `JSON.stringify` 悄悄丢成 `{}` / `undefined`，客户端不报错。
  看不出类型的标识符、`new Date()`、spread、嵌套函数自己的 `return` **不猜**，避免误报。
- **三条响应式卫生规则**（AI 高频、且不报错只行为错的坑）：
  - `plain/no-async-effect`：`effect(async () => { await … })` —— 依赖收集在第一个 `await` 之后失效。
  - `plain/no-effect-loop`：`effect(() => count.set(count() + 1))` —— 读了又写同一个 signal，
    是同步递归、直接 `RangeError: Maximum call stack`；只报**没有条件闸门**的写法，
    `if (c() > 10) c.set(0)` 这种钳位会在第二轮收敛，不报。
  - `plain/no-computed-side-effect`：`computed(() => { s.set(…) })` —— 派生值必须是纯函数。
- **AI 可发现性**：`plaindev agent-context [--write]` 把 `AGENTS.md` §1–5 现读现切并打印
  （规则只有一份，不维护第二份副本）。`--write` 落盘的目标按「谁会被 AI 自动读取」排序：
  跨工具标准 **`AGENTS.md`**（Codex / Cursor / Copilot / Windsurf / Claude Code … 都读它），
  再加 `.github/copilot-instructions.md` 与 `.cursor/rules/plain.mdc`（带 `alwaysApply`
  front-matter）给只认自家文件的工具兜底。**已存在的文件默认不覆盖**（项目自己写的
  AGENTS.md 通常更好），要覆盖得显式 `--force`；`--targets agents,copilot,cursor` 可只写其一。
- **`plaindev mcp`**：零依赖的 MCP stdio server，暴露 `plain_check` / `plain_schema`
  两个工具，AI IDE 可以直接调 —— 不必等人类跑一次构建才知道写错了。
- **误报的出口：行级抑制指令**：`plain-ignore-line` / `plain-ignore-next-line`
  （可跟规则码，不跟则抑制该行全部 lint 规则），按「CLI 报出来的行号」匹配。
  只作用于 lint 规则 —— 编译器的 `PLAIN_E*` 是产物必坏的硬错，**不可抑制**。
  `plaindev check` 会报出抑制处数，避免它变成静音开关。
- **列表 keyed 复用**：`arr.map(x => <li key={x.id}>…)` 现在按 key 认领行，
  头部插入 / 重排不会重建已有节点（关闭 `SPEC.md` §4 里 `each(..., keyFn, ...)` 的欠账）。
  `each()` 新增可选的第 4 个参数 `keyFn`；不传时行为与之前完全一致。
- **契约检查接进构建链路（默认开启）**：vite 插件 `transform` 第一步就跑 `lint`，
  失败抛 `PLAIN_E2001`（带规则码、位置、可自动修提示）。
  此前 `lint` 只在 `plaindev check` 里跑，写得不对照样构建成功、语义静默出错。
  新增选项 `plainPlugin({ lint: "warn" | false })`。
- **新增契约规则 `plain/no-props-destructure`**：解构 props（`const { title } = props`）
  会拿到 getter 本身并丢失响应性 —— 这是 AI 从 React / Solid 带过来的头号反模式。
  口径补齐到三种写法：`const { x } = props`、`const { x } = props.data`、
  `function Card({ x })` / `const Row = ({ x }) => …`（**参数解构**此前完全漏过，
  而它正是 React 肌肉记忆里最顺手的一种）。先 `resolve()` 再解构是正确写法，不报。
- **`server()` 自包含校验**：新增编译错误 `PLAIN_E1006`。`server()` 的函数体会被物理搬到
  `.plain/server.mjs`，那个文件里没有 import、也没有模块作用域，所以引用「本文件里绑定了、
  却不在函数体内」的名字（模块变量 / import / 外层参数）到了服务端必然 ReferenceError。
  此前要等运行时才炸，现在编译期就报出来。
  实现上**只报确知被文件绑定的名字**，不去猜全局变量 —— 避免误报，误报会毁掉免疫系统的可信度。
- **结构化编译错误**：`PlainCompileError` 带
  `code`（`PLAIN_E1001`–`PLAIN_E1007`、`PLAIN_E2001`）/ `file` / `line` / `column` / `hint`，
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
- **Plain vs React 对比基线 `eval/compare/`**：3 个用例（计数器 / 列表增删 / 父状态传子组件），
  **共用同一份提示词与同一份断言**，框架差异全部收在适配器里（交互一律走 DOM 事件）。
  服务端边界类任务不可比，已排除并说明理由；Plain 侧的构建期闸门与 React 侧默认无闸门
  这一不对称也写进了公平性说明。
  已验证：两边的「各自惯用但错」实现被**同一行断言**抓住（就地改 / 派生状态快照）。
  新增 `package.json` 脚本 `eval` / `eval:compare`，并接进 CI 作为 harness 自检。
- 覆盖率度量与门禁：`pnpm run coverage`（c8 + `src` 级 sourcemap 映射），门槛写在 `.c8rc.json`。
- GitHub Actions 工作流（`.github/workflows/ci.yml`）：构建 + 内核/单元测试 + 覆盖率门禁；
  真实浏览器端到端改为手动触发。
- 单元测试套件 `test/*.test.mjs`（`node:test`）：覆盖 `lint` 规则与自动修复、`schema` 契约提取、
  `compiler` 报错兜底与 sourcemap、`cli` 子命令、`vite` 插件的编译/剥离/契约拦截、
  `keyed` 列表语义、`server`（静态托管/目录穿越/RPC/起服）、SSR 序列化、运行时边界分支。
- `ROADMAP.md`（分阶段计划与验收标准，含「为什么先做免疫系统与评测」的排序原则）、
  `CONTRIBUTING.md`（环境、提交信息与改动要求）。
- **常见场景配方 `docs/patterns.md`**：补齐此前无官方写法的表单类场景 ——
  受控输入、控件速查、多字段组织、异步提交（loading / error / 禁用）、
  列表内行编辑（行内局部状态 + keyed 复用）、校验分层（客户端 UX + 服务端权威）。
  两条实测踩坑一并记入：`{...spread}` 封装受控绑定**只在创建时求值一次、不进 `effect`**
  （信号变了不更新，静默失效，无静态规则能拦）；`resolve(props.onSave)` 会把 `on*` 事件 prop
  **当场调用**（`on[A-Z]` 开头不包 getter，应直接 `props.onSave(...)`）。
  README / AGENTS.md 已加入口。
- **`eval/RESULTS.md` 记入首个真实模型跑数（含效度声明）**：7/7 首次通过、平均轮次 1.00；
  但该次执行前模型已读过 `check.mjs`，**不是协议干净的有效指标**，只能作为上界与 harness 联调记录 ——
  只喂 `task.md` 的有效实验仍待补。

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
