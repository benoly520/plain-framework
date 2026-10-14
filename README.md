# Plain

> 一个**编译到 DOM** 的前端框架：TSX 视图 + signals 响应式 + **显式的服务端边界**。
> 为「AI 写、人来维护」而设计 —— 少推理、少概念、少意外。

```tsx
import { signal, computed, mount, server } from "plain";

const count = signal(0);                       // 唯一的状态原语
const double = computed(() => count() * 2);    // 派生值，读法完全一致

const now = server(() => Date.now());          // 编译期物理搬到服务端

function App() {
  return (
    <button onClick={() => count.set(count() + 1)}>
      点了 {count()} 次，翻倍是 {double()}
    </button>
  );
}

mount("#app", App());
```

---

## 目录

- [10 秒理解 Plain](#10-秒理解-plain)
- [核心规则（只有 5 条）](#核心规则只有-5-条)
- [安装与运行](#安装与运行)
- [API 全表](#api-全表)
- [编译器支持 / 不支持的写法](#编译器支持--不支持的写法)
- [server()：显式执行边界](#server显式执行边界)
- [SSR 与注水](#ssr-与注水)
- [HMR 热更新](#hmr-热更新)
- [工具链 plaindev](#工具链-plaindev)
- [面向 AI 的设计](#面向-ai-的设计)
- [边界与已知限制](#边界与已知限制)
- [测试与质量](#测试与质量)
- [常见场景配方 docs/patterns.md](docs/patterns.md)
- [路线图 ROADMAP.md](ROADMAP.md) ｜ [给 AI 代理的说明 AGENTS.md](AGENTS.md) ｜ [AI 正确率评测 eval/](eval/README.md) ｜ [安全说明 SECURITY.md](SECURITY.md)

---

## 10 秒理解 Plain

| 维度 | 传统框架 | Plain |
| --- | --- | --- |
| 视图 | 自己写 VNode / DOM diff | **编译期生成建 DOM 的代码**，运行时没有虚拟 DOM |
| 状态 | useState / ref / reactive / store 多套 | **只有 `signal`** |
| 依赖收集 | deps 数组 / 手动 memo | 自动，**没有依赖数组** |
| 副作用顺序 | hook 顺序必须稳定 | 无序，**没有 hook 规则** |
| 组件边界 | 隐式（一切都在浏览器） | **`server()` 显式标注，编译期物理剥离** |
| 安全 | `innerHTML` 随手可写 | **编译产物里不可能出现 innerHTML** |

生成的代码大概长这样（可读、可断点、可 grep）：

```js
const __el1 = document.createElement("button");
__el1.addEventListener("click", () => count.set(count() + 1));
__effect(() => { __t2.nodeValue = __stringify(count()); });
__effect(() => { __t3.nodeValue = __stringify(double()); });
```

---

## 核心规则（只有 5 条）

1. **状态只有 `signal`**：读 `s()`，写 `s.set(v)` 或 `s.set(prev => next)`。
   派生用 `computed(fn)`，读法完全一样。没有 `useState` / `ref` / `reactive` / `.value` / `.get()` 这些分支。
2. **组件就是「返回 JSX 的函数」**，必须是 `return (<jsx />)` 的形式（编译期会把它展开成建 DOM 的代码）。
3. **列表用 `arr.map(x => <li/>)`，条件用 `{cond ? <a/> : <b/>}` 或 `{cond && <a/>}`。**
   编译成 `each()` / `when()`，行级响应式自动生效，不用 memo。
   想让**节点跟着数据走**（头部插入 / 重排时不重建）就给顶层元素写 key：
   `arr.map(x => <li key={x.id}>…</li>)`。不写 key 则按位置复用 —— 两种都对，语义不同而已。
4. **副作用用 `effect(fn)`**，依赖自动收集；随组件/列表行一起被回收，需要额外清理时用 `onCleanup`。
5. **要跑在服务端的代码，用 `server()` 包起来。** 客户端产物里只剩 RPC 桩。

> 组件里拿到 `props.x` 一律用 `resolve(props.x)` 取值 —— 编译器把动态属性统一传成 getter，
> 这样父组件状态一变，子组件自动更新，且只更新用到的那几行。

---

## 安装与运行

```bash
pnpm add -D vite      # 唯一的硬依赖（除了 typescript）
pnpm add plain

npx plaindev dev          # 开发：dev server + /_plain/rpc
npx plaindev build        # 构建：产出 dist/ 与 .plain/server.mjs
npx plaindev serve dist   # 生产：静态托管 + RPC，一条命令
```

`vite.config.js`：

```js
import { defineConfig } from "vite";
import plain from "plain/vite";

export default defineConfig({
  plugins: [plain()],
  resolve: { alias: { plain: "plain" } },
});
```

`tsconfig.json` —— `jsx: "preserve"` **必须**（Plain 自己要处理 JSX）：

```json
{
  "compilerOptions": {
    "jsx": "preserve",
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "baseUrl": ".",
    "paths": { "plain": ["node_modules/plain/dist/index.d.ts"] }
  }
}
```

---

## API 全表

整个运行时 API 就这些。**约定：对外 API 面恒定，新增即 breaking change。**

### 响应式

| API | 说明 |
| --- | --- |
| `signal(init)` | 唯一状态原语。`s()` 读，`s.set(v)` 写，`s.peek()` 不建依赖地读 |
| `computed(fn)` | 派生值，读法与 `signal` 一致 |
| `effect(fn)` | 副作用，返回 `{ dispose() }`；在组件/列表内随其生命周期自动回收 |
| `batch(fn)` | 合并多次写入，只触发一轮更新 |
| `createScope(fn)` | 创建一个可整体回收的作用域 |
| `onCleanup(fn)` | 注册卸载回调 |
| `resolve(v)` | 取值：是 getter 就调用，否则原样返回（组件里统一用它） |

### DOM

| API | 说明 |
| --- | --- |
| `mount(selOrEl, node)` | 挂载，返回卸载函数 |
| `insert(parent, get)` | 插入任意表达式结果（编译器生成，手写也可用） |
| `when(parent, cond, then, else)` | 条件渲染（编译器生成） |
| `each(parent, getter, itemFn, keyFn?)` | 列表渲染（编译器生成）。传了 `keyFn` 走按 key 复用，否则按位置复用 |
| `createSlot(label?)` | 带锚点的插槽：组件要**事后整体替换自己的内容**时返回它 |
| `place(parent, node)` | 编译器挂载组件的统一入口（兼容 Node / Fragment / Slot） |
| `ErrorBoundary` | 子树报错就地降级 |
| `hydrate(el, App, opts?)` | SSR 注水：复用服务端节点，自动读回首屏数据载荷，返回 `{ dispose, warnings }` |
| `hmrApply(id, newMod)` | 热替换指定模块的挂载点（一般由 vite 插件调，无需手写） |

### 异步与跨端

| API | 说明 |
| --- | --- |
| `resource(fn)` | 返回 `{ data, loading, error, refetch }`；`fn` 里读的 signal 变化会自动重取，并丢弃过期响应 |
| `server(fn)` | 编译期物理剥离到服务端，客户端变 RPC 桩 |
| `rpc(name, args)` | 底层调用（一般不用手写） |
| `setRpcEndpoint(url)` | 改 RPC 端点（部署在子路径时用） |

### 跨层传值（Context）

| API | 说明 |
| --- | --- |
| `createContext<T>(默认值)` | 创建一个 Context（**必须给默认值**：没有 Provider 时读它，不会静默变 `undefined`） |
| `<Ctx.Provider value={…}>…</Ctx.Provider>` | 在子树里提供值（普通组件标签，无需改编译器） |
| `useContext(Ctx)` | 返回一个**可调用 getter**，读法 `useContext(Ctx)()` —— 与 `signal` 一致，结构上不可能快照住旧值 |
| `Context<T>` | 类型：`value` 与 `useContext` 的返回类型由 `createContext<T>` 一处决定，传错 / 读错是 `tsc` 错误 |

> 请求级数据（当前用户 / 会话）请走 Context 或 props，**不要放模块作用域的 signal** ——
> SSR 下后者会在同进程的多个请求之间串味。设计与验收见 [`docs/rfcs/context-and-ssr-isolation.md`](docs/rfcs/context-and-ssr-isolation.md)。

### 路由

```tsx
const router = createRouter({
  routes: [
    { path: "/", component: Home },
    { path: "/user/:id", component: User },
    { path: "*", component: NotFound },
  ],
  mode: "hash", // 或 "history"
});

// 页面切换写成函数调用，插值会自动追踪 router 状态
function currentPage() {
  const m = router.current();
  return m.route ? m.route.component({ params: m.params, path: m.path }) : null;
}
```

`Link` 组件与 `navigate(to)` 由 `router` 提供；路由切换会**自动回收上一页的所有 effect**。

---

## 编译器支持 / 不支持的写法

### 支持

```tsx
// 1. 组件：return (<jsx />)
function Card(props) {
  return (<section className="card">{props.children()}</section>);
}

// 2. 列表（带 key 时按 key 复用节点；不带则按位置复用）
<ul>{todos().map(t => <li key={t.id} className={t.done ? "done" : ""}>{t.text}</li>)}</ul>

// 3. 条件（可无限嵌套）
{loading() ? <p>加载中</p> : error() ? <p>{error().message}</p> : <div>{data().name}</div>}

// 4. 与运算
{user() && <span>{user().name}</span>}

// 5. 内联函数（编译成真正的函数，不是字符串）
<StatCard label="用户" value={() => stats().users} />

// 6. 事件
<button onClick={(e) => submit(e)}>提交</button>

// 7. 命令式逃逸口：拿到这个元素（内建元素专用）
<canvas ref={(el) => { el.getContext("2d"); }} />
```

### 命令式逃逸口 `ref`

组件体拿不到自己创建的 DOM 节点。需要命令式操作（`dialog.showModal()` / `canvas.getContext()` /
`video.play()` / 第三方库要节点）时，在**内建元素**上用 `ref={(el) => …}`：

```tsx
<canvas ref={(el) => {            // el 类型由标签推导：HTMLCanvasElement
  const ctx = el.getContext("2d");
  draw(ctx);
  return () => { /* 元素回收时清理（可选） */ };
}} />
```

- **调用时机**：元素**连入文档之后**调用一次（≈ 平台的 `connectedCallback`）—— 所以
  `showModal()` 这类「必须在文档里才能调」的 API 可以放心用。
- **返回值**：可选清理函数，随该元素 / 组件回收（≈ `disconnectedCallback`）。
- **作用域**：回调在该元素的 owner 作用域内执行；**要用这个节点的响应式逻辑就写进回调里**
  （组件体的语句先于 DOM 构建执行，那时节点还不存在）。
- **只放内建元素上**：组件上写 `ref` 会编译报错（组件不保证有根节点）。
- SSR 期间不执行；注水后执行一次。

取舍与验收见 [`docs/rfcs/ref-escape-hatch.md`](docs/rfcs/ref-escape-hatch.md)。

### 不支持 —— 会**在编译期报错并给出行号**

| 写法 | 原因 | 改法 |
| --- | --- | --- |
| `.map()` 里 `return` 的不是 JSX | 无法编译成 DOM 指令 | 换成返回 JSX |
| `innerHTML` / `insertAdjacentHTML` | 安全红线 | 用 `{expr}` 插值 |
| `useState` / `useEffect` 等 React API | 不是 Plain 的 API | `signal` / `effect` |
| JSX 属性展开 `{...expr}`（`PLAIN_E1008`） | 展开只做了半套：不进响应式 + 绕过 class / style / value，会静默跑错 | 展开成显式属性 |

编译器最后有一道**自检**：产物里若残留任何未处理的 JSX，或代码无法解析，直接抛错。
**不会**把坏代码悄悄交给打包器。

**一个刻意的取舍**：列表里同时写 `key=` 和 index 参数会**直接编译报错**（`PLAIN_E1005`），
而不是悄悄丢掉其中一个。原因：keyed 复用下行只构建一次，回调捕获的 index 无法随位置更新，
两者同时生效必然有一个语义是错的 —— 而**静默的语义降级**恰恰是本框架最想消灭的失败模式。

### 错误码（一套）

编译器、lint、构建期**共用同一套** `PLAIN_Exxxx` 编号 —— 机器只需记一套前缀。
`error.code` / `error.file` / `error.line` / `error.column` / `error.hint`，`JSON.stringify(error)` 即可拿到。

编号自带分类：`E10xx` 编译器内部 · `E11xx` lint（可抑制）· `E2xxx` 构建期闸门。

| 错误码 | 含义 |
| --- | --- |
| `PLAIN_E1001` | 有 JSX 落在编译器不认识的写法里（附正确写法提示） |
| `PLAIN_E1002` | 产物无法解析（通常是输入没先剥离 TS 类型） |
| `PLAIN_E1003` | 产物里残留 JSX（编译器 bug） |
| `PLAIN_E1004` | 遇到不支持的语法节点（编译器 bug） |
| `PLAIN_E1005` | 列表的 `key` 与 index 参数同时使用（二者选一） |
| `PLAIN_E1006` | `server()` 的函数体引用了外部变量（闭包不会跟到服务端） |
| `PLAIN_E1007` | `server()` 的调用参数 / 返回值无法 JSON 序列化（函数 / 类实例 / Stream） |
| `PLAIN_E1008` | JSX 属性展开 `{...expr}`（只做了半套支持，会静默跑错） |
| `PLAIN_E1009` | `ref` 用在组件上（组件没有稳定根节点） |
| `PLAIN_E1010` | `ref` 的值不是函数（应为 `ref={(el) => …}`） |
| `PLAIN_E1011` | `ref` 回调不能是 `async`（清理与异步不兼容） |
| `PLAIN_E2001` | 契约检查未通过（由构建链路抛出，`plaindev check --fix` 可自动修） |

**契约检查默认接在构建链路里**（`plainPlugin({ lint: "warn" | false })` 可调），
所以下面那些 AI 常见错误会让**构建失败**，而不是拖到运行时才炸：

| 契约规则（错误码） | 拦截的写法 | 能否自动修 |
| --- | --- | --- |
| `PLAIN_E1101` | `count = 1` | ✅ 改成 `count.set(1)` |
| `PLAIN_E1102` | `{count}` / `checked={done}` | ✅ 补上调用 |
| `PLAIN_E1103` | `useState` / `useEffect` / … | ❌ 语义不同，只报错 |
| `PLAIN_E1104` | `el.innerHTML = …` | ❌ 安全红线，只报错 |
| `PLAIN_E1105` | `const { title } = props` / `function Card({ title })` | ❌ 两种改法语义不同，只报错 |
| `PLAIN_E1106` | `items().push(x)` / `todos()[0].done = true` / `const a = items(); a.push(x)` | ❌ 只报错 |
| `PLAIN_E1107` / `PLAIN_E1112` | `const t = props.title` / `{props.title}` / `let t; t = props.title` | ❌ 内联 resolve 与 thunk 语义不同，只报错 |
| `PLAIN_E1108` | `resolve(props.onClick)` | ✅ 去掉 resolve → `props.onClick` |
| `PLAIN_E1109` | `effect(async () => { await … })` | ❌ 依赖收集在 await 后失效，只报错 |
| `PLAIN_E1110` | `effect(() => count.set(count() + 1))` | ❌ 自触发会栈溢出，只报错（钳位写法不报） |
| `PLAIN_E1111` | `computed(() => { s.set(…) })` | ❌ 派生值必须纯，只报错 |
| `PLAIN_E1113` | 模块作用域创建 `resource()`（import 时立即执行 / SSR 导入即发请求） | ❌ 挪进组件 / `createScope`，只报错 |
| `PLAIN_E1114` | 对 `useContext(Ctx)` 的返回值直接取属性（它是 getter） | ❌ 改成先调用：`useContext(Ctx)()`，只报错 |

> 每个码还有一个**可读短名**（`PLAIN_E1107` = `no-props-snapshot`），完整目录见 `src/errors.ts`；
> 旧写法 `plain/no-props-snapshot` 在抑制指令里仍被接受（向后兼容），但输出统一走新码。

给 AI 代理看的完整反模式目录在 [`AGENTS.md`](AGENTS.md)。编译器侧还会拦 `server()` 的参数与返回值里字面量函数 / 本文件类实例 / Stream（`PLAIN_E1007`）。

规则是启发式，确认误报时用**行级抑制指令**（只对 lint 规则生效；编译器的 `PLAIN_E*` 压不住）：

```js
const t = props.title; // plain-ignore-line PLAIN_E1112
// plain-ignore-next-line
effect(() => count.set(count() + 1));
```

不写规则码表示抑制该行全部规则；`plaindev check` 会把抑制处数报出来 —— 抑制是可见的，不是静音开关。

```
[PLAIN_E1001] Counter.tsx:8:11 这些位置的 JSX 编译器还不认识：Counter.tsx:8
  提示：组件用 'return (<jsx/>)'；列表用 'arr.map(x => <jsx/>)'；条件用 '{cond ? <a/> : <b/>}' 或 '{cond && <a/>}'
```

---

## server()：显式执行边界

这是 Plain 最重要的一条设计：**「这段代码跑在哪」在源码里一眼可见**。

```tsx
const db = server(async (id: string) => {
  const secret = process.env.DB_URL;      // 只有服务端有
  return await query(secret, id);
});

function User(props) {
  const user = resource(() => db(props.params.id));   // 客户端调用方式不变
  return <p>{user.data()?.name}</p>;
}
```

编译后：

- **客户端产物**：`const db = (...args) => rpc("db", args);` —— 函数体一行都不在
- **服务端清单 `.plain/server.mjs`**：完整函数体 + `__plainHandlers` 汇总
- **dev**：`plaindev dev` 自带 `/_plain/rpc`
- **生产**：`plaindev serve dist`，或在你自己的 Node 服务里挂中间件：

```js
import { rpcMiddleware } from "plain/server";
app.use(rpcMiddleware({ manifest: ".plain/server.mjs" }));
```

**边界说明：**

- `server()` 里引用的**外部变量必须可序列化地自己获取** —— 函数体会被物理搬走，闭包不会跟过去。
  这是刻意设计：让「跨端的数据依赖」暴露在明面上。
- 参数与返回值走 JSON，**不要传函数、类实例、Stream**。
- 鉴权请在 `server()` 里自己做（它就在你的服务端进程里）。
- **函数名在整个应用里必须唯一**。清单是单文件（`.plain/server.mjs`），多入口 / 多模块下
  同名 `server()` 函数会被**构建期拦下并报冲突**（点名两处来源文件），而不是静默互相覆盖 ——
  客户端 RPC 桩还在调旧名字、服务端实现却已换成另一个，是这里最贵的失败模式。
  Vite 侧的 entry `input`、shared chunk 等打包配置照常透传，框架不介入。

---

## SSR 与注水

Plain 编译产物是「直接建 DOM + effect 首次同步执行」，所以 SSR 不需要独立渲染器 ——
**换一个 `document` 实现即可**（`src/server/dom-shim.ts`，零依赖）。

```js
import { renderToString, renderToStringSync, renderToStringWithData } from "plain/server";

const html = renderToStringSync(App);                    // 同步部分（resource 停在 loading）
const { html, data } = await renderToStringWithData(App, { // 等 resource 静默 + 收集首屏载荷
  handlers: await loadHandlers(),                        // server() 直调（不走 HTTP）
  url: req.url,                                          // router 按请求 URL 渲染
});
```

### 首屏数据：`server()` + `resource()` 就是唯一写法

没有 `loader()` / `getServerSideProps` 这类概念 —— 一条链把「首屏就有数据」接起来：

| 环节 | 发生了什么 |
| --- | --- |
| 服务端 | `server()` **直调**同进程实现（不 fetch 自己）；渲染后**等所有 `resource` 静默**（不是猜一个毫秒数） |
| 收集 | 编译器给每个 `resource(...)` 注入了**调用点 key**（如 `app.tsx:19#0`），按**创建序**收进 `data` |
| 传输 | `data` 写进页面 `<script type="application/json" id="plain-data">`；`hydrate` 自己读回来 |
| 注水 | 按「同一个 key 自己的队列」按创建序**配对种入** → 首帧与 HTML 一致（不闪 loading、不多请求一次） |
| 之后 | 仍做一次 **SWR 后台校验**：`promiseFn` 照跑，所以依赖变化照样能重取（不为此牺牲响应性） |

**注水**：`hydrate` 复用服务端已渲染的真实节点（**节点对象身份不变**，不整树重建），
文本/属性不一致时就地修正，随后事件与响应式照常工作。

```js
import { hydrate } from "plain";

const { dispose, warnings } = hydrate(document.getElementById("app"), App);
```

SSR 序列化时会保留 `plain-` 前缀的注释锚点（`<!--plain-[-->…<!--plain-]-->`），
注水靠它们定位动态区间；普通注释仍会被丢弃。注水与 SSR 同源：都跑同一份编译产物，
`mount()`（未注水）行为完全不变。

### 起生产服务

```js
import { serve } from "plain/server";

await serve({
  dist: "dist",
  ssr: { template: "dist/index.html", entry: ".plain/ssr/entry-server.js" },
});
```

模板里要有两个占位注释（**缺了或写重了都直接报错**，不静默出一张没数据的页面）：
`<!--plain-ssr-->`（应用 HTML，放在承载容器**里面**）、`<!--plain-data-->`（载荷 script，放在容器**外面**）。
完整可跑的例子见 [`examples/ssr/`](examples/ssr)：`pnpm run build:example:ssr` 构建、
`pnpm run start:example:ssr` 起服务（打开 `/todo/2` 的网页源代码就能看到那条数据）。

**命中缓存、省掉整页重渲染（可选）**：给 `ssr` 一个 `cache` 选项，按**完整 URL（含 query）** + TTL
缓存渲染后的整页 HTML，命中直接回、不再现渲染：

```js
await serve({
  dist: "dist",
  ssr: {
    template: "dist/index.html",
    entry: ".plain/ssr/entry-server.js",
    cache: { ttl: 30_000, max: 1000 },   // ttl 0 = 永不过期（靠 max 淘汰），max 默认 1000
  },
});
```

只在**渲染成功**后写缓存（500 等错误不进缓存、也不污染其它命中）；并发同 URL 自动去重（防惊群）。
**dev 下不要开** —— 代码一变缓存就是脏的（dev SSR 走 vite 插件那条路，不走本中间件）。

**dev 下不必先构建**：给 vite 插件一个**源码**入口，页面导航就交给服务端渲染（改代码立刻生效，
`server()` 直调用的是内存里的 dev 注册表，也不依赖 `.plain/server.mjs`）：

```js
// vite.config.js
plain({ ssr: { entry: "./entry-server.tsx" } });   // 示例：pnpm run dev:example:ssr
```

> 模板里的资源引用请用**绝对路径**（`/entry-client.tsx`，不是 `./entry-client.tsx`）：
> SSR 的页面可能是 `/todo/2` 这类嵌套地址，相对路径会被解析成 `/todo/entry-client.tsx` ——
> 首屏 HTML 正常，客户端脚本却 404。绝对路径在 dev 与构建后都指向项目根。

> **并发安全**：SSR 期间 `globalThis.document` 是「取值时查当前渲染上下文」的访问器
> （不是换全局再换回来），每次渲染跑在自己的 `AsyncLocalStorage` 作用域里 ——
> 同进程并发渲染互相不串。根因与修法见 [`docs/rfcs/ssr-data.md`](docs/rfcs/ssr-data.md) §3.4。
> `renderToString` 结束后会回收 SSR 期间创建的 effect，避免污染同进程后续的 hydrate。

---

## HMR 热更新

dev（vite）下改动 Plain 模块**不整页刷新**：只重建相关挂载点的 DOM 子树
（`syncRange` 替换锚点区间）。**说清保住什么、丢什么**：

- **保住**：窗口滚动、**锚点区间之外**的 DOM（节点身份不变，它们的焦点 / 输入 / 局部滚动原样），
  以及模块级 `signal` 的原始值 —— 这是唯一「主动搬运」的状态；保留不了会在控制台
  **显式告警**，绝不静默重置；
- **丢掉**：被重建子树**之内**的 DOM 状态 —— 焦点 / 选区、未受控输入的值、局部滚动、
  第三方组件实例（Monaco 等会被 `ref` 的清理函数销毁后重建）。受控输入的值能回来，
  因为值本来就在 `signal` 里，重渲染即恢复。

换句话说：HMR 的粒度是**锚点区间**，不是节点。边界由 `test/hmr.test.mjs` 钉住。
vite 插件默认开启，可用 `plain({ hmr: false })` 关闭。

```js
// vite.config.js
import plain from "plain/vite";
export default { plugins: [plain()] };              // dev 即具备 HMR
```

底层运行时 API（一般无需手写）：`hmrApply(id, newMod)` / `snapshotSignals` /
`restoreSignals`；插件会为每个模块注入 `import.meta.hot.accept` 并自动关联模块 id。

---

## 工具链 plaindev

```bash
plaindev check [dir] [--no-fix]     # 契约检查 + 自动修复高频错误
plaindev schema [dir] [--out f]     # 输出机器可读的组件契约 JSON
plaindev dev [root] [--port n]      # 开发服务器（含 RPC）
plaindev build [root] [--out-dir d] # 生产构建
plaindev serve [dist] [--port n]    # 生产托管 + RPC
plaindev agent-context [--write]    # 打印给 AI 的规则上下文（取自 AGENTS.md）
                                    # --write 落盘 AGENTS.md / copilot / cursor，不覆盖已有文件
plaindev mcp                        # MCP stdio server：把 check / schema 交给 AI IDE
plaindev lsp                        # LSP stdio server：编辑器里实时诊断（didOpen/didChange）
```

### `check`：把 AI 的典型错误直接改掉

```bash
$ plaindev check src
src/Counter.tsx
  x src/Counter.tsx:8:3   [PLAIN_E1101]    不能直接给 signal 变量 "count" 赋值，要用 "count.set(...)"
  x src/Counter.tsx:14:10 [PLAIN_E1102] signal 要调用取值："{count()}"
  -> 已自动修复并写回 src/Counter.tsx
```

能自动修的（AST 定位 + 源码切片，不做正则替换）：

| 规则 | 代码 | 自动改成 |
| --- | --- | --- |
| `PLAIN_E1101` | `count = v` | `count.set(v)` |
| `PLAIN_E1102` | `{count}` / `checked={done}` | `{count()}` / `checked={done()}` |
| `PLAIN_E1103` | `useState(...)` | 只报错（语义不同，不能瞎改） |
| `PLAIN_E1104` | `el.innerHTML = ...` | 只报错（安全红线） |

### `schema`：给 AI / CI / IDE 的机器可读契约

```json
{
  "file": "main.tsx",
  "components": [
    {
      "name": "TodoView",
      "props": [{ "name": "todo", "optional": false, "type": "Todo" }],
      "propsSource": "declared",
      "renders": ["div", "p", "button"]
    }
  ],
  "serverFunctions": [{ "name": "fetchStats", "params": [], "async": true }],
  "routes": [{ "path": "/todo/:id", "component": "Detail" }]
}
```

`props` 的事实来源是**组件自己声明的类型**（`props: CardProps`），不是猜：

- `propsSource: "declared"` —— 按声明的类型解析：`optional` 来自 `?`、`type` 来自注解；
- `propsSource: "declared-unresolved"` —— 声明了类型但解析不了（跨文件、`Pick<…>` 之类的工具类型），
  此时附带 `declaredType` 并退回推断结果，**不假装解析成功**；
- `propsSource: "inferred"` —— 组件没写类型注解，退回「读了什么 + 同文件调用点传了什么」的旧推断；
- 声明与推断不一致时额外给出 `inferredProps`，AI 能一眼看出「猜」错在哪。

> 「少传 / 多传 prop」这类错**不靠 schema 校验** —— Plain 用 TS，且 JSX 类型是收紧的，
> `tsc` 在编译期就报（见 `test/types.test.mjs`）。schema 的价值是给 AI 一份**不用通读代码**的契约，
> 而不是再造一个类型检查器。

Agent 拿到这份 JSON 就知道「这个文件里能改什么、有哪些跨端调用」，不用先通读全文 ——
这是减少推理量的关键一步。

---

## 面向 AI 的设计

Plain 的每条设计都对应一个「AI 常犯的错」：

| AI 的常见失败模式 | Plain 的应对 |
| --- | --- |
| 忘记依赖数组 / memo 化的值过期 | 自动依赖收集，**没有依赖数组这个概念** |
| hook 顺序错 / 条件调用 hook | **没有 hook 概念**，`effect` 就是普通函数 |
| 状态框架混用（`ref` + `reactive` + `store`） | **只有 `signal`**，读法只有一种 |
| 在 JSX 里忘了 `.value` / 少写 `()` | 契约检查**自动修正** `{count}` → `{count()}` |
| 把服务端代码写进浏览器（泄漏密钥） | 编译期**物理剥离**，泄漏在结构上不可能 |
| `innerHTML` 拼字符串导致 XSS | 编译产物**不生成 innerHTML**；插值一律走文本节点 |
| 列表更新不生效（mutation / key 错） | 行级响应式自动生效，**不用写 key** |
| 大段 JSX 改动后不知从哪下手 | `plaindev schema` 给结构摘要；产物是直线的建 DOM 代码，可读可断点 |

---

## 边界与已知限制

### 已完成并验证

- ✅ signals / computed / effect / batch / 作用域回收（无泄漏）
- ✅ 编译到 DOM，零虚拟 DOM、零 innerHTML
- ✅ 列表行级响应式、条件分支回收、按 index 复用
- ✅ 组件 props / children / 内联函数 prop
- ✅ 路由（history / hash / `:param` / `*`），切换即回收
- ✅ `resource` 异步（竞态丢弃）与错误态
- ✅ `ErrorBoundary` 就地降级
- ✅ `server()` 编译期物理剥离 + dev / 生产 RPC 链路
- ✅ SSR 输出（`renderToStringSync` / `renderToString`）
- ✅ **SSR 注水**：`hydrate(container, App)` 复用服务端节点（身份不变）、就地修正、交互可用
- ✅ **SSR 首屏数据**：`server()` 直调 + 等静默 + `renderToStringWithData` 收载荷 +
  编译器注入调用点 key + 注水配对种入（首帧与 HTML 一致）；`ssrMiddleware` / `serve({ ssr })` 一行起。
  并发隔离（`AsyncLocalStorage`）、示例 [`examples/ssr/`](examples/ssr)。设计见
  [`docs/rfcs/ssr-data.md`](docs/rfcs/ssr-data.md)
- ✅ **dev 下的 SSR**：插件给**源码**入口即可（`plain({ ssr: { entry } })`）—— 走 vite 的
  `ssrLoadModule` + dev 内存注册表 + `transformIndexHtml`，不必先构建，改代码立刻生效
- ✅ **HMR 热更新**：dev 下改组件只热替换 DOM 子树（不整页刷新），模块级 signal 值尽力保留
- ✅ CLI：check / schema / dev / build / serve
- ✅ TypeScript 类型（含 JSX 类型，`tsc --noEmit` 通过）
- ✅ 列表 keyed 复用（`key={...}`）：头部插入 / 重排不重建已有节点
- ✅ **命令式 DOM 逃逸口** `ref={(el) => …}`：元素连入文档后回调（≈ `connectedCallback`）、
  可返回清理函数、列表 / 分支回收正确、SSR 跳过、注水后执行；`PLAIN_E1009`–`E1011` 编译期拦截
- ✅ **Context（跨层传值）+ SSR 请求级隔离**：`createContext` / `<Ctx.Provider>` / `useContext`
  （读法同 signal，结构上不会快照住旧值）；作用域随父 owner 回收；请求级数据终于有正确的位置，
  杜绝「模块作用域 signal 跨请求串味」；`PLAIN_E1114` 拦「直接取属性」
- ✅ **JSX 类型收紧**：内建元素去掉 `[attr: string]: any` —— 属性名拼错 / 类型写错（`scr` /
  `checked="yes"` / `onClikc`）在编辑器与 `tsc` 下当场报错；`data-*` / `aria-*` 与常用属性、事件一并补全；
  未知标签保持宽松。`test/types.test.mjs` 用真 `tsc` 钉住（防索引签名被加回来）
- ✅ **契约「声明化」**：`plaindev schema` 的 props 以组件**声明的类型**为准（带 `type` 与 `optional`），
  解析不了就标 `declared-unresolved` 并退回推断 —— 不假装；「少传 / 多传 prop」交给 `tsc`，不重复造检查器
- ✅ **HMR 覆盖所有模块**：此前只有「挂载模块 + 导出 `App` / `default`」能热替换，改独立组件文件或
  `import()` 懒加载模块会**静默留旧代码**；现在走「重跑挂载点根组件」（不整页刷新），
  认不出根组件时明确告警并整页刷新
- ✅ 结构化编译错误（`PLAIN_E100x` + 文件/行列/hint，可 JSON 序列化）
- ✅ `server()` 自包含校验（`PLAIN_E1006`）：引用了外部变量在**编译期**报错，不再等运行时 `ReferenceError`
- ✅ `server()` 参数与返回值可序列化校验（`PLAIN_E1007`）：函数 / 类实例 / Stream 在编译期报错
- ✅ 编译产物 line 级 sourcemap，经 vite 链式回传给 devtools
- ✅ 契约检查**默认接在构建链路**（`lint: "warn" | false` 可调）：AI 典型错误构建即失败
- ✅ `AGENTS.md` + 反模式目录（20 条均有静态检查；看不出类型的不猜）
- ✅ AI 可发现性：`plaindev agent-context [--write]` 把规则落盘成跨工具标准 `AGENTS.md`
  （外加 `.github/copilot-instructions.md` 与 `.cursor/rules/*.mdc` 兜底，已有文件不覆盖）；
  `plaindev mcp` 把 `check` / `schema` 暴露给 AI IDE；`plaindev lsp` 把**同一条规则链**做成
  **编辑器实时诊断**（写时就报，不必等 dev / build）；确认误报可用行级抑制指令
- ✅ AI 正确率评测骨架 `eval/`（任务 + 验收断言 + 指标口径）
- ✅ 单测 264 项（内核 19 + 单元 245）+ 真实 Chromium 端到端 23 项
- ✅ 覆盖率度量与门槛（c8：行 90% / 分支 82% / 函数 85%），CI 强制不倒退

### 尚未实现（不假装有）

分阶段计划与验收标准见 [`ROADMAP.md`](ROADMAP.md)。当前状态：

| 缺口 | 影响 | 优先级 |
| --- | --- | --- |
| **组件级（细粒度）热替换** | 现在最细的粒度是「挂载点」：改动被别处使用的模块时会把挂载点的根组件全部重跑（会丢焦点 / 滚动），而不是只换那一棵子树 | P2 |
| **SSR 流式输出** | 每个页面请求仍要等数据到齐才吐首字节（按路由缓存已落地，见上文） | P2 |
| **RPC 请求合并 / 防抖** | 高频调用会各发一次请求 | P1 |
| **多入口 / 代码分割** | 只验证了单入口 | P1 |
| **并发渲染 / 时间切片** | 没有 | P2 |

> HMR 与 SSR 注水（hydration）均已落地（见上文两节与 [`ROADMAP.md`](ROADMAP.md) M4/M5）。

### 明确的设计取舍（不是缺陷）

- **组件必须是 `return (<jsx />)`** —— 限制了写法，换来「产物完全可预测」与「编译期可报错」。
  AI 只需记住这一条。
- **`server()` 的闭包不会跟到服务端** —— 刻意让跨端依赖显式化。
- **没有 `.value` / `.get()`** —— `s()` 一种读法，少一个选择就少一类错误。

---

## 测试与质量

```bash
pnpm test              # 构建 + 内核 19 项 + 单元 245 项
pnpm run coverage      # 覆盖率（c8）；低于门槛直接失败
pnpm run test:browser  # 23 项：真实 Chromium 走完整个应用（需先构建示例）
```

分层：

- `test/run.mjs`（19 项）：响应式内核 / 列表 / 作用域回收 / 路由 / RPC / SSR / XSS 的集成验证。
- `test/*.test.mjs`（245 项，`node:test`）：
  `lint` 规则与自动修复（含 deep-path 就地把 / 参数解构 / effect 卫生的不误报）、
  `errors` 统一错误码目录（唯一性 / lint 产出码都在表里 / 新旧抑制名都命中）、
  `schema` 契约提取、`compiler` 报错兜底与 sourcemap、
  `cli` 子命令（含 `agent-context` / `mcp` 的 wire 层）、`vite` 插件的编译 / 剥离 / 契约检查拦截 /
  多入口清单冲突、
  `server`（静态托管 / 目录穿越 / RPC / 一行起服）、
  `testing`（`plain/testing` 自己的单测 + 真编译 TSX 的端到端）、
  `keyed` 列表复用语义、`PLAIN_E1005` / `PLAIN_E1006` / `PLAIN_E1007`（参数与返回值）的诊断与不误报、
  `ref` 命令式逃逸口（编译正反例 + 连接 / 清理 / 列表 / 条件 / SSR 跳过 / 注水）、
  `context` 跨层传值（默认值 / 嵌套遮蔽 / 兄弟隔离 / 响应性 / effect 路径 / 回收 / SSR 隔离 / 注水）、
  `lsp` 子命令（Content-Length 分帧 / 诊断往返 / 未知方法）、
  `types`（用真 `tsc` 钉住 JSX 类型收紧：拼错属性名 / 写错类型要报、合法写法不报）、
  `schema` 的 props 声明化（`type` 别名 / 内联字面量 / `extends` 与 `&` 合并 / 解析不了如实标记）、
  HMR（挂载点精确替换 / 非挂载模块重跑兜底 / 认不出根组件时明确告警 / 能力边界：
  区间外保住、区间内重建）、
  `ssr-data`（SSR 数据全链：服务端直调 / 等静默 / 并发隔离 / 载荷迁移与注水配对 /
  `ssrMiddleware` 的占位符与转义）、
  异步资源生命周期与 context getter（`PLAIN_E1113` / `PLAIN_E1114`）、
  `eval` 上下文档位、SSR 序列化、运行时边界分支。
- `test/browser.mjs`（23 项）：真实 Chromium 端到端，覆盖勾选 / 取消勾选、新增、筛选、删除、
  路由跳转、详情参数、`server()` 往返、404、ErrorBoundary 降级与重试，以及**控制台零报错**。

其中若干项是**回归测试**，专门盯着历史上被验证过的致命 bug：

- 「勾选待办后 UI 不更新」—— 行级响应式（`rowProxy`）的回归点
- 「切换分支 / 删除行后 effect 泄漏」—— owner 作用域回收的回归点
- 「JSX 属性里的 signal 漏调用」—— `autofix` 区间重叠会把源码改坏（`done()` → `done()()`）的回归点
- 「多个文件各自有 `server()`」—— 服务端清单增量更新产出重复 `const` 声明的回归点
- 「sourcemap 少算一行占位」—— helper import 行会让后续映射整体错位一行的回归点

### 官方测试工具包（`plain/testing`）

Plain 的产物是**纯 DOM**（无虚拟 DOM），所以测组件就是「挂进真实容器 → 点它 → 读它产出的 DOM」。
`plain/testing` 把这几件事收成一组零依赖 API，**不引 @testing-library**（它靠可访问性角色 +
语义查询，对直接产 DOM 的框架是过度设计）。

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { render, fireEvent, expectText } from "plain/testing";
import { Counter } from "./Counter.js";

test("点一次加一", () => {
  const ui = render(Counter);            // 挂进全新容器，返回查询/解挂 API
  expectText(ui, "add0");                // 失败信息带实际文本 + HTML
  fireEvent.click(ui.get("button"));     // 事件里的 signal 写入同步 flush
  expectText(ui, "add1");
  ui.unmount();                          // 回收 effect + 移除容器
});
```

`render()` 返回 `container` / `html()` / `text()` / `get()` / `query()` / `queryAll()` /
`getByText()` / `queryByText()` / `unmount()`；`fireEvent` 覆盖 `click` / `input(value)` /
`change(value)` / `submit` / `focus` / `blur` / `keyDown` / `keyUp` / `fire(type)`。
因为 `signal.set` 本就同步 flush，`fireEvent` 之后 DOM 已是最终态 —— **不需要 await**；
异步数据（`resource`）用 `await flush()` 等微任务。

测试环境要先有 DOM（推荐 `jsdom`）。`render()` 在缺 DOM 时抛**带安装指引**的错，不会丢个
`document is not defined` 让你猜。

### AI 正确率评测（`eval/`）

「Plain 比 React 更适合 AI」目前还是个**主张**。`eval/` 把它变成可比的数据，分两套：

```bash
pnpm run eval              # Plain 自己的质量指标（7 个任务）
pnpm run eval:compare      # Plain vs React 对称对比（3 个用例，共用提示词与断言）

node eval/run.mjs --prompt          # 打印任务提示词，交给代理
node eval/compare/run.mjs --prompt  # 打印对比用例的提示词
# 两者都支持 --reference：跑参考实现自检 harness（不算指标）
```

- `eval/tasks/`：代理会不会犯这些错、构建期拦不拦得住。与 `AGENTS.md` 反模式目录对齐。
- `eval/compare/`：**同一份提示词 + 同一份断言**，框架差异全部收在适配器里；
  服务端边界类任务不可比，已排除并说明理由。

指标口径是**首次通过率 / 平均迭代轮次 / 拦截率**（失败里有多少是被构建时拦下的），
而不是满意度或上手时间。协议与公平性要求见 [`eval/README.md`](eval/README.md) 与
[`eval/compare/README.md`](eval/compare/README.md)，结果记在 [`eval/RESULTS.md`](eval/RESULTS.md)。

覆盖率由 c8 度量、由 CI 强制（配置见 `.c8rc.json`）：

| 指标 | 门槛 | 当前实测 |
| --- | --- | --- |
| 语句 | 90% | 94.1% |
| 分支 | 82% | 86.3% |
| 函数 | 85% | 91.6% |
| 行 | 90% | 94.1% |

> 覆盖率最低的是 `src/cli/index.ts`（约 77%）：`dev` / `build` / `serve` 三个子命令要真起 vite，
> 目前只在示例端到端里被间接验证（`src/cli` 目录整体约 87%）。

```bash
$ pnpm test
通过 19 / 19          # 内核
# pass 245 / fail 0   # 单元

$ pnpm run test:browser
通过 23 / 23
```

---

## 示例

完整示例在 [`examples/todo/`](examples/todo/)：待办列表 + 详情路由 + 统计页（服务端数据）+ 错误边界，覆盖全部核心能力。

> ⚠️ `examples/todo` 没有自己的 `package.json`，它依赖**根目录框架先编译成 `dist/`**。
> 启动前必须先装依赖、编译框架，否则 `dist/cli/index.js` 等文件不存在。

```bash
# 1. 装依赖（只需 typescript + vite）
pnpm install

# 2. 编译框架源码到 dist/
pnpm run build

# 3. 启动示例（推荐：走 examples/todo/vite.config.js，端口 8100）
pnpm run dev:example
#    打开 http://localhost:8100/

# 3'. 也可以用官方 CLI（plaindev）；注意它不读 vite.config.js，端口是 vite 默认的 5173
node dist/cli/index.js dev examples/todo
#    打开 http://localhost:5173/
```

两条命令的区别：

| 命令 | 端口 | 是否读 `examples/todo/vite.config.js` | 说明 |
| --- | --- | --- | --- |
| `pnpm run dev:example` | 8100 | 是（含 `serverEntry` / `root` 配置） | 与示例配置完全一致，推荐 |
| `node dist/cli/index.js dev examples/todo` | 5173 | 否（`configFile: false`，用插件默认配置） | 适合体验 plaindev CLI 自身 |

> 改了源码后需重新 `pnpm run build` 再刷新（框架自身源码的构建；示例应用的组件改动
> 在 dev 下走 HMR，无需整页刷新）。

---

## 目录结构

```
src/
  runtime/
    signal.ts    响应式内核：signal / computed / effect / batch / 作用域回收 / rowProxy
    dom.ts       建 DOM：insert / when / each（index 或 keyed 复用）/ Slot 锚点 / 最小重排
    async.ts     resource（竞态安全）/ rpc / server
    router.ts    路由（history / hash / :param / *）
    error.ts     ErrorBoundary
    index.ts     唯一对外入口
  compiler/
    index.ts     TSX -> 建 DOM 代码（TS 解析 + 源码切片 + 产物自检）
    manifest.ts  服务端清单生成（dev 增量 / build 全量）
    schema.ts    组件契约提取
  vite/index.ts  Vite 插件（类型剥离 -> 编译 -> 服务端剥离 -> RPC 中间件）
  server/
    index.ts     rpcMiddleware / staticMiddleware / serve
    render.ts    renderToString（SSR）
    dom-shim.ts  零依赖的服务端 DOM
  cli/index.ts   plaindev
  lint.ts        契约检查与自动修复
  index.ts       汇总导出（产出 dist/index.d.ts 作为包类型入口）
types/           历史手写 .d.ts 已删除，类型由 tsc 自动从源码产出到 dist/
test/
  run.mjs                  内核/集成验证（必跑）
  *.test.mjs               单元测试（node:test，由 pnpm test:unit 跑）
  browser.mjs              真实浏览器端到端（手动触发）
.c8rc.json                 覆盖率门槛配置
.github/workflows/ci.yml   构建 + 单测 + 覆盖率门禁
AGENTS.md                  给 AI 代理的工作说明 + 反模式目录
ROADMAP.md                 分阶段计划与验收标准
CHANGELOG.md               更新日志
CONTRIBUTING.md            贡献与提交约定（Conventional Commits）
eval/                      AI 正确率评测：任务 + 验收断言 + 指标
```

---

## 许可证

本项目采用 **MIT License**（见仓库根目录 `LICENSE` 文件）：

- **可自由商用**：可自由使用、复制、修改、合并、发布、分发、再授权与销售，包括在商业产品/服务中集成。
- **唯一要求**：保留版权声明与许可证全文。
- 版权与署名归作者 **benoly520** 所有。

如需企业支持或商业合作，可联系作者（GitHub: [@benoly520](https://github.com/benoly520)）——这是**可选的增值项**，不是使用的前置条件。
