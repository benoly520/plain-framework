# Plain 路线图

> 目标：从「可用 MVP+」走到「可被企业采用」。
> 每一项都给出**可验证的验收标准**；没写进本文件的，就不算计划内的承诺。
>
> **进度**：M0–M3 已完成；**M4（HMR）与 M5（SSR 注水 hydration）已落地**（见下文对应小节）。

## 排序原则

Plain 的命题是「让 AI 首次写对的比例更高」（AX），不是「让人写得更爽」（DX）。
所以排序规则是：

1. **能验证命题的** > 能提升手感的；
2. **能让错误变便宜**（构建时拦下）的 > 让错误变安静的；
3. 纯 DX 优化排在有数据之后。

判据的完整定义（AI-first 四道闸）见 [`SPEC.md` §1.1](SPEC.md)：**平台 → 构建 / 工具链 → 编译期检查 → 最后才是运行时概念**。

> 这条规则是修正过的：最初的路线图把 HMR / hydration 排在前面，
> 那是因为潜意识里还在用「框架好不好用」打分 —— 而那是提案说要抛弃的旧坐标系。
> 现在的顺序是：**先把免疫系统通电、把命题变成可测的数字，再回来做手感。**

## 完成定义（DoD）

一个里程碑算完成，必须同时满足：

1. 有测试覆盖，且至少包含一条回归测试或边界测试；
2. `pnpm run coverage` 不低于 `.c8rc.json` 门槛，新增代码自身行覆盖不低于 85%；
3. README / CHANGELOG / AGENTS.md 同步，不出现「说做了但没做」的描述；
4. 对外 API 面若有变化，在 CHANGELOG 中显式标注为 breaking。

---

## M0 —— 质量基建 ✅ 已完成

- c8 覆盖率度量 + `.c8rc.json` 门槛（行 90 / 分支 82 / 函数 85）
- GitHub Actions：构建 + 内核/单元测试 + 覆盖率门禁
- 单元测试从 0 到 105 项，补齐原先零覆盖的 `lint` / `schema` / `compiler` / `cli` / `vite` / `server`
- 统一包管理器（pnpm）、`engines` / `packageManager` / `sideEffects`、`CHANGELOG` / `CONTRIBUTING`

## M1 —— 编译期与运行时正确性 ✅ 已完成

- **列表 keyed 复用**：`<li key={x.id}>` 时按 key 认领行，头部插入 / 重排不重建已有节点
- **结构化编译错误**：`PLAIN_E100x` + `file` / `line` / `column` / `hint`，可 JSON 序列化
- **产物 sourcemap**：line 级映射，经 vite 链式回传给 devtools

## M2 —— 免疫系统闭环 ✅ 已完成

之前的问题是：`lint` 只在 `plaindev check` 里跑，**构建默认不检查** —— 写得不对照样构建成功，
语义静默出错。也就是「可选的不叫免疫系统」。

- **契约检查接进构建链路**：vite 插件 `transform` 第一步就跑，默认 `lint: "error"`；
  失败抛 `PLAIN_E2001`（带规则码、位置、可自动修提示）。`lint: "warn" | false` 可调。
- **补掉「静默降级」**：列表同时用 `key=` 和 index 参数，原来是悄悄丢掉 key，
  现在是编译错误 `PLAIN_E1005`（静默的语义降级是本框架最该消灭的失败模式）。
- **新增反模式检查**：`plain/no-props-destructure` —— 解构 props 会拿到 getter 本身、丢掉响应性
  （这是 AI 从 React / Solid 带过来的头号反模式）。
- **`server()` 自包含校验 `PLAIN_E1006`**：函数体会被物理搬走，任何「本文件里绑定了、
  却不在函数体内」的引用（模块变量 / import / 外层参数）到了服务端必然 ReferenceError。
  此前要等运行时才炸，现在是编译期错误。刻意**不去猜全局变量**（`process` / `Math` / `fetch`），
  免得误报 —— 误报会毁掉整个免疫系统的可信度。
- **`AGENTS.md` + 反模式目录**：10 条反模式，逐条标注**是否已被静态检查覆盖** ——
  没覆盖的明确写「未拦截，自己保证」，不让代理误以为不报错就是对的。

**验收标准**（已达成）

- [x] 写错 `count = 1` 时 `plaindev build` 失败，并给出规则码与自动修提示
- [x] `lint: "warn"` 只告警不阻断；`lint: false` 完全关闭
- [x] `key` + index 同时使用编译报错，不再是静默降级
- [x] `server()` 闭包误用变成编译错误（`PLAIN_E1006`），并有正/反两组测试
- [x] 示例项目（`examples/todo`）在契约检查打开后仍能正常构建

## M3 —— AI 正确率评测 ◐ 骨架与基线完成，缺真实模型实验

命题要能被证伪。现在有两套东西：

- **`eval/tasks/`**（7 个任务）：Plain 自己的质量指标 —— 代理会不会犯这些错、构建期拦不拦得住。
  与 `AGENTS.md` 反模式目录对齐，当前覆盖 4 条反模式。
- **`eval/compare/`**（3 个用例）：**Plain vs React 的对称对比** —— 同一份提示词、同一份断言
  （不是「表达同一件事的两份断言」，是同一个 `check.mjs` 文件），框架差异全部收在适配器里。
  服务端边界类任务不可比，已明确排除并说明理由。

两边都逐条验证过 harness **能区分对错**：reference 全过；「直觉但错」的实现按设计失败 ——
其中 `compare` 的两组坏例（就地改 / 派生状态快照）被**同一行断言**抓住，
说明对比测的是行为本身，而不是某一方的实现细节。

**还缺**

- [ ] 用真实模型跑一轮并记进 `eval/RESULTS.md`：`tasks` 记首次通过率 / 平均轮次 / 拦截率；
  `compare` 记两侧首次通过率（**同一模型**，Plain 的「构建期拦下」单独记）
- [ ] `compare` 用例扩充（当前 3 个，样本太小，结论只能算方向性）
- [ ] `compare` 的 React 侧是否接 eslint / React Compiler —— 不接的话「构建期闸门」这栏对 React 不公平
- [ ] 把实验中被踩到的坑回填进 `AGENTS.md` 反模式目录

**为什么这条比 HMR 优先**：HMR 改善的是人的手感，跟「AI 写得更准」没有因果关系；
而这条能把主张变成数据，且便宜得多。

## M4 —— HMR（P0，✅ 已落地）

**现状**：`src/runtime/hmr.ts` 提供挂载点注册表与热替换；`src/vite/index.ts` 在 dev
（`watchMode`）下注入 `import.meta.hot.accept`，`handleHotUpdate` 让改动走 accept 管道
而非整页刷新。

**设计要点**

- 组件是纯函数 → 可以「重跑组件 + 替换它产出的 DOM 子树」，不必重载页面；
- 运行时侧维护挂载点注册表（`hmrRegister`，记录组件挂在哪个容器/锚点）；
- 模块作用域 `signal` 的值尽力保留（基于 `import.meta.hot.data` 快照，仅原始值可迁移）；
  保留不了必须显式 `console.warn`，绝不静默重置；
- 热替换只回收旧 effect（`dispose`），DOM 交由 `syncRange` 做最小重排 —— 保住焦点/滚动/输入。

**验收标准**

- [x] 改一个只含 `signal` + 组件的文件，不整页刷新；改动人只重建该挂载点区间（最小重排）
- [x] 模块作用域 `signal` 的值在热替换后保留（不可迁移时显式告警）
- [x] 组件被替换后，旧 effect 全部回收（`dispose` 回收 `cleanups`）
- [x] `test/hmr.test.mjs` 覆盖「替换 → 状态保留 → effect 回收 → 未注册返回 false」

**API**：`hmrApply(id, newMod)` / `snapshotSignals` / `restoreSignals` / `hmrScope`；
vite 插件 `hmr` 选项（默认开）。挂载点模块 id 由插件注入的 `__plainBeginModule(id)` 自动关联。

**风险（已处理）**：热替换下模块状态语义——本实现选择「尽力保留 + 不可保留显式告警」，
不引入新 API（`hot.state()` 类约定留待需要时再议）。

## M5 —— SSR 注水 hydration（P0，✅ 已落地）

**现状**：`src/runtime/hydrate.ts` 提供 `hydrate(container, App)`；SSR 输出保留 `plain-`
前缀的认领锚点，客户端按「游标」认领服务端节点。

**设计要点（与 SSR 同源）**：都靠「换掉 `globalThis.document`」让同一份编译产物跑起来——
SSR 换成零依赖服务端垫片（产出 HTML），hydrate 换成「认领式 document」（从服务端 DOM
按游标取节点，**节点对象身份不变**）。非 hydrate 时 `mount()` 行为零变化。

**验收标准**

- [x] `hydrate(container, App)` 复用服务端已有节点，而不是清空重建（节点身份断言）
- [x] 文本/属性与服务端不一致时能就地修正，而不是整树重渲染
- [x] 未注水的 `mount()` 行为完全不变（回归测试）
- [x] `test/hydrate.test.mjs`：SSR 字符串 → 另一份 DOM 解析 → hydrate → 交互可用（7 项全绿）

**副作用（breaking）**：`renderToString`/`renderToStringSync` 现在会在渲染结束后**还原宿主
全局**（`document`/`Node`/`window`）并回收 SSR 期间创建的 effect —— 修复了同进程内 SSR 后
再 hydrate 时的全局污染与残留 effect 触发。依赖「SSR 后全局仍被垫片占用」的非标准用法需调整。

**风险（已处理）**：注水的「首屏认领」与「后续更新」两条路径统一在 `syncRange` 内切换
（hydrate 期启用 `reconcileHydrate` 的就地对齐，平时保持既有最小重排语义）。

## M6 —— 剩余的 AI 原生工具（P1）

- **MCP server** ✅ 已落地（`plaindev mcp`，零依赖 stdio JSON-RPC）：把 `plain_check` /
  `plain_schema` 暴露成 MCP 工具，AI IDE 可直接调用。
  仍缺 **LSP 实时诊断**（编辑器里写时就报，而不是等 dev / build）—— 那是另一套投入
  （要维护 tsserver 插件），先做 MCP 是因为成本低、收益同构。
- **让 AI 找得到规则** ✅ 已落地：`plaindev agent-context [--write]` 把 `AGENTS.md` §1–5
  现读现切，`--write` 时落盘成跨工具标准 `AGENTS.md`，外加 `.github/copilot-instructions.md`
  与 `.cursor/rules/*.mdc` 兜底（已有文件默认不覆盖，`--force` 才覆盖）。
  「让 AI 找到规则」比「把规则写得更全」更优先 —— 文档没人读就是零。
- **误报的出口** ✅ 已落地：行级抑制指令 `plain-ignore-line` / `plain-ignore-next-line`
  （只作用于 lint 规则；编译器的 `PLAIN_E*` 是硬错，不可抑制），`plaindev check`
  会把抑制处数报出来，避免它变成静音开关。
- **错误码统一** ✅ 已落地：lint 与编译器**共用一套 `PLAIN_Exxxx`**（`E10xx` 编译器内部 /
  `E11xx` lint 可抑制 / `E2xxx` 构建期），单一事实来源 `src/errors.ts` 的 `ERROR_CATALOG`；
  旧名 `plain/<rule>` 在抑制指令里仍被接受（向后兼容），输出统一走新码。详见 CHANGELOG。
- **补齐目录里标 ❌ 的静态检查**（按价值排序）✅ 已落地：
  1. `const t = props.title` → `plain/no-props-snapshot`
  2. 对 signal 持有值就地改（`items().push(x)`）→ `plain/no-signal-mutate`
  3. 给 `server()` 传函数 / 类实例 / Stream → `PLAIN_E1007`
    （只报源码上确知的形态；标识符类型不明 / `Date` / spread 不猜）
  4. 覆盖面补强：深层路径与别名就地改、参数解构 `function Card({ x })`、`server()` 返回值
  5. 响应式卫生：`effect(async …)` / `effect` 自触发 / `computed` 写 signal（目录 11–13）
- **评测的上下文档位** ✅ 已落地：`eval/run.mjs --prompt --context task|minimal|full`。
  这条是自变量，不记下来三次跑的数字就没法比（见 `eval/README.md`）。
  真实 agent 结果仍待跑 —— 评测的诚实性优先于「有个数字」。
- **契约从「推断」变成「声明」**：`schema.ts` 的 props 来自「代码读了什么 + 调用点传了什么」，
  `<Card {...rest}/>` 就推不出来。让 AI 显式声明再校验，契约才可信。
- **JSX 类型收紧**：`src/types.ts` 里 `[attr: string]: any` 让「类型即校验」在组件边界失效。

**验收标准**

- [x] MCP server 可被 AI IDE 连上，暴露 `schema` / `check` 两个工具
      （工具名 `plain_check` / `plain_schema`；wire 层已有脚本化会话测试，
      **真实 IDE 连通性尚未外部验证** —— 不在本仓自证范围内）
- [x] 编译器与 lint 使用同一套错误码前缀（`PLAIN_Exxxx`，见 `src/errors.ts`）

## M7 —— 生态与合规

- **许可证** ✅ 已落地：`LICENSE` 由「非商业许可」改为 **MIT**（可自由商用），
  `package.json`（`SEE LICENSE IN LICENSE` → `MIT`）与 README「许可证」章节同步。
  原决策二选一（MIT / Apache-2.0）选了 MIT —— 与 JS 生态默认一致，采用摩擦最小；
  企业支持 / 商业合作降级为**可选增值项**，不再作为采用的前置条件。
- 多入口 / 代码分割 —— **拆成两半，边界说清**（此前一条笼统写「只验证了单入口」，容易误导）：
  - **打包侧（非目标，框架不揽）**：多个 HTML 入口、`rollupOptions.input`、shared chunk 抽取、
    `splitVendorChunk` 等，纯属 Vite/Rollup 配置，透传即可。框架不写这条的文档、也不实现。
  - **框架侧（真问题，已根因定位）**：
    1. **`server()` 清单是单文件**（`serverEntry` 单一 `.plain/server.mjs`）——多入口 / 多构建
       时服务函数会写进同一个文件互相覆盖。 ✅ **已落地**：跨文件同名在构建期抛错并点名两处
       来源（`assertNoNameCollision` + vite 插件按来源查重），同文件热更新不误报。
    2. **懒加载子树**：`dynamic import()` 进来的 Plain 模块同样要能被 `__plainBeginModule(id)`
       打标并注册 HMR（当前只在静态模块求值时打标）。
    - **已排除的伪问题**：「同页多棵独立 App 根」不会串味 —— 认领游标按 `hydrate` 的
      `container` 走，天然隔离（已用最小复现验证）。原先担心的「锚点 `plain-` 前缀冲突」不成立。
- RPC 请求合并 / 防抖
- 官方测试工具包（`render()` / `fireEvent` 之类）✅ 已落地：`plain/testing` 独立子路径、零依赖 ——
  `render`（挂载 + DOM 查询 + 干净解挂）/ `fireEvent`（click / input / change / submit / 键盘 /
  自定义）/ `flush` / `expectText`；缺 DOM 时报带安装指引的错。测试与文档齐。
- `SECURITY.md` ✅ 已落地：安全模型（`server()` 物理剥离 / 产物无 `innerHTML` / 运行时零 `eval`）、
  CSP 影响（dev RPC 的 `new Function` 仅 dev，**build 已改为不求值函数体**）、已知边界与报告方式。
  Vite 插件的 `new Function` 只在 dev 生效 —— 生产 CSP 无需 `unsafe-eval`。

**验收标准**

- [x] LICENSE 决策落地并同步 README
- [x] 验证「同页多棵 App 根」是否有锚点/游标串味 —— 结论：**不串味**（认领游标按容器隔离）
- [x] `server()` 清单在多入口下按入口隔离（附「两个入口各有 `server()` 函数、互不覆盖」的测试）
      —— 结论：同名跨文件在构建期报冲突（点名来源），不同名各自保留；同文件热更新替换函数体
- [x] `SECURITY.md` 落地（安全模型 / CSP / 边界 / 报告方式），并把构建期 `new Function` 收敛到 dev
- [x] 官方测试工具包 `plain/testing` 落地（`render` / `fireEvent` / `flush`），有测试与文档
- [ ] 动态 `import()` 的 Plain 模块能注册 HMR 并热替换（附测试）

---

## 非目标（明确不做）

- 虚拟 DOM / 运行时整树 diff（与「编译到 DOM」的核心取舍冲突）
- 并发渲染 / 时间切片
- 为功能扩张而扩充对外 API 面（SPEC 原则 6「稳定小核心」）
- 逻辑 / 视图 / 样式分离（与 locality 原则冲突，见 README「设计取舍」）
- 刷 100% 行覆盖率（用变异测试衡量断言强度，而不是堆执行过的行）
