# RFC：props 真 getter 与 `resolve` 的退场（已实施）

> **状态**：已实施（clean break），不再保留兼容层
> **决议**：方案 C-clean —— 动态值 prop 编译成真 `get` accessor；`on*` / 内联函数保持函数值；
> `children` 保持 lazy thunk；**删除运行时导出 `resolve`**；同一次发布同步 lint / 文档 / 示例 / eval。
> 不提供编译器双模式、deprecation 或“新旧都行”的兼容层（依据 `AGENTS.md` §7.9）。
> 变更明细见 [`CHANGELOG.md`](../../CHANGELOG.md)。
> **缘起**：AI 在多个 Plain 项目中高频犯两类错误：signal 漏写 `s()`、props 漏写 `resolve(props.x)`。
> signal 一侧已有自动修复；本 RFC 记录 props 一侧的根因、方案对比、最终决议与升级影响。
> **相关**：`AGENTS.md` §3 反模式目录 / §4 错误码、`src/compiler/index.ts`、`src/lint.ts`、
> `src/runtime/signal.ts`、`docs/patterns.md`、`eval/tasks/`
>
> 下文 §1–§3 保留讨论过程；§4.2、§5、§6.2、§7 已按最终决议改写。

---

## 1. 问题

### 1.1 两个高频错误，修复能力并不对等

| 错误 | 典型写法 | 当前处理 | 能否自动修 |
| --- | --- | --- | --- |
| signal 漏调用 | `{count}` | `PLAIN_E1102` | 能。`plaindev check` 默认 `--fix`，把 `count` 改成 `count()` |
| props 漏 `resolve` | `{props.title}` | `PLAIN_E1112` | 不能。测试明确钉住 `fix === undefined` |

需要先纠正一个常见印象：**signal 的自动修复不是编译器在构建时偷偷改源码**，而是 lint 的
autofix；vite 构建只负责拦下并提示“N 处可自动修”，不会写回文件
（见 [`src/vite/index.ts`](../../src/vite/index.ts#L136-L148)、
[`src/cli/index.ts`](../../src/cli/index.ts#L73-L99)）。

props 一侧不可自动修，测试里写死了（见
[`test/lint.test.mjs`](../../test/lint.test.mjs#L444-L479)），README 也给了原因：
“inline resolve vs thunk differ semantically”。

### 1.2 根因不是“AI 忘了”，而是 props 有四套形态

当前编译器在 `collectProps` 里对组件属性分四类处理
（[`src/compiler/index.ts`](../../src/compiler/index.ts#L1475-L1506)）：

| 属性形态 | 编译产物 | 读到的值 |
| --- | --- | --- |
| 静态字面量 `title="x"` | `title: "x"` | 普通字符串 |
| 动态表达式 `title={s()}` | `title: () => (s())` | thunk 函数 |
| 事件 `onClick={fn}` | `onClick: fn` | 原始函数 |
| 内联函数 `fallback={(e) => ...}` | `fallback: (e) => ...` | 原始函数 |

也就是说，`props.title` 有时是 `"x"`，有时是 `() => "x"`。`resolve` 的作用是
“如果是函数就调用”（[`src/runtime/signal.ts`](../../src/runtime/signal.ts#L228-L234)），
用运行时启发式把这几套形态强行抹平。根因有三层：

1. **形态不可从语法判断**：`props.x` 是普通值、getter、事件函数还是内联函数，取决于调用点怎么传；
2. **类型声明在撒谎**：组件写 `props: { title: string }`，运行时动态 prop 实际是 `() => string`，
   tsc 不会报错，AI 按类型推理必然写错；
3. **`resolve` 自身有三义性**：普通值、getter、函数值都可能是函数，`resolve` 无法区分，
   于是 `resolve(props.onClick)` 会把事件处理器当场调用（`PLAIN_E1108`）。

### 1.3 当前 `E1112` 的覆盖与盲区

规则只认“裸链”表达式（`props.x` / `props.a.b`）出现在 JSX 表达式或变量初始化里
（[`src/lint.ts`](../../src/lint.ts#L291-L352)、
[`src/lint.ts`](../../src/lint.ts#L525-L563)）：

| 写法 | 当前结果 | 实际后果 | 能否安全自动修 |
| --- | --- | --- | --- |
| `<h2>{props.title}</h2>` | `E1112` | 构建期拦下 | 能改成 `{resolve(props.title)}` |
| `value={props.title}` | `E1112` | 构建期拦下 | 同上 |
| `{props.title + "!"}` | 漏报 | 渲染函数源码 / 错误字符串，静默 | 能包住整条链 |
| ``{`${props.title}`}`` | 漏报 | 静默渲染函数源码 | 能 |
| `{props.ok ? <A/> : <B/>}` | 漏报 | getter 恒真，分支永远走错 | 能 |
| `{props.items.map(...)}` | 漏报 | 运行时报 `TypeError` | 能包住 `props.items` |
| `const t = props.title` | `E1112` | 快照，第二次更新不刷新 | 不能局部替换 |
| `const t = resolve(props.title)` | `E1112` | 组件体里仍是快照；**写在 effect 里其实正确** | 不能局部替换 |
| `props.onClick(...)` / `props.children()` | 不报（合法） | — | 不应包 `resolve` |

两个实现层事实：

- **声明分支没有 effect 上下文豁免**，而赋值分支有 `isDirectlyInComponentBody`
  （[`src/lint.ts`](../../src/lint.ts#L298-L332)）。因此
  `effect(() => { const t = resolve(props.title); ... })` 这种正确写法会被误报。
- **vite 在编译前会剥掉 TS 类型**，编译器看不到 props 的类型注解，无法在 codegen 阶段
  按类型决定“这里要包 resolve”。能做类型判断的只有跑在剥离之前的 lint。

---

## 2. 设计目标与非目标

### 目标

- 普通值 prop 的读取回归“读一次就是值”，不再需要 `resolve`；
- 类型声明与运行时一致，让 AI 的 React/JS 先验可以直接复用；
- 保持现有响应式语义：JSX / effect 里的读取仍然订阅，组件体里的读取仍然是快照；
- 不引入运行时 Proxy、不引入“函数是不是 getter”的猜测。

### 非目标

- 不通过 Proxy / 编译器插 `resolve` / 运行时启发式来“自动解包”；
- 不试图消除“把 props 存进变量”的快照问题——那是 JS 值捕获语义，不是 props 读取语义；
- 不在本次一并重设计 children 的渲染模型（除非另立 RFC）。

---

## 3. 候选方案

### 方案 A：现状 + 文档与检查（补丁式）

保持 thunk + `resolve`，只做三件事：

1. 扩 lint 检测到“任意 props 链出现在值位置”，补上除法链以外的盲区；
2. 给“值位置直接读”加 autofix，变量快照仍不修；
3. 把文档里 `const t = props.title` → `resolve(props.title)` 的歧义改掉，
   让 AI 每次改完跑 `plaindev check --fix`。

优点：改动最小、风险最低。  
缺点：`resolve` 这个额外概念还在，类型仍然撒谎，AI 仍然要记“props 要 resolve”，
只是多了一层 lint 兜底。属于缓解，不是根治。

### 方案 B：编译器在 codegen 里自动插 `resolve`

在生成 JSX 读取时，把 `{props.title}` 自动改写成 `{resolve(props.title)}`。

不推荐，理由：

- 源码和产物分叉，debug / sourcemap / 阅读编译产物更困难；
- 只是把“漏写”变成“自动补”，没有消除 `resolve` 的心智负担；
- 仍然无法区分函数型 prop，`resolve(props.render)` 依旧会误调用；
- 类型声明仍然是假的。

### 方案 C：真 getter（推荐，bounded 版本）

编译器把动态值 prop 生成为标准 JS accessor 属性：

```js
// 源码
function Card(props) {
  return <h2>{props.title}</h2>;
}

// 编译产物（示意）
const __p = {
  get title() { return (titleSignal()); },
  onClick: handler,
  children: () => { /* ... */ },
};
Card(__p);
```

规则：

| prop 类别 | 编译产物 | 读取结果 |
| --- | --- | --- |
| 静态字面量 | 数据属性 | 值 |
| 动态普通值 | `get key() { return (expr); }` | 值 |
| `on*` 事件 | 原始函数 | 函数 |
| 内联函数 | 原始函数 | 函数 |
| `children` | **保留 lazy thunk**（推荐） | 调用后得到 Fragment |

为什么不是“打补丁”：

- 它是编译期静态 lowering，props 对象变成普通 JS accessor，没有运行时 Proxy；
- 不再需要“这个函数是不是 getter”的猜测，`resolve` 的三义性对普通值消失；
- 类型终于和运行时一致，不需要再引入 `Props<P>` 类型工具；
- 读点是普通属性读取，符合 React/JS 先验，AI 不需要额外记 `resolve`。

必须诚实的一点：**源码层的 `props.x` 和 Solid 的 props getter 观察行为一样**，
都是“读属性直接得到值”。区别在实现：Plain 是编译期生成标准 accessor，
Solid 是运行时 Proxy 拦截。如果目标是“每一次响应式读取都必须在源码里显式可见”，
方案 C 不满足；那种目标只能走方案 D。

### 方案 D：统一显式 thunk `props.x()`

所有普通值 prop 保持 thunk，但去掉 `resolve`，统一写成 `props.title()`；
编译器像 `E1102` 一样自动补 `()`。

优点：

- 读点显式，AI 能看出“这是一次响应式读取”；
- 类型可以是 `() => T`，也诚实；
- 可以复用 signal 的自动修复机制。

缺点：

- 把“忘写 `()`”这个高频错误搬到 props 上；
- 函数型 prop / children 仍要特殊处理（`props.render(x)` vs `props.title()`）；
- 比属性读取更啰嗦，和 React/JS 先验不一致。

### 方案 E：Proxy 自动解包

运行时用 Proxy 拦截 `props` 的 `get`，自动调用 thunk。

不推荐：

- 运行时魔法，未知 key、spread、函数 prop 都要特殊处理；
- “props 里缺了什么”更难发现；
- 读一次多少开销不透明；
- 正是本 RFC 想避免的“掩盖问题”。

### 方案 F：类型层 `Props<P>`（可作为独立中间方案）

在不改运行时的情况下，让 props 类型显式包含 getter：

```ts
type MaybeGetter<T> = T | (() => T);
type Props<P> = {
  [K in keyof P]: P[K] extends (...args: any[]) => any ? P[K] : MaybeGetter<P[K]>;
};
```

组件写 `props: Props<CardProps>`，`props.title` 的类型变成 `string | (() => string)`，
直接当 `string` 用会被 tsc 报错。

优点：不动运行时，能让 `tsc` 提前发现错误。  
缺点：Plain 构建用 esbuild 剥类型、不跑 tsc，需要额外的 `tsc --noEmit` 闸门；
而且这只是把 `resolve` 的必要性写进类型，没有消除 `resolve` 概念。
如果采用方案 C，方案 F 就不需要了。

### 方案对比

| 方案 | 源码读法 | 运行时 | 类型真实度 | AI 额外规则 | 结论 |
| --- | --- | --- | --- | --- | --- |
| A 现状 + 检查 | `resolve(props.x)` | thunk + 启发式 | 假 | 要记 resolve | 缓解 |
| B 编译器插 resolve | `props.x` | thunk + 自动补 | 假 | 无，但产物分叉 | 拒绝 |
| C 真 getter | `props.x` | 标准 accessor | 真 | 无 | **推荐** |
| D 统一 thunk | `props.x()` | thunk | 真 | 要记 `()` | 备选 |
| E Proxy | `props.x` | Proxy 拦截 | 真 | 无，但运行时魔法 | 拒绝 |
| F 类型 `Props<P>` | `resolve(props.x)` | thunk | 类型层真 | 要记 resolve | 可独立采用 |

---

## 4. 方案 C 的语义边界

### 4.1 响应式仍然成立

JSX 插值、属性绑定、条件、列表都通过 effect 读取表达式
（例如 [`src/runtime/dom.ts`](../../src/runtime/dom.ts#L349-L376) 的 `insert`）。
把 thunk 换成 getter 后，读取发生在同一个 effect 内，signal 订阅关系不变：

```js
// 属性绑定
__effect(() => { el.textContent = __stringify(props.title); });

// 普通值 prop 直接读
__effect(() => { el.textContent = __stringify((props.title)); });
```

两者都在 effect 内读 getter，都会订阅。组件体里的读取仍然是快照，
这一点和现在 `resolve(props.title)` 在组件体里一样，不是回归。

### 4.2 `resolve` 删除，clean break

最终决议不是“保留 resolve 作为 MaybeGetter helper”，而是**删除运行时导出 `resolve`**：

- `props.x` 直接是值；再包一层 `resolve` 没有语义，只会让 AI 看到第二条“官方读法”；
- `resolve(props.render)` 会把函数 prop 当场调用，保留它就是保留一个主动陷阱；
- `Link.to` 收紧为 `string`，`Provider value` 直接读 `props.value` —— 不再有内部 MaybeGetter 读法；
- `PLAIN_E1108` 随 `resolve` 一起删除；`props.onClick` 直接调用。

迁移只走 codemod / 构建期报错，不做“旧写法也能用”的承诺。

### 4.3 函数型 prop 是唯一真正的语义地雷

`resolve` 的实现是“函数就调用”。在方案 C 下：

| 写法 | 现在 | 方案 C 后 |
| --- | --- | --- |
| `fallback={(e) => ...}` + `resolve(props.fallback)` | 内联函数原样，`resolve` 已会调用 | 不变，仍然错 |
| `render={handler}` + `resolve(props.render)` | 标识符被包成 thunk，`resolve` 只解一层，返回函数 | getter 直接返回函数，`resolve` 会把 handler 调用掉 |

也就是说，**“靠标识符传函数 prop，再用 resolve 解一层”的写法会 break**。
需要在迁移时加类型感知的 lint/codemod：声明类型是函数签名时，`resolve(props.fn)` 去掉 `resolve`。
不能试图让 `resolve` 自己变聪明——它无法区分“函数值”和“thunk”，
而 `resolve(() => 7)` 的现有行为是被测试钉住的。

### 4.4 children：不要直接翻转成普通 getter

`children` 当前编译成“构建 DocumentFragment 的函数”
（[`src/compiler/index.ts`](../../src/compiler/index.ts#L1532-L1534)），
里面可能包含动态子节点和 effect。如果变成普通 getter：

- 每读一次就重建一棵子树；
- `props.children ? ... : ...` 会先构建一次、丢弃，再构建一次真正挂载；
- 被丢弃的子树里的 effect 仍然注册、订阅，造成无效工作和额外清理。

三个选择：

1. **保留 `children` 为显式 lazy thunk（推荐）**  
   类型写明 `children?: () => Renderable`。运行时组件
   [`router.ts`](../../src/runtime/router.ts#L112)、
   [`error.ts`](../../src/runtime/error.ts#L37-L39)、
   [`context.ts`](../../src/runtime/context.ts#L45) 和 examples 完全不用改。  
   这不是打补丁，而是明确承认：**值 prop 是 live value，children 是 lazy render subtree**。
2. **children 也翻转成 getter**  
   需要全量 codemod + “只读一次”约定，升级面显著扩大，并引入重复构建这个新坑。
3. **引入 Slot 抽象**  
   `props.children` 返回 lazy slot，由 `insert` 消费。最干净，但属于另一个 RFC，
   不适合和 getter 升级一起做。

### 4.5 快照和解构不会消失

getter 只保证“读一次拿到值”，不会让普通变量自动更新：

- `const t = props.title` 仍是快照；
- `const { title } = props` 仍是快照；
- 它们必须继续由 `PLAIN_E1112`（变量形态）和 `PLAIN_E1105` 拦截。

升级后，这类“React 肌肉记忆”很可能成为新的高频错误，文档和 lint 不能放松。

---

## 5. 升级影响

### 5.1 存量写法迁移矩阵（clean break）

最终决议不保留 `resolve`，所以下表按「必须迁移」口径给出：

| 存量写法 | 方案 C-clean 后 | 是否要改 | 说明 |
| --- | --- | --- | --- |
| `{props.title}` / `title={props.title}` | 正确 | 不用改 | 原来被 `E1112` 拦，升级后直接工作 |
| `resolve(props.title)` | **运行时不再有 `resolve`** | 必须改 | codemod 去掉 `resolve(...)`，直接 `props.title` |
| `String(resolve(props.title))` | 同上 | 必须改 | 改成 `String(props.title)` |
| `const t = resolve(props.title)` 写在 effect 里 | 同上 | 必须改 | 改成 `const t = props.title`（effect 内会订阅） |
| `const t = props.title` / `const {title}=props` | 仍是快照 | 必须改 | getter 不会让变量自动更新 |
| `props.children()` | children 保持 thunk | 不用改 | 语义上是 lazy subtree，不是兼容 |
| `props.value()`（把值 prop 当函数调） | 报错 | 必须改 | 现在读出来就是值 |
| `props.onClick(...)` | 不变 | 不用改 | `on*` 仍是原始函数 |
| `resolve(props.onClick)` | `resolve` 不存在 | 必须改 | 直接 `props.onClick(...)` |
| `render={handler}` + `resolve(props.render)` | `resolve` 不存在 | 必须改 | 直接 `props.render(x)` |
| 手动调用组件传 `{ title: () => "x" }` | 需要传值 | 必须改 | 编译产物传的是值 |
| `Object.keys(props)` / `{...props}` | 得到值而非函数 | 审计 | 原来枚举到 thunk |
| SSR / hydrate / HMR | 同一套编译器 | 不用改 | 服务端和客户端都生成同样 getter |
| props 类型声明 | 终于说真话 | 不用改 | 不需要 `Props<P>` |

### 5.2 仓库内规模

决策前的粗略统计（已完成迁移）：

- `resolve(props.)` 约 70 处，分布在 24 个文件；其中文档（`AGENTS.md`、`README.md`、
  `docs/patterns.md`、`docs/from-other-frameworks.md` 等）占大头；
- `props.children` 约 17 处，分布在 10 个文件；运行时组件与 examples 占 8 处左右。

结论：

- **业务代码的机械迁移量不大**（主要是去掉 `resolve` 包裹），但因为是 clean break，
  必须一次性跑完 codemod；
- **真正的成本在文档/AI 上下文、lint 规则、eval 断言**；
- `children` 不翻转，所以运行时组件和 examples 不需要重写。

### 5.3 四块影响

1. **业务代码**：低到中等。绝大多数值 prop 写法不变；边缘是 `props.value()`、
   函数型 prop + `resolve`、手动组件调用、props 枚举/展开。
2. **运行时组件**：如果 children 保持 thunk，`router.ts` / `error.ts` / `context.ts` 零改动。
3. **编译器与 lint**：改动集中但必须同步；lint 若不同步，会把正确代码继续报错。
4. **文档与 eval**：工作量最大；不改的话 AI 会继续按旧叙事写 `resolve`，
   虽然多数能跑，但会在函数型 prop 上踩雷。

### 5.4 SSR / hydrate / HMR

- SSR 与 hydrate 都跑同一份编译产物（`hydrate.ts` 用认领式 document 重跑组件），
  props getter 会在两端以同样方式生成，不存在“服务端是值、客户端是 thunk”的分叉；
- HMR 重新执行组件函数，会重新创建 props 对象，getter 自然更新；
- 需要补的测试：服务端渲染、客户端注水、父 signal 更新穿透、prop 转发、函数型 prop、children。

---

## 6. 必须同一版本一起改的四件事

### 6.1 编译器

- `collectProps`：动态、非 `on*`、非内联函数的属性改为 `get key() { return (expr); }`；
- 静态字面量仍用数据属性；
- `on*` 与内联函数保持原始函数；
- `children` 继续 `children: () => { ... }`；
- 注意属性名合法性：含 `-` 等非标识符的属性名要用带引号的 getter 写法
  （`get "data-x"() {}`），不能直接拼 `${key}:`。

### 6.2 lint

- 删除 `PLAIN_E1112` 的 JSX 分支（否则 `{props.title}` 会被误报）；
- 保留变量声明 / 赋值 / 解构的“快照”检测；声明形态只报组件渲染作用域，
  effect / 事件回调里的读取不报（回调重跑会重新求值）；
- 删除 `PLAIN_E1108`（`resolve` 已不存在）；
- 更新错误文案与 `src/errors.ts` 中的说明。

### 6.3 文档与 AI 上下文

- `AGENTS.md` 第 3 节反模式 #5 / #9：删除“动态 props 一律 `resolve`”的叙事，
  改成“props 是 live read；在 JSX/effect 里直接读，不要存变量；解构仍是快照”；
- `README.md` / `README_CN.md` / `docs/patterns.md` / `docs/from-other-frameworks.md`：
  同步改写所有 `resolve(props.x)` 示例；
- 删除 `resolve` 的公开叙事，不再把它定义为“MaybeGetter / 兼容 helper”；
- `eval/tasks/06-props-snapshot` 的断言前提改为考“不能快照”；
- examples 注释里“props 动态值统一用 resolve 取”要改。

### 6.4 测试与版本

- 编译器输出快照：`children: () =>`、动态 prop 的 `get`；
- 运行时组件测试：如果 children 翻转，手动传入的 `children: () => ...` 要改成值；
- lint 测试：删除 JSX `E1112` 用例，保留快照/解构用例；
- 新增回归：父 signal 更新后子组件直接读 `props.x` 能更新；prop 转发；函数型 prop；
  SSR + hydrate；HMR。
- 版本：已在 `0.4.0` 落地（clean break：删除 `resolve` 与 `MaybeGetter`，不保留双模式）；
- **不要做编译器双模式**（thunk/getter 开关）。两套约定并存正是 AI 最容易混的地方。

---

## 7. 迁移步骤

1. 编译器与 lint 同版本发布；
2. codemod（例如 `plaindev migrate props-getters`）：
   - `props.value()` → `props.value`（仅限确定是值 prop 的场景）；
   - `resolve(props.x)` → `props.x`（值 prop）；`resolve(props.fn)` → `props.fn`（函数 prop）；
   - children 不翻转，`props.children()` 保持不变；
3. 升级后先跑 `tsc --noEmit` / `plaindev check` / 测试；
4. 重点排查：
   - 手动调用组件时传入 thunk props 的地方；
   - `Object.keys(props)`、`{...props}`、把 props 当普通对象传递的地方；
   - 残留的 `resolve` 导入（会直接报“模块没有导出 resolve”）；
5. 更新项目内的 AI 上下文 / 模板 / 脚手架，避免新代码继续按旧叙事写。

**如果 children 保持 thunk，运行时组件与 examples 不需要改动，迁移主要集中在编译器、
lint、文档和少量边缘代码。**

---

## 8. 风险与未决问题

1. **可观察行为与 Solid 类似**  
   真 getter 与 Solid 的 props getter 在源码层都是“读属性得到值”。区别是实现层。
   如果团队要求“每次响应式读取必须显式可见”，应改选方案 D，而不是 C。

2. **children 的归属**  
   保留 thunk 会留下一个显式特例；翻转 getter 会扩大升级面并引入重复构建。
   建议本次保留 thunk，Slot 抽象另立 RFC。

3. **`resolve` 的去留**  
   不能直接删除：`Link.to` 等 MaybeGetter 仍需要它，且存量代码大量使用。
   建议保留导出、缩小语义、文档降级；是否最终移除留到后续 major。

4. **快照错误会浮上来**  
   升级后 `const t = props.title`、`const {title}=props` 仍是错误，
   而且可能成为新的高频错误。`E1112` 快照规则与 `E1105` 必须保留。

5. **函数型 prop 的兼容**  
   “标识符传函数 + `resolve` 解一层”的写法会 break；需要类型感知的 lint/codemod。
   不做的话，这是升级中最容易被忽略的静默风险。

6. **是否加 dev 运行时兜底**  
   可选：给编译期生成的 getter/thunk 在 dev 下挂一个会抛错的 `toString` /
   `Symbol.toPrimitive`，让“把 props 直接拼字符串”从静默变成显式报错。
   它覆盖不了算术 / 条件判断，且会增加运行时复杂度，建议作为独立议题。

7. **性能**  
   accessor 读取与 thunk 调用开销接近；真正的风险在 children 若翻转成 getter 后的重复构建。
   保留 children thunk 可以规避。

---

## 9. 结论

- **支持方案 C 的 bounded 版本**：普通值 prop 编译成真 getter，`children` 保留 lazy thunk；
- **不做** Proxy 自动解包、编译器自动插 `resolve`——这两者才是补丁和掩盖；
- **必须同步**编译器、lint、文档、eval、测试与版本；否则 AI 会收到互相矛盾的信号；
- **不要期待 getter 消灭所有 props 错误**：快照/解构仍然存在，lint 与文档要继续守；
- 升级后的主要收益是：`props.x` 回归普通 JS 属性读取，类型和运行时一致，
  AI 不再需要记 `resolve` 这个额外概念；这比在旧约定上继续加自动修复更根治。

---

## 附录：关键代码位置

| 位置 | 作用 |
| --- | --- |
| [`src/compiler/index.ts`](../../src/compiler/index.ts#L1475-L1506) | `collectProps`：四类 prop 形态 |
| [`src/compiler/index.ts`](../../src/compiler/index.ts#L1532-L1534) | `children` 编译为 lazy thunk |
| [`src/runtime/signal.ts`](../../src/runtime/signal.ts#L228-L234) | `resolve`：函数就调用 |
| [`src/runtime/dom.ts`](../../src/runtime/dom.ts#L349-L376) | `insert`：在 effect 内读取表达式 |
| [`src/lint.ts`](../../src/lint.ts#L291-L352) | `E1112` 变量/赋值/JSX 检测 |
| [`test/lint.test.mjs`](../../test/lint.test.mjs#L444-L479) | 钉住 `E1112` 不可自动修 |
| [`src/runtime/router.ts`](../../src/runtime/router.ts#L105-L112) | `Link` 的 MaybeGetter `to` 与 children thunk |
| [`src/runtime/error.ts`](../../src/runtime/error.ts#L37-L39) | ErrorBoundary 的 children thunk |
| [`src/runtime/context.ts`](../../src/runtime/context.ts#L35-L45) | Context value 的 getter 化与 children |
