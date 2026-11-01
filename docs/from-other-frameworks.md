# 从其它框架迁移到 Plain（React / Vue / Svelte / Solid / Angular）

> 目的：给来自其它框架的同学一张「心智映射表」——把你们的肌肉记忆翻译成 Plain 的唯一写法。
>
> 本文只讲**对比与迁移陷阱**；Plain 自己怎么用请看 [`README.md`](../README.md) 与
> [`docs/patterns.md`](patterns.md)，反模式目录与错误码看 [`AGENTS.md`](../AGENTS.md)。

Plain 的定位是「编译到 DOM + 唯一状态原语 + 显式服务端边界」，所以和各家都有交集：

- **和 React 对比最多**：没有 `useState / useEffect`、没有依赖数组、没有 hook 调用规则，组件只是「返回 JSX 的纯函数」；
- **和 Solid 最像**：细粒度响应式、props 是 getter、都靠编译；
- **和 Svelte 理念最像**：都「编译到 DOM」，没有运行时虚拟 DOM 的 diff；
- **和 Angular 响应式最像**：`signal / computed / effect` 几乎是同一套；
- **和 Vue 概念映射最直接**：但在 Plain 里必须丢掉「Proxy 深度响应式」的幻想。

---

## 0. 先看这几条（所有框架通用）

| 你要的东西 | 你可能习惯的写法 | Plain 的写法 |
| --- | --- | --- |
| 一个会变的值 | `useState` / `ref` / `reactive` / `signal` / `$state` / `createSignal` | `signal(v)`：读 `s()`，写 `s.set(v)` 或 `s.set(prev => next)` |
| 派生值 | `useMemo` / `computed` / `$derived` / `createMemo` / `derived` | `computed(() => …)`，读法与 signal 一致 |
| 副作用 | `useEffect` / `watch` / `watchEffect` / `effect` / `createEffect` / `$:` | `effect(() => …)`，**自动收集依赖，没有 deps 数组** |
| 批量更新 | `batch` / `unstable_batchedUpdates` | `batch(() => …)` |
| 作用域 / 根 | `createRoot`（Solid） | `createScope(() => …)` |
| 清理 | `useEffect` 返回清理 / `onUnmounted` / `onDestroy` / `onCleanup` | `onCleanup(fn)`，或从 `effect` / `ref` 回调 `return () => {}` |
| 异步数据 | `useQuery` / `SWR` / `createResource` / store | `resource(() => …)` → `.data() / .loading() / .error() / .refetch()` |
| 只在服务端跑 | RSC / Server Actions / `getServerSideProps` / loader | `server(async (…) => …)`，编译期**物理剥离**到服务端 |
| 双向绑定 | `v-model` / `bind:value` / `[(ngModel)]` / React 受控 `value + onChange` | **没有**：`value={s()}` + `onInput={…}`（见 patterns §1） |
| 条件 / 列表 | `v-if` / `{#if}` / `*ngIf` / `<Show>` | `{cond ? <a/> : <b/>}` / `{cond && <a/>}` |
| | `v-for` / `{#each}` / `*ngFor` / `<For>` | `{items().map((it) => <li key={it.id}/>)}` |
| 挂载后操作 DOM | `useEffect(…, [])` / `onMounted` / `onMount` / `ngOnInit` | 内建元素 `ref={(el) => {…}}`（元素**连入文档后**调用一次） |
| 跨层传值 | React Context / `provide/inject` / DI | `createContext(default)` + `<Ctx.Provider value>` + `useContext(Ctx)()` |
| 组件挂载生命周期 | 有 | **没有**：组件是「返回 JSX 的函数」，需要 DOM 就用 `ref` 回调 |

> 记住一句：**Plain 只有一个状态原语 `signal`**，读是调用 `()`，写是 `.set()`。
> 其它框架的 `useState / ref / reactive / .value / $state / createSignal` 全部收敛到这一种。

---

## 1. 从 React 过来

| React | Plain | 注意 |
| --- | --- | --- |
| `useState(0)`，`setX(v)` | `signal(0)`：读 `x()`，写 `x.set(v)` | 没有 setter 函数，读写都走 signal |
| `setX(prev => prev + 1)` | `x.set((prev) => prev + 1)` | `set` 直接接受函数 |
| `useMemo(() => a + b, [a, b])` | `computed(() => a() + b())` | **没有 deps 数组**，自动收集依赖 |
| `useCallback(fn, [deps])` | 普通函数（组件不重渲染，无需稳定引用） | 没有「引用稳定」需求 |
| `useEffect(() => {…}, [])` | 初始化直接写在组件体；DOM 相关用 `ref` 回调 | Plain 没有「挂载」生命周期 |
| `useEffect(() => {…}, [x])` | `effect(() => { … x() … })` | 自动收集依赖；别在 effect 里回写同一 signal（`PLAIN_E1110`） |
| `useEffect(() => () => cleanup(), [])` | `onCleanup(cleanup)` 或 `ref` / `effect` 回调 `return cleanup` | |
| `useRef(null)`（拿 DOM） | 内建元素 `ref={(el) => {…}}` | 元素**连入文档后**调用一次 |
| `useRef(v)`（不触发渲染的可变值） | `signal(v)`（要响应式）或普通变量（不需要） | 没有专门的「静默可变引用」API |
| `useContext(Ctx)` | `useContext(Ctx)()` | 返回 getter，**读法要调用 `()`**（`PLAIN_E1114`） |
| `<Ctx.Provider value>` | 一样 | 一致；默认值必须显式给 |
| `<input value={x} onChange={…} />` | `<input value={x()} onInput={(e) => x.set(e.target.value)} />` | 文本输入用 `onInput`；永远受控，无受控/非受控之分 |
| `{cond && <A/>}` / `{cond ? <A/> : <B/>}` | 一样 | |
| `items.map((it) => <li key={it.id}/>)` | 一样 | key 语义不同：Plain 的 key 让节点跟着数据走（不是 diff 提示） |
| `dangerouslySetInnerHTML` | 不支持（`PLAIN_E1104`） | 用 `{expr}` 插值，编译产物不生成 innerHTML |
| `forwardRef` / `memo` / `createPortal` | 都不需要；浮层用平台 `<dialog>` / `popover` | 组件是纯函数，没有重渲染 |
| `useReducer` | `signal` + 普通函数，或 `computed` | 没有专门 API |
| `useQuery` / `SWR` | `resource(() => …)` | 自带 `data / loading / error / refetch` |
| RSC / Server Actions / `getServerSideProps` | `server(async (…) => …)` | 编译期物理剥离，不是另一套数据管道 |

**React 迁移最易踩**

- 肌肉记忆写 `useState` / `useEffect` / `useMemo` / `useCallback` / `useRef` → `PLAIN_E1103`（react-habit）。
- 解构 props / 把 `props.x` 存进变量 → `PLAIN_E1105` / `PLAIN_E1107` / `PLAIN_E1112`；动态值用 `resolve(props.x)`。
- `resolve(props.onClick)` —— 事件 prop 不是 getter → `PLAIN_E1108`。
- `className` / `htmlFor` → `PLAIN_E1115`（warn，可自动修）。
- 以为组件会「重渲染」：Plain 组件函数只执行一次，之后由细粒度 signal 直接更新 DOM；所以组件体里读到的是 props getter，要 `resolve`。

> 一句话：React 的心智模型（状态 → 视图）几乎能平移，但 Plain 删掉了「hooks + 依赖数组 + 重渲染」整条链路，
> 换成「signal + 自动追踪 + 编译期直出 DOM」。所以最容易犯的错，是继续用 hooks 那套 API（`PLAIN_E1103` 专门拦它）。

---

## 2. 从 Vue 过来（Composition API / SFC）

| Vue 3 | Plain | 注意 |
| --- | --- | --- |
| `ref(0)`，`x.value` | `signal(0)`，`x()` | 读是**调用**，不是 `.value` |
| `x.value = 1` | `x.set(1)` | 直接赋值会被 `PLAIN_E1101` 拦 |
| `reactive({ a: 1 })` | `signal({ a: 1 })` | 必须**整值替换**：`s.set({ ...s(), a: 2 })`；`s().a = 2` 不触发更新（`PLAIN_E1106`） |
| `computed(() => …)` | `computed(() => …)` | 一样；派生必须是纯的（`PLAIN_E1111`） |
| `watch(x, cb)` / `watchEffect` | `effect(() => …)` | `effect` **立即执行一次**（≈ `watchEffect`；要 `watch` 的惰性就自己 guard） |
| `onMounted` | 元素级 `ref={(el) => {…}}`；非 DOM 的初始化直接写在组件体 / `effect` | Plain 没有「组件挂载」生命周期 |
| `onUnmounted` / `onScopeDispose` | `onCleanup(fn)` 或从 `effect`/`ref` 回调 `return () => {…}` | |
| `provide` / `inject` | `createContext(default)` + `<Ctx.Provider value={…}>` + `useContext(Ctx)()` | 必须给默认值；读法是调用 `()`，对返回值取属性会被 `PLAIN_E1114` 拦 |
| `v-model="x"` | `value={x()}` + `onInput={(e) => x.set(e.target.value)}` | 没有 `v-model` / 修饰符 |
| `v-if` / `v-else` | `{cond ? <a/> : <b/>}` | |
| `v-for="it in items"` | `{items().map((it) => <li key={it.id}>{it.text}</li>)}` | `key` 让节点跟着数据走 |
| `:prop="expr"` | `prop={expr}` | 属性可以是值或 getter，自动追踪 |
| `@click` | `onClick` | 事件名是 `on` + 大写开头（`onClick` / `onInput`） |
| `<style scoped>` / SFC | TSX + 独立 CSS | 单文件样式**未实现**（见 [`docs/sfc-styles.md`](sfc-styles.md)） |
| `nextTick` | 不需要 | Plain 是同步更新 |
| Pinia store | 模块级 `signal` / `computed` 组合，或 Context | 请求级数据别放模块作用域（SSR 会串味） |

**Vue 迁移最易踩**

- 把 `reactive` 的**深度响应式**带过来：直接改对象/数组字段 → `PLAIN_E1106`。
- 用 `x.value` 读写 signal。
- 期待 `v-model` / `@input` 修饰符 —— Plain 一律显式三件套。

---

## 3. 从 Svelte 过来（runes / legacy）

| Svelte | Plain | 注意 |
| --- | --- | --- |
| `let count = 0` | `signal(0)` | 读 `count()` |
| `$: doubled = count * 2` | `computed(() => count() * 2)` | 纯派生用 `computed` |
| `$: { sideEffect() }` | `effect(() => { … })` | 有副作用用 `effect` |
| `$state` / `$derived` / `$effect`（runes） | `signal` / `computed` / `effect` | |
| `onMount` | `ref={(el) => {…}}`（元素）/ `effect`（非 DOM） | |
| `onDestroy` | `onCleanup` / `return () => {…}` | |
| `bind:value` | `value={s()}` + `onInput` | |
| `{#if}` / `{:else}` | `{cond ? <a/> : <b/>}` | |
| `{#each items as it (it.id)}` | `{items().map((it) => <li key={it.id}/>)}` | |
| `on:click` | `onClick` | |
| `writable` / `readable` store、`$store` | `signal`（自动订阅）；异步用 `resource` | 读法统一 `s()` |
| `tick()` | 不需要 | 同步更新 |

**Svelte 迁移最易踩**

- 把 `$:` 当成一种东西：Plain 里要拆成 `computed`（纯派生）与 `effect`（副作用）。
- 直接改 `let` 变量 → `PLAIN_E1101`。

> 理念上 Svelte 和 Plain 最同源：都「编译到 DOM」，都靠编译期把响应式摊平成直白的 DOM 操作。

---

## 4. 从 Solid 过来（最接近）

| Solid | Plain | 注意 |
| --- | --- | --- |
| `const [x, setX] = createSignal(0)` | `const x = signal(0)` | **不要解构**：signal 是可调用函数，不是 `[get, set]` 元组 |
| `x()` / `setX(v)` | `x()` / `x.set(v)` | |
| `createMemo(() => …)` | `computed(() => …)` | |
| `createEffect(() => …)` | `effect(() => …)` | |
| `createResource(…)` | `resource(() => …)` | |
| `createContext` / `useContext` | `createContext` / `useContext` | 读法：`useContext(Ctx)()` |
| `createRoot(fn)` | `createScope(fn)` | |
| `batch(fn)` | `batch(fn)` | 一样 |
| `untrack(() => x())` | `x.peek()` | 不建立依赖地读一次 |
| `onMount` / `onCleanup` | `ref` 回调 / `onCleanup` | |
| `<Show>` / `<For>` | `{cond ? …}` / `.map` | |
| `props.x`（getter 自动追踪） | `resolve(props.x)` | **最大差异**：Plain 要求动态值显式 `resolve`，直接当值用会抓快照（`PLAIN_E1107` / `PLAIN_E1112`） |

**Solid 迁移最易踩**

- 解构 `createSignal` 的返回值。
- 以为 `props.x` 直接用就行 —— Plain 要 `resolve(props.x)`。
- `resolve(props.onClick)` —— 事件 prop 不是 getter，会被 `PLAIN_E1108` 拦。

---

## 5. 从 Angular 过来（signals 时代最接近）

| Angular | Plain | 注意 |
| --- | --- | --- |
| `signal(0)`，`c()`，`c.set(v)` | `signal(0)`，`c()`，`c.set(v)` | 几乎完全相同 |
| `c.update(fn)` | `c.set((prev) => fn(prev))` | Plain 的 `set` 直接接受函数 |
| `computed(() => …)` | `computed(() => …)` | |
| `effect(() => …)` | `effect(() => …)` | |
| `@Input()` / `input()` | props | 动态值要 `resolve(props.x)` |
| `@Output()` / `output()` / `EventEmitter` | `on*` prop 回调：`props.onSave(…)` | 不要 `resolve` 事件 prop（`PLAIN_E1108`） |
| `model()` / `[(ngModel)]` | `value={s()}` + `onInput` | 没有双向绑定 |
| `inject(Service)` / `providers` | `useContext(Ctx)` / `<Ctx.Provider value>`，或模块级单例 | 请求级数据走 Context |
| `*ngIf` / `*ngFor` | `{cond ? …}` / `.map` | |
| `[prop]="expr"` / `(click)="fn()"` | `prop={expr}` / `onClick` | |
| `ngOnInit` | 组件体直接写（DOM 前）/ `ref` 回调（DOM 后） | |
| `ngOnDestroy` | `onCleanup` / `return () => {…}` | |
| `ngOnChanges` | 不需要 | props 是 getter，读 `resolve(props.x)` 自动跟随 |
| `ChangeDetectionStrategy` / zone.js | 不需要 | 细粒度 signal 直接更新 DOM |

**Angular 迁移最易踩**

- 模板语法整段照搬（`*ngIf` / `[(ngModel)]` / `[prop]`）。
- 在 `ngOnInit` 里等 DOM —— Plain 要用 `ref` 回调（那时元素才连入文档）。
- 事件 prop 用 `resolve`（`PLAIN_E1108`）。

---

## 6. 通用迁移陷阱 → 错误码

| 你带过来的习惯 | Plain 报什么 | 正确写法 |
| --- | --- | --- |
| 直接给状态赋值（`x.value = 1` / `count = 1`） | `PLAIN_E1101`（signal-assign） | `x.set(1)` |
| JSX 里漏调用（`{count}`） | `PLAIN_E1102`（signal-not-called，**可自动修**） | `{count()}` |
| 就地改对象/数组（Vue reactive / React 直接改 state 的习惯） | `PLAIN_E1106`（no-signal-mutate） | `s.set({ ...s(), … })` / `s.set([...])` |
| 解构 props（Vue `toRefs`、Solid / React 解构 props） | `PLAIN_E1105`（no-props-destructure） | `resolve(props.x)` |
| 把 props 存进变量（抓快照） | `PLAIN_E1107` / `PLAIN_E1112`（no-props-snapshot） | 用的时候 `resolve(props.x)` |
| `resolve` 事件 prop | `PLAIN_E1108`（no-resolve-event-prop） | `props.onClick(…)` |
| `useEffect` / `effect` 读写同一 signal | `PLAIN_E1110`（no-effect-loop） | 用 `computed` 派生，别在 effect 里回写 |
| `computed` 里写 signal | `PLAIN_E1111`（no-computed-side-effect） | 派生保持纯函数 |
| 模块作用域建 `resource`（在模块顶层 watch / 取数） | `PLAIN_E1113`（no-module-scope-resource） | 放进组件或 `createScope` |
| `useContext(Ctx).prop` | `PLAIN_E1114`（no-context-getter-property） | `useContext(Ctx)().prop` |
| React 拼写（`className` / `htmlFor`） | `PLAIN_E1115`（warn，**可自动修**） | `class` / `for` |
| `useState` / `useEffect` …（React） | `PLAIN_E1103`（react-habit） | `signal` / `effect` |

> 规则只拦「确定错的」，误报用行级抑制（详见 [`AGENTS.md`](../AGENTS.md)）。
> React 的独有习惯有专门错误码（`PLAIN_E1103` / `PLAIN_E1115`）；
> Vue / Svelte / Angular 的**独有语法**（`.value`、`$:`、模板）大多没有专门错误码——
> 它们不是「Plain 的反模式」，而是「别的框架的 API」，写进来会直接是语法 / 运行时错误，
> 所以靠上面的映射表规避，而不是等编译器抓。

---

## 7. 一句话总结

- **从 React 来**：心智模型能平移，但要删掉 hooks / 依赖数组 / 重渲染的惯性；`PLAIN_E1103` 专门拦 `useState` 这类肌肉记忆。
- **从 Vue 来**：概念一一对应，但**丢掉 Proxy 深度响应式的幻想** —— Plain 只有整值替换。
- **从 Svelte 来**：理念最像（都编译到 DOM），把 `$:` 拆成 `computed`（派生）与 `effect`（副作用）。
- **从 Solid 来**：几乎同构，只需记住「不要解构 signal、props 动态值要 `resolve`」。
- **从 Angular 来**：signals 部分几乎照搬，模板与 DI 换成 JSX / Context。

---

## 相关文档

- [`README.md`](../README.md)：语法与 API 全貌
- [`docs/patterns.md`](patterns.md)：每个场景的唯一推荐写法
- [`AGENTS.md`](../AGENTS.md)：反模式目录 + 错误码
- [`docs/rfcs/ref-escape-hatch.md`](rfcs/ref-escape-hatch.md)：命令式 DOM（对应 `useEffect(…, [])` / `onMounted` / `onMount` 那类需求）
- [`docs/rfcs/context-and-ssr-isolation.md`](rfcs/context-and-ssr-isolation.md)：跨层传值与 SSR 请求隔离
- [`eval/compare/`](../eval/compare/README.md)：Plain vs React 的对称实证评测（同一提示词 + 同一断言）
