# AGENTS.md —— 给 AI 编码代理的 Plain 工作说明

> 这个文件是给 AI 代理看的（人请看 [README.md](README.md)）。
> 目标：让代理**一次写对**，而不是写完再靠人排查。
> 纪律：**先读第 3 节的反模式目录，再动手写代码。** 写表单 / 提交 / 校验这类常见场景前，
> 先看 [`docs/patterns.md`](docs/patterns.md)（每个场景只有一种推荐写法）。

## 1. Plain 是什么

编译型前端框架：TSX 视图 + signals 响应式 + 编译期物理剥离的 `server()` 边界。
组件编译成**直接操作 DOM 的代码** —— 没有虚拟 DOM、没有 hook、没有依赖数组、没有 Proxy 魔法。

## 2. 只有 5 条规则

1. 状态只有 `signal`：读 `s()`，写 `s.set(v)` 或 `s.set(prev => next)`。派生用 `computed(fn)`。
2. 组件 = 返回 JSX 的函数，必须写成 `return (<jsx />)`。
3. 列表 `arr.map(x => <li key={x.id} />)`；条件 `{cond ? <a/> : <b/>}` 或 `{cond && <a/>}`。
4. 副作用用 `effect(fn)`，依赖自动收集，随组件 / 列表行一起回收。
5. 要跑在服务端的代码用 `server(fn)` 包起来（客户端产物里只剩 RPC 桩）。

组件里取 props 一律 `resolve(props.x)` —— 动态属性在编译器里是 getter。

跨层传值（主题 / 语言 / 当前用户）用 `createContext` / `<Ctx.Provider value={…}>` / `useContext`，
**读法是调用** `useContext(Ctx)()`（与 `signal` 一致）。**请求级数据不要放模块作用域的 signal** ——
SSR 下模块作用域是同进程共享的，会把 A 请求的数据渲染进 B 请求的响应；这类数据必须走 Context 或 props。

## 3. 反模式目录（Anti-Pattern Catalog）

「自动拦截」那一列告诉你哪些错误**构建时就会失败**。标 ❌ 的必须自己保证正确。

| # | 反模式（别写） | 正确写法 | 自动拦截？ | 评测任务 |
| --- | --- | --- | --- | --- |
| 1 | `count = 1` | `count.set(1)` | ✅ `PLAIN_E1101`（可自动修） | — |
| 2 | `{count}` / `checked={done}` | `{count()}` / `checked={done()}` | ✅ `PLAIN_E1102`（可自动修） | — |
| 3 | `useState` / `useEffect` / `useMemo` / `useCallback` / `useRef` | `signal` / `effect` / `computed` | ✅ `PLAIN_E1103` | — |
| 4 | `el.innerHTML = html` / `insertAdjacentHTML` | `{expr}` 插值 / `createTextNode` | ✅ `PLAIN_E1104` | — |
| 5 | `const { title } = props` | `resolve(props.title)`，或 `const title = () => resolve(props.title)` | ✅ `PLAIN_E1105` | — |
| 6 | `<li key={x.id}>` 与 `(x, i) =>` 的 index 同时用 | 二者选一：要 key 就删掉 index 参数；要 index 就删掉 key | ✅ `PLAIN_E1005` | — |
| 7 | 就地改数据：`items().push(x)` | 生成新值：`items.set([...items(), x])` | ✅ `PLAIN_E1106` | 05 |
| 8 | `server()` 函数里引用**本文件的**模块变量 / import / 外层参数 | 在函数体内自己获取（`process.env.DB_URL`、`await import("./db.js")`），或作为参数传进来 | ✅ `PLAIN_E1006` | 04（间接） |
| 9 | 把 getter 存进变量：`const t = props.title`（或忘了 `resolve`；`t = props.title` 同样算） | `resolve(props.title)`；要响应式就写成 thunk | ✅ `PLAIN_E1107`/`PLAIN_E1112` | 06 |
| 10 | 给 `server()` 传函数 / 类实例 / Stream | 只传 JSON 可序列化的参数 | ✅ `PLAIN_E1007` | 07 |
| 11 | `effect(async () => { await … })` | 依赖收集在第一个 `await` 之后失效：把 `await` 提到 `effect` 外，或用 `resource()` | ✅ `PLAIN_E1109` | — |
| 12 | `effect(() => count.set(count() + 1))`（读了又写同一个 signal） | 派生值用 `computed(fn)`；`effect` 里只写「没读过」的 signal | ✅ `PLAIN_E1110` | — |
| 13 | `computed(() => { s.set(…) })` | `computed` 必须是纯函数，副作用放 `effect` | ✅ `PLAIN_E1111` | — |
| 14 | `resolve(props.onClick)`（`on*` 事件 prop 不能 resolve） | `props.onClick(...)`：编译器不给 `on*` 包 getter，传进来的就是函数，`resolve` 会把它当场调用 | ✅ `PLAIN_E1108`（可自动修） | — |
| 15 | JSX 属性展开 `{...expr}` | 展开成显式属性：展开只做半套（不进响应式 + 绕过 class / style / value），会静默跑错 | ✅ `PLAIN_E1008` | — |
| 16 | 在**组件**上写 `ref` | 把 `ref` 放到组件内部的元素上 | ✅ `PLAIN_E1009` | — |
| 17 | `ref` 的值不是函数（`ref` / `ref="x"` / 返回 JSX） | `ref={(el) => { … }}` | ✅ `PLAIN_E1010` | — |
| 18 | `ref={async (el) => …}` | 把 `await` 提到回调外 | ✅ `PLAIN_E1011` | — |
| 19 | 在**模块作用域**创建 `resource(...)`（import 时立即执行、SSR 导入即发请求、无人回收） | 放进组件函数体，或 `createScope(() => …)` 里 | ✅ `PLAIN_E1113` | — |
| 20 | 对 `useContext(Ctx)` 的返回值直接取属性（`t.name` / `useContext(Ctx).name`） | 先调用再取：`useContext(Ctx)().name` | ✅ `PLAIN_E1114` | — |

> 「评测任务」列是 `eval/tasks/` 里针对这条反模式的任务编号 —— 它衡量的是
> **代理实际会不会犯这个错**，和「自动拦截」是两件事（一个任务可能既没被拦截、
> 也没被拦住，那就是最贵的失败）。跑法见 [eval/README.md](eval/README.md)。
>
> 关于第 7、9、10 条：只报**源码上看得出**的写法（`items().push`、`const t = props.title`、
> 字面量函数 / 本文件的类 / `new ReadableStream()` 这类）。看不出类型的标识符、
> `new Date()`、`...spread` **不猜** —— 不去猜，是为了不误报。
>
> 关于第 8 条：编译器只报「本文件里确实绑定了、但不在函数体内」的名字。
> 全局对象（`process` / `Math` / `fetch` …）不在判定范围内 —— 不去猜全局，是为了不误报。
>
> 第 8 条还有一条**应用级约束**：`server()` 函数名在整个应用里必须唯一。清单是单文件
> （`.plain/server.mjs`），多入口 / 多模块下同名会被**构建期拦下并报冲突**（点名两处来源），
> 而不是静默互相覆盖。Vite 的多入口 / 分包配置照常透传，框架不介入。
>
> 关于第 12 条：只报**没有条件闸门**的自触发（`if (c() > 10) c.set(0)` 这种钳位会在
> 第二轮收敛，不报）；回调定义在别处（`effect(load)`）看不出是不是 async / 纯的，也不猜。
> 已知边界：表达式形式的自我收敛写法（`count.set(Math.min(count() + 1, 10))`）看不出闸门，
> 会被报成死循环 —— 确认是规则判断错了，用第 4.1 节的抑制指令，不要绕开规则。
>
> 关于第 16–18 条：`ref`（**只能放内建元素上**）是命令式 DOM 逃逸口 —— 元素**连入文档后**回调一次
> （≈ 平台的 `connectedCallback`），返回的清理函数随元素回收。**要用这个节点的响应式逻辑，就写进
> 回调里**（组件体的语句先于 DOM 构建执行，那时节点还不存在）。弹窗 / 画布 / 第三方库的配方见
> [`docs/patterns.md`](docs/patterns.md)，取舍见 [`docs/rfcs/ref-escape-hatch.md`](docs/rfcs/ref-escape-hatch.md)。
>
> 关于第 19 条：`resource()` 内部是 effect，放模块作用域会在**模块被 import 时立刻执行**
> （App 还没挂载；SSR 下更是在服务端「导入模块」时就发请求），而且没有 owner 可回收。
> 放进组件函数体，或放进 `createScope(() => …)` 里。

## 4. 错误码

**一套编号**：编译器、lint、构建期共用 `PLAIN_Exxxx`，数字自带分类 ——
`E10xx` 编译器内部 · `E11xx` lint（可抑制）· `E2xxx` 构建期闸门。

| 码 | 含义 | 你该做什么 |
| --- | --- | --- |
| `PLAIN_E1001` | JSX 写法编译器不认识 | 按 `hint` 改成 `return (<jsx/>)` / `.map(...)` / 三元 / `&&` |
| `PLAIN_E1002` | 产物无法解析 | 输入必须是「已剥离 TS 类型」的 JSX（走 vite 正常不会遇到） |
| `PLAIN_E1003` | 产物里残留 JSX | 编译器 bug，附最小复现提 issue |
| `PLAIN_E1004` | 遇到不支持的语法节点 | 同上 |
| `PLAIN_E1005` | 列表的 key 与 index 同时使用 | 二者选一 |
| `PLAIN_E1006` | `server()` 的函数体引用了外部变量 | 在函数体内自己获取，或改成参数传入（闭包不会跟到服务端） |
| `PLAIN_E1007` | `server()` 的调用参数无法 JSON 序列化 | 只传数据；把函数 / 校验逻辑写进 `server()` 函数体 |
| `PLAIN_E1008` | JSX 属性展开 `{...expr}` | 展开成显式属性（展开只做半套，会静默跑错） |
| `PLAIN_E1009` | `ref` 用在组件上 | 把 `ref` 放到组件内部的元素上 |
| `PLAIN_E1010` | `ref` 的值不是函数 | 写成 `ref={(el) => { … }}`（可返回清理函数） |
| `PLAIN_E1011` | `ref` 回调是 `async` | 把 `await` 提到回调外（清理与异步不兼容） |
| `PLAIN_E1101` | 直接给 signal 变量赋值 | 改成 `.set(…)`（可自动修） |
| `PLAIN_E1102` | JSX 里把 signal 当值用 | 补上调用 `()`（可自动修） |
| `PLAIN_E1103` | React 肌肉记忆（`useState` 等） | 换 `signal` / `effect` / `computed` |
| `PLAIN_E1104` | `innerHTML` / `outerHTML` | 用 `{expr}` 插值 / `createTextNode`（安全红线） |
| `PLAIN_E1105` | 解构 props | `resolve(props.title)`，或写成 thunk |
| `PLAIN_E1106` | 就地对 signal 值做修改 | 生成新值再 `.set` |
| `PLAIN_E1107` / `PLAIN_E1112` | props getter 被存进变量 / 忘了 `resolve` | 内联 `resolve` 或 thunk（两码同一条规则的不同形态） |
| `PLAIN_E1108` | `resolve(props.onClick)` | 去掉 `resolve` → `props.onClick`（可自动修） |
| `PLAIN_E1109` | `effect(async () => …)` | 把 `await` 提到 `effect` 外，或用 `resource()` |
| `PLAIN_E1110` | `effect` 自触发 | 派生值用 `computed`；`effect` 里只写没读过的 signal |
| `PLAIN_E1111` | `computed` 里写 signal | `computed` 必须纯，副作用放 `effect` |
| `PLAIN_E1113` | 在模块作用域创建 `resource()` | 放进组件函数体，或 `createScope(() => …)` 里 |
| `PLAIN_E1114` | 对 `useContext(Ctx)` 的返回值直接取属性 | 先调用再取：`useContext(Ctx)().name` |
| `PLAIN_E2001` | 契约检查未通过 | 跑 `npx plaindev check --fix <dir>` 自动修，再重新构建 |

> `E11xx` 每条还带一个可读短名（`PLAIN_E1107` = `no-props-snapshot`），完整目录见 `src/errors.ts`。
> 旧写法 `plain/no-props-snapshot` 在抑制指令里仍被接受（向后兼容），但输出统一走新码。

错误对象带 `code` / `file` / `line` / `column` / `hint`，`JSON.stringify(error)` 可直接读，不用正则去刮 message。

### 4.1 规则判断错了怎么办（抑制指令）

契约规则是**启发式**：绝大多数时候对，少数情况下会误报（例如上面第 12 条那个
`Math.min` 钳位、或者你确实要「只取一次初值」）。这时用**行级抑制指令**，
而不是把规则关掉、也不是为了过构建而把代码写扭曲：

```js
// plain-ignore-next-line PLAIN_E1110
effect(() => count.set(Math.min(count() + 1, 10)));

const t = props.title; // plain-ignore-line PLAIN_E1112
```

- 两种写法：`plain-ignore-line`（同一行）与 `plain-ignore-next-line`（下一行），`//` 与 `/* */` 都认。
- 后面可以跟规则码（多个用空格分隔）。**不写规则码表示抑制该行全部 lint 规则**。
- 指令匹配的是「CLI 打印出来的行号」。多行表达式（如 `effect(() => {\n … \n})`）要把指令
  放在**报错那一行**，不是内部那行。
- `plaindev check` 会把「有几处抑制」打出来 —— 抑制是**可见**的，不是静音开关。
- **编译器的 `PLAIN_E*` 不能抑制**：那些是产物必坏的硬错（产物无法解析 / 服务端引用外部变量 /
  参数返回值不可序列化），压下去只会把错误推到运行时。

## 5. 命令

```bash
pnpm run build              # tsc → dist/（改完 src 必须跑）
pnpm test                   # 内核 + 单元测试
pnpm run coverage           # 覆盖率；低于 .c8rc.json 门槛会失败
pnpm run check              # 对 src 跑契约检查（默认自动修）
npx plaindev check <dir>    # 对任意目录跑契约检查
npx plaindev schema <dir>   # 产出机器可读的组件 / server / 路由契约 JSON
npx plaindev agent-context  # 打印本文件里「给 AI 的部分」
                            # --write 落盘 AGENTS.md / copilot / cursor（已存在的文件不覆盖）
npx plaindev mcp            # 把 check / schema 暴露成 MCP 工具，AI IDE 可直接调
npx plaindev lsp            # LSP stdio server：把契约检查接进编辑器，写代码时就报
```

## 6. 仓库地图

| 路径 | 职责 |
| --- | --- |
| `src/runtime/` | signal / dom / ref / context / async / router / error / hydrate / hmr —— 运行时（**对外 API 面冻结**；`ref.ts` / `context.ts` 是近期新增，见 `docs/rfcs/`） |
| `src/runtime/hydrate.ts` | SSR 注水：认领式 document 复用服务端节点（`claim-document.ts` / `hydration-context.ts` 为内核） |
| `src/runtime/hmr.ts` | HMR 挂载点注册表与热替换（`hmrApply` / 模块级 signal 快照） |
| `src/compiler/` | TSX → 建 DOM 代码、服务端清单、契约提取、sourcemap |
| `src/vite/` | Vite 插件：契约检查 → 类型剥离 → 编译 → `server()` 剥离 → HMR 注入 → 回传 sourcemap |
| `src/lint.ts` | 契约检查与自动修复（反模式目录 1–5、7、9、11–13 的执行者） |
| `src/errors.ts` | **错误码唯一来源**：`ERROR_CATALOG` 登记码 / 短名 / 可否抑制 / 说明；映射查询与抑制匹配 |
| `src/testing/` | `plain/testing` 官方测试工具包（`render` / `fireEvent` / `flush`），独立子路径、非冻结 API |
| `src/cli/` | `plaindev` |
| `test/` | 测试（跑的是 `dist/`，不是 `src/`） |
| `eval/` | AI 正确率评测：任务 + 验收断言 + 指标 |
| `docs/patterns.md` | 常见场景（表单 / 异步提交 / 列表内表单 / 校验 / 命令式 DOM）的**唯一推荐写法** |
| `docs/rfcs/` | 设计提案（如 `ref-escape-hatch.md`），评审后进 `SPEC.md` |

## 7. 改动约束

1. **不要扩充对外 API 面**：运行时导出是冻结的，新增即 breaking change。
2. 改行为必须带测试，`pnpm run coverage` 不得低于门槛。
3. 编译产物与运行时不得出现 `innerHTML` / `eval`（有测试守着）。
4. 提交信息用 Conventional Commits，scope 用模块名（`lint` / `compiler` / `runtime` / `server` / `vite` / `cli`）。
5. 改完 `src/` 记得 `pnpm run build` —— 测试与示例用的都是 `dist/`。
6. **新增行为前先过「AI-first 四道闸」**（可静态验证 / 可本地推理 / 重复优于抽象 / 平台优先）——
   优先级从高到低：交给平台 → 交给构建 / 工具链 → 变成编译期检查 → 才考虑新增运行时概念。定义见 [`SPEC.md` §1.1](SPEC.md)。
7. **不要给 `CommonAttributes` 加回 `[attr: string]: any`**（`src/types.ts`）：那会让内建元素上的
   属性名拼错 / 类型写错在 `tsc` 下静默通过（`<img scr>` / `<input checked="yes">` / `<div onClikc>`）。
   要支持冷门属性，就往那个枚举里**补一个名字**。防回归测试见 `test/types.test.mjs`。

## 8. 帮这个框架变好（重要）

这个框架的核心命题是「让 AI 首次写对的比例更高」。所以：

- 如果你在写 Plain 代码时**踩到了坑**，那是最有价值的信号 —— 把它补进第 3 节的反模式目录，
  或写成 `eval/tasks/` 里的一个新任务。
- 如果某个反模式你认为是错的（误报），也请提出来：反模式目录宁可少，不可误。
