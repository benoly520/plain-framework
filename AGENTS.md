# AGENTS.md —— 给 AI 编码代理的 Plain 工作说明

> 这个文件是给 AI 代理看的（人请看 [README.md](README.md)）。
> 目标：让代理**一次写对**，而不是写完再靠人排查。
> 纪律：**先读第 3 节的反模式目录，再动手写代码。**

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

## 3. 反模式目录（Anti-Pattern Catalog）

「自动拦截」那一列告诉你哪些错误**构建时就会失败**。标 ❌ 的必须自己保证正确。

| # | 反模式（别写） | 正确写法 | 自动拦截？ | 评测任务 |
| --- | --- | --- | --- | --- |
| 1 | `count = 1` | `count.set(1)` | ✅ `plain/signal-assign`（可自动修） | — |
| 2 | `{count}` / `checked={done}` | `{count()}` / `checked={done()}` | ✅ `plain/signal-not-called`（可自动修） | — |
| 3 | `useState` / `useEffect` / `useMemo` / `useCallback` / `useRef` | `signal` / `effect` / `computed` | ✅ `plain/react-habit` | — |
| 4 | `el.innerHTML = html` / `insertAdjacentHTML` | `{expr}` 插值 / `createTextNode` | ✅ `plain/no-inner-html` | — |
| 5 | `const { title } = props` | `resolve(props.title)`，或 `const title = () => resolve(props.title)` | ✅ `plain/no-props-destructure` | — |
| 6 | `<li key={x.id}>` 与 `(x, i) =>` 的 index 同时用 | 二者选一：要 key 就删掉 index 参数；要 index 就删掉 key | ✅ `PLAIN_E1005` | — |
| 7 | 就地改数据：`items().push(x)` | 生成新值：`items.set([...items(), x])` | ✅ `plain/no-signal-mutate` | 05 |
| 8 | `server()` 函数里引用**本文件的**模块变量 / import / 外层参数 | 在函数体内自己获取（`process.env.DB_URL`、`await import("./db.js")`），或作为参数传进来 | ✅ `PLAIN_E1006` | 04（间接） |
| 9 | 把 getter 存进变量：`const t = props.title`（或忘了 `resolve`；`t = props.title` 同样算） | `resolve(props.title)`；要响应式就写成 thunk | ✅ `plain/no-props-snapshot` | 06 |
| 10 | 给 `server()` 传函数 / 类实例 / Stream | 只传 JSON 可序列化的参数 | ✅ `PLAIN_E1007` | 07 |
| 11 | `effect(async () => { await … })` | 依赖收集在第一个 `await` 之后失效：把 `await` 提到 `effect` 外，或用 `resource()` | ✅ `plain/no-async-effect` | — |
| 12 | `effect(() => count.set(count() + 1))`（读了又写同一个 signal） | 派生值用 `computed(fn)`；`effect` 里只写「没读过」的 signal | ✅ `plain/no-effect-loop` | — |
| 13 | `computed(() => { s.set(…) })` | `computed` 必须是纯函数，副作用放 `effect` | ✅ `plain/no-computed-side-effect` | — |

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
> 关于第 12 条：只报**没有条件闸门**的自触发（`if (c() > 10) c.set(0)` 这种钳位会在
> 第二轮收敛，不报）；回调定义在别处（`effect(load)`）看不出是不是 async / 纯的，也不猜。
> 已知边界：表达式形式的自我收敛写法（`count.set(Math.min(count() + 1, 10))`）看不出闸门，
> 会被报成死循环 —— 确认是规则判断错了，用第 4.1 节的抑制指令，不要绕开规则。

## 4. 错误码

| 码 | 含义 | 你该做什么 |
| --- | --- | --- |
| `PLAIN_E1001` | JSX 写法编译器不认识 | 按 `hint` 改成 `return (<jsx/>)` / `.map(...)` / 三元 / `&&` |
| `PLAIN_E1002` | 产物无法解析 | 输入必须是「已剥离 TS 类型」的 JSX（走 vite 正常不会遇到） |
| `PLAIN_E1003` | 产物里残留 JSX | 编译器 bug，附最小复现提 issue |
| `PLAIN_E1004` | 遇到不支持的语法节点 | 同上 |
| `PLAIN_E1005` | 列表的 key 与 index 同时使用 | 二者选一 |
| `PLAIN_E1006` | `server()` 的函数体引用了外部变量 | 在函数体内自己获取，或改成参数传入（闭包不会跟到服务端） |
| `PLAIN_E1007` | `server()` 的调用参数无法 JSON 序列化 | 只传数据；把函数 / 校验逻辑写进 `server()` 函数体 |
| `PLAIN_E2001` | 契约检查未通过 | 跑 `npx plaindev check --fix <dir>` 自动修，再重新构建 |

错误对象带 `code` / `file` / `line` / `column` / `hint`，`JSON.stringify(error)` 可直接读，不用正则去刮 message。

### 4.1 规则判断错了怎么办（抑制指令）

契约规则是**启发式**：绝大多数时候对，少数情况下会误报（例如上面第 12 条那个
`Math.min` 钳位、或者你确实要「只取一次初值」）。这时用**行级抑制指令**，
而不是把规则关掉、也不是为了过构建而把代码写扭曲：

```js
// plain-ignore-next-line plain/no-effect-loop
effect(() => count.set(Math.min(count() + 1, 10)));

const t = props.title; // plain-ignore-line plain/no-props-snapshot
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
```

## 6. 仓库地图

| 路径 | 职责 |
| --- | --- |
| `src/runtime/` | signal / dom / async / router / error —— 运行时（**对外 API 面冻结**） |
| `src/compiler/` | TSX → 建 DOM 代码、服务端清单、契约提取、sourcemap |
| `src/vite/` | Vite 插件：契约检查 → 类型剥离 → 编译 → `server()` 剥离 → 回传 sourcemap |
| `src/lint.ts` | 契约检查与自动修复（反模式目录 1–5、7、9、11–13 的执行者） |
| `src/cli/` | `plaindev` |
| `test/` | 测试（跑的是 `dist/`，不是 `src/`） |
| `eval/` | AI 正确率评测：任务 + 验收断言 + 指标 |

## 7. 改动约束

1. **不要扩充对外 API 面**：运行时导出是冻结的，新增即 breaking change。
2. 改行为必须带测试，`pnpm run coverage` 不得低于门槛。
3. 编译产物与运行时不得出现 `innerHTML` / `eval`（有测试守着）。
4. 提交信息用 Conventional Commits，scope 用模块名（`lint` / `compiler` / `runtime` / `server` / `vite` / `cli`）。
5. 改完 `src/` 记得 `pnpm run build` —— 测试与示例用的都是 `dist/`。

## 8. 帮这个框架变好（重要）

这个框架的核心命题是「让 AI 首次写对的比例更高」。所以：

- 如果你在写 Plain 代码时**踩到了坑**，那是最有价值的信号 —— 把它补进第 3 节的反模式目录，
  或写成 `eval/tasks/` 里的一个新任务。
- 如果某个反模式你认为是错的（误报），也请提出来：反模式目录宁可少，不可误。
