# Plain —— 面向 AI 的前端框架规范

> 本文是《面向 AI 时代的前端框架》讨论的落地规范。目标：**让 AI 基于本框架更好、更容易、更快地实现复杂前端项目；更少推理、更简单、长期可维护。**
>
> 设计缘起见 [`docs/ai_frontend_framework_discussion.md`](docs/ai_frontend_framework_discussion.md)。
>
> **本文描述「规范」，[`src/`](src/) 是它的正式实现（当前 0.3.0）。** 规范与实现不一致时以本文件为准，
> 并应提 issue；本文档末尾 [§9](#9-实现状态对照) 给出逐条落地对照。
>
> 历史：早期曾有一个 ~200 行的运行时原型（`html` 标签模板 + 运行时 diff），
> 已被编译型实现取代，源码保留在 [`prototype/`](prototype/) 仅供追溯（**不是本规范的现行形态**）。

---

## 0. 设计哲学一句话

**让"读代码就能推出行为"成为唯一规则，其他一律编译掉。**

AI 生成代码的失败模式不是"写不出"，而是"写出的代码依赖一堆本地不可见的隐性规则（hook 顺序、deps 数组、Proxy 自动追踪、服务端/客户端边界猜测）"。本框架的所有决策都服务于消除这些隐性规则。

---

## 1. 核心原则（按对 AI 的重要性排序）

| # | 原则 | 具体做法 | 反模式（现有框架） |
|---|---|---|---|
| 1 | **Locality 本地可推** | 无 hook 顺序、无 deps 数组、无 Proxy 魔法；effect 自动追踪读取了什么 | React deps 数组、Vue Proxy、Svelte `$:` |
| 2 | **唯一状态原语** | 只有 `signal` / `computed` / `effect` | React 20+ hooks、Vue Composition/Options 双范式 |
| 3 | **单文件单语言** | 逻辑与 markup 同作用域（TSX），无模板/逻辑分离 | Vue/Svelte/Angular 模板与脚本分离 |
| 4 | **显式执行边界** | `server()` 一个关键字声明代码在哪端跑 | RSC、Svelte `load`、SolidStart 靠约定 |
| 5 | **编译到 DOM** | 零框架运行时，组件编译成直接 DOM 操作 | React/Vue 虚拟 DOM diff |
| 6 | **稳定小核心** | ~10 个导出，API 长期冻结 | Angular 全功能栈 |
| 7 | **类型即校验** | immutable 更新，非法状态难表达 | Svelte 深代理"原地改忘触发" |
| 8 | **AI 原生工具** | 机器可读组件 schema + 自解释错误 + lint 给改法 | 各框架文档为人类写 |

### 1.1 功能取舍判据：AI-first 四道闸

上面 8 条是「怎么做」，这一节回答「**要不要做**」。任何候选能力（新的运行时原语、编译期语法、工具链特性）在立项前先过四道闸：

| # | 判据 | 通过标准 | 不过关的后果 |
|---|---|---|---|
| P1 | **可静态验证** | 写错能在编译期 / 构建期被拦下 | 错误拖到运行时才暴露 —— 对 AI 是负资产 |
| P2 | **可本地推理（无隐藏耦合）** | 读一段代码就能推出行为，不依赖「最近的边界 / 全局注册表 / 渲染顺序」 | AI 只能背文档，而背文档必然漂移 |
| P3 | **重复优于抽象** | 显式重复写样板，胜过引入隐式魔法 | 抽象藏起来的行为，AI 无法验证、无法 grep |
| P4 | **平台优先** | Web 平台原语能表达的，就不发明框架概念 | 同一件事有两种写法，多一个 AI 会选错的点 |

AI 的失败模式不是「写不出」，而是「**自信地写错**」（P1）与「**本地推不出**」（P2）；而 AI 写样板代码几乎零成本（P3），对 Web 标准的掌握又远比某个框架私有 API 稳（P4）。

**解法落点顺序** —— 四条都满足不了时，不要急着加运行时概念，按此顺序找答案：

1. **平台能做吗？** 交给平台，框架只负责「教 + 引导」（例：模态交给 `<dialog>` / `popover`，不造 `<Portal>`）；
2. **构建 / 工具链能做吗？** 自动化到 AI 不可见，并给出**可验证的数字**（例：按路由自动分包 + bundle 预算，而不是让 AI 手写 `lazy()`）；
3. **能变成编译期检查吗？** 做成 lint / 契约规则，把「要记得」变成「会报错」（例：异步 UI 的态不完备用规则拦，而不是引入 `<Suspense>` 这种隐藏边界）；
4. 三条都不行，才考虑加运行时概念 —— 且必须过 P1、P2。

这套判据不是新规矩，而是把既有决策的隐含标准写出来：拒绝 `bind(s)`（P3 / P4）、拒绝 `{...spread}`（P1：只做半套、会静默跑错）、拒绝 `key` 与 index 并存（P1：静默的语义降级）。

---

## 2. 组件模型

- 组件就是一个**普通函数**，返回视图节点（源码用 TSX 表达，编译后返回 DOM 构建指令）。
- 逻辑与视图**同一作用域**：状态、派生、事件处理都写在组件函数体内，不拆文件、不拆 `<template>`。
- 没有 `class 组件`、没有 `forwardRef`。跨组件共享**普通**状态 = 把 `signal` 提升到模块作用域后导入；
  **跨层传值**（主题 / 语言 / 当前用户）用 `createContext` + `<Ctx.Provider>` + `useContext`。
  注意区分：**请求级**数据（当前用户 / 会话）**必须**走 Context 或 props ——
  放进模块作用域的 signal 会在 SSR 下跨请求泄漏（见 `docs/rfcs/context-and-ssr-isolation.md`）。

```tsx
function Counter() {
  const count = signal(0);                      // 状态
  const doubled = computed(() => count() * 2);  // 派生
  return (
    <button onClick={() => count.set(count() + 1)}>
      点我 {count()}（doubled: {doubled()}）
    </button>
  );
}
```

> **视图语法是 TSX，不是模板字符串。** 没有 `html\`...\``、没有 `v-model`、没有 `bind`：
> 插值 `{signal()}` 即细粒度绑定，属性用原生 HTML 名（`class` / `onClick` 由编译器映射到
> `className` / `addEventListener`），布尔属性按属性语义处理（见 §4）。

---

## 3. 状态与响应式

| 原语 | 语义 | 读取 | 写入 |
|---|---|---|---|
| `signal(v)` | 可变状态 | `s()` | `s.set(x)` 或 `s(x)` |
| `computed(fn)` | 派生值（自动追踪 `fn` 内读取的 signal） | `c()` | 只读 |
| `effect(fn)` | 副作用，依赖变化自动重跑 | — | — |

**铁律**：
1. 读取 signal 只发生在 `effect` / `computed` / 视图绑定内部才会建立依赖——不在这些上下文里读就是普通取值。
2. **状态更新走 immutable**（生成新值/新数组），不用深代理。理由：对 AI 更可预测，消灭"原地改了但忘了触发"这一类最难查的 bug。
   - 就地改（`items().push(x)`）由契约 lint **构建期**拦截（`PLAIN_E1106`），不是靠文档提醒。
3. 没有 `useMemo` / `useCallback` / `React.memo`——`computed` 与视图绑定天然细粒度，编译器负责只更新依赖的 DOM 节点。
4. `effect` 是**同步**的：`effect(async () => …)` 会在第一个 `await` 之后丢失依赖收集（`PLAIN_E1109`）。
   要取异步数据用 `resource()`，不要拿 `effect` 当 `useEffect` 使。

---

## 4. 视图与控制流

- 视图用 **TSX** 书写，插值 `{expr}` 即**细粒度绑定**（只有该文本/属性节点更新，不重渲染整棵子树）。
- 控制流用**普通 JS 表达式**，不发明新的模板 DSL（避免"框架方言"增加 AI 的学习与出错面）。
  编译器把下列四种形状直接编译成对应的运行时原语，**其余表达式一律按「普通值插入」处理**：

  | 源码形状 | 编译成 | 说明 |
  |---|---|---|
  | `arr.map((x, i) => <li key={x.id}/>)` | `each(parent, getter, itemFn, keyFn)` | keyed 列表，按 key 复用未变节点 |
  | `cond ? <A/> : <B/>` | `when(parent, cond, thenFn, elseFn)` | 条件分支，可任意嵌套 |
  | `cond && <A/>` | `when(parent, cond, thenFn, null)` | 逻辑与短路 |
  | 其它表达式 | `insert(parent, () => expr)` | 求值后作为节点插入（文本 / 节点 / 数组） |

  - **key 与 index 不能并存**：同一条 map 回调里同时用到 index 参数，**编译期报错 `PLAIN_E1005`**——
    keyed 复用下行只构建一次，捕获的 index 无法随位置更新，两者同时生效必有一个语义是错的。
    这里刻意不做静默降级：静默的语义降级是本规范最想消灭的失败模式。
  - **JSX 位置只支持上表四种形状**；`||` / `??` 短路、`filter().map()` 链式、
    `try/catch` 包裹 JSX、`switch` 返回 JSX 等属于「其它表达式」，会走 `insert` 兜底。
    需要响应式或 keyed 复用时要**先赋值给变量再插值**，写法见 [`AGENTS.md`](AGENTS.md)。
- 事件：`onClick={fn}` 等，编译期转 `addEventListener`（字符串事件名会被拒，避免静默失效）。
- 布尔属性（`checked`/`disabled`/...）按属性语义处理，不依赖字符串 `"false"` 的歧义。
- **属性名与类型受类型系统约束**：未知属性名 / 类型写错（`scr` / `checked="yes"` / `onClikc`）
  在编辑器与 `tsc` 下当场报错（见 `test/types.test.mjs`）。
- **属性名归一化只有一处**（`src/attrs.ts`）：静态字面量与动态表达式**只允许「值从哪来」不同，
  不允许「落到哪个属性」不同**。**规范拼写是原生 HTML 名**（`class` / `for`）；
  camelCase 的 DOM 名（`className` / `htmlFor`）只作为**兼容输入**接受，归一到同一个属性 ——
  收它们不是为了「兼容 React API」，而是为了 AI / 存量代码的首次写对率；代价是方言多一种，
  所以兼容面就这两个名字、集中在 `REACT_COMPAT_ALIASES` 里显式登记（**扩大它是一次显式决定**，
  由 `test/attrs.test.mjs` 钉住）。其余 camelCase（`colSpan` / `tabIndex`）是 DOM property 名，
  靠「HTML 一律小写」成立，不在兼容表里。
  写法会**自动收敛**到规范名：内建元素上写 `className` / `htmlFor` 由 `PLAIN_E1115`
  提示并自动改写（`plaindev check` 默认就会改），因为它与 `class` / `for` 完全等价，
  所以只告警、绝不阻断构建；组件上的 `className` 是组件自己定的 prop 名，不动。
  SVG / MathML 属性名大小写敏感（`viewBox` / `preserveAspectRatio`）必须原样保留。
  响应式属性在客户端走 property（`setAttribute` 改不动已脏的表单状态），
  服务端垫片把同一批 property 反射回 `attributes`，SSR 才不会丢动态 `href` / `value` / `checked`；
  等价性由 `test/attrs.test.mjs` 钉住。
- **不支持属性展开 `{...expr}`**（编译期报错 `PLAIN_E1008`）：展开只做了半套 —— 不进响应式更新，
  且绕过 class / style / value 的正确属性路径，会静默跑错。与 `PLAIN_E1005` 同一条理由：
  **不做静默降级**，宁可在编译期挡住。
- **命令式 DOM 用 `ref={(el) => …}`**（内建元素专用）：元素连入文档后回调一次
  （≈ 平台的 `connectedCallback`），返回的清理函数随元素回收。组件上写 `ref` 报 `PLAIN_E1009`。
  只提供「回调」一种形态，不引入 `.current` box / Signal 形态（SPEC 原则 6：稳定小核心）——
  取舍与验收见 [`docs/rfcs/ref-escape-hatch.md`](docs/rfcs/ref-escape-hatch.md)。

---

## 5. 显式执行边界

```tsx
const loadUser = server((id) => db.users.find(id)); // 只跑在服务端
```

- `server()` 标注的函数：**编译版从客户端 bundle 物理剥离**，在调用处生成 RPC 桩（参数序列化、返回 Promise）。
- 这是消除"服务端/客户端边界靠猜"的根本手段：AI 只需决定"这函数在哪端"，不必推断。
- 边界靠**编译器静态校验**兜底，而不是靠文档提醒：
  - 函数体引用「本文件里绑定了、却不在函数体内」的名字（模块变量 / import / 外层参数）
    → `PLAIN_E1006`（搬过去必然 `ReferenceError`）；
  - 参数或返回值不是 JSON 可序列化（函数 / 类实例 / Stream）→ `PLAIN_E1007`；
  - 函数名在整个应用内必须唯一，同名跨文件在**构建期**报冲突并点名两处来源
    （清单是单文件 `.plain/server.mjs`，不允许多入口互相覆盖）。

---

## 6. 编译目标

本框架**已经**是编译到 DOM 的形态（`src/compiler/`），运行时只保留响应式内核与 DOM 原语：

1. TSX → 编译为创建真实 DOM 的**指令**，无虚拟 DOM、无 diff、无模板 DSL。
2. 组件是纯函数 → 可以「重跑组件 + 替换它产出的 DOM 子树」，
   这也是 HMR 不整页刷新的基础（见 `src/runtime/hmr.ts`）。
3. `server()` 边界在编译期物理割裂客户端/服务端产物（见 §5）。
4. 文档 / 属性 / 列表 key 的具体编译形态见 §4 的对照表。
5. 服务端可产出 HTML（SSR）并由客户端**复用同一批节点**注水（`src/server/dom-shim.ts` +
   `src/runtime/claim-document.ts`）；两端共用同一份编译产物，靠「换掉 `globalThis.document`」实现。

> 结果：框架运行时被压到 **~1.7 KB gzip**（最小计数器应用，含框架；对比 React 同应用 67.4 KB，
> 见 `benchmark/size.mjs`）。这不是"运行时原型"，是正式实现的实测值。

---

## 7. AI 原生工具（路线图）

1. **机器可读组件 schema**：扫描项目导出，生成 AI 可直接消费的"有哪些组件、接收什么 props、触发什么事件"清单，免去 AI 通读源码。
2. **自解释错误**：编译/运行错误附带"为什么 + 修正后片段"。
3. **契约式 lint**：把上面的"铁律"变成可自动修复的规则（如检测到在 effect 外写入却期望响应，直接提示）。

> **落地状态**（详见 [README](README.md) 与 [AGENTS.md](AGENTS.md)）：
> 1 ✅ 已实现（`plaindev schema`）：props 的事实来源是**组件声明的类型**（`props: CardProps`），
>   `optional` 来自 `?`、`type` 来自注解；解析不了时附 `propsSource: "declared-unresolved"` 退回推断，**不假装**。
> 2 ✅ 已实现（`PLAIN_E100x` / `PLAIN_E11xx` / `PLAIN_E2001` + `hint`，可 JSON 序列化）；
>   错误码单一来源见 `src/errors.ts` 的 `ERROR_CATALOG`。
> 3 ✅ 已实现 **15 条 lint 规则**（`PLAIN_E1101`–`PLAIN_E1115`）+ 编译器侧语义校验，
>   并**默认接入构建链路**（`error` 级即构建失败；`warn` 级只提示、不阻断，
>   `lint: "warn" | false` 可调 —— 目前唯一的 `warn` 规则是 `PLAIN_E1115`）；
>   VS Code 侧的同一套诊断由 `plaindev lsp` 提供，MCP 侧由 `plaindev mcp` 提供。
>   [`AGENTS.md`](AGENTS.md) 反模式目录当前 **22 条**（含 §3.1 的视图语法边界），逐条标注是否被静态检查覆盖。
>   **看不出的标识符不猜**（不误报优先于多报），未覆盖的条目明确写「未拦截，自己保证」。
> 另有零依赖官方测试工具包 `plain/testing`（`render` / `fireEvent` / `flush`）。

---

## 8. 与"直接造一个全新编译器"的关系

不建议从零写编译器。务实路径：**取 Solid/Svelte 的响应式 + 编译内核，套一层本规范的"减法外壳"**——砍掉模板/逻辑分离、钉死 `server/client` 边界、冻结小 API 面。

本框架正是这条路的**已完成形态**：编译前端基于 TypeScript 官方解析器（不自造 parser），
编译后端产出裸 DOM 指令，运行时只剩信号内核与 DOM 原语。早期用 200 行运行时原型验证过模型
（保留在 `prototype/` 供追溯），此后换成编译器实现。

---

## 9. 实现状态对照

| 规范条目 | 实现 | 测试 |
|---|---|---|
| §1.1 四道闸（P1–P4） | 决策记录散见 `docs/rfcs/` | — |
| §2 组件模型 / TSX | `src/compiler/index.ts` | `test/compiler.test.mjs` |
| §3 signal / computed / effect | `src/runtime/signal.ts` | `test/runtime-extra.test.mjs` |
| §4 视图与控制流 / keyed 复用 | `src/compiler/index.ts` + `src/runtime/dom.ts` | `test/keyed.test.mjs` |
| §4 属性类型收紧 | `src/types.ts` | `test/types.test.mjs`（真 `tsc`） |
| §4 属性名归一化（静态 / 动态等价、SVG 大小写、SSR 反射） | `src/attrs.ts` + `src/server/dom-shim.ts` | `test/attrs.test.mjs` |
| §4 `ref` 逃逸口 | `src/runtime/ref.ts` | `test/ref.test.mjs` |
| §5 `server()` 边界 | `src/compiler/index.ts` + `src/runtime/async.ts` | `test/eval-context.test.mjs` |
| §6 编译到 DOM | `src/compiler/` | `test/compiler.test.mjs` |
| §6 SSR / 注水 | `src/server/` + `src/runtime/hydrate.ts` | `test/ssr-data.test.mjs`、`test/hydrate.test.mjs` |
| §6 HMR | `src/runtime/hmr.ts` + `src/vite/index.ts` | `test/hmr.test.mjs` |
| §7 schema / 错误 / lint | `src/compiler/schema.ts` + `src/cli/` + `src/lint.ts` + `src/errors.ts` | `test/cli.test.mjs`、`test/schema.test.mjs`、`test/lint.test.mjs` |

> 进度与验收标准的**权威来源**是 [`ROADMAP.md`](ROADMAP.md)；本节只做"规范条目 ↔ 代码"的索引。
