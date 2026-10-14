# Plain —— 面向 AI 的最小可行前端框架规范（草案 α）

> 本文是《面向 AI 时代的前端框架》讨论的落地规范。目标：**让 AI 基于本框架更好、更容易、更快地实现复杂前端项目；更少推理、更简单、长期可维护。**
>
> 配套可运行原型（"草案 α"，已被 `src/` 下的正式编译型实现取代）：[`prototype/framework.js`](prototype/framework.js)（内核）、[`prototype/app.js`](prototype/app.js)（演示）、[`prototype/index.html`](prototype/index.html)（预览）。设计缘起见 [`docs/ai_frontend_framework_discussion.md`](docs/ai_frontend_framework_discussion.md)。

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
| 3 | **单文件单语言** | 逻辑与 markup 同作用域（hyperscript），无模板/逻辑分离 | Vue/Svelte/Angular 模板与脚本分离 |
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

- 组件就是一个**普通函数**，返回视图节点（运行时版返回 `DocumentFragment`，编译版返回 DOM 构建指令）。
- 逻辑与视图**同一作用域**：状态、派生、事件处理都写在组件函数体内，不拆文件、不拆 `<template>`。
- 没有 `class 组件`、没有 `forwardRef`、没有 `Provider` 包裹层。跨组件共享状态 = 把 `signal` 提升到模块作用域后导入。

```js
function Counter() {
  const count = signal(0);                 // 状态
  const doubled = computed(() => count() * 2); // 派生
  return html`<button onclick=${() => count(count() + 1)}>
    点我 ${count}（doubled: ${doubled}）
  </button>`;
}
```

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
3. 没有 `useMemo` / `useCallback` / `React.memo`——`computed` 与视图绑定天然细粒度，编译器（或运行时）负责只更新依赖的 DOM 节点。

---

## 4. 视图与控制流

- 视图用 `html\`...\`` 构造，插值 `${signal}` 即**细粒度绑定**（只有该文本/属性节点更新，不重渲染整棵子树）。
- 控制流用**普通函数**，不发明新的模板 DSL（避免"框架方言"增加 AI 的学习与出错面）：
  - `when(cond, thenFn, elseFn)` —— 条件
  - `each(items, keyFn, itemFn)` —— keyed 列表，按 key 复用未变节点
    - 落地形态（见 `src/compiler` + `src/runtime/dom.ts`）：用户写 `key={...}`，
      编译器把 `arr.map(x => <li key={x.id}/>)` 编译成 `each(parent, getter, itemFn, keyFn)`。
    - 边界：同一条 map 回调里若同时用到 index 参数，**编译期报错 `PLAIN_E1005`（二者选一）**——
      keyed 复用下行只构建一次，捕获的 index 无法随位置更新，两者同时生效必有一个语义是错的。
      这里刻意不做静默降级：静默的语义降级是本规范最想消灭的失败模式。
- 事件：`onclick=${fn}` 等，编译期转 `addEventListener`。
- 布尔属性（`checked`/`disabled`/...）按属性语义处理，不依赖字符串 `"false"` 的歧义。
- **不支持属性展开 `{...expr}`**（编译期报错 `PLAIN_E1008`）：展开只做了半套 —— 不进响应式更新，
  且绕过 class / style / value 的正确属性路径，会静默跑错。与 `PLAIN_E1005` 同一条理由：
  **不做静默降级**，宁可在编译期挡住。
- **命令式 DOM 用 `ref={(el) => …}`**（内建元素专用）：元素连入文档后回调一次
  （≈ 平台的 `connectedCallback`），返回的清理函数随元素回收。组件上写 `ref` 报 `PLAIN_E1009`。
  只提供「回调」一种形态，不引入 `.current` box / Signal 形态（SPEC 原则 6：稳定小核心）——
  取舍与验收见 [`docs/rfcs/ref-escape-hatch.md`](docs/rfcs/ref-escape-hatch.md)。

---

## 5. 显式执行边界

```js
const loadUser = server((id) => db.users.find(id)); // 只跑在服务端
```

- `server()` 标注的函数：运行时版透传；**编译版从客户端 bundle 剥离**，在调用处生成 RPC 桩（参数序列化、返回 Promise）。
- 这是消除"服务端/客户端边界靠猜"的根本手段：AI 只需决定"这函数在哪端"，不必推断。

---

## 6. 编译目标（下一步：把运行时换成编译期）

运行时原型已证明模型成立。正式版应做**编译到 DOM**，把框架运行时也消除（对标 Svelte）：

1. `.plain` 单文件组件 → 编译为创建真实 DOM 的指令，无虚拟 DOM、无 diff。
2. `signal` 裸变量写法（如 `count = count + 1`）可由编译器在赋值处插入写入指令——魔法被限制在"赋值"一个语法点，且编译器直接报错 misuse。
3. `server()` 边界在编译期物理割裂客户端/服务端产物。
4. 结果：首屏零框架 JS、极致细粒度、AI 生成的代码几乎 1:1 映射到底层 DOM 操作。

---

## 7. AI 原生工具（路线图）

1. **机器可读组件 schema**：扫描项目导出，生成 AI 可直接消费的"有哪些组件、接收什么 props、触发什么事件"清单，免去 AI 通读源码。
2. **自解释错误**：编译/运行错误附带"为什么 + 修正后片段"。
3. **契约式 lint**：把上面的"铁律"变成可自动修复的规则（如检测到在 effect 外写入却期望响应，直接提示）。

> **落地状态**（详见 [README](README.md) 与 [AGENTS.md](AGENTS.md)）：
> 1 已实现（`plaindev schema`，但 props 仍是"推断"而非"声明"，待补）；
> 2 已实现（`PLAIN_E100x` / `PLAIN_E2001` + `hint`，可 JSON 序列化）；
> 3 已实现 10 条 lint 规则并**默认接入构建链路**（构建即失败），另有编译器侧的语义校验
> `PLAIN_E1005`（key/index 冲突）、`PLAIN_E1006`（`server()` 引用外部变量）、
> `PLAIN_E1007`（`server()` 的参数 / 返回值无法 JSON 序列化）。
> 反模式目录 19 条均有静态检查；看不出的标识符不猜（见 `AGENTS.md`）。

---

## 8. 与"直接造一个全新编译器"的关系

不建议从零写编译器。务实路径：**取 Solid/Svelte 的响应式 + 编译内核，套一层本规范的"减法外壳"**——砍掉模板/逻辑分离、钉死 `server/client` 边界、冻结小 API 面。本原型用 200 行运行时先验证模型，正是这条路的起点。
