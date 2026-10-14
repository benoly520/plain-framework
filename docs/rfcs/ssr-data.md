# RFC：SSR 数据预取（服务端直调 + 确定性等待 + 数据迁移）

> **状态**：已接受，实现中（运行时 + 服务端 + 编译期 key + 示例）
> **判据依据**：[`SPEC.md` §1.1 功能取舍判据（AI-first 四道闸）](../../SPEC.md)
> **相关**：`docs/rfcs/context-and-ssr-isolation.md`、`ROADMAP.md` M5、`docs/patterns.md`

---

## 1. 问题

SSR 的三块机制都已经在：`renderToString` / `renderToStringSync`（换掉 `document` 跑同一份编译产物）、
`hydrate`（认领服务端节点、身份不变）、`createContext`（请求级隔离）。
但**这条路今天走不通**，卡在三个具体的坑上：

| # | 坑 | 具体表现 |
| --- | --- | --- |
| 1 | **`server()` 在服务端走 HTTP** | 组件的 `resource(() => fetchStats())` 在服务端执行时，`fetchStats` 已经是 `rpc("fetchStats")` 桩 → `fetch("/_plain/rpc")` = **自己请求自己**。构建期预渲染没有服务在监听（直接失败）；生产环境还得猜自己的 host / port / 子路径 / TLS（**又一个「无法验证的决策」**） |
| 2 | **等待靠固定毫秒** | `renderToString(App, { wait: 50 })` —— 50 是猜的：后端慢一点 SSR 就出骨架屏，而且**没人能静态发现**（数量级写错、偶发抖动都看不出来） |
| 3 | **首屏数据不迁移** | 服务端渲染出了数据，客户端 hydration 时 `resource` 又从 `loading` 开始 → 首帧与 HTML 不一致 → **注水告警 + 可见闪烁 + 多一次 RPC** |

结果：`examples/` 只有 CSR；SSR 停在"组件级零件"，**没有一条照着就能投产的路**。

## 2. 判据对照

| 闸 | 本设计如何过关 |
| --- | --- |
| **P1 可静态验证** | 调用点 key 由**编译器**注入（必然存在、不会漏）；没注入 `handlers` 却在 SSR 里调 `server()` → **明确报错**，不静默走网络；资源永不 settle 有上限 guard + 显式告警 |
| **P2 可本地推理** | 不新增用户要学的概念：`server()` + `resource()` 就是唯一写法，同一份源码两端同构。「服务端与客户端渲染同一棵树」是注水本来就有的前提，不是新增耦合 |
| **P3 重复优于抽象** | **不引入 `loader()` / `getServerSideProps`** —— 显式重复（每个 `resource` 自己声明依赖）胜过一层「数据从 loader 流到 props」的隐式管道 |
| **P4 平台优先** | 服务端直调 = 就是**调用那个函数**（同进程、同一份 `.plain/server.mjs`），不发明通信机制 |

## 3. 三个决策

### 3.1 决策一：`server()` 在 SSR 期间**直调**，不走 HTTP

`renderToString(App, { handlers })` 把服务端清单的 handler 表注入运行时；SSR 期间的
`rpc(name, args)` 不再 `fetch`，而是直接 `await handlers[name](...args)`。

- **用户代码零改动**（写一次、两端同构）；
- 少一次网络往返，也**不依赖任何 host / port 猜测**；
- 没注入 `handlers` 却在 SSR 里调了 `server()` → **抛带指引的错**（不是静默去 fetch）。

> 这一条同时让「`server()` 是显式执行边界」这个模型更完整：同一个函数有两条执行路径
> ——**服务端直调**（SSR）与**客户端 RPC**（浏览器），而两者对调用方完全透明。

### 3.2 决策二：等待从「固定毫秒」改成「等静默」

渲染完成后，循环等待「当前所有 `resource` 的 pending promise」；settle 后的 effect 可能
**又创建新的 `resource`**，所以循环到不动为止。

- `wait` 保留为**额外上限 guard**（兼容既有调用），但不再是主要手段；
- 达到上限仍有未 settle 的资源 → **显式 `console.warn`**（"绝不静默"），而不是安静地少渲染数据。

### 3.3 决策三：首屏数据**随 HTML 迁移**（SWR 语义）

1. **编译器**给每个 `resource(...)` 调用注入**调用点 key**（`文件:行#序号`）—— 编译期必然存在，
   不需要 AI 手写，也不会漏；
2. **服务端**按**创建序**收集 `{ key, value }`，序列化进页面（`<script type="application/json" id="plain-data">`）；
3. **客户端** hydration 时按「同一个 key 自己的队列」按创建序**配对种入**：
   `data = 种子值`、`loading = false` → 首帧与 HTML 一致；
4. 种入后仍按 **stale-while-revalidate** 在后台校验一次。

**为什么 key 用调用点、而不是运行期序号**：运行期全局序号是**隐藏耦合** —— 服务端与客户端
只要有一处条件渲染不同就整体错位，而且错位之后是**静默串数据**（A 的数据渲染进 B）。
调用点 key 把配对范围缩到「同一处调用」，最坏情况只影响同 key 的多实例；而「两端渲染同一棵树」
本来就是 hydration 的前提。

**为什么种入后还要后台校验一次（SWR）**：不重新执行 `promiseFn()` 就不能收集它读取的 signal 依赖
→ 依赖变化时**永不重取** = 静默的陈旧数据（本框架最恨的失败模式）。
代价是首屏多一次后台请求，换来「注水后行为与纯 CSR 完全一致」。

### 3.4 决策四（**必须最先做**）：并发渲染不能靠「换全局」

现状：`installServerDOM()` 把 `globalThis.document` / `globalThis.Node` 换成垫片，`__restore()`
再换回来 —— 隐含假设「渲染是同步的、恢复是 LIFO 弹栈」。

一旦渲染过程里有 `await`（本 RFC 的等静默、既有的 `wait: N`、以及下面的数据迁移），这个假设就破了：

1. 请求 A 在 `await` 时，请求 B 开始渲染 → **B 保存的「上一个 document」是 A 的垫片**；
2. A 先结束 → `__restore()` 把全局恢复成 **A 的垫片**（因为 B 已经把 prev 换掉了）；
3. B 后续的 `document.*` 全写进 A 那个**已经废弃的垫片**；
4. B 再 `__restore()` → 全局永久停在废弃垫片上。**同进程后续的渲染 / 注水全部串味。**

所以并发隔离要做在**渲染之前**，而且不能靠全局换入换出：
用 `node:async_hooks` 的 `AsyncLocalStorage` 保存「本次渲染的垫片」，
`globalThis.document` 改成**取值时查当前异步上下文**的访问器 ——
每个请求各自看到自己的垫片，`await` 前后一致，也不存在换入换出的窗口。

> 这一条必须排在数据迁移**之前**：载荷收集是「本次渲染的」状态，
> 渲染本身都串的话，载荷只会把串味放大（A 的数据种进 B 的页面）。

## 4. 主动「不做」清单

| 不做 | 理由（对应闸） |
| --- | --- |
| `loader()` / `getServerSideProps` 概念 | 引入新概念 + 一层数据管道；`resource` + `server` 已能表达同一件事，真正的差别只在「键」，而键由编译器免费给出 —— P3 / P4 不过 |
| 把固定 `wait: N` 当成主要手段 | 毫秒数是猜的：后端一慢就 SSR 出骨架屏，且**静态发现不了** —— P1 不过 |
| 种入后**跳过** `promiseFn()` | 会丢掉 signal 依赖收集 → 依赖变化永不重取 = 静默陈旧数据。宁可多一次后台请求 |
| 用运行期全局序号做配对键 | 隐藏耦合：条件渲染一有差异就静默串数据 —— P2 不过 |
| 「数据缓存 / 失效（staleTime / cache 配置）」体系 | 先把首屏这条主路走通；缓存策略等有真实数据再定，别提前造概念 |
| 流式 SSR / Suspense 式边界 | 与 SPEC 一致：隐藏边界对 AI 是负资产，先要「三态写全」 |

## 5. 实现落点

| 落点 | 改动 |
| --- | --- |
| `src/runtime/async.ts` | `rpc()` 在 SSR 上下文下直调 handlers；`resource()` 登记 pending、消费种子 |
| `src/runtime/ssr-context.ts`（新） | `beginSSR({ handlers, collect })` / `endSSR()` / `pendingCount()` / `settle()` |
| `src/server/render.ts` | `renderToString(App, { handlers })`；等待改为静默循环 + 上限 guard |
| `src/server/index.ts` | 新增 `ssrMiddleware({ template, entry, handlers })`（Node 标准中间件，与 `rpcMiddleware` 同形状） |
| `src/runtime/hydrate.ts` | 认领前从页面读取数据载荷并种入 |
| `src/compiler/index.ts` | 给 `resource(...)` 调用注入调用点 key（内部参数，不进公开 API 面） |

## 6. 验收标准

- [ ] 同进程下并发两个 SSR 请求（各自带不同的 server 数据 + 各自的 `await`），
      两个响应互不包含对方的数据，且渲染结束后 `globalThis.document` 不残留废弃垫片（3.4）
- [ ] SSR 首屏 HTML 里就是**真实数据**（不是骨架屏），且**不依赖固定毫秒**
- [ ] 注水首帧与 HTML 一致（**没有注水告警**），且注水后行为与纯 CSR 一致（依赖变化会重取）
- [ ] 没注入 `handlers` 却在 SSR 里调 `server()` → 明确报错（不静默走网络）
- [ ] 资源永不 settle → 上限 guard + 显式告警
- [ ] `examples/` 有一个能跑的 SSR 示例：首屏有数据 + 注水可交互

## 7. 已拍板的三项

1. **不引入 loader**：`server()` + `resource()` 是唯一写法（3.1 / 3.3）。
2. **种入后 SWR 后台校验**：宁可多一次请求，也不丢依赖收集（4）。
3. **配对键 = 编译器注入的调用点 key**，不是运行期序号（3.3）。

## 8. 分期

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| 零 | **并发隔离**（3.4）：`AsyncLocalStorage` 取代「换全局 + LIFO 恢复」+ 并发测试 | ✅ 已落地（`runSSR` / 取值查上下文的访问器 / pending 按渲染隔离；3 项并发测试） |
| 一 | 服务端直调（3.1）+ 确定性等待（3.2） | ✅ 已落地（等静默 / 直调 / handlers 缺失明确报错 / reject 不炸 SSR） |
| 二 | 数据迁移（3.3）：编译器 key + 载荷序列化 + 注水种入 | 待做 |
| 三 | `ssrMiddleware` + SSR 示例 + `docs/patterns.md` 配方 + 文档同步 | 待做 |
