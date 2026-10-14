# RFC：Context（依赖注入）与 SSR 请求级隔离

> **状态**：已接受，实现中
> **判据依据**：[`SPEC.md` §1.1 功能取舍判据（AI-first 四道闸）](../../SPEC.md)
> **相关**：`AGENTS.md` §3 反模式目录 / §4 错误码、`README.md`「API 全表」、`docs/patterns.md`
> **前置**：`docs/rfcs/ref-escape-hatch.md`（同样是「小核心 + 编译期可检查」的取向）

---

## 1. 问题

### 1.1 跨层传值只能靠 prop drilling

Plain 组件只从父组件拿 `props`。跨层（主题 / 语言 / 当前用户 / 功能开关）只能一层层往下传：
`App → Layout → Page → Panel → DeepChild`。这是企业级应用最常见的结构性摩擦，也是 AI 生成代码里
最容易「漏传一层」的地方（漏了不报错，只是值变成 `undefined`）。

### 1.2 「共享状态放模块作用域」在 SSR 下是**跨请求泄漏**（安全红线）

README 现在的建议是：

> 跨组件共享状态 = 把 `signal` 提升到模块作用域后导入。

这在 CSR 下没问题，**在 SSR 下是红线**：模块作用域在进程里是「一份」，而同进程会服务多个请求。

```tsx
// 反例：当前用户存在模块作用域的 signal 里
const currentUser = signal<User | null>(null);

const loadUser = server(async (id: string) => {
  /* … */ return await db.find(id);
});

export function App(props: { userId: string }) {
  const u = resource(() => loadUser(props.userId));
  effect(() => currentUser.set(u.data() ?? null));   // 写进模块作用域
  return <Header />;                                  // Header 读 currentUser()
}
```

请求 A 渲染到一半、请求 B 开始渲染 —— 两者写的是**同一个** `currentUser`。
轻则 A 的页头显示 B 的用户名，重则 B 的响应里带上 A 的私有数据。
`renderToString` 的 `createScope` 只能回收 effect，回收不了模块变量的值。

**根因不是框架 bug，而是「请求级数据没有正确的位置可放」**：框架只提供了一种共享状态（模块作用域 signal），
而它恰好是 SSR 下最不该用的那一种。AI 会照着文档写，于是必然踩中。

## 2. 为什么这是 P0

- 它是唯一「不修就有正确性 / 安全事故」的缺口（跨请求数据泄漏）；
- 它同时是「企业级应用写不下去」的摩擦（prop drilling）；
- 上述两点合起来：**没有 Context，企业级 SSR 用不了、企业级应用架构立不起来**。

## 3. 设计

### 3.1 API（两个函数 + 一个组件标签）

```tsx
import { createContext, useContext } from "plain";

const ThemeCtx = createContext<"light" | "dark">("light");   // 必须有默认值

function App() {
  const theme = signal<"light" | "dark">("light");
  return (
    <ThemeCtx.Provider value={theme()}>
      <DeepChild />
    </ThemeCtx.Provider>
  );
}

function DeepChild() {
  const theme = useContext(ThemeCtx);
  return <div className={`t-${theme()}`}>…</div>;   // 读法与 signal 一致：调用它
}
```

- `createContext<T>(defaultValue: T) → Context<T>` —— **必须给默认值**；
  没有任何 `Provider` 时读到默认值，**不会静默变成 `undefined`**。
- `<Ctx.Provider value={...}>…</Ctx.Provider>` —— 普通组件标签（编译器把 `Ctx.Provider` 当组件处理，
  **无需改编译器**）；`value` 走 props 的既有规则，动态值自动是 getter。
- `useContext(Ctx) → () => T` —— 返回一个**可调用 getter**，读法 `useContext(Ctx)()`，
  与 `signal()` / `computed()` / `resource.data()` **完全一致**（P2/P3：读法只有一种）。
  因此**结构上不可能「快照住旧值」** —— 这是它不用 `T` 的原因（见 §6 备选）。

> `useContext` **不是 hook**：没有调用顺序约束、可以条件调用。名字沿用生态最广的写法，
> 是为了命中 AI 的先验，减少「记错名字」这一类错。

### 3.2 机制：owner 作用域链（复用 `ErrorBoundary` 的先例）

Plain 已有「作用域链」这一套设施（`ErrorBoundary` 用它挂 `ERROR_HANDLER`，`effect` 用它找最近边界）。
Context 完全复用：

- `Provider` 用 `withOwner(scope, …)` 开一个**嵌套 owner 作用域**，把 `ctx -> valueGetter` 挂在 `scope` 上；
- `useContext(ctx)` 沿**从内到外**的作用域链找最近的注册点：
  - 创建期：`ownerStack`（`withOwner` 维护的栈）；
  - effect 重跑期：`effect.ownerChain`（创建时快照的链，`ErrorBoundary` 已在用）。
- 找不到 → 返回 `defaultValue` 的 getter。

因为「组件创建一定发生在其父级作用域内」，作用域链天然等于**组件树位置**：

```
mount(cleanups)                       ← 最外层
  └─ <ThemeCtx.Provider>  → withOwner(scopeA)  { ThemeCtx → getter }
       └─ <DeepChild>                          ← 创建期 owner = scopeA
            └─ useContext(ThemeCtx)  → 命中 scopeA
```

### 3.3 生命周期与回收

`Provider` 的 `scope` **挂在父 owner 上**（`onCleanup(() => scope.forEach(f => f()))`）：

- 父卸载 / 列表行回收 / 分支切换 → `scope` 整体回收 → 子树内所有 effect 一并回收；
- 不会出现「Provider 自己造了个 owner 却没人回收」的悬挂（`ErrorBoundary` 的 `rebuild` 有这个问题，
  本设计不复用它的写法，只复用「作用域链」这个机制）。

### 3.4 SSR 请求级隔离

- Provider 的值**跟着 owner 作用域走**，而作用域是**每次渲染现建现收**的：
  `renderToString` 在 `createScope` 里跑，Provider 的 `scope` 是它的嵌套作用域，渲染结束随它一起回收
  → **下一个请求读到的是全新作用域，不可能拿到上一个请求的值**。
- 由此给 AI 一条**可执行的新规则**（写进 `AGENTS.md`）：
  **请求级数据一律走 Context 或 props，禁止放进模块作用域的 signal。**
- 验收测试：同一进程内**并发**渲染两个请求，各自 `provide` 不同的 `currentUser`，
  断言两份 HTML 互不串味（含「先渲染 A 到一半，再渲染 B」的交错）。

### 3.5 类型

```ts
export interface Context<T> {
  readonly __plainContext: unique symbol;         // 品牌：不可与普通对象混用
  Provider(props: { value: T; children?: any }): unknown;
  readonly defaultValue: T;
}
export function createContext<T>(defaultValue: T): Context<T>;
export function useContext<T>(ctx: Context<T>): () => T;
```

`value` 的类型与 `useContext` 的返回类型**由 `createContext<T>` 一处决定**，
`Provider` 传错类型 / 消费者读错类型都是 `tsc` 错误（P1：类型即校验）。

### 3.6 与 lint 对齐

把 `const x = useContext(Ctx)` 声明纳入 `collectSignals` 的识别范围 —— 于是 `{x}` 会被
**已有的 `PLAIN_E1102` 自动修**成 `{x()}`。**零新增 lint 规则**，复用现成机制。

## 4. 判据对照

| 闸 | 本设计如何过关 |
| --- | --- |
| **P1 可静态验证** | 类型由 `createContext<T>` 一处决定，传错 / 读错是 `tsc` 错误；`{x}` 漏调用被 `PLAIN_E1102` 自动修 |
| **P2 可本地推理** | Provider 的**位置**写在 JSX 里、读点在组件里可 grep；读法只有一种（调用它），不会快照住旧值 |
| **P3 重复优于抽象** | 2 个函数 + 1 个组件标签；不引入「多个 Context 合并 / 命名空间 / 自动注入」等花样 |
| **P4 平台优先** | Web 平台没有「跨层传值」原语，无可借用；这是**唯一**必须新增的运行时概念 |

## 5. 对外 API 影响（**新增，非破坏**）

这是运行时 `API` 面冻结以来**第一次有意扩面**：新增 `createContext` / `useContext` 两个导出与
`Context<T>` 类型。理由与本 RFC 绑定（P0）。除此之外不扩面；此后继续冻结。
`CHANGELOG` 需显式标注为「新增导出（非 breaking，但改变了『API 恒定』的约定）」。

## 6. 备选方案（明确不采用）

| 备选 | 为什么不采用 |
| --- | --- |
| `useContext(Ctx)` 直接返回 `T` | 组件体里 `const t = useContext(Ctx)` 会**快照住旧值**（值与信号的经典静默失败）。要救它就得再加一条与 `E1107/E1112` 同构的快照规则，成本更高、且仍留一个「忘了 resolve」的坑 |
| 继续用模块作用域 signal 共享 | SSR 下跨请求泄漏（§1.2），且无法用静态检查兜住 |
| 只有 prop drilling | 跨cutting concern 要穿 5–10 层，企业级不可用；AI 极易漏传一层且无任何报错 |
| `inject` / `provide` 命名（Vue 风格） | AI 先验弱于 `createContext` / `useContext`，会多一类「记错名字」的错 |
| 把 Provider 做成 `createScope` 式函数（`provide(ctx, v, () => …)`） | 多一层嵌套函数、且 children 是「值」而不是 JSX thunk，和编译器产出的 `children()` thunk 不搭；组件标签更贴合 Plain 的 JSX 模型 |

## 7. 明确不做

- 不做「值变化时自动重跑消费者组件」（Plain 没有组件重渲染这一层；变化通过 getter/signal 表达）；
- 不做 context 的 SSR 序列化（请求级值本来就该按请求重新 provide）；
- 不做「无 Provider 时的告警」（默认值是显式声明的，读到默认值不是错误）；
- 不做跨文档 / 跨 window 的 context（认领游标和 owner 都按容器隔离，天然如此）。

## 8. 验收标准

- [ ] `createContext` / `<Ctx.Provider>` / `useContext` 三层传递可用，`useContext()` 读法为「调用它」
- [ ] 无 Provider 时读到 `defaultValue`（不返回 `undefined`）
- [ ] 嵌套 Provider：内层遮蔽外层；兄弟子树互不可见
- [ ] Provider 卸载 / 列表行回收 / `when` 分支切换 → 子树 effect 一并回收（无泄漏断言）
- [ ] SSR：同进程并发两个请求各自 provide 不同值，两份 HTML 互不串味
- [ ] hydrate：注水后 `useContext` 读到 provider 的值（节点身份不变）
- [ ] `const x = useContext(Ctx); {x}` 被 `PLAIN_E1102` 自动修成 `{x()}`
- [ ] `tsc --noEmit` 通过；覆盖率不低于门槛

## 9. 未决问题（实现时定，写进测试）

1. **`Function.name` 风险**：`useContext()` 返回的是函数，`theme.name` 在 TS 里是否可访问？若可，
   需在类型上加品牌、或加一条 lint 提示（实现时先用最小复现确认）。
2. **`value` 与 `resolve` 的边界**：`Provider` 里 `value` 恒为 getter（编译器保证），
   但手写 `new` 调用时可能是裸值 —— `resolve()` 两条都兼容，实现按 `resolve` 处理。
3. **作用域链的查找成本**：链长 = Provider 嵌套深度，通常 < 5，线性查找足够；不做缓存。
