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
- 事件：`onclick=${fn}` 等，编译期转 `addEventListener`。
- 布尔属性（`checked`/`disabled`/...）按属性语义处理，不依赖字符串 `"false"` 的歧义。

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

---

## 8. 与"直接造一个全新编译器"的关系

不建议从零写编译器。务实路径：**取 Solid/Svelte 的响应式 + 编译内核，套一层本规范的"减法外壳"**——砍掉模板/逻辑分离、钉死 `server/client` 边界、冻结小 API 面。本原型用 200 行运行时先验证模型，正是这条路的起点。
