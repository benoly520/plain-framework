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
- [SSR](#ssr)
- [工具链 plaindev](#工具链-plaindev)
- [面向 AI 的设计](#面向-ai-的设计)
- [边界与已知限制](#边界与已知限制)
- [测试与质量](#测试与质量)

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
   编译成 `each()` / `when()`，行级响应式自动生效，不用写 key、不用 memo。
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
    "paths": { "plain": ["node_modules/plain/types/plain.d.ts"] }
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
| `each(parent, list, itemFn)` | 列表渲染，行级响应式（编译器生成） |
| `createSlot(label?)` | 带锚点的插槽：组件要**事后整体替换自己的内容**时返回它 |
| `place(parent, node)` | 编译器挂载组件的统一入口（兼容 Node / Fragment / Slot） |
| `ErrorBoundary` | 子树报错就地降级 |

### 异步与跨端

| API | 说明 |
| --- | --- |
| `resource(fn)` | 返回 `{ data, loading, error, refetch }`；`fn` 里读的 signal 变化会自动重取，并丢弃过期响应 |
| `server(fn)` | 编译期物理剥离到服务端，客户端变 RPC 桩 |
| `rpc(name, args)` | 底层调用（一般不用手写） |
| `setRpcEndpoint(url)` | 改 RPC 端点（部署在子路径时用） |

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

// 2. 列表
<ul>{todos().map(t => <li className={t.done ? "done" : ""}>{t.text}</li>)}</ul>

// 3. 条件（可无限嵌套）
{loading() ? <p>加载中</p> : error() ? <p>{error().message}</p> : <div>{data().name}</div>}

// 4. 与运算
{user() && <span>{user().name}</span>}

// 5. 内联函数（编译成真正的函数，不是字符串）
<StatCard label="用户" value={() => stats().users} />

// 6. 事件
<button onClick={(e) => submit(e)}>提交</button>
```

### 不支持 —— 会**在编译期报错并给出行号**

| 写法 | 原因 | 改法 |
| --- | --- | --- |
| `.map()` 里 `return` 的不是 JSX | 无法编译成 DOM 指令 | 换成返回 JSX |
| `innerHTML` / `insertAdjacentHTML` | 安全红线 | 用 `{expr}` 插值 |
| `useState` / `useEffect` 等 React API | 不是 Plain 的 API | `signal` / `effect` |

编译器最后有一道**自检**：产物里若残留任何未处理的 JSX，或代码无法解析，直接抛错。
**不会**把坏代码悄悄交给打包器。

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

---

## SSR

Plain 编译产物是「直接建 DOM + effect 首次同步执行」，所以 SSR 不需要独立渲染器 ——
**换一个 `document` 实现即可**（`src/server/dom-shim.mjs`，零依赖）。

```js
import { renderToString, renderToStringSync } from "plain/server";

const html = renderToStringSync(App);                    // 同步部分
const html2 = await renderToString(App, { wait: 20 });   // 等异步 resource
```

> **只提供 SSR 输出，不含注水**。见下方限制表。

---

## 工具链 plaindev

```bash
plaindev check [dir] [--no-fix]     # 契约检查 + 自动修复高频错误
plaindev schema [dir] [--out f]     # 输出机器可读的组件契约 JSON
plaindev dev [root] [--port n]      # 开发服务器（含 RPC）
plaindev build [root] [--out-dir d] # 生产构建
plaindev serve [dist] [--port n]    # 生产托管 + RPC
```

### `check`：把 AI 的典型错误直接改掉

```bash
$ plaindev check src
src/Counter.tsx
  x src/Counter.tsx:8:3   [plain/signal-assign]    不能直接给 signal 变量 "count" 赋值，要用 "count.set(...)"
  x src/Counter.tsx:14:10 [plain/signal-not-called] signal 要调用取值："{count()}"
  -> 已自动修复并写回 src/Counter.tsx
```

能自动修的（AST 定位 + 源码切片，不做正则替换）：

| 规则 | 代码 | 自动改成 |
| --- | --- | --- |
| `plain/signal-assign` | `count = v` | `count.set(v)` |
| `plain/signal-not-called` | `{count}` / `checked={done}` | `{count()}` / `checked={done()}` |
| `plain/react-habit` | `useState(...)` | 只报错（语义不同，不能瞎改） |
| `plain/no-inner-html` | `el.innerHTML = ...` | 只报错（安全红线） |

### `schema`：给 AI / CI / IDE 的机器可读契约

```json
{
  "file": "main.tsx",
  "components": [
    { "name": "TodoView", "props": [{ "name": "todo", "optional": false }], "renders": ["div", "p", "button"] }
  ],
  "serverFunctions": [{ "name": "fetchStats", "params": [], "async": true }],
  "routes": [{ "path": "/todo/:id", "component": "Detail" }]
}
```

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
- ✅ CLI：check / schema / dev / build / serve
- ✅ TypeScript 类型（含 JSX 类型，`tsc --noEmit` 通过）
- ✅ 单测 19 项 + 真实 Chromium 端到端 23 项

### 尚未实现（不假装有）

| 缺口 | 影响 | 现状建议 |
| --- | --- | --- |
| **注水（hydration）** | SSR 只有首屏 HTML，客户端会重新渲染一次 | 需要 SSR 交互的项目先只用 CSR |
| **HMR / 热更新** | dev 下改文件会整页刷新 | 不影响正确性，只影响手感 |
| **Source map** | 断点落在编译产物上（产物本身可读） | 可接受 |
| **列表 keyed diff** | 当前按 index 复用行；大列表 `unshift` 会有多余更新 | 尾部增删无影响 |
| **多入口 / 代码分割** | 只验证了单入口 | 路由懒加载用动态 `import()` |
| **并发渲染 / 时间切片** | 没有 | 典型业务不需要 |
| **RPC 请求防抖 / 批量** | 高频调用会各发一次请求 | 用 `computed` 收敛后再调 |

### 明确的设计取舍（不是缺陷）

- **组件必须是 `return (<jsx />)`** —— 限制了写法，换来「产物完全可预测」与「编译期可报错」。
  AI 只需记住这一条。
- **`server()` 的闭包不会跟到服务端** —— 刻意让跨端依赖显式化。
- **没有 `.value` / `.get()`** —— `s()` 一种读法，少一个选择就少一类错误。

---

## 测试与质量

```bash
node test/run.mjs       # 19 项：内核 / 列表 / 作用域回收 / 路由 / RPC / SSR / XSS
node test/browser.mjs   # 23 项：真实 Chromium 走完整个应用（需先 build）
```

其中两项是**回归测试**，专门盯着历史上被验证过的致命 bug：

- 「勾选待办后 UI 不更新」—— 行级响应式（`rowProxy`）的回归点
- 「切换分支 / 删除行后 effect 泄漏」—— owner 作用域回收的回归点

浏览器端到端覆盖：勾选 / 取消勾选、新增、筛选、删除、路由跳转、详情参数、
`server()` 往返、带参 `server()` 调用、404、ErrorBoundary 降级与重试，
以及**控制台零报错**。

```bash
$ node test/run.mjs
通过 19 / 19

$ node test/browser.mjs
通过 23 / 23
```

---

## 示例

完整示例在 [`examples/todo/`](examples/todo/)：待办列表 + 详情路由 + 统计页（服务端数据）
+ 错误边界，覆盖全部核心能力。截图在 [`examples/todo/shots/`](examples/todo/shots/)。

```bash
node src/cli/index.mjs dev examples/todo     # 打开 http://localhost:5173
```

---

## 目录结构

```
src/
  runtime/
    signal.js    响应式内核：signal / computed / effect / batch / 作用域回收 / rowProxy
    dom.js       建 DOM：insert / when / each / Slot 锚点 / 最小重排
    async.js     resource（竞态安全）/ rpc / server
    router.js    路由（history / hash / :param / *）
    error.js     ErrorBoundary
    index.js     唯一对外入口
  compiler/
    index.mjs    TSX -> 建 DOM 代码（TS 解析 + 源码切片 + 产物自检）
    manifest.mjs 服务端清单生成（dev 增量 / build 全量）
    schema.mjs   组件契约提取
  vite/index.mjs Vite 插件（类型剥离 -> 编译 -> 服务端剥离 -> RPC 中间件）
  server/
    index.mjs    rpcMiddleware / staticMiddleware / serve
    render.mjs   renderToString（SSR）
    dom-shim.mjs 零依赖的服务端 DOM
  cli/index.mjs  plaindev
  lint.mjs       契约检查与自动修复
types/plain.d.ts 全部类型 + JSX 类型
```
