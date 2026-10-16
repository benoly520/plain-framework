# 更新日志

本项目遵循[语义化版本](https://semver.org/lang/zh-CN/)；提交信息遵循
[Conventional Commits](https://www.conventionalcommits.org/zh-hans/)。

## [Unreleased]

### 变更（破坏性）

- **`plaindev schema` 的 props 从「推断」变「声明」**：`props` 的事实来源改为**组件自己声明的类型**
  （`props: CardProps`）—— `optional` 来自 `?`、`type` 来自注解，跨文件调用也会漏的旧问题消失。
  新增 `propsSource`（`declared` / `declared-unresolved` / `inferred`）如实标注来源：
  解析不了（跨文件、`Pick<…>` 等工具类型）时附 `declaredType` 并退回推断，**不假装解析成功**；
  声明与推断不一致时附 `inferredProps` 做对照。旧字段 `props` 的**形状不变**（仍是
  `{name, optional}` 数组，声明可得时多一个 `type`），无注解的组件行为不变。
  新增测试 `test/schema.test.mjs` 六项（`type` 别名 / 内联字面量 / `extends` 与 `&` 合并 /
  解析不了如实标记 / 空 interface / 无注解仍是 inferred）。
  > 明确**不做**的两件事（避免重复实现 `tsc` 已有的能力）：项目级「调用点校验」与
  > 「强制声明 props 类型」—— JSX 类型已收紧 + `strict` 下隐式 `any` 本就报错，`tsc` 已覆盖。
- **JSX 类型收紧：去掉 `CommonAttributes` 的 `[attr: string]: any`**。此前内建元素上「任何属性名、
  任何类型」都放行 —— `<img scr="a.png" />`（拼错）、`<input checked="yes" />`（该传布尔）、
  `<div onClikc={…} />`（事件名拼错）在 `tsc` 下静默通过、运行时静默失效。现在都会报错。
  为不误伤合法写法，同时补上：HTML 全局属性、`data-*` / `aria-*`（模板字面量索引签名）、
  常用跨元素属性与事件（**枚举**，而不是 `on*` 兜底 —— 否则 `onClikc` 又拦不住了）。
  - **边界（写明）**：这是一套**共用**属性、不按元素区分 —— 拦「拼写错 / 类型错」，不拦
    「属性放错元素」（`<div colSpan={2} />` 不报）；未知标签 / 自定义元素走兜底，保持宽松。
  - **可能影响存量代码**：拼错的属性名、或没被枚举到的冷门属性会开始报错 ——
    冷门属性提 issue 往枚举表里补一个名字即可（**不是**把索引签名加回来）。
  - 测试：`test/types.test.mjs` 用真 `tsc` 检查（防的就是有人把 `[attr: string]: any` 加回来）。

### 新增

- **官方脚手架 `create-plain`**：`packages/create-plain` 提供 `create-plain <项目名>` 命令，
  复制内置 `minimal` 模板并替换 `__PROJECT_NAME__` 占位符。**不联网、不自动安装依赖、不自动 git init**，
  安装与版本管理交给用户。根目录新增 `npm run create-plain` 便捷脚本。
- **数据表格示例 `examples/data-table`**：5 万行数据的**窗口化（虚拟列表）+ 列排序 + 搜索**，
  演示大规模数据下 signals 的细粒度更新与恒定 DOM 节点数（视口内恒为 ~20 行，
  上下用占位 `div` 撑出真实滚动高度）。构建产物仅约 11.6 kB（gzip 4.5 kB）。
  根目录新增 `npm run dev:example:data-table` / `build:example:data-table`，并纳入 `typecheck:example`。
- **RPC 请求合并（可选，非破坏性）**：`setRpcBatching(true)` 开启后，同一微任务内的多次
  `rpc()` 合并成一次 `POST /_plain/rpc/batch`（单次调用仍走普通端点），把一次渲染里
  并发拉的多个 `resource` 的多轮往返压成一轮。服务端 `rpcMiddleware` 已内置批量端点、
  单条端点保持兼容；老服务端不支持批量协议时客户端**自动退化**成逐条请求，调用不会失败。
  默认关闭，应用行为零变化。验收：`test/server.test.mjs`（批量端点 / 单批并存 / 退化路径）。
- **dev 下的 SSR：给源码入口就行，不必先构建**（vite 插件新增 `ssr` 选项）：
  ```js
  plain({ ssr: { entry: "./entry-server.tsx" } })
  ```
  页面导航（GET、看起来像页面）交给服务端渲染：模块走 vite 的 `ssrLoadModule`（同一条 transform
  管线，改代码立刻生效），`server()` 直调用的是**内存里那份 dev 注册表**（所以 dev 也不需要
  `.plain/server.mjs`），模板是源 `index.html` 并先过 `transformIndexHtml`（注入 `@vite/client`、
  改写脚本引用）。中间件**必须装在 vite 内部中间件之前**，否则 `/` 会被 vite 自己的 index.html 先 serve 掉。
  与生产（`serve({ ssr })`）共用 `renderPage` —— 「两个占位符 + 载荷转义」这套规则只有一份。
  出错（编译 / 契约检查 / 渲染）**透出 500 + 原因**，不吞成白屏。
  - 顺手修掉示例里一个真 bug：模板里用**相对路径**引脚本（`./entry-client.tsx`）时，
    SSR 的嵌套地址（`/todo/2`）会被 vite 解析成 `/todo/entry-client.tsx` —— 首屏 HTML 对、
    但客户端脚本 404。模板里的资源引用一律用绝对路径（`/entry-client.tsx`），
    构建时照样会被换成带 hash 的产物。示例与文档都已写明。
  - 测试 `test/vite-plugin.test.mjs` 新增 4 项（导航走 SSR + 模板过 vite + 载荷注入 /
    vite 自身请求与静态资源放行 / 出错透出 500 / 模板缺占位符同样报错）。
- **SSR 按路由缓存（可选，生产路径）**：`ssrMiddleware` / `serve({ ssr })` 新增 `cache` 选项
  `{ ttl?, max? }` —— 按**完整 URL（含 query）** + TTL 缓存渲染后的整页 HTML，命中直接回 HTML、
  省掉整页重渲染。`ttl` 默认 0（永不过期，靠 `max` 上限淘汰），`max` 默认 1000。
  - 只在**渲染成功**（已产出 HTML）后写缓存；500 等错误**不会**进缓存、也不会污染其它命中。
  - 并发同 URL **去重**（一个 `inflight` Map）：同一时刻只渲染一次，其余请求复用结果（防惊群）。
  - **dev 下不要开** —— 代码一变缓存就是脏的（dev SSR 走的是 vite 插件那条路，本中间件是生产路径）。
  - 测试 `test/ssr-data.test.mjs` 新增 6 项（默认关闭 / 同 URL 命中不重渲染 / 不同 URL 独立 /
    并发只渲染一次 / TTL 过期重渲染 / 超 max 淘汰最旧 / 失败不进缓存）。
- **SSR 分块流式输出（可选，生产路径）**：`ssrMiddleware` / `serve({ ssr })` 新增 `stream: true` 选项。
  先把模板里「第一个占位符之前」的确定性壳（`<head>` / 容器等）**立刻 flush** 出去抢首字节（TTFB），
  剩下的（含等 `resource()` 数据到齐后填好的应用 HTML 与载荷）再分块写；并设 `x-accel-buffering: no`
  避免反代把整页缓冲掉、把流式吃掉。`stream` 与 `cache` 可同时开（命中即瞬时、未命中才流式）。
  - **边界（写明）**：这抢的是「首字节 / 早拉 CSS·JS」，不是「内容随数据逐段出现」——
    后者要客户端流式注水（suspense 式），是另一件更大的事，本框架暂未做。流式与非流式**最终字节完全一致**，
    客户端注水逻辑不受影响（这也是为什么流式安全）。`renderPage` 仍是生产/dev 共用的唯一拼装处。
  - 测试 `test/ssr-data.test.mjs` 新增 4 项（分块写出且字节=非流式 / 首块是壳不含应用 HTML 与载荷 /
    按 URL 渲染且载荷仍在 / 默认非流式走 end 不拆块）。
- **SSR 数据预取（阶段三：`ssrMiddleware` + SSR 示例）**：把前两个阶段接成一条能投产的链。
  - **`ssrMiddleware({ template, entry, manifest })`**（`plain/server`，Node 标准 `(req,res,next)`，与
    `rpcMiddleware` 同形状）：`renderToStringWithData(App, { handlers, url })` -> 把应用 HTML 写进模板的
    `<!--plain-ssr-->`、把首屏载荷写进 `<!--plain-data-->`。载荷以
    `<script type="application/json" id="plain-data">` 输出并**转义 `<`**（数据里出现 `</script>`
    不能逃出标签）。模板占位符**缺了或出现多次都报错**（后者：注入点不明确时静默挑第一处 =
    把 HTML 插到看不见的地方 —— 这是我自己写示例时踩到的坑）。只接手「看起来像页面导航」的 GET。
  - **`serve({ ssr: {...} })`**：一行起「SSR + 静态托管 + RPC」，顺序是
    RPC -> SSR -> 静态/SPA 兜底（SSR 必须在 SPA 兜底之前，否则页面导航全被吞成 index.html）。
  - **`renderToString` / `renderToStringSync` 新增 `url` 选项**，配合下面这条：
    **router 现在支持服务端按请求 URL 渲染**（服务端没有 `window`）。顺带修掉一个真缺陷：
    路由匹配原来是 `computed`（有缓存），而服务端路径来自每次渲染的上下文，
    **第二个请求会复用第一个请求的匹配结果** —— 改成每次直接算（匹配本身很便宜）。
  - **跨运行时副本共享 SSR 上下文**：`getSSRStore()` 的钩子挂在进程级共享槽上。
    SSR 构建若把框架运行时**打包进产物**（alias / `ssr.noExternal` / 依赖树里两份），
    进程里就有两个 runtime 副本 —— 模块局部的钩子跨不过去，应用那份会以为「不在 SSR」而
    退回 HTTP（或报「没注入 handlers」），极难查。浏览器里这个槽位永远是空的。
  - **示例 `examples/ssr/`**：同一份 `app.tsx` 服务端直出 HTML（首屏就有数据）+ 客户端注水接管；
    `pnpm run build:example:ssr` 构建（客户端 + SSR 两份产物），`pnpm run start:example:ssr` 起服务。
    实测 `/todo/2` 的 HTML 里直接带 `让注水不重复取数据`，载荷为
    `[{"key":"app.tsx:34#1","ok":true,"value":{...}}]`（key 可读、无绝对路径泄漏）。
  - 测试 `test/ssr-data.test.mjs` 新增 5 项：模板注入 + **按请求 URL 渲染对应路由** /
    载荷里的 `</script>` 被转义 / 模板缺占位符 -> 500 / 占位符重复 -> 500 / 静态资源与非 GET 放行。
- **SSR 数据预取（阶段二：首屏数据随 HTML 迁移）**：阶段一让首屏「有数据」，阶段二让注水
  「**不重复取、不闪一下**」。设计见 [`docs/rfcs/ssr-data.md`](docs/rfcs/ssr-data.md) §3.3。
  - **编译器注入调用点 key**：`resource(fn)` -> `resource(fn, undefined, "src/App.tsx:31#0")`。
    键由编译器给而不是手写 —— 必然存在、不会漏，而且服务端构建与客户端构建对同一份源码
    得到**同一个键**（`keyBase` 用项目相对路径：可读、不泄漏构建机绝对路径；
    `sourcemap.sources` 仍用真实模块路径，devtools 定位不受影响）。
  - **服务端按创建序收集**：`renderToStringWithData(app, opts)` -> `{ html, data }`
    （`renderToString` 变成它的便捷壳）。「没拿到值」也占位（`ok: false`）——
    少一条会让同 key 的后续实例**错位配对**，那是静默串数据，比多一次请求糟得多。
  - **注水时种入**：`hydrate` 从页面 `<script type="application/json" id="plain-data">` 读回来
    （也可显式传 `data`），按「同一个 key 自己的队列」按创建序配对种入 -> **首帧与 HTML 一致、
    0 注水告警、不闪 loading**；随后仍做一次 SWR 后台校验（跳过 `promiseFn()` 会丢 signal
    依赖收集 = 静默陈旧数据）。载荷坏了**明确告警**，不静默退化成「首屏各自重新取一次」。
  - 测试 `test/ssr-data.test.mjs` 新增 5 项：注入 key 可复现且两端一致 / 服务端按创建序收集 /
    **端到端（SSR + 载荷 -> 注水 0 告警、首帧就是服务端值、后台校验确实发生）** /
    **列表多实例按创建序配对（不串位）** / 载荷坏掉时告警。
  > 已知限制：别名导入（`import { resource as r }`）识别不到 -> 没有 key ->
  > 退化成「注水后后台照常取一次」（**结果正确**，只多一次请求）。
- **SSR 数据预取（阶段一：服务端直调 + 确定性等待）**：把 SSR 从「机制齐全」推向「照着就能投产」，
  设计与取舍见 [`docs/rfcs/ssr-data.md`](docs/rfcs/ssr-data.md)。本阶段落地两件事：
  - **服务端直调**：`renderToString(App, { handlers })` 注入服务端清单后，SSR 期间的 `server()`
    调用**直调同进程的 handler**，不再 `fetch("/_plain/rpc")` **请求自己**（那需要猜 host / port /
    子路径，构建期更是没有服务在监听）。用户代码零改动 —— 同一份源码两端同构。
    没注入 `handlers` 却在 SSR 里调了 `server()` → **抛带指引的错**，不静默退回 fetch。
    `renderToStringSync` 也进同一个上下文（同步版依然不等待异步资源）。
  - **确定性等待**：`renderToString` 从「等 `wait: 50` 毫秒」（猜出来的数 —— 后端一慢 SSR 就渲染
    骨架屏，而且静态发现不了）改成**等所有 `resource` 静默**：循环 settle 到没有 pending，
    settle 后新建的 resource 由下一轮接住（**串联两层也能等到**）；等满 20 轮仍有剩余 → 显式
    `console.warn`。`wait` 保留为额外上限，不再是主要手段。
  - 测试 `test/ssr-data.test.mjs`（5 项）：首屏就是真实数据 / 串联两层也等到 /
    SSR 期间**一次 fetch 都不发**（fetch 被打桩成会抛错）/ 缺 `handlers` 明确报错 /
    资源 reject 不炸 SSR（`allSettled`，错误落在 `error` 态）。
  - ⚠️ **本阶段同时暴露一个必须先修的并发缺陷**（RFC §3.4）：`installServerDOM()` 靠「换全局
    `document` + LIFO 恢复」，隐含假设「渲染是同步的」。一旦渲染里有 `await`（等静默 / `wait` /
    接下来的数据迁移），同进程并发渲染会互相覆盖 prev，最后 `globalThis.document` **永久停在一个
    废弃垫片**上。已在「修复」一节里修掉（阶段零）。
- **`plaindev lsp`：编辑器实时诊断（LSP over stdio）**：不写 tsserver 插件 —— 直接把契约检查的
  **同一条规则链**做成 `textDocument/publishDiagnostics`，于是**编辑器里报的**与**构建时拦的**
  是同一套 `PLAIN_Exxxx` 与同一份修法提示（可自动修的在 message 里带「可自动修」）。
  最小子集：`initialize` / `initialized` / `didOpen` / `didChange` / `didClose` / `shutdown` / `exit`；
  文本同步用 Full；分帧走 LSP 的 `Content-Length`（与 MCP 的换行分隔不同）；落定前做一次空写
  排空屏障，避免诊断被 `process.exit` 截断；只对 `.tsx/.jsx/.ts/.js` 出诊断。
  文档：README 工具链 / 已完成、`AGENTS.md` §5；测试 `test/lsp.test.mjs`。
  对应 ROADMAP M6 里长期挂着的「仍缺 LSP 实时诊断」。
- **Context（跨层传值）+ SSR 请求级隔离**：新增 `createContext` / `useContext` 两个导出与
  `Context<T>` 类型；`<Ctx.Provider value={…}>` 是普通组件标签（**无需改编译器**）。
  - `useContext(Ctx)` 返回**可调用 getter**（读法 `useContext(Ctx)()`，与 `signal` 一致）：
    结构上不可能「存进变量 → 快照住旧值」。`const x = useContext(Ctx)` 纳入 lint 的 signal 识别，
    `{x}` 会被 `PLAIN_E1102` 自动修；对返回值直接取属性由新规则 `no-context-getter-property`
    （`PLAIN_E1114`）拦下 —— 否则会静默取到 `Function.name` / `length` 这类函数成员
    （esbuild 不做类型检查，这类错构建期不会报）。
  - 机制复用 `ErrorBoundary` 的 owner 作用域链：Provider 开一个嵌套作用域，把 `ctx -> getter`
    挂在作用域上；作用域挂在父 owner 上 → 卸载 / 列表行回收 / 分支切换时子树 effect 一并回收。
  - **SSR 请求级隔离**：Provider 作用域**每次渲染现建现收**，下一个请求拿到的是全新作用域，
    不可能读到上一个请求的 Provide 值 —— 于是「请求级数据」终于有了正确的位置
    （此前只能放模块作用域 signal，会在同进程多请求之间串味）。
  - 文档：README「跨层传值（Context）」、`AGENTS.md` 反模式 20 与错误码表、`docs/patterns.md` §10、
    `SPEC.md` §2、提案 `docs/rfcs/context-and-ssr-isolation.md`；测试 `test/context.test.mjs`（9 项）。
  - **属对外 API 面扩面**（新增导出，非 breaking，但改变了「API 恒定」的约定）。
- **契约规则 `no-module-scope-resource`（`PLAIN_E1113`）**：在**模块作用域**创建 `resource()`。
  `resource()` 内部是 effect，放模块作用域会在**模块被 import 的那一刻立刻执行** —— 立刻发起请求
  （App 还没挂载；SSR 下更是在服务端「导入模块」时就发请求），而且没有 owner 可回收。
  正确位置是组件函数体，或 `createScope(() => …)` 里。判定口径是纯语法事实
  （`resource(...)` 到 `SourceFile` 之间没有任何函数祖先）—— **不存在误报**；看不出的不猜。
  同步：`AGENTS.md` 反模式 19 / §4 错误码、`README` 契约规则表、`docs/patterns.md` §6、`SPEC.md`；
  测试见 `test/lint.test.mjs`。
  > 原计划的「渲染 `data()` 却不处理 `loading` / `error`」规则经核实会造成误报（官方示例的
  > `resource` 也不处理 `error()`；现有测试把 `{data()}` 视为合法），按「宁可少，不可误」**不实现**。
- **命令式 DOM 逃逸口 `ref={(el) => …}`**（内建元素专用，**零新增对外 API**）：
  组件体默认拿不到自己创建的节点，`dialog.showModal()` / `canvas.getContext()` / 第三方库要节点
  这些真实需求此前无路可走（写 `ref={fn}` 会被当普通属性**静默丢弃**）。现在编译期把
  `ref={fn}` 编译成内部符号 `__ref(el, fn)`：元素**连入文档之后**回调一次
  （≈ 平台的 `connectedCallback`），返回的清理函数随元素回收（≈ `disconnectedCallback`）；
  `el` 的类型由标签推导（`<canvas>` → `HTMLCanvasElement`、`<dialog>` → `HTMLDialogElement` 等），
  无需手写泛型。
  - 生命周期：列表行增删 / `when` 分支切换 / keyed 复用移动语义正确；SSR 期间不执行；
    hydration 认领后执行一次；回调在**该元素的 owner 作用域内**执行 —— 因此
    「要用这个节点的响应式逻辑，就写进 `ref` 回调」是官方推荐写法（组件体的语句先于 DOM 构建执行）。
  - 编译期拦截三态：`PLAIN_E1009`（组件上用 `ref`）/ `PLAIN_E1010`（值非函数 / 返回 JSX）/
    `PLAIN_E1011`（`async` 回调）。
  - 文档：README「命令式逃逸口 `ref`」、`AGENTS.md` 反模式 16–18 与错误码表、
    `docs/patterns.md` §9（弹窗 / 画布 / 第三方库 / 焦点）、提案 `docs/rfcs/ref-escape-hatch.md`。
  - 测试：`test/ref.test.mjs`（14 项：编译正反例 + 连接 / 清理 / 列表 / 条件 / SSR / 注水）。
- **`plain/testing` 官方测试工具包**（零依赖，独立子路径，不并入冻结的运行时 API 面）：
  - `render(Component)` —— 挂进全新容器，返回 `container` / `html()` / `text()` /
    `get()` / `query()` / `queryAll()` / `getByText()` / `queryByText()` / `unmount()`；
    用 scope 兜住卸载，组件 effect 不串到下一个用例。
  - `fireEvent` —— `click` / `input(value)` / `change(value)` / `submit` / `focus` /
    `blur` / `keyDown` / `keyUp` / `fire(type)`，派发真实 DOM 事件并把回调里的 signal
    写入合并成一轮刷新（`signal.set` 本就同步 flush，调用方无需 await）。
  - `flush()` —— 等微任务（给 `resource` 这类异步）；`expectText(ui, s)` —— 失败信息带
    实际文本与 HTML。
  - 缺 DOM 环境时抛**带安装指引**的错，而非 `document is not defined`。
  - 测试：`test/testing.test.mjs`（含真编译 TSX 的端到端 + 各事件变体）；覆盖率 100%。
  - 文档：README「官方测试工具包」小节。

- **`SECURITY.md`**：写清安全模型与边界 —— `server()` 编译期物理剥离、产物不生成 `innerHTML`、
  运行时零 `eval` / `new Function`（生产 CSP 无需 `unsafe-eval`）；dev RPC 中间件的
  `new Function` 只在 dev 生效；鉴权 / 限流不在框架职责内的说明；以及漏洞报告方式。
  同步：**build 阶段不再求值 server 函数体**（此前 transform 在构建时也会 `new Function`
  求值一遍，只为填充 registry）—— 清单只需要函数体文本，少一处构建期 `new Function`，
  CSP 面更小、也避免构建机执行到只该跑在服务端运行时的代码。dev 仍求值（`/_plain/rpc` 需要），
  且不依赖调用顺序（`configureServer` 会补求值已登记的 body）。

### 修复

- **裸控制流 `return` 不再漏编译，也不再误报成「编译器 bug」**。此前编辑规则只认
  `isJsxLike(表达式)`，于是 `return cond ? <a/> : <b/>`、`return cond && <a/>`、
  `return xs.map(x => <li/>)` 这类**表达式本身是控制流**的写法被判为「不含 JSX」而漏编译 —
  产物里残留原始 JSX 标签，一路漏到 `assertClean`，最后报成 `PLAIN_E1003`
  （"这是编译器 bug，请附最小复现提 issue"）——**把用户完全合法的写法误导成框架缺陷**。
  同期 `if (x) return <a/>;`（渲染函数里的提前 return）、渲染函数 `try/catch` 分支里的
  `return <a/>` 也被同一原因漏掉。
  现在：
  - 编辑规则 3 的判据从「表达式是 JSX」改成 `isEmittableReturnBody`（**含 JSX** +
    最近的函数是渲染函数 / `.map()` 回调），与 `emitStmt → genFragment` 的实际行为对齐；
  - 编辑规则 2（箭头简洁体）同样放宽：`() => cond ? <a/> : <b/>` 不再漏编译；
  - `isEmittedJsx` 改为「先向上穿透括号 / 三元 / `&&`，再判定 holder」，并支持提前 `return`；
  - **边界保持不变**：`||` / `??` 短路的 JSX、数组字面量、IIFE、链式后置 `.map().filter()`
    仍报 `PLAIN_E1001`（`||` / `??` **不**参与穿透 —— 它们会落到 `insert` 兜底，JSX 不会被 emit）。
  - **关键区分**：JSX 是「本表达式的控制流结果」还是「一个独立函数的返回值」。
    后者（`return () => <jsx/>` 组件工厂）由内层箭头自己编译，外层 `return` 不抢它 ——
    否则会漏编译内层 JSX。`containsJsx` 因此以**函数边界**为准（`.map(cb)` 回调例外）。
  新增回归测试 `test/compiler.test.mjs` 4 组（裸控制流 return 合法 10 例 / 产物不残留 JSX /
  `||`·`??` 仍报 E1001 / 组件工厂不被外层抢编译）。
  文档同步：更新 [`AGENTS.md`](AGENTS.md) §3.1 与反模式第 21 条、`PLAIN_E1001` 的 `hint`。
- **HMR 单测补上「真实 `import()` 懒加载」覆盖**。此前「改动非挂载模块 → 重跑挂载点」只有
  一个**用假模块 id 模拟**的用例，没有真正走一遍动态 `import()`。新增
  `test/hmr.test.mjs` 用例：父模块懒加载子模块并渲染，子模块改动后 `hmrApply(子模块 id)`
  重跑父挂载点、父模块重新取到子模块新代码，DOM 显示新内容（且不整页刷新）；另补
  「注册表为空时 `hmrApply` 返回 false，交给整页刷新」的失败边界。
  顺带修正测试基建 `inDom`：回调是异步时**等 Promise 落定再还原全局**（原先 `try/finally`
  在首个 `await` 处就拆了 jsdom 全局）。
- **不支持的 JSX 位置改为报「用户可见的语法错误」，不再伪装成编译器 bug**。
  此前 `{cond || <a/>}`、`{cond ?? <a/>}`、数组字面量 `{[<a/>, <b/>]}`、IIFE 里的 JSX、
  `try/catch` 分支里 `return <a/>`、链式后置 `.map(...).filter(...)` 等写法，
  会被兜底检查 `assertClean` 报成 `PLAIN_E1003`（"产物里残留未处理的 JSX，这是编译器 bug，
  请附最小复现提 issue"）——**把用户的语法错误误导成框架缺陷**，违背 P1（错误要可行动）。
  根因：`assertJsxCovered` 用「有 JSX 祖先就跳过」判断是否已处理，嵌套在 `{...}` 里的 JSX
  因而**从不参与判定**，一路漏到产物自检。
  现在改为按「编译器会 emit 它的位置」白名单判定（`return` / 箭头隐式体 / 三元分支 /
  `&&` 右侧 / JSX 子节点 / `.map()` 回调 / 组件工厂返回 / JSX 属性值渲染函数），
  其余一律报 `PLAIN_E1001`，并给出具体行号与改法（"先赋值给变量再插值"或"抽成组件函数"）。
  新增回归测试 `test/compiler.test.mjs` 两组（7 个合法形状 + 6 个应拦截形状）。
  文档同步：[`AGENTS.md`](AGENTS.md) 新增 §3.1「视图语法边界」与反模式目录第 21 条。
- **SSR 并发渲染不再串味、不再残留废弃垫片**（RFC §3.4 的根因修复）。此前 `installServerDOM()`
  靠「换掉 `globalThis.document` → 用完换回来」，隐含假设「渲染是同步的、恢复是 LIFO」。
  但渲染过程里有 `await`（等静默 / `wait` / 数据迁移），同进程并发渲染就破了这个假设 ——
  10 行最小复现直接看到两种失效：**先结束的请求把全局还原掉 → 后一个请求的后续 `document.*`
  落到另一个请求的垫片上（串味），或落到 `undefined`（TypeError 崩掉）**。
  现在：
  - `document` / `Node` 改成「**取值时查当前渲染上下文**」的访问器（只装一次，**不再换入换出**）；
  - 新增 `src/server/ssr-scope.ts` 的 `runSSR(handlers, fn)`：用 `AsyncLocalStorage` 让每个渲染
    跑在自己的作用域里，**异步上下文贯穿 `await`**，垫片 / handlers / pending 全按渲染隔离；
  - `src/runtime/ssr-context.ts` 从「模块级状态」改成**只留一个「读当前上下文」的钩子** ——
    这份代码要进浏览器包，不能 import `node:async_hooks`；没注册钩子时 `isSSR()` 恒为 `false`；
  - `resource` 的 pending 从模块级 `Set` 移进渲染上下文：并发请求不再互相等对方的资源；
    客户端也不再常驻一个无用的 `Set`。
  - 测试 `test/ssr-data.test.mjs` 新增 3 项（用 `Promise.all` 制造真并发）：**各自数据只出现在
    自己的响应里** / **handlers 不互相借用**（没注入的那个必须报错）/ **结束后不残留垫片与上下文**。
- **HMR：改动「非挂载模块」不再静默留旧代码**。`hmrApply` 此前只处理「改动模块 == 挂载模块
  且导出 `App` / `default`」，其余情况打一句 warning 就返回 `false` —— 于是改独立组件文件、
  `import()` 懒加载进来的模块时，**界面纹丝不动且没有任何提示**（最坏的失败模式）。
  现在两条路：精确替换（挂载模块，只换它的子树）＋ **重跑兜底**（改动的是被别处使用的模块时，
  把各挂载点的根组件全部重跑，从而取到新版本、且不整页刷新）；挂载模块的新版本认不出根组件时
  **明确告警并 `invalidate()`** 交给整页刷新。测试 `test/hmr.test.mjs` 新增两项。
  > 同时修正 ROADMAP 里的错误诊断：懒加载模块**本来就被** `__plainBeginModule(id)` 打标
  >（vite 对按需加载的模块同样会跑 transform），真正的问题在 `hmrApply` 的匹配范围。
  > 已知粒度边界：改动非挂载模块时会重建挂载点的子树（丢焦点 / 滚动），
  > 组件级细粒度热替换仍待做。
- **`mount()` 卸载不再泄漏 effect / 清理回调**：此前 `mount()` 返回的卸载函数只移除 DOM，
  不回收该挂载点作用域内的 effect / `onCleanup` / `ref` 清理（它们只在 HMR 热替换时被回收）。
  现在卸载会**先回收作用域内的一切副作用、再移除 DOM**。依赖「卸载后 effect 仍存活」的非标准用法需调整。
- **`server()` 清单的多入口隔离**：`.plain/server.mjs` 是单文件清单，此前多入口 / 多模块下
  **同名 `server()` 函数会静默互相覆盖** —— 客户端 RPC 桩还在调旧名字，服务端实现却已换成
  另一个（最贵的「静默语义降级」）。现在：
  - Vite 插件为每个 server 函数记录**来源模块**，跨文件同名时**构建期抛错**并点名两处来源路径；
    同一文件重复 transform（HMR）不算冲突，函数体按最新版本替换。
  - `src/compiler/manifest.ts` 新增 `assertNoNameCollision`：`renderServerManifest` 写盘前查重，
    同名且来源不同（或来源都未知）即拒绝，避免任何一条静默覆盖路径。
  - 边界同时写清：Vite 的多入口 entry / shared chunk / `splitVendorChunk` 等属**打包侧配置**，
    框架透传不介入；框架侧只解决「单文件清单同名覆盖」这一个真问题。
  - 测试：`test/vite-plugin.test.mjs`（跨文件冲突抛错 / 不同名各自保留 / 同文件热更新）+
    `test/server.test.mjs`（`assertNoNameCollision` 三种情形）；`manifest.ts` 覆盖率 100%。

### 变更（破坏性）

- **错误码收敛到一套 `PLAIN_Exxxx`**：此前 lint 用字符串规则码（`plain/no-props-snapshot`）、
  编译器用 `PLAIN_E1005` 这类码，两套并存 —— 机器要记两套前缀、IDE / CI / AI 也得写两套匹配。
  现在 **编译器 / lint / 构建期共用一套编号**，数字自带分类：
  `E10xx` 编译器内部 · `E11xx` lint（可抑制）· `E2xxx` 构建期闸门。
  新增单一事实来源 [`src/errors.ts`](src/errors.ts)：`ERROR_CATALOG` 一处登记码 / 短名 /
  可否抑制 / 说明，lint 规则从表里反查短名，杜绝两处各写各的。映射：

  | 旧规则码 | 新错误码 |
  | --- | --- |
  | `plain/signal-assign` | `PLAIN_E1101` |
  | `plain/signal-not-called` | `PLAIN_E1102` |
  | `plain/react-habit` | `PLAIN_E1103` |
  | `plain/no-inner-html` | `PLAIN_E1104` |
  | `plain/no-props-destructure` | `PLAIN_E1105` |
  | `plain/no-signal-mutate` | `PLAIN_E1106` |
  | `plain/no-props-snapshot`（保留初值形态） | `PLAIN_E1107` |
  | `plain/no-resolve-event-prop` | `PLAIN_E1108` |
  | `plain/no-async-effect` | `PLAIN_E1109` |
  | `plain/no-effect-loop` | `PLAIN_E1110` |
  | `plain/no-computed-side-effect` | `PLAIN_E1111` |
  | `plain/no-props-snapshot`（赋值 / JSX 形态） | `PLAIN_E1112` |

  **兼容**：`plain-ignore-line` / `plain-ignore-next-line` 里的旧名 `plain/<rule>`
  仍被接受（`parseSuppressionCodes` 新旧都收，`isSuppressed` 经短名映射命中），
  但 CLI / vite 插件 / MCP 的输出统一走新码。`src/errors.ts` 的 `LINT_RULE_CODES` /
  `ruleNameOf` / `codeOfRule` / `legacyCode` 为工具链提供映射查询。
  测试见 `test/errors.test.mjs`（目录唯一性、lint 产出码都在表里、新旧抑制名都能命中）。

### 新增

- **HMR 热更新（M4 落地）**：`src/runtime/hmr.ts` 提供挂载点注册表与热替换内核；
  `src/vite/index.ts` 在 dev（`watchMode`）下为每个模块注入 `import.meta.hot.accept`，
  `handleHotUpdate` 让改动走 accept 管道而**不整页刷新**。改组件时只重建它产出的
  DOM 子树（`syncRange` 替换锚点区间，区间之外的节点不动）；模块级 `signal` 值尽力保留
  （基于 `import.meta.hot.data` 快照，仅原始值可迁移），保留不了**显式 `console.warn`**。
  新增运行时 API：`hmrApply(id, newMod)` / `snapshotSignals` / `restoreSignals` /
  `hmrScope` / `getHmrModuleId`；vite 插件新增 `hmr` 选项（默认开）。
- **SSR 注水 hydration（M5 落地）**：`hydrate(container, App)` 复用服务端已渲染的节点，
  **节点对象身份不变**（不整树重建）；文本/属性不一致时就地修正；未注水的 `mount()`
  行为完全不变。机制与 SSR 同源——都靠「换掉 `globalThis.document`」跑同一份编译产物，
  hydrate 换成「认领式 document」按游标从服务端 DOM 取节点。SSR 序列化时保留 `plain-`
  前缀的认领锚点（普通注释仍丢弃）。新增 types：`HydrateOptions` / `HydrateResult`。

### 修复

- **SSR 不再污染宿主全局**：`renderToString` / `renderToStringSync` 渲染结束后会还原
  `globalThis.document` / `Node` / `window`，并回收 SSR 期间创建的 effect。
  此前 SSR 会把这些全局永久占成服务端垫片、且残留 effect 仍在订阅信号——同一进程里
  随后做 hydrate 时，点击等更新会同时触发「SSR 残留 effect（锚点是垫片节点）+ hydrate
  effect」，在垫片节点上做 DOM 操作直接抛错。**属行为修正，依赖旧行为的非标准用法需调整。**
- **`mount` 的 HMR 热替换**：`dispose` 改为只回收 effect（不再连带移除锚点/子树 DOM），
  由 `rebuild` 经 `syncRange` 做最小重排替换——修复热替换后挂载点被清空的问题。

- **契约规则 `plain/no-signal-mutate`**：就地改 signal 持有值（`items().push(x)` /
  `items()[0] = x`）不会触发更新。构建期报错，不自动修。
  覆盖面按「源码上看得出的可变操作」铺开：深层路径（`todos()[0].done = true`、
  `user().profile.name = "x"`、`todos()[0].tags.push(x)`）与**先存后改**
  （`const arr = items(); arr.push(x)`，按函数作用域解析别名）都拦；
  `items().filter(f).push(x)`（改的是新数组副本）不报。
- **契约规则 `plain/no-props-snapshot`**：把动态 props 的 getter 存进变量
  （`const t = props.title` / `const t = resolve(props.title)`）、赋值形态（`let t; t = props.title`，
  只报组件函数体顶层的赋值，写在 `effect` / 回调里的会重跑、不报）或 JSX 里忘了 `resolve`
  （`{props.title}`）。`on*` 事件 prop 编译器不包 getter（存进变量、透传都合法）与 thunk 写法不报；
  动态下标（`props[key]`）看不出来，仍按 getter 报。
- **`server()` 参数与返回值可序列化校验**：新增编译错误 `PLAIN_E1007`。调用 `server()` 产物时
  传入字面量函数、本文件的类实例、或 `ReadableStream` / `FormData` 等，编译期失败；
  `server(() => …)` 的**返回值**同样要能序列化（`return () => {}`、`return new ReadableStream()`、
  对象里夹函数、返回函数体内自产的 helper 都会报）—— 此前这类返回值会被 RPC 的
  `JSON.stringify` 悄悄丢成 `{}` / `undefined`，客户端不报错。
  看不出类型的标识符、`new Date()`、spread、嵌套函数自己的 `return` **不猜**，避免误报。
- **三条响应式卫生规则**（AI 高频、且不报错只行为错的坑）：
  - `plain/no-async-effect`：`effect(async () => { await … })` —— 依赖收集在第一个 `await` 之后失效。
  - `plain/no-effect-loop`：`effect(() => count.set(count() + 1))` —— 读了又写同一个 signal，
    是同步递归、直接 `RangeError: Maximum call stack`；只报**没有条件闸门**的写法，
    `if (c() > 10) c.set(0)` 这种钳位会在第二轮收敛，不报。
  - `plain/no-computed-side-effect`：`computed(() => { s.set(…) })` —— 派生值必须是纯函数。
- **AI 可发现性**：`plaindev agent-context [--write]` 把 `AGENTS.md` §1–5 现读现切并打印
  （规则只有一份，不维护第二份副本）。`--write` 落盘的目标按「谁会被 AI 自动读取」排序：
  跨工具标准 **`AGENTS.md`**（Codex / Cursor / Copilot / Windsurf / Claude Code … 都读它），
  再加 `.github/copilot-instructions.md` 与 `.cursor/rules/plain.mdc`（带 `alwaysApply`
  front-matter）给只认自家文件的工具兜底。**已存在的文件默认不覆盖**（项目自己写的
  AGENTS.md 通常更好），要覆盖得显式 `--force`；`--targets agents,copilot,cursor` 可只写其一。
- **`plaindev mcp`**：零依赖的 MCP stdio server，暴露 `plain_check` / `plain_schema`
  两个工具，AI IDE 可以直接调 —— 不必等人类跑一次构建才知道写错了。
- **误报的出口：行级抑制指令**：`plain-ignore-line` / `plain-ignore-next-line`
  （可跟规则码，不跟则抑制该行全部 lint 规则），按「CLI 报出来的行号」匹配。
  只作用于 lint 规则 —— 编译器的 `PLAIN_E*` 是产物必坏的硬错，**不可抑制**。
  `plaindev check` 会报出抑制处数，避免它变成静音开关。
- **列表 keyed 复用**：`arr.map(x => <li key={x.id}>…)` 现在按 key 认领行，
  头部插入 / 重排不会重建已有节点（关闭 `SPEC.md` §4 里 `each(..., keyFn, ...)` 的欠账）。
  `each()` 新增可选的第 4 个参数 `keyFn`；不传时行为与之前完全一致。
- **契约检查接进构建链路（默认开启）**：vite 插件 `transform` 第一步就跑 `lint`，
  失败抛 `PLAIN_E2001`（带规则码、位置、可自动修提示）。
  此前 `lint` 只在 `plaindev check` 里跑，写得不对照样构建成功、语义静默出错。
  新增选项 `plainPlugin({ lint: "warn" | false })`。
- **新增契约规则 `plain/no-props-destructure`**：解构 props（`const { title } = props`）
  会拿到 getter 本身并丢失响应性 —— 这是 AI 从 React / Solid 带过来的头号反模式。
  口径补齐到三种写法：`const { x } = props`、`const { x } = props.data`、
  `function Card({ x })` / `const Row = ({ x }) => …`（**参数解构**此前完全漏过，
  而它正是 React 肌肉记忆里最顺手的一种）。先 `resolve()` 再解构是正确写法，不报。
- **`server()` 自包含校验**：新增编译错误 `PLAIN_E1006`。`server()` 的函数体会被物理搬到
  `.plain/server.mjs`，那个文件里没有 import、也没有模块作用域，所以引用「本文件里绑定了、
  却不在函数体内」的名字（模块变量 / import / 外层参数）到了服务端必然 ReferenceError。
  此前要等运行时才炸，现在编译期就报出来。
  实现上**只报确知被文件绑定的名字**，不去猜全局变量 —— 避免误报，误报会毁掉免疫系统的可信度。
- **结构化编译错误**：`PlainCompileError` 带
  `code`（`PLAIN_E1001`–`PLAIN_E1007`、`PLAIN_E2001`）/ `file` / `line` / `column` / `hint`，
  可 `JSON.stringify`，供 IDE / CI / AI 直接消费（`SPEC.md` §7「自解释错误」）。
- **编译产物 sourcemap**：`compile()` 返回 line 级 `map`，vite 插件会链式回传给 devtools，
  断点与堆栈可定位回 `.tsx` 源文件。
- **`AGENTS.md` + 反模式目录**：10 条反模式逐条标注「是否已被静态检查覆盖」，
  未覆盖的明确写「自己保证」，避免代理把「不报错」当成「是对的」。
- **AI 正确率评测骨架 `eval/`**：7 个任务（计数器 / keyed 列表 / 服务端边界 / 服务端读配置 /
  不可变更新 / props 取值快照 / 服务端自校验）+ 验收断言 + 指标口径
  （首次通过率 / 平均轮次 / 拦截率）+ 公平性与自欺清单。
  harness 新增 `evalServerFn()`：把物理剥离出来的服务端函数单独执行（与 dev 的 `evalFn` 同路径），
  从而能断言 `server()` 的真实行为。7 个 reference 全过；6 个「直觉但错」的实现全部按设计失败。
- **Plain vs React 对比基线 `eval/compare/`**：3 个用例（计数器 / 列表增删 / 父状态传子组件），
  **共用同一份提示词与同一份断言**，框架差异全部收在适配器里（交互一律走 DOM 事件）。
  服务端边界类任务不可比，已排除并说明理由；Plain 侧的构建期闸门与 React 侧默认无闸门
  这一不对称也写进了公平性说明。
  已验证：两边的「各自惯用但错」实现被**同一行断言**抓住（就地改 / 派生状态快照）。
  新增 `package.json` 脚本 `eval` / `eval:compare`，并接进 CI 作为 harness 自检。
- 覆盖率度量与门禁：`pnpm run coverage`（c8 + `src` 级 sourcemap 映射），门槛写在 `.c8rc.json`。
- GitHub Actions 工作流（`.github/workflows/ci.yml`）：构建 + 内核/单元测试 + 覆盖率门禁；
  真实浏览器端到端改为手动触发。
- 单元测试套件 `test/*.test.mjs`（`node:test`）：覆盖 `lint` 规则与自动修复、`schema` 契约提取、
  `compiler` 报错兜底与 sourcemap、`cli` 子命令、`vite` 插件的编译/剥离/契约拦截、
  `keyed` 列表语义、`server`（静态托管/目录穿越/RPC/起服）、SSR 序列化、运行时边界分支。
- `ROADMAP.md`（分阶段计划与验收标准，含「为什么先做免疫系统与评测」的排序原则）、
  `CONTRIBUTING.md`（环境、提交信息与改动要求）。
- **常见场景配方 `docs/patterns.md`**：补齐此前无官方写法的表单类场景 ——
  受控输入、控件速查、多字段组织、异步提交（loading / error / 禁用）、
  列表内行编辑（行内局部状态 + keyed 复用）、校验分层（客户端 UX + 服务端权威）。
  两条实测踩坑一并记入：`{...spread}` 封装受控绑定**只在创建时求值一次、不进 `effect`**
  （信号变了不更新，静默失效，无静态规则能拦）；`resolve(props.onSave)` 会把 `on*` 事件 prop
  **当场调用**（`on[A-Z]` 开头不包 getter，应直接 `props.onSave(...)`）。
  README / AGENTS.md 已加入口。
- **`eval/RESULTS.md` 记入首个真实模型跑数（含效度声明）**：7/7 首次通过、平均轮次 1.00；
  但该次执行前模型已读过 `check.mjs`，**不是协议干净的有效指标**，只能作为上界与 harness 联调记录 ——
  只喂 `task.md` 的有效实验仍待补。
- **契约规则 `plain/no-resolve-event-prop`**：`resolve(props.onClick)` —— 编译器对 `on[A-Z]`
  的 prop **不包 getter**（传进来的就是函数本身），而 `resolve(fn)` 会把函数**当场调用**，
  于是事件处理器在渲染期就被执行。构建期报错，**可自动修**（去掉 `resolve` → `props.onClick`）。
  此前 `plain/no-props-snapshot` 把 `on*` 一律当「合法透传」豁免，恰好漏放了这一种。
- **`eval/compare` 补齐上下文档位 `--context task|minimal|full`**：此前只有 `eval/tasks` 有这条自变量，
  compare 侧缺失 —— 于是「给不给规则文档」这个最关键的自变量没处记，不同档位的数字之间不可比。
  现与 tasks 侧同口径（从 `AGENTS.md` 现读现切），运行输出与 `--prompt` 都会打印档位。
  React 侧不额外喂文档（React 是模型已有知识），故这一档量的是「Plain 要补多少文档才追得上」。

### 修复

- `lint`：JSX 属性里的 signal 漏调用会被重复报错，且两条 `fix` 区间重叠会让 `autofix`
  把源码改坏（`checked={done}` → `checked={done()()}`）。现在同一标识符只报一次，
  重叠的 fix 会被安全跳过。
- `compiler/manifest`：dev 增量更新时会把 `__plainHandlers` 当成用户函数再写一遍，
  产出重复 `const` 声明，导致多文件场景下 `/_plain/rpc` 直接加载失败。
- `test/browser.mjs`：不再硬编码 `/usr/bin/chromium`，改为环境变量
  （`PLAIN_CHROMIUM_PATH` / `CHROMIUM_PATH` / `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`）
  加常见路径探测，失败时给出可操作的提示。

### 变更（含 breaking）

- **`key` 与 index 同时使用现在是编译错误 `PLAIN_E1005`**（此前是静默丢掉 key、退回按位置复用）。
  keyed 复用下行只构建一次，回调捕获的 index 无法随位置更新，两者同时生效必然有一个语义是错的；
  静默的语义降级正是本框架最该消灭的失败模式。
  受影响的写法：`arr.map((x, i) => <li key={x.id}>…</li>)`。修法：删掉 `key` 或删掉 index 参数。
- **JSX 属性展开 `{...expr}` 现在是编译错误 `PLAIN_E1008`**（此前是「半套支持」：接受，但会静默跑错）。
  展开产物是一段**只跑一次**的循环（不进 `effect`，信号变了不更新），且一律 `setAttribute`：
  `className` 不生效、`style` 对象变成 `"[object Object]"`、`value` / `checked` 被设成 attribute
  而非 property。受影响的写法：`<Card {...rest} />`、`<input {...attrs} />`。修法：展开成显式属性。
  理由同 `PLAIN_E1005` —— 不做静默降级。
- 统一包管理器为 pnpm，移除 `package-lock.json`。
- `tsconfig`：打开 `noImplicitAny`，开启 `sourceMap` / `declarationMap`。
- `package.json`：新增 `engines`、`packageManager`、`sideEffects`。
- 从仓库移除构建产物 `plain-deliverable.zip`；`coverage/` 加入 `.gitignore`。

### 许可证

- **由「非商业许可」改为 MIT**：此前 `LICENSE` 默认禁止商用（`ROADMAP.md` 标注为企业级目标互斥的前置决策），
  现改为 **MIT** —— 可自由使用、修改、再分发与商用，唯一要求是保留版权声明与许可证全文。
  配套同步 `package.json` 的 `license` 字段（`SEE LICENSE IN LICENSE` → `MIT`）与 README「许可证」章节；
  `ROADMAP.md` M7 的许可证决策项已勾选完成。这不是代码 breaking change，但改变了使用授权范围。

## [0.3.0]

TypeScript 源码 + tsc 构建；signals 响应式内核、编译到 DOM、`server()` 编译期物理剥离、
SSR 输出、路由与 ErrorBoundary、`plaindev` CLI 与 Vite 插件。
