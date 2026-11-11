# 0.4 之后的心智负担与改进影响评估

> 状态：**分析文档**（不含实现）。
> 基线：`0.4.0` —— props 已改为真 getter，`resolve` 已删除。
> 更新：`0.5.0` 已落地 R1（`PLAIN_E1202`）、R2（`PLAIN_E1203`）与 R3（文档修正）；
> `0.6.0` 修复了外部审查中复现的 8 类缺陷（server 别名剥离、响应式中间态、effect 作用域逃逸、
> refetch 竞态、批量 RPC 路由/重放、SSR query/缓存、模板 `$&`、诊断提示不可编译）。
> R4 / R5 按本文评估不做。下文保留当时的分析与影响评估，命中规则以当前实现为准。
> 关联：[`AGENTS.md`](../AGENTS.md) §3、[`props-live-getters.md`](rfcs/props-live-getters.md)、
> [`migrate-0.3-to-0.4.md`](migrate-0.3-to-0.4.md)。

## 1. 结论摘要

- `resolve` 消除的是**语法负担**：读错会立刻看到函数源码或类型报错。
- 剩下的负担主要变成**语义负担**：代码看起来完全正常，但不会更新。
- 最大的静默错误源是「**组件体只执行一次**」，而不是 `children`、`ref` 或 `server()`。
- 0.5.0 已补一条「组件体内派生值 / 快照」的 lint（`PLAIN_E1202`），把算术、模板串、`.map()`、
  条件表达式都覆盖进来。
- 对已有项目：**运行时零影响**，因为不改编译器与运行时；影响只发生在跑
  `plaindev check` 的 CI 上——新增诊断、按命中数决定修复成本。
- 不建议自动化「SSR 模块作用域 signal」检查：合法的全局 UI 状态（主题、Toast 队列）
  与请求级数据在静态上无法区分，误报率会很高。

## 2. 负担清单

| # | 心智负担 | 写错的后果 | 工具是否拦住 | 层级 |
| --- | --- | --- | --- | --- |
| 1 | **组件体只执行一次**：派生值 / 提前 `return` / 条件分支写在函数体里 | 永久不更新，且不报错 | `E1112`（直接链）/ `E1202`（复合表达式、体内 `.map()`）；`helper(props)` 仍不拦 | 静默语义 |
| 2 | **读取位置决定订阅**：只有 JSX `{expr}` / `effect` / `computed` 里的读才订阅 | 静默不更新 | 部分（同上） | 静默语义 |
| 3 | **读取约定不一致**：`s()` / `props.x` / `props.children()` / `useContext(Ctx)()` | 漏 `()` 渲染函数源码或拿到函数 | `E1102` 只修 signal；`children` 漏 `()` 基本不拦 | 静默语义 |
| 4 | **值 vs 函数**：`{props.render}` 当值插值 | 渲染函数源码 | `E1203`（直接 props 链；`String(...)` 等间接形态不拦） | 静默语义 |
| 5 | effect 自动依赖的边界：条件读、`await` 后失效、自触发 | 漏订阅 / 死循环 | `E1109` / `E1110` / `E1111`；条件读不拦 | 响应式边界 |
| 6 | 不可变更新：`items().push(x)` | 不更新 | `E1106` | 响应式边界 |
| 7 | 无属性展开 `{...props}` | 编译期报错 | `E1008` | 可恢复 |
| 8 | JSX 语法边界：无 `\|\|` / `??` / IIFE / 数组字面量 / 链式 `.map().filter()` | 编译期报错 | `E1001`，带改法 | 可恢复 |
| 9 | 列表 key 与 index 二选一 | 编译期报错 | `E1005` | 可恢复 |
| 10 | `server()` 边界：不能闭包外部变量、参数可序列化、函数名全应用唯一 | 构建期报错 | `E1006` / `E1007` + 清单冲突 | 平台边界 |
| 11 | **SSR 请求级数据不能放模块作用域 signal** | A 请求数据渲染进 B 请求 | ❌ 无检查，只有文档约定 | 平台边界 |
| 12 | `ref` 只能放内建元素、只能回调、不能 async | 编译期报错 | `E1009`–`E1011` | 可恢复 |
| 13 | 内建属性是封闭枚举，冷门属性要改类型表 | 类型报错 | `tsc` | 可恢复 |

第 7–10、12–13 条是**构建期或类型期**报错：虽然要记，但错了能立刻纠正，属于可恢复负担。
真正贵的是第 1–4 条：**静默错误**，也是 AI 最容易反复犯的。

## 3. 静默语义负担（重点）

### 3.1 组件体只执行一次

组件函数只执行一次，函数体里的任何控制流都只在挂载时求值：

```tsx
function App(props) {
  const full = props.first + props.last;           // ❌ 静态字符串
  const rows = props.items.map(x => <li>{x}</li>); // ❌ 静态列表
  if (!props.user) return <Login />;               // ❌ 永远不会切到 Login
  return <h2>{full}</h2>;
}
```

三处都「看起来对」，但都不响应。正确写法是把读与派生放进 JSX / `computed`：

```tsx
function App(props) {
  const full = computed(() => props.first + props.last);
  return <h2>{full()}</h2>;
}
```

0.4.0 的 lint 只识别**初始化器本身就是 `props.x` 链**的情况
（[`lint.ts`](../src/lint.ts#L510-L512)）；0.5.0 起扩展为：

| 写法 | 是否报错（0.5.0） |
| --- | --- |
| `const t = props.title` | ✅ `E1112` |
| `const t = props.title + "!"` | ✅ `E1202` |
| ``const t = `${props.title}` `` | ✅ `E1202` |
| `const t = label(props.title)` | ✅ `E1202` |
| `const rows = items().map(...)` | ✅ `E1202`（signal 读取） |

这是 `resolve` 解决之后**已补上的一条规则**（`PLAIN_E1202`）：组件体内任何含有 props / signal
读取的变量初始化，只要不是 thunk / `computed` / `signal` 种子，就报快照。它覆盖算术、模板串、
`.map()`、条件表达式；`helper(props)` 这种整个对象逃逸的形态仍不拦。

### 3.2 读取位置决定订阅

同一条表达式，写在不同位置，语义完全不同：

```tsx
// ✅ JSX 里读：每次依赖变化重新求值
<h2>{props.title}</h2>

// ✅ effect 里读：effect 重跑
effect(() => { document.title = props.title; });

// ✅ computed 里读：派生值自动更新
const t = computed(() => props.title);

// ❌ 组件体里读：挂载时取一次
const t = props.title;
```

规则本身只有一句「读必须在追踪上下文里」，但判断「哪里算追踪上下文」需要理解运行时模型。
lint 能覆盖直接形态，覆盖不了 `helper(props)`（已知盲区，见
[`patterns.md`](patterns.md#L269)）、局部 `.map()`、闭包。

### 3.3 读取约定的 `()` 不一致

现在读值有四种写法：

- `count()` —— signal
- `props.title` —— 值 prop，**不用 `()`**
- `props.children()` —— lazy subtree，**必须 `()`**
- `useContext(Ctx)()` —— context，**必须 `()`**

`resolve` 时代至少有一条「值都要 `resolve`」的统一规则；现在「要不要 `()`」取决于**值的来源**。
这比 `resolve` 轻——不需要额外函数包裹——但仍是记忆点，且 `children` 的漏调用没有专门检查。

### 3.4 值 vs 函数

`props.render` 与 `props.title` 在源码上长得一样，但一个是函数、一个是值：

```tsx
<div>{props.render}</div>   // ❌ 渲染函数源码
<div>{props.render(x)}</div> // ✅
```

在 getter 模型下这是必然结果：编译器不需要知道类型，使用处必须知道。0.5.0 的 `E1203`
只拦「直接 props 链」的插值；`String(props.format)` 这类间接形态仍不报。

### 3.5 响应式边界

- 条件读：`effect(() => { if (flag()) return; x(); })` —— `x()` 在 `flag()` 为假的轮次不订阅；
- `await` 之后读取失效（`E1109` 拦 `effect(async …)`，但拦不住间接 async）；
- `effect` 读写了同一个 signal 会自触发（`E1110`，钳位写法需抑制）；
- `computed` 必须是纯函数（`E1111`）。

这些是细粒度响应式固有的，不随 props 模型改变。

## 4. 可恢复负担

- **无属性展开**：包装组件不能 `{...rest}`，必须逐个展开（`E1008`）。
- **JSX 语法边界**：`||` / `??` / IIFE / 数组字面量 / 链式 `.filter().map()` 都不行（`E1001`）。
- **列表 key 与 index 二选一**（`E1005`）。
- **内建属性是普通值**：不能传 getter / 函数；`class` / `for` 优先于 `className` / `htmlFor`。
- **`ref` 规则**：只能放内建元素、只能回调、不能 async、组件体执行时节点还不存在。

这些都会在编译期或类型期失败，并带改法提示，属于「记一次就好」的负担。

## 5. 平台边界负担

- **`server()` 隔离**：不能闭包本文件的模块变量 / import / 外层参数；参数必须 JSON 可序列化；
  函数名全应用唯一。概念上像 RPC，但「为什么不能直接 import db」仍是高频困惑点。
- **SSR 请求隔离**：请求级数据不能放模块作用域 signal —— 模块作用域在同进程内共享，
  会把 A 请求的数据渲染进 B 请求的响应。
- **hydration**：服务端与客户端首屏必须一致；effect 在 SSR 期间不执行；`ref` 在注水后执行一次。

第 11 条是唯一「错了不报、影响最大」的结构性负担。

## 6. 文档与实现不一致（本次发现）

[`from-other-frameworks.md`](from-other-frameworks.md#L72) 写：

> 组件体里读 `props.x` 会订阅，读出来就是当前值。

后半句对，前半句不对。组件通过 [`mount`](../src/runtime/dom.ts#L68-L76) 的 `withOwner`
调用，只有 owner，没有 active effect；props getter 内部的 signal 读取不会建立订阅。
**组件体里读 `props.x` 是快照**，这正是 `E1112` 存在的原因。

这句话会直接教出错误的模型；它是 React 开发者和 AI 的入口文档，错误模型的代价比缺一条 lint 更大。
**建议修正为**：只有 JSX `{expr}` / `effect` / `computed` 里的读才订阅，组件体里的读是一次性取值。

## 7. 建议调整与存量项目影响评估

| 建议 | 代码改动 | 运行时行为 | CI 影响 | 误报风险 | 建议发布 |
| --- | --- | --- | --- | --- | --- |
| R1：补「组件体派生值」lint | 无 | 无 | 新增诊断 | 中（一次取值场景） | `0.5.0`（已落地） |
| R2：拦 `{props.children}` / 函数值插值 | 无 | 无 | 新增诊断 | 低 | `0.5.0`（已落地） |
| R3：修正文档订阅描述 | 无 | 无 | 无 | 无 | `0.5.0`（已落地） |
| R4：SSR 模块 signal 自动检查 | 无 | 无 | 可能大量误报 | **高** | 不建议 |
| R5：统一 `()` 读法 | 会破坏 `children` 惰性 | 有 | — | — | 不建议 |

下面逐条展开。

### R1：组件体派生值 lint

**规则范围**（建议）：

- 只检查组件渲染作用域内的变量声明 / 赋值；
- 初始化器里含有 props 读取或 signal 调用；
- 排除：箭头函数 / 函数表达式（thunk、回调）、`computed(...)`、`signal(...)`（作为初始值种子）、
  `effect(...)` 等追踪上下文内的声明。

**对存量项目的影响：**

1. **运行时零影响**：不改编译器与运行时，产物完全一致。
2. **只影响 `plaindev check`**：如果 CI 里跑 check，会新增失败；不跑 check 的项目无感。
3. **增量范围有限**：`const t = props.x` 这类**直接链**今天已经报 `E1112`，
   项目早已处理；R1 新增的是**复合表达式**：
   - `const full = props.first + props.last`
   - ``const label = `${props.name}（${props.id}）` ``
   - `const rows = items().map(...)`
   - `const visible = props.items.filter(...)`
4. **典型真实命中**：AI 生成的项目里 `const rows = items().map(...)` 这种「在体内先算列表再插值」
   很常见，且确实是静态列表——升级后会暴露一批**潜在 bug**，这是收益，也是工作量。
5. **典型误报**：
   - 有意只取初始值：`const initial = props.value; const s = signal(initial);`
     （直接链今天已报，项目已有抑制；复合形式会新增）；
   - 只用于挂载期的一次性计算，如 `const id = `c${props.id}`` 后立刻写进 DOM 属性；
   - 函数型 prop 的复合取值，如 `const cb = props.onSave ?? noop`。
   这些用行级 `plain-ignore` 抑制即可，抑制在 check 输出里是可见的。
6. **修复成本**：每条命中要么挪进 JSX / `computed`，要么抑制；不涉及 API 改名、不改类型、
   不改构建。按经验，一个中型项目通常是**个位数到几十处**，具体取决于 AI 生成代码的比例。

**版本建议**：如果直接设为 error，建议 `0.5.0`（工具链行为变更，可能让 CI 变红）；
设为 warning 可以放 `0.4.x`，但 warning 更容易被 AI 与开发者忽略，与「一次写对」的目标相悖。

### R2：拦 `{props.children}` / 函数值插值

**规则范围**：JSX 插值表达式的**直接值**是 `props.children`，或名字明显是函数型 prop
（`on*` / `render*` / `*Fn`）却没有调用。`{props.children && <Footer/>}` 这类控制流不算。

**对存量项目的影响：**

- 运行时零影响；
- 误报极低：把函数直接插进视图几乎总是错误；
- 命中数通常很少（AI 更常犯的是漏 `()` 的 signal，那已有 `E1102`）；
- 可以直接 error 级发布，不构成迁移负担。

### R3：修正文档

零代码影响。建议单独 `0.4.1` 发布，避免和 lint 变更混在一起。

### R4：SSR 模块 signal 自动检查

**不建议做**，原因：

- 模块作用域 signal 既可能是请求级数据（错误），也可能是合法的全局 UI 状态
  （主题、Toast 队列、登录态缓存）；
- 静态上无法区分「这个 signal 会不会被请求数据写入」；
- 误报会让项目大面积抑制，反而降低检查的可信度。

更合适的做法：在 `docs/patterns.md` 给出「请求级数据用 Context / props」的唯一推荐写法，
并在 SSR 模板里提供一个正确的请求作用域示例。

### R5：统一读取 `()`

不建议。`children` 的 `()` 来自 lazy subtree 语义，不是历史包袱；把它变成 getter 会改变
求值时机。统一读法需要重做 Slot 模型，属于独立 RFC，不应借这次 lint 改进夹带。

## 8. 如何在现有项目上量化影响

升级前先在一个分支上做一次「只检查、不修」的扫描：

```bash
# 1. 升到包含新规则的版本后
npx plaindev check src --no-fix

# 2. 粗看「组件体内先算再插值」的候选
rg -n 'const\s+\w+\s*=\s*[^;]*props\.' --glob '*.tsx'
rg -n 'const\s+\w+\s*=\s*\w+\(\)\.(map|filter|slice|sort)' --glob '*.tsx'

# 3. 粗看函数值直接插值
rg -n '\{\s*props\.children\s*\}' --glob '*.tsx'
rg -n '\{\s*props\.(render|format|on[A-Z]\w*)\s*\}' --glob '*.tsx'
```

建议记录三个数：新增诊断数、其中真实 bug 数、需要抑制数。三者比例决定是否值得全量推。

## 9. 落地结果

1. **`0.5.0`**：R1（`PLAIN_E1202`）+ R2（`PLAIN_E1203`），error 级，带行级抑制；
   同步更新 `AGENTS.md` 反模式表、`docs/patterns.md`、README 错误码表与 CHANGELOG，
   并注明「仅工具链，无运行时变更」。
2. **`0.5.0`**：修正 [`from-other-frameworks.md`](from-other-frameworks.md#L72) 的订阅描述
   （原计划单独发 `0.4.1`，与本次一同发布）。
3. **不做 R4 / R5**：SSR 用文档与模板约束，读取约定保持现状。
4. 不给 R1 做自动修复：复合表达式的正确改法取决于意图（挪进 JSX、`computed`、还是一次取值），
   自动改写会制造新的错误。

## 10. 反向意见与风险

- R1 会让「有意只取一次」的代码变吵。这是可接受的：抑制是显式的、可见的，
  比静默不更新便宜。
- R1 无法覆盖 `helper(props)` 与跨函数逃逸，因此不能宣称「快照问题已被消灭」；
  它只是把最常见的形态从静默变成报错。
- 如果某项目大量依赖「挂载时算一次」的静态视图，R1 的修复成本会高于平均值；
  这种情况应先确认那些视图是否本来就该静态。
- 所有建议都不改变「组件体只执行一次」这个根本模型；负担不会归零，目标是让错误**尽早可见**。
