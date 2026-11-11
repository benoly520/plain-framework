# Plain 内核：设计与实现的完整说明

> 目的：**理解这个框架的核心**只需要读这一篇。它记录「当初为什么这么设计」以及「现在到底是怎么实现的」，
> 避免时间久了要靠重新推导源码来回忆。
>
> 与其它文档的分工：
> - [`README.md`](../README.md) / [`README_CN.md`](../README_CN.md)：怎么用（API 全表、错误码、SSR 用法）。
> - [`AGENTS.md`](../AGENTS.md)：**别写错**（反模式目录 + 错误码）。
> - [`SPEC.md`](../SPEC.md)：应该是什么样（原则与判据）。
> - [`docs/rfcs/`](rfcs/)：单个决策的提案与验收（`ref` / `context` / SSR 数据）。
> - **本文件**：内部怎么运转、每处取舍的代价、改动时不能破的不变量。
>
> 三处需要说明的事实：编译器源码 2010 行（`src/compiler/index.ts`）、运行时约 1800 行、
> 全文结论均可对照源码复核；带 `§x.y` 的引用指向 RFC。

---

## 0. 怎么读这篇

三种读者，三条路线（都不用通读）：

| 你想干的事 | 按顺序读 | 不必读 |
| --- | --- | --- |
| 读懂「TSX 到底被编译成了什么」 | §1 → §2 → §3 | §6–§8 |
| 改运行时（响应式 / 列表 / 注水） | §4 → §5 → §7 → §9 | §2 的细节 |
| 只想快速回忆某个设计当初怎么想的 | §1 的取舍表 → §1.3 原型对照 → §10 决策索引 | 其余 |

**读源码时的三个抓手**（比背文件更重要）：

1. **注释锚点**：`plain-[` / `plain-?` / `plain-#` / `plain-{label}]` —— 运行时所有动态区间都靠它定位，SSR 也只保留它。
2. **owner（`Set<dispose fn>`）**：一切 effect 的归属。组件 / 分支 / 列表行 / 插入点各自一个 Set，回收靠它。
3. **产物里的 helper 别名**：`__effect` / `__insert` / `__when` / `__each` / `__place` / `__createEl` / `__ref` —— 看到它们就等于看到编译器的生成规则。

---

## 1. 设计命题与它换来的代价

### 1.1 命题

> 让 AI **第一次就写对**；写不对时**在编译期报错**，而不是运行时静默跑错。

四条判据（`SPEC.md` §1.1「AI-first 四道闸」，优先级从高到低）：
**可静态验证 → 可本地推理 → 重复优于抽象 → 平台优先**。

由此推出整套实现里反复出现的同一个纪律：

> **宁可编译期报错，也不留「半对」的行为。**

这不是洁癖，而是对失败模式的排序：静默跑错的代价远高于构建失败。框架里这个纪律的直接产物：

| 做法 | 为什么不能「先支持一半」 |
| --- | --- |
| JSX 属性展开 `{...x}` → `PLAIN_E1008` | 展开只在创建时求值、不进 effect、绕过 `class`/`style`/`value` 的正确路径 —— 支持一半就必然静默跑错 |
| `key` + `index` 同时用 → `PLAIN_E1005` | keyed 下行只构建一次，回调捕获的 index 无法随位置更新；二者必有一个静默失效 |
| `server()` 引用外部变量 → `PLAIN_E1006` | 函数体会被物理搬走，闭包不会跟过去，否则服务端 `ReferenceError` |
| 同名 `server()` 跨文件 → 构建期抛错 | 清单是单文件，后者会静默覆盖前者，客户端还在调旧名字 |
| `ref` 不是函数 / 是 async / 返回 JSX → `E1010`/`E1011` | 静默忽略等于「写一个不存在的能力」 |

### 1.2 代价（明确接受，不要当成 bug）

| 限制 | 换来了什么 |
| --- | --- |
| 组件必须 `return (<jsx />)`（表达式整体被编译） | 产物完全可预测，编译期能对每处写法报行号 |
| props 不能解构 / 不能存进变量，直接读 `props.x` | 动态 prop 是真 getter（见 §3.3），解构或存变量会**快照**住旧值 |
| `server()` 闭包不过去 | 跨端依赖显式化，没有「本地能跑、上线就 500」 |
| 非注水路径下 `syncRange` **不复用节点** | 实现简单可预测；代价是区间内的焦点 / 选区 / 不受控输入 / 局部滚动会丢 |
| HMR 对受影响区间**整段重建** | 不整页刷新，但区间内的 DOM 状态同样会丢 |
| 没有 vDOM / 并发渲染 / 时间切片 | 运行时极小、无 diff 开销 |

### 1.3 原型（`prototype/`）：这套设计最早的样子

[`prototype/framework.js`](../prototype/framework.js)（299 行，纯 JS、零依赖，配 `app.js` + `index.html` 可直接跑）
是**编译版之前的那一版实现**：`html\`…\`` 标签模板 + 运行时事后绑定。它的文件头注释就是最初的设计原则，
8 条，按「对 AI 的重要性」排序 —— 那是今天 `SPEC.md` §1.1 四道闸的前身。

> 跑法：随便起个静态服务（`python3 -m http.server`）打开 `prototype/index.html`；`type="module"` 不能走 `file://`。

**八条原则的去向**（原文 → 现在落在哪）：

| 原型原则（文件头原文） | 结果 |
| --- | --- |
| Locality：无 hook 顺序 / 无 deps 数组 / 无 Proxy 魔法 | 保留，成为四道闸的「可本地推理」。`rowProxy` 只做**读追踪**，不是状态代理，没违背这条 |
| 唯一状态原语 `signal` / `computed` / `effect` | 逐字保留 —— `computed = signal + effect` 到现在一行没改（§4.2） |
| 单文件单语言（逻辑与标记同作用域） | 原则保留，**换掉载体**：`html\`\`` → TSX。要类型和静态检查，就得让视图是真正的表达式 |
| 显式执行边界 `server()` | 保留，并从「打个标记」升级为编译期物理剥离（§6） |
| 编译到 DOM | 原型只是**模拟**（原文就写了「运行时版用细粒度绑定模拟」）；真正的编译器是第二阶段 |
| 稳定小核心、API 长期冻结 | 保留 |
| 类型即校验 | 原型是 `.js`、**一个类型都没有**；现在靠 TS + 收窄的 JSX 类型 + `tsc`（`test/types.test.mjs`） |
| AI 原生 / 错误自解释 | 收敛成「可静态验证」：lint + `PLAIN_Exxxx` 全套错误码 |
| （紧随其后的补充段）不用深代理，状态走 immutable | 保留；「原地改数组」现在由 lint `PLAIN_E1106` 直接拦 |

**关键差异**（原型怎么做 → 现在怎么做 → 为什么改）：

| 方面 | 原型 | 现在 | 为什么改 |
| --- | --- | --- | --- |
| 视图 | `html\`\`` 拼出字符串 → `template.innerHTML` → 用 TreeWalker 扫全树，把 `\0<idx>\0` 占位符换成节点 / 绑定 | 编译期直接生成 `createElement` + `insert` / `when` / `each` 调用（§3） | `innerHTML` 是安全红线；事后扫一遍等于把 DOM 建两次；而且没有任何静态检查的抓手 |
| 绑定 | 每个文本占位、每个属性各一个 `effect`；属性把多个 token `split` 再拼串 | 一个 `{expr}` 一个 `__insert` effect；属性按 [`attrs.ts`](../src/attrs.ts) 一张表落地 | 同一语义只能有一条路径，不能「静态走 setAttribute、动态走 property」静默分叉（§3.2） |
| 条件 | `when(cond, then, else)` 每次 cond 变化都 `replaceChildren` 重建整块 | 分支 key 相同直接早退；真换分支才重建，且先跑旧分支 cleanups | 重建丢焦点；原型里旧分支的 effect 根本没人回收 |
| 列表 | `each(items, keyFn, itemFn)`：**只有 keyed**、`keyFn` 必填；行 effect 不回收 | `each(parent, getter, itemFn, keyFn?)`：默认按位置复用，keyed 可选；每行一个 `rowProxy`（§4.5） | 每行一个 signal 才治得住「改了数据 UI 不动」；`key` 不该是必填仪式 |
| 生命周期 | `effect` 只有 `deps`，**没有 dispose、没有 owner**；`mount` 也不返回卸载函数 | `createScope` / `withOwner` / `onCleanup`；组件 / 分支 / 行 / 插入点各一个 Set（§4.4） | 原型里切分支、删行都在泄漏 —— 这是后来补的第一课 |
| 异步 | `resource(fn)` 只返 `data` / `loading`：无竞态丢弃、无 `error`、无 `refetch` | `{ data, loading, error, refetch }` + ticket 序号丢弃过期响应（§7.4 的同一套 key 机制） | 条件快速变化时，先发的旧响应会覆盖新响应 |
| `server()` | `fn.__server = true`，函数照旧进 bundle | 函数体搬进 `.plain/server.mjs`，客户端只留 RPC 桩（§6.1） | 「写在浏览器里也不泄漏密钥」只能靠物理剥离，不能靠命名约定 |
| 读写 | `s()` 读、`s.set(v)` 写；但文件头注释声称「`signal(x)` 也写」 | **只有** `s()` 读、`s.set(v)` 写，写错与漏调用都由 `PLAIN_E1101/E1102` 拦在编译期 | 见下 |

值得单独记一笔：**原型自己就踩了这个坑**。`signal` 的 `read` 函数完全忽略参数，而 demo 里写的是
`count(count() + 1)` 自增、`count(0)` 重置 —— 于是**原型里的计数器点了根本不动，而且不报任何错**。
（注释说「带参即写」，实现不认参数，两层各写各的。）这就是后来「读写彻底分开 + 每条规则都带错误码」的直接动机：
只要允许「一次调用两种含义」，必然出现「看起来在写、其实只是读」的静默失败 —— 正是 §1.1 那条纪律要消灭的东西。

**原型证明了什么**：`signal` / `computed` / `effect` 这套内核 + 「组件就是一个返回视图的函数」的写法，够用、够小、AI 写得出来。

**它没证明什么**（也就是后来必须走到编译器的原因）：模板事后绑定既没法静态检查，也没法在产物里消灭 `innerHTML`，
更没法在编译期把 `server()` 搬走 —— 而这三件事恰好是「AI 一次写对」的全部依赖。
所以原型不是被推翻的，是**被替换了载体**：模型留着，实现从「运行时绑定」换成「编译期生成」。

---

## 2. 编译管线

### 2.1 六个步骤（Vite 插件入口）

`src/vite/index.ts` 的 `transform` 是唯一入口，顺序固定：

```
0. 契约检查 lint.check(code)        → 有 level=error 的问题就让构建失败（PLAIN_E2001）
1. 去类型 esbuild(jsx: "preserve")  → 得到「合法 JSX 的纯 JS」，编译器只吃这种输入
2. 编译   compile(code, fileName)   → { code, serverFunctions, map }
3. 登记   .plain/server.mjs         → server() 函数体落盘（dev 增量、build 结束整体重写）
4. 注入   HMR（仅 dev）              → 首尾追加 __plainBeginModule + import.meta.hot.accept
5. 返回   { code, map }             → sourcemap 交给 vite 链式合并
```

第 1 步必须在第 2 步之前，这不是风格问题：编译器只做「JSX → DOM 代码」，
类型语法（`as` / 泛型 / 注解）由 esbuild 先剥掉。若传进来的还是 TS，
产物解析会失败并报 `PLAIN_E1002`（提示就是「先用 esbuild `jsx: 'preserve'` 处理」）。

### 2.2 `compile()` 内部

```ts
compile(source, fileName, { mapSource, keyBase, sourceMap }) -> { code, serverFunctions, map }
```

1. `ts.createSourceFile(..., ScriptKind.JSX)` 建 AST（**只做结构分析，不用 TS factory 重建**）。
2. 一遍 `walk` 收集 `edits`（源码区间替换），同时做各类断言：
   - `server(fn)` → RPC 桩 + 把函数体收进 `serverFunctions`（§6.1）
   - `resource(fn)` → 补上「调用点 key」（§7.4）
   - 组件箭头简洁体 / 渲染函数里的 `return` → 换成 `{ …建 fragment… }` 块
   - `PLAIN_E1005/E1006/E1007/E1008/E1009–E1012` 的检查
3. `assertJsxCovered()`：**每一个 JSX 都必须落在一个「编译器会 emit 它」的位置**（§2.4），否则 `PLAIN_E1001`。
4. `applyEdits()`：按区间切片拼接，同时记录 `EditSegment`（产物区间 ↔ 源码区间）。
5. 前置一行 `HELPER_IMPORT`（全用别名，避免和用户 import 撞名）。
6. `assertClean()`：把产物**重新解析一遍** —— 解析失败 `PLAIN_E1002`，残留 JSX `PLAIN_E1003`（都标「编译器 bug」）。
7. `buildSourceMap()`：line 级、base64 VLQ；跳过第 1 行 helper import。

**为什么用「源码切片」而不是 AST 重建**：可预测、出错好定位行号。
AST 打印会把格式化、注释、行号全部打散，而「报错精确到行」是本框架的卖点。

### 2.3 唯一发射入口：`emitExprInto(node, parentVar)`

任何表达式都从这一个函数变成「渲染到 `parentVar`」，按形状分派四种：

| 表达式形状 | 生成 | 备注 |
| --- | --- | --- |
| `arr.map(cb)` | `__each(parent, () => arr, cb', keyFn?)` | 顶层元素带 `key` → 传第 4 个参数（keyed 复用） |
| `cond ? a : b` | `__when(parent, () => cond, () => {a}, () => {b})` | 分支切换时回收上一分支的 effect |
| `cond && a` | `__when(parent, () => cond, () => {a}, null)` | |
| JSX | `emitNode` → 建元素 / 调组件 | |
| 其它（含普通值） | `__insert(parent, () => expr)` | 包进 effect，值变了就地重算 |

`emitStmt` 负责语句层：`return` / `if` / `try` / `switch` / 循环 / 块 / 就地小渲染函数都递归处理，
所以「提前 return」也能编译。**跨进嵌套函数后只改写含 JSX 的 return**，
普通辅助函数（`function double(n) { return n * 2 }`）原样保留。

### 2.4 「会被 emit」的判定（`assertJsxCovered`）

JSX 合法位置只有两处入口的覆盖范围：

- **A.** `emitChild → emitExprInto`：JSX 元素 / fragment 的直接子节点、`{expr}` 本身；
- **B.** `emitMapItemBody`：`.map(cb)` 回调里的 `return`。

判定时向上穿透「语义透明」的节点（括号 / `as` / 三元 / `&&` 右侧），遇到 `||` / `??`
**不穿透** —— 它们不在支持形状里，会落到 `insert` 内联源码，JSX 就不会被 emit。
所以 `{cond || <a/>}`、数组字面量 `{[<a/>]}`、IIFE、`.map(cb).filter()` 尾部箭头体
一律 `PLAIN_E1001`，并给出「先赋值给变量 / 抽成组件函数」的提示。

> 这条设计的价值在于错误归属：漏编译如果不拦，会一路漏到 `assertClean`，
> 最后报成「编译器 bug（E1003）」，把用户合法的写法误导成框架缺陷。

---

## 3. 产物对照表（TSX → 生成代码）

> 名字里的数字（`__f1` / `__el2`）只是「本文件内递增的唯一后缀」，示意用。
> 开头固定一行：
> `import { effect as __effect, stringify as __stringify, insert as __insert, each as __each, when as __when, rpc as __rpc, place as __place, createEl as __createEl, __ref } from "plain";`

### 3.1 组件与文本插值

```tsx
export function App() {
  return (<p>{count()}</p>);
}
```
```js
export function App() {
  const __f1 = document.createDocumentFragment();
  const __el2 = __createEl("p", __f1);
  __insert(__el2, () => (count()));
  __f1.appendChild(__el2);
  return __f1;
}
```

要点：组件返回的是 **DocumentFragment**；`{count()}` 变成 `__insert`（一个 effect），
所以「读取写在花括号里」才算订阅 —— 在花括号外取值是普通读取，不订阅。

### 3.2 属性：三条完全不同的落地路径

```tsx
<input value="x" />                 // 字面量
<input value={v()} />               // 动态
<input checked={ok()} />            // 布尔属性
<div class={c()} data-id={id()} />  // className / 非反射属性
<button onClick={save} />           // 事件
```
```js
__el2.setAttribute("value", "x");                                    // 字面量：一次写死
__effect(() => { const __v = (v()); if (__v == null) __el2.removeAttribute("value");
                 else __el2.value = __v; });                          // 动态：走 property + null 守卫
__effect(() => { __el2.checked = (ok()); });                          // 布尔：直接赋 property
__effect(() => { __el2.className = __stringify(c()); });              // class 需 stringify
__effect(() => { const __v = (id()); if (__v === false || __v == null)
                 __el2.removeAttribute("data-id");
                 else __el2.setAttribute("data-id", __stringify(__v)); });
__el2.addEventListener("click", save);
```

三条路径的判据全部来自 [`src/attrs.ts`](../src/attrs.ts) 一张表：

- **静态字面量 → `setAttribute`**：可被 SSR 序列化，首屏不需要额外反射层。
- **动态 → property**（`REFLECTED_ATTRS` 里登记的走 property）：`setAttribute` 改不动「已经脏了」的表单状态
  （用户输入过的 `<input>`，设 `value` 属性不改变当前值）。
- **SVG / MathML → 一律 `setAttribute` 原样名**：`className` 是只读的 `SVGAnimatedString`，赋值在严格模式会抛错。

`null` / `undefined` 的两种处理**不能混**：布尔属性交给 WebIDL 强转（`null` → 不勾选），
字符串属性必须 `removeAttribute`（否则 `maxLength=undefined` 会变成 `maxlength="0"`，输入框一个字符都打不进）。

### 3.3 组件调用：props 是 getter，children 是 thunk

```tsx
<Card title={t()} onClick={save}>hi</Card>
```
```js
const __props3 = {
  get title() { return (t()); },
  onClick: (save),
  children: () => { const __cf = document.createDocumentFragment();
                    __cf.appendChild(document.createTextNode("hi")); return __cf; }
};
__place(__f1, Card(__props3));
```

三条规则：

- 动态值 prop 编译成**真正的 getter**（`get x() { return expr }`），组件里直接读 `props.x` ——
  读出来就是当前值，在 JSX / effect 里读会自动订阅。把值存进变量仍是快照（`E1107` / `E1112`）。
- `on*` prop **原样**传函数；内联箭头 / 函数表达式也原样传（它们本身就是函数值）。
- `children` 是 **thunk**（惰性子树），组件里写 `props.children()`；它不是 getter，因为每次读都会
  重新构建一棵子树，语义上是「惰性渲染」，不是「实时值」。
- `key` 不是 prop，由 `each` 消费；`ref` 只在**内建元素**上合法（`E1009`）。

### 3.4 条件与列表

```tsx
{cond ? <a/> : <b/>}
{cond && <b/>}
<ul>{items().map(it => <li key={it.id}>{it.text}</li>)}</ul>
```
```js
__when(parent, () => (cond), () => { /* 建 <a> */ }, () => { /* 建 <b> */ });
__when(parent, () => (cond), () => { /* 建 <b> */ }, null);

__each(__el2, () => (items()), (it) => {
  const __f8 = document.createDocumentFragment();
  const __el9 = __createEl("li", __f8);
  __insert(__el9, () => (it.text));
  __f8.appendChild(__el9);
  return __f8;
}, (it) => (it.id));          // 有 key → keyed 复用；无 key 则该参数不生成
```

### 3.5 `server()` 与 `resource()`

```tsx
const load = server(async (id: number) => ({ id }));
const user = resource(() => load(1));
```
```js
// 客户端产物：函数体一行都不在
const load = ((...__args) => __rpc("load", __args));
const user = resource(() => load(1), undefined, "src/App.tsx:2#0");
```

```js
// .plain/server.mjs（自动生成，勿手改）
export const load = async (id) => ({ id });
export const __plainHandlers = { load };
export async function handle(name, args = []) {
  const fn = __plainHandlers[name];
  if (!fn) throw new Error('unknown server fn: ' + name);
  return await fn(...args);
}
```

`resource` 的第 3 个参数是**编译器注入的调用点 key**（`<项目相对路径>:<行号>#<同文件内序号>`）。
手写这个 key = 又多一个会漏、会写错的东西；编译器给则必然存在、且服务端与客户端两次构建一致。

### 3.6 `ref`

```tsx
<input ref={(el) => { el.focus(); return () => el.blur(); }} />
```
```js
__ref(__el2, (el) => { el.focus(); return () => el.blur(); });
```

---

## 4. 响应式内核（`src/runtime/signal.ts`，270 行）

### 4.1 数据结构

```ts
signal = { value, subs: Set<effect> }   // 读：s() 时把 activeEffect 双向登记
effect = { deps: Set<signal>, fn, disposed, ownerChain, run(), dispose() }
```

- **读**：`s()` → 有 `activeEffect` 就把 `effect` 加进 `s.subs`、把 `s` 加进 `effect.deps`。
- **写**：`s.set(v | prev => next)` → `Object.is` 短路；否则改值后跑 `subs`（batch 中则入队）。
- **重跑前先 `cleanup`**：清空旧依赖再重新收集，所以依赖可以随条件变化。
- **`effectStack`** 支持嵌套 effect 的依赖归属；**`ownerChain`** 是创建时的 owner 链**快照** ——
  因为重跑时 `ownerStack` 早已为空，找最近的 `ErrorBoundary` 只能靠快照。

### 4.2 `computed` 不是惰性图

```ts
computed(fn) = signal(undefined) + effect(() => out.set(fn()))
```

没有依赖版本号、没有惰性求值、没有拓扑排序：上游一变就同步重算并写回。
代价是「菱形依赖可能多算一次」，收益是**实现 20 行、行为可本地推理** —— 与「AI 可推理」的命题一致。

**代价之二（此前未写明）：创建即求值让模块顶层的声明顺序成为硬约束。** 顶层
`computed` 在 import 阶段就会执行回调，引用「后面才声明」的 const / let / class 会
撞暂时性死区（TDZ），import 时即抛 `ReferenceError` —— 且 tsc 查不到（回调体内的
引用被视为延迟执行）。框架用 lint 规则 `PLAIN_E1201`
（`no-eager-computed-forward-ref`）在构建期拦下这一形态；缘起与方案取舍见
[`docs/rfcs/computed-eager-tdz.md`](rfcs/computed-eager-tdz.md)。

### 4.3 批处理与死循环

- `batch(fn)` 用 `batchDepth` 计数，归零时 `flush()`；flush 是循环取队列（settle 期间可能又入队）。
- 循环上限 10000 次，超出直接抛 `[plain] 检测到响应式死循环（effect 反复自触发）` —— 不静默挂死。
- `effect(() => s.set(s() + 1))`（读同一 signal 又写）由 lint 拦为 `PLAIN_E1110`。

### 4.4 作用域回收：唯一的泄漏防线

```
createScope(fn) / withOwner(set, fn) / onCleanup(fn)
```

- `effect()` 创建时把自己注册进 `activeOwner`（一个 `Set<dispose fn>`）；
- 组件挂载、`when` 分支、`each` 行、`insert` 重算、`Context.Provider` 各自 `withOwner(new Set)`；
- 回收 = 把这个 Set 里的函数全跑一遍。

`insert` 有个关键细节：**每次重算都换一个新的 owner**，这样「动态组件被替换」时，
它自己创建的 effect 会被整体回收（路由切换 / 列表重建不会泄漏）。

### 4.5 `rowProxy`：列表行级响应式的根因修复

```ts
each(parent, getter, (item) => {
  const rowSignal = signal(item);                    // 每行一个 signal
  itemFn(rowProxy(() => rowSignal()), index);        // 行内读任何属性都先读它
});
```

`rowProxy` 是个 `Proxy`：任何属性读取都会先 `getRow()`（读该行的 signal），于是
**行内每个绑定自动订阅「这一行」**。这直接根治了「勾选待办 UI 不更新」这类致命 bug，
也让 AI 不必手写 key / memo / 依赖数组。

### 4.6 `untracked`

- `untracked(fn)`：执行但不建立依赖，**仅内部使用**（列表 key 计算：算 key 时读值不该引起重算）。

### 4.7 Context：复用 owner 链，天然请求隔离

- `Provider` 用 `withOwner` 开子作用域，把 `ctx → value getter` 挂在作用域对象上（`Symbol` 为键）。
- `useContext(Ctx)` 沿 `getOwnerChain()` **从内到外**找最近的注册点，找不到给默认值。
- 返回的是 **getter**（`useContext(Ctx)()`），和 signal 同一读法 —— 避免「存进变量 = 快照旧值」。
- SSR 隔离不靠额外机制：作用域**每次渲染现建现收**，下一个请求拿到全新作用域，
  不可能读到上一个请求的 Provider 值。

---

## 5. DOM 层（`src/runtime/dom.ts`，523 行）

### 5.1 为什么用注释锚点而不是 Fragment

Fragment 一旦被 append 到父节点就会被「抽干」，之后再往里写全丢（旧版本正是死在这里）。
所以统一用**一对注释锚点**定位真实父节点与区间：

| 锚点 | 用于 |
| --- | --- |
| `plain-[` … `plain-]` | `insert`（任意表达式） |
| `plain-?` … `plain-/?` | `when` |
| `plain-#` … `plain-/#` | `each` |
| `plain-{label}]` … `plain-/{label}]` | `createSlot(label)` |
| `plain-root]` … `plain-/root]` | `mount` / `hydrate` 的整树区间 |

`createSlot` 是「组件需要事后整体替换自己内容」时（ErrorBoundary / 路由容器 / 懒加载）的返回值类型。

### 5.2 `syncRange`：最小重排，但**不复用节点**

```
已就位的节点不做任何 DOM 操作 → 删除区间内多余的 → 按顺序 insertBefore 缺失/错位的
```

明确语义：**非注水路径不复用节点**（旧的 remove、新的 insertBefore），所以区间内的
焦点 / 选区 / 未受控输入 / 局部滚动会丢。要复用节点只有注水那条路（§7.5 `reconcileHydrate` 的 `inPlaceUpdate`）。
细粒度更新（`insert` / keyed `each`）不经过整段重建，节点照旧复用。

### 5.3 `when`：只在分支 key 变化时才换

```ts
const key = cond ? "then" : "else";
if (currentKey === key) return;     // 同一个分支，不重建
```
换分支时先跑上一分支的 `cleanups` 再建新的 —— 分支内的 effect / 定时器 / 订阅一并回收。

### 5.4 `each`：两种复用策略

| 模式 | 触发 | 行为 |
| --- | --- | --- |
| index（默认） | 无 `key` | 行按位置复用，只 `rowSignal.set(newItem)`（节点与 effect 都留着） |
| keyed | 顶层元素有 `key={}` | 按 key 建 pool 复用；key 消失 → 整行 `dropRow` |

- **key 在 `untracked` 里算**：读值但不订阅，避免 key 字段变化引起额外重算。
- **keyed 模式禁用 index**（`PLAIN_E1005`）：keyed 下行只构建一次，回调捕获的 index 不会随位置更新。
- `dropRow` = 先跑该行 cleanups，再摘它的 DOM 节点。

### 5.5 其它

- `createEl(tag, parent)`：`SVG_TAGS` / `MATH_TAGS` 按**标签名**直接 `createElementNS`，
  否则按父节点 `namespaceURI` 继承（`foreignObject` 场景）。
  按标签名判是为了修 `uni-ui` 的图标问题：真实 `<polyline>` 创建时的直接父是 fragment（HTML 上下文）。
- `place(parent, node)`：编译器调用组件的统一出口，兼容 Node / Fragment / Slot，并 `flushRefs()`。
- `ref`：元素**连入文档后**才调用（`dialog.showModal()` 在游离节点上会抛 `InvalidStateError`），
  所以先登记待办，由 `syncRange` / `place` / `hydrate` 统一 flush。SSR 垫片没有 `isConnected`，
  待办永不 flush —— 服务端不跑副作用，正是想要的。

---

## 6. `server()`：编译期物理剥离

### 6.1 三步

1. **编译期**：`server(fn)` → `((...__args) => __rpc("name", __args))`；函数体源码进 `serverFunctions`。
2. **落盘**：写入 `.plain/server.mjs`（单文件清单）。dev 增量 `updateServerManifest`，build 结束 `writeServerManifest` 整体重写。
3. **运行**：服务端 `loadHandlers()` 导入清单拿 `__plainHandlers`；客户端只有桩。

### 6.2 三条静态判定

| 错误码 | 判定方式 | 刻意的不做 |
| --- | --- | --- |
| `E1006` 函数体引用了外部变量 | 文件级绑定集合 − 函数体内声明 − 其它 `server()` 名 | 不猜全局（`process` / `Math` / `fetch` 不在判定内）—— 猜必误报 |
| `E1007` 参数 / 返回值不可序列化 | AST 上确知的：函数 / 本文件的类 / `new` 常见 Stream 构造 / 含方法的对象字面量 | 看不出类型的标识符、`new Date()`、spread 一律不猜 |
| 同名冲突 | `assertNoNameCollision`（带两个来源文件） | 同一文件重复 transform（HMR）不算冲突 |

`E1007` 也覆盖返回值：RPC 的 `JSON.stringify` 会把函数 / Stream **悄悄丢成 `{}`** ——
客户端不报错、只拿到空值，属于最贵的静默失败。

### 6.3 dev 与 build 的差异（CSP 相关）

- **dev**：`needsCallable = true`，函数体用 `new Function` 求值成可调用对象，供 `/_plain/rpc` 用。
- **build**：**不求值**。清单只要文本，避免构建机执行非预期代码，也少一处 `new Function`。

### 6.4 `rpc()` 的三条路径

| 场景 | 行为 |
| --- | --- |
| SSR 期间 | **直调**同进程 handler（`AsyncLocalStorage` 里的 store），不走 HTTP；无 handler → 明确报错 |
| 客户端 + `setRpcBatching(true)` | 同一微任务内的调用合并成一次 `POST /_plain/rpc/batch`；批量端点不可用则**自动退化**逐条 |
| 客户端默认 | `POST /_plain/rpc` 单条 |

---

## 7. SSR 与注水

### 7.1 为什么不需要独立渲染器

编译产物是「直接建 DOM + effect 首次同步执行」。所以 SSR 只要**换掉 `document` 实现**，
同一份产物在 Node 里跑出字符串即可：

- 服务端：`src/server/dom-shim.ts`（零依赖的 `SElement` / `SText` / `SComment` / `SFragment`）
- 客户端注水：`src/runtime/claim-document.ts`（**认领**服务端已有节点，而不是新建）

### 7.2 服务端垫片的两个关键点

1. **属性反射**：`REFLECTED_ATTRS` 上的每个 property 都要反射回 `attributes`，
   否则 `serializeNode` 遍历 `attributes` 时整条丢 —— 历史 bug 是「SSR 下动态 `href` / `value` / `checked` 全部消失」。
   这张表与客户端**共用** `src/attrs.ts`，一端加属性两端同时生效。
2. **只保留自己的锚点**：`serializeNode` 对注释只输出 `plain-` 前缀的，其余丢弃。
   没有锚点，客户端无法定位动态区间。

### 7.3 「等静默」而不是猜毫秒

`resource` 的 promise 通过 `trackPending` 登记进**本次渲染**的 pending；
`renderToStringWithData` 循环 `settlePending()` 直到 pending 为空（上限 20 轮，超了显式告警）。
`wait: 50` 那种猜数字的写法保留只为兼容旧调用。

### 7.4 首屏数据迁移（三个 key 一致性）

```
编译器注入 key  →  服务端 openSSRSlot(key) 按创建序占槽
                →  serialize: [{ key, ok, value? }]（没取到也要占位 ok:false）
                →  HTML 里 <script type="application/json" id="plain-data">
                →  hydrate 前 __loadSSRPayload → resource 按 key 取种子（取到就消费）
```

必守的两条：

- **按创建序**，不是按 settle 序：`value` 何时到位不确定，但「同 key 的第几个实例」两端都确定。
  少占一条就会让后续同 key 的实例错位配对（静默串数据，比多一次请求糟得多）。
- **种入后仍跑一次 `promiseFn`**：不翻回 loading（首帧与 HTML 一致，不闪），
  但依赖必须收集（丢依赖 = 数据永久陈旧），顺带就是一次 stale-while-revalidate。

### 7.5 注水协议：扁平快照 + 游标

```ts
beginHydrate(root) → flatten(root)          // 深度优先的「文档顺序」扁平数组
                   → index = 0             // 游标 = 数组下标
```

- 为什么用扁平快照而不是 live `nextSibling`：编译产物**边认领边 appendChild** 重挂节点，
  live 兄弟链会被打乱；扁平快照始终等于「SSR 产出顺序」，结果稳定可预期。
- `claimElement` / `claimText` / `claimMarker`：类型对上就复用（**节点身份不变**），
  文本值不同**就地改 `nodeValue`**；类型不符 → 记 `mismatch` 告警并退回新建（`recover`）。
- `claimPair(open, close)`：认领一对锚点，把两者之间的**直接兄弟**作为 content 摘下返回。
  只收同一父级的直接兄弟 —— 区间内嵌套的 insert / when / each 由它们自己递归认领。
- `suspendHydrate()`：锚点对认领后，内部内容应由运行时**新建**，再经 `syncRange` 与已认领内容对齐。
  否则会重复消费游标。`insert` / `when` / `each` 都用了这个开关。
- 结束时 `assertConsumed()`：还有没认领的服务端节点 → `extra` 告警（已保留）。
- 收尾把 `document` / `Node` / `Element` / `window` **恢复成容器所属文档**的方向，
  而不是「进入前的值」—— 进入前可能被 SSR 垫片占用，还原成垫片会让后续新建产出 shim 节点。

### 7.6 并发安全：`AsyncLocalStorage` + 一个共享钩子

- 服务端 `runSSR(handlers, fn, url)` 把「垫片 + handlers + pending + 收集槽 + url」放进 `AsyncLocalStorage`，
  异步上下文贯穿 `await`，并发渲染互不踩。
- **运行时侧（要进浏览器包）不 import `node:async_hooks`**：只保留一个「读当前上下文」的钩子
  （`__setSSRStoreReader`），没注册时 `isSSR()` 恒为 false。
- 钩子挂在 `globalThis.__plainSSRContext` 共享槽上：SSR 构建若把运行时打了两份，
  模块局部变量跨不过去（应用那份会以为「不在 SSR」，`server()` 退回 HTTP），共享槽让两份副本认同一个上下文。

---

## 8. HMR

### 8.1 两条路，都不是「什么都不做」

| 情况 | 处理 |
| --- | --- |
| 改动模块**自己**是挂载点，且新版导出 `App` / `default` | **精确替换**：只重建该挂载点区间 |
| 改动模块被别处使用（独立组件文件 / `import()` 懒加载） | **重跑兜底**：把各挂载点的根组件全部重跑（正确性优先于少重建） |

返回 `false` 时调用方 `invalidate()` → 整页刷新。
**绝不静默留在旧代码上** —— 以前只做第一条、其余打一句 warning 就返回，结果是「改了组件界面纹丝不动」。

### 8.2 注入方式

Vite 插件在模块**首尾追加**代码（不能把模块体包进闭包：`export` 不允许出现在函数体内）：

```js
import { __plainBeginModule as __plainBegin, hmrApply as __plainApply,
         snapshotSignals as __plainSnap, restoreSignals as __plainRestore } from "plain";
__plainBegin("<module id>");
/* ……原模块体…… */
if (import.meta.hot) {
  import.meta.hot.accept((__newMod) => {
    if (!__newMod) { import.meta.hot.invalidate(); return; }
    const __snap = import.meta.hot.data.__plainSnap || {};
    __plainRestore(__newMod, __snap, "<module id>");
    const __applied = __plainApply("<module id>", __newMod);
    import.meta.hot.data.__plainSnap = __plainSnap(__newMod);
    if (!__applied) import.meta.hot.invalidate();
  });
}
```

`__plainBegin(moduleId)` 让随后的 `mount()` / `hydrate()` 自动与「所在模块」关联 —— 零配置。

### 8.3 到底保住了什么

| 保住 | 丢掉 |
| --- | --- |
| 页面不重载：window 滚动、页面级状态、**锚点区间之外**的 DOM | 区间内**整段重建**：焦点 / 光标 / 选区、区间内局部滚动 |
| 模块作用域 signal 的**原始值**（snapshot / restore） | 不受控输入的值、区间内第三方实例（Monaco 等，会被 ref 清理再重建） |

受控输入的值能回来（值本来就在 signal 里）。
signal 快照只保留原始值（string / number / boolean / bigint / null / undefined），
对象 / 函数 / DOM 节点记 `ok=false` 并 **显式 `console.warn` 后重置** —— 绝不静默。

---

## 9. 不变量清单（改代码前先扫一眼）

| # | 不变量 | 为什么 | 守它的测试（节选） |
| --- | --- | --- | --- |
| 1 | 属性「拼写 → 落地方式」只有 `src/attrs.ts` 一张表，静态与动态**落地必须一致** | 曾出现 `<label htmlFor>` 静态落 `htmlfor`、动态落 `.htmlFor` 的静默分叉 | `test/attrs.test.mjs` |
| 2 | 编译产物必须能被 JS 解析，且**不含任何 JSX** | 否则错误归因错成「编译器 bug」 | `test/compiler.test.mjs`、`test/compiler-errors.test.mjs` |
| 3 | 产物与运行时**不出现 `innerHTML` / `eval`** | XSS 面与 CSP；`new Function` 只在 dev 的 RPC 求值里 | `test/run.mjs` |
| 4 | `server()` 函数体自包含；参数与返回值 JSON 可序列化 | 函数体被物理搬走，闭包不过去 | `test/compiler-errors.test.mjs` |
| 5 | `server()` 名字在**整个应用**唯一（跨文件冲突构建期报错） | 清单是单文件，同名会静默覆盖 | `test/vite-plugin.test.mjs`、`test/server.test.mjs` |
| 6 | `key` 与 `index` 二选一 | keyed 下 index 无法随位置更新 | `test/keyed.test.mjs` |
| 7 | 每个 effect 都归属某个 owner，且能被整批回收 | 泄漏的唯一防线 | `test/context.test.mjs`、`test/runtime-extra.test.mjs` |
| 8 | 锚点只由运行时产生；SSR 只保留 `plain-` 前缀注释 | 注水靠锚点定位区间 | `test/hydrate.test.mjs`、`test/server.test.mjs` |
| 9 | `resource` 调用点 key 在服务端与客户端**同一份源码得到同一个值**；槽按创建序 | 错位 = 静默串数据 | `test/ssr-data.test.mjs` |
| 10 | 产物 sourcemap 是 line 级、且 helper import 那一行要跳过 | 断点 / 堆栈要落在组件与语句上 | `test/sourcemap.test.mjs` |
| 11 | HMR 认不出根组件时必须整页刷新，不得静默留在旧代码 | 最坏的失败模式 | `test/hmr.test.mjs` |
| 12 | 「同一行为只有一条官方路径」：不新增兼容双轨 / 编译器双模式 | AI 会同时学到两套模型，分支会分叉 | 评审（`AGENTS.md` §7.9） |

---

## 10. 决策索引：某个设计当初怎么想的，去哪看

| 想知道 | 位置 |
| --- | --- |
| 为什么「编译到 DOM」而不是 vDOM | [`SPEC.md`](../SPEC.md) §6、`README_CN.md`「10 秒理解」对比表 |
| AI-first 四道闸（功能取舍判据） | [`SPEC.md`](../SPEC.md) §1.1 |
| 最初的设计设想（8 条原则、原始运行时） | [`prototype/framework.js`](../prototype/framework.js) 文件头注释 + 本文 §1.3 |
| `ref` 为什么必须是函数、必须连接后调用 | [`docs/rfcs/ref-escape-hatch.md`](rfcs/ref-escape-hatch.md) |
| Context 为什么复用 owner 链、SSR 怎么隔离 | [`docs/rfcs/context-and-ssr-isolation.md`](rfcs/context-and-ssr-isolation.md) |
| SSR 直调 handler / 等静默 / 首屏数据 key | [`docs/rfcs/ssr-data.md`](rfcs/ssr-data.md) |
| props 为什么是 getter | [`docs/rfcs/props-live-getters.md`](rfcs/props-live-getters.md) |
| 每条反模式为什么是错的、对应错误码 | [`AGENTS.md`](../AGENTS.md) §3–§4 |
| 里程碑、已排除的伪问题、非目标 | [`ROADMAP.md`](../ROADMAP.md) |
| 构建产物为什么不压缩 / 发布怎么收敛 | [`docs/build-and-release.md`](build-and-release.md) |
| 单文件样式为什么没做 | [`docs/sfc-styles.md`](sfc-styles.md) |

---

## 11. 常见误解（读源码前先校准）

1. **这不是响应式虚拟 DOM**：没有 VNode、没有 diff；每个 `{expr}` 编译成一个 `effect`，直接改文本 / 属性。
2. **`computed` 不是惰性**：上游变就同步重算，没有缓存失效图（§4.2）。
3. **`children` 是 thunk**：`props.children()`，不是已建好的节点 —— 这才让子树惰性与作用域回收成立。
4. **`key` 不是 prop**：它是编译期指令，由 `each` 消费；写在组件上不会传给组件。
5. **`syncRange` 默认不复用节点**：所以「局部状态丢了」通常不是 bug，而是这条语义（§5.2）。
6. **SSR 没有第二个渲染器**：就是同一份产物 + 换 document（§7.1）；所以「SSR 和 CSR 渲染不一致」几乎只可能来自
   首屏数据没迁移、或踩了请求级状态放模块作用域（`AGENTS.md` §2 已警告）。
7. **HMR 的粒度是「挂载点 / 根组件」，不是组件实例**（§8.1）。
