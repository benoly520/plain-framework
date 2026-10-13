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
- [路线图 ROADMAP.md](ROADMAP.md) ｜ [给 AI 代理的说明 AGENTS.md](AGENTS.md) ｜ [AI 正确率评测 eval/](eval/README.md)

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
```

### 不支持 —— 会**在编译期报错并给出行号**

| 写法 | 原因 | 改法 |
| --- | --- | --- |
| `.map()` 里 `return` 的不是 JSX | 无法编译成 DOM 指令 | 换成返回 JSX |
| `innerHTML` / `insertAdjacentHTML` | 安全红线 | 用 `{expr}` 插值 |
| `useState` / `useEffect` 等 React API | 不是 Plain 的 API | `signal` / `effect` |

编译器最后有一道**自检**：产物里若残留任何未处理的 JSX，或代码无法解析，直接抛错。
**不会**把坏代码悄悄交给打包器。

**一个刻意的取舍**：列表里同时写 `key=` 和 index 参数会**直接编译报错**（`PLAIN_E1005`），
而不是悄悄丢掉其中一个。原因：keyed 复用下行只构建一次，回调捕获的 index 无法随位置更新，
两者同时生效必然有一个语义是错的 —— 而**静默的语义降级**恰恰是本框架最想消灭的失败模式。

### 编译错误码

编译期错误都带机器可读信息，便于 IDE / CI / AI 直接消费：
`error.code` / `error.file` / `error.line` / `error.column` / `error.hint`，`JSON.stringify(error)` 即可拿到。

| 错误码 | 含义 |
| --- | --- |
| `PLAIN_E1001` | 有 JSX 落在编译器不认识的写法里（附正确写法提示） |
| `PLAIN_E1002` | 产物无法解析（通常是输入没先剥离 TS 类型） |
| `PLAIN_E1003` | 产物里残留 JSX（编译器 bug） |
| `PLAIN_E1004` | 遇到不支持的语法节点（编译器 bug） |
| `PLAIN_E1005` | 列表的 `key` 与 index 参数同时使用（二者选一） |
| `PLAIN_E1006` | `server()` 的函数体引用了外部变量（闭包不会跟到服务端） |
| `PLAIN_E2001` | 契约检查未通过（由构建链路抛出，`plaindev check --fix` 可自动修） |

**契约检查默认接在构建链路里**（`plainPlugin({ lint: "warn" | false })` 可调），
所以下面那些 AI 常见错误会让**构建失败**，而不是拖到运行时才炸：

| 契约规则 | 拦截的写法 | 能否自动修 |
| --- | --- | --- |
| `plain/signal-assign` | `count = 1` | ✅ 改成 `count.set(1)` |
| `plain/signal-not-called` | `{count}` / `checked={done}` | ✅ 补上调用 |
| `plain/react-habit` | `useState` / `useEffect` / … | ❌ 语义不同，只报错 |
| `plain/no-inner-html` | `el.innerHTML = …` | ❌ 安全红线，只报错 |
| `plain/no-props-destructure` | `const { title } = props` | ❌ 两种改法语义不同，只报错 |

给 AI 代理看的完整反模式目录（含**尚未**被静态检查覆盖的坑）在 [`AGENTS.md`](AGENTS.md)。

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

---

## SSR

Plain 编译产物是「直接建 DOM + effect 首次同步执行」，所以 SSR 不需要独立渲染器 ——
**换一个 `document` 实现即可**（`src/server/dom-shim.ts`，零依赖）。

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
- ✅ 列表 keyed 复用（`key={...}`）：头部插入 / 重排不重建已有节点
- ✅ 结构化编译错误（`PLAIN_E100x` + 文件/行列/hint，可 JSON 序列化）
- ✅ `server()` 自包含校验（`PLAIN_E1006`）：引用了外部变量在**编译期**报错，不再等运行时 `ReferenceError`
- ✅ 编译产物 line 级 sourcemap，经 vite 链式回传给 devtools
- ✅ 契约检查**默认接在构建链路**（`lint: "warn" | false` 可调）：AI 典型错误构建即失败
- ✅ `AGENTS.md` + 反模式目录（明确标注哪些已被静态检查、哪些还没有）
- ✅ AI 正确率评测骨架 `eval/`（任务 + 验收断言 + 指标口径）
- ✅ 单测 126 项（内核 19 + 单元 107）+ 真实 Chromium 端到端 23 项
- ✅ 覆盖率度量与门槛（c8：行 90% / 分支 82% / 函数 85%），CI 强制不倒退

### 尚未实现（不假装有）

分阶段计划与验收标准见 [`ROADMAP.md`](ROADMAP.md)。当前状态：

| 缺口 | 影响 | 优先级 |
| --- | --- | --- |
| **HMR / 热更新** | dev 下改文件整页刷新；Plain 的核心场景是「AI 写 → 人看」，这条最伤反馈环 | P0 |
| **注水（hydration）** | SSR 只有首屏 HTML，客户端会重新渲染一次 | P0 |
| **AI 原生工具（MCP）** | `schema` / `check` 还不能被 AI IDE 直接调用 | P1 |
| **RPC 请求合并 / 防抖** | 高频调用会各发一次请求 | P1 |
| **多入口 / 代码分割** | 只验证了单入口 | P1 |
| **并发渲染 / 时间切片** | 没有 | P2 |

> 需要 SSR 交互的项目请先只用 CSR —— 这是当前唯一会影响正确性的缺口（hydration）。

### 明确的设计取舍（不是缺陷）

- **组件必须是 `return (<jsx />)`** —— 限制了写法，换来「产物完全可预测」与「编译期可报错」。
  AI 只需记住这一条。
- **`server()` 的闭包不会跟到服务端** —— 刻意让跨端依赖显式化。
- **没有 `.value` / `.get()`** —— `s()` 一种读法，少一个选择就少一类错误。

---

## 测试与质量

```bash
pnpm test              # 构建 + 内核 19 项 + 单元 107 项
pnpm run coverage      # 覆盖率（c8）；低于门槛直接失败
pnpm run test:browser  # 23 项：真实 Chromium 走完整个应用（需先构建示例）
```

分层：

- `test/run.mjs`（19 项）：响应式内核 / 列表 / 作用域回收 / 路由 / RPC / SSR / XSS 的集成验证。
- `test/*.test.mjs`（107 项，`node:test`）：
  `lint` 规则与自动修复、`schema` 契约提取、`compiler` 报错兜底与 sourcemap、
  `cli` 子命令、`vite` 插件的编译 / 剥离 / 契约检查拦截、
  `server`（静态托管 / 目录穿越 / RPC / 一行起服）、
  `keyed` 列表复用语义、`PLAIN_E1005` / `PLAIN_E1006` 的诊断与不误报、SSR 序列化、运行时边界分支。
- `test/browser.mjs`（23 项）：真实 Chromium 端到端，覆盖勾选 / 取消勾选、新增、筛选、删除、
  路由跳转、详情参数、`server()` 往返、404、ErrorBoundary 降级与重试，以及**控制台零报错**。

其中若干项是**回归测试**，专门盯着历史上被验证过的致命 bug：

- 「勾选待办后 UI 不更新」—— 行级响应式（`rowProxy`）的回归点
- 「切换分支 / 删除行后 effect 泄漏」—— owner 作用域回收的回归点
- 「JSX 属性里的 signal 漏调用」—— `autofix` 区间重叠会把源码改坏（`done()` → `done()()`）的回归点
- 「多个文件各自有 `server()`」—— 服务端清单增量更新产出重复 `const` 声明的回归点
- 「sourcemap 少算一行占位」—— helper import 行会让后续映射整体错位一行的回归点

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
| 语句 | 90% | 94.3% |
| 分支 | 82% | 85.6% |
| 函数 | 85% | 91.2% |
| 行 | 90% | 94.3% |

> 唯一明显偏低的是 `src/cli`（约 69%）：`dev` / `build` / `serve` 三个子命令要真起 vite，
> 目前只在示例端到端里被间接验证。

```bash
$ pnpm test
通过 19 / 19          # 内核
# pass 107 / fail 0   # 单元

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

> 改了源码后需重新 `pnpm run build` 再刷新（目前无 HMR，dev 下整页刷新，见「已知限制」）。

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

本项目采用 **Plain Framework 非商业许可证**（见仓库根目录 `LICENSE` 文件）：

- **默认禁止商用**：本框架仅可用于学习、研究、个人项目、教学等非商业目的。
- **商用需授权**：任何商业用途（在商业产品/服务中集成、付费咨询/培训、以营利为目的的使用等）**必须事先获得作者书面授权**。
- 任何使用、复制、修改或分发均须保留版权声明与许可证全文，并注明作者为 **benoly520**。

如需商业授权，请联系作者（GitHub: [@benoly520](https://github.com/benoly520)）。
