# 0.3 → 0.4 迁移指南

`0.4.0` 把 props 从「thunk + `resolve`」改成「真 getter + 直接读」。这是一次
**行为约定变更（clean break）**：不提供编译器双模式、deprecation 期，也没有「新旧都行」的兼容层。
按本文一次改完即可；改完后代码里只保留一种 props 读法。

> 设计背景与取舍见 [`docs/rfcs/props-live-getters.md`](rfcs/props-live-getters.md)。
> 为什么不做兼容层见 [`AGENTS.md` §7 第 9 条](../AGENTS.md#7-改这个框架时必须守住的约定)。

## 谁需要迁移

所有在 `0.3.x` 下写过组件的项目。典型需要改的代码：

```tsx
resolve(props.title)                 // 值 prop
resolve(props.onClick)               // 事件 prop
resolve(props.render)(x)             // 函数型 prop
const t = () => resolve(props.title) // 旧 thunk 写法
<input value={() => name()} />       // 依赖 MaybeGetter 的类型口子
<Link to={() => "/x"}>               // 手写 thunk
```

## 变更总览

| # | 0.3 | 0.4 | 性质 |
| --- | --- | --- | --- |
| 1 | 动态值 prop 是 thunk，必须 `resolve(props.x)` | 动态值 prop 是真 getter，直接读 `props.x` | 运行时 + 类型 |
| 2 | 运行时导出 `resolve` | **已删除** | 破坏性 |
| 3 | 内建元素属性类型是 `MaybeGetter<T> = T \| (() => T)` | 一律是普通值 `T` | 破坏性（类型） |
| 4 | `Link` 的 `to: string \| (() => string)` | `to: string` | 破坏性（类型） |
| 5 | lint：JSX 形态 `PLAIN_E1112`、`PLAIN_E1108` | 两条规则删除 | 工具链 |
| 6 | 组件体 / effect 里存 props 都可能报快照 | 只在组件渲染作用域里报；effect / 事件回调内不报 | 工具链（更准） |

`children` 不在变更范围内：它一直是 lazy subtree，继续写 `props.children()`。

---

## 第 0 步：准备

1. 升依赖：`plain` / `plaindev` 都升到 `0.4.0`（两边必须同版本，编译器与 lint 是一套约定）。
2. 开分支，先跑一遍现有测试 / 构建，记下基线。
3. 全量搜索待改点：

```bash
# 1) resolve 的所有调用点（只改从 plain 导入的那个 resolve，别误伤同名的本地函数）
rg -n '\bresolve\(' --glob '*.{ts,tsx,js,jsx}'
# 2) 所有「把 props.x 当函数调用」的地方 —— 第 2 步逐个人工判断
rg -n 'props\.[A-Za-z_$][\w$]*\s*\(' --glob '*.{ts,tsx}'
# 3) JSX 属性里的箭头函数（事件处理器 / 组件 render prop / 原生属性函数值混在一起，人工分流）
rg -n '=\{\s*\([^)]*\)\s*=>' --glob '*.tsx'
# 4) 残留的旧类型引用
rg -n 'MaybeGetter' --glob '*.{ts,tsx}'
```

## 第 1 步：删除 `resolve`

### 1.1 值 prop：去掉 `resolve`，并去掉多余的调用

```tsx
// 0.3
effect(() => { el.textContent = String(resolve(props.title)); });
const t = () => resolve(props.title);

// 0.4
effect(() => { el.textContent = String(props.title); });
const t = () => props.title;
```

如果旧代码是 `props.title()`（把 thunk 直接调用），现在要改成 `props.title`：

```tsx
// 0.3：动态值 prop 是 thunk
<h2>{props.title()}</h2>

// 0.4：直接读就是值
<h2>{props.title}</h2>
```

### 1.2 事件 prop：直接调用

`on*` 在 0.3 / 0.4 都是原始函数，`resolve` 只会把它当场调用掉（旧的 `PLAIN_E1108`）：

```tsx
// 0.3（错误写法，旧 lint 会拦）
resolve(props.onClick)(e);

// 0.4
props.onClick(e);
```

### 1.3 函数型 prop：按函数用

```tsx
// 0.3：render={handler} 被包成 thunk，要先解一层再调用
resolve(props.render)(x);

// 0.4：读出来就是 handler
props.render(x);
```

内联箭头（`render={(x) => ...}`）在 0.3 就是原始函数，改法相同：`props.render(x)`。

### 1.4 组件体里的快照仍然要改

`resolve` 删掉后，下面这种写法**不会**自动变正确：

```tsx
// ❌ 0.4 仍然错误：组件体只执行一次，t 是快照
function Card(props) {
  const t = resolve(props.title); // 0.3
  const t = props.title;          // 0.4（同样错误，lint 会报 PLAIN_E1112）
  return <h2>{t}</h2>;
}
```

正确写法是**用的时候直接读**，或显式 thunk：

```tsx
function Card(props) {
  return <h2>{props.title}</h2>;          // 在 JSX effect 里读，自动订阅
}

function Card(props) {
  const t = () => props.title;            // 需要传出去时用 thunk
  return <h2>{t()}</h2>;
}
```

`effect` / `computed` / 事件回调里的局部变量是正确用法，0.4 的 lint 不再误报：

```tsx
effect(() => {
  const t = props.title; // ✅ 回调重跑会重新读
  document.title = t;
});
```

### 1.5 删除 import

```diff
- import { signal, effect, resolve } from "plain";
+ import { signal, effect } from "plain";
```

## 第 2 步：审计函数型 prop（最容易静默出错的一步）

这是唯一需要**逐处判断**的地方：旧代码里 `props.fn()` 的含义取决于 `fn` 是怎么传进来的。

| 传法 | 0.3 `props.render` | 0.4 `props.render` | 迁移动作 |
| --- | --- | --- | --- |
| `render={(x) => ...}` | 函数本身 | 函数本身 | 不变：`props.render(x)` |
| `render={handler}` | thunk，`props.render()` 才拿到 `handler` | `handler` 本身 | 去掉一层 `()`：`props.render(x)` |
| `render={cond ? a : b}` | thunk | 函数本身 | 去掉一层 `()` |

检查命令：

```bash
rg -n 'props\.[A-Za-z_$][\w$]*\s*\(' --glob '*.{ts,tsx}'
```

逐个确认：这个 prop 是**值**还是**函数**？

- 值 prop（`title` / `count` / `item`）：读法里不应该有 `()`；
- 函数 prop（`on*` / `render` / `format` / 回调）：`props.fn(...)` 是调用它，不再需要多一层。

> 判断不了就看组件调用点：传的是箭头函数 / 函数名，还是普通表达式。

## 第 3 步：清理 `MaybeGetter` 式写法

`MaybeGetter<T>` 已删除，内建元素属性只接受普通值。旧类型允许但运行时一直是错的写法要改掉：

```tsx
// 0.3：类型通过，运行时把函数源码写进 DOM
<div title={() => name()} />
<input value={() => name()} />
<div class={() => cls()} />

// 0.4
<div title={name()} />
<input value={name()} />
<div class={cls()} />
```

如果业务代码里显式引用过 `JSX.MaybeGetter<T>`（少见），改成对应的普通类型：

```diff
- const props: { title: JSX.MaybeGetter<string> } = ...
+ const props: { title: string } = ...
```

组件自己的 props 类型也建议同步收紧。旧写法能跑，但类型在说谎：

```diff
- type CardProps = { title: string | (() => string) };
+ type CardProps = { title: string };
```

## 第 4 步：`Link` 的 `to`

```tsx
// 0.3：允许手写 thunk
<Link to={() => "/users/" + id()}>…

// 0.4：直接写表达式，编译器负责响应式
<Link to={"/users/" + id()}>…
<Link to="/about">…
```

手动调用 `Link({ to: () => "/x" })` 的地方同样改成 `Link({ to: "/x" })`。

## 第 5 步：lint 与抑制指令

1. **删除旧抑制**：`PLAIN_E1108` 和「JSX 里忘了 resolve」的 `PLAIN_E1112` 已不存在。
   残留的 `// plain-ignore-line PLAIN_E1108` 不会再报错，但已经没有任何作用，建议清掉：

   ```bash
   rg -n 'PLAIN_E1108|plain/no-resolve-event-prop' --glob '*.{ts,tsx}'
   rg -n 'plain-ignore.*PLAIN_E1112' --glob '*.{ts,tsx}'
   ```

2. **重新跑检查**：`plaindev check src`。0.4 的快照规则只在组件渲染作用域里报，
   effect / 事件回调里的旧抑制大概率也可以删。

3. **helper 约定**：`const t = label(props)` 这种把整个 `props` 传给 helper 再存返回值的写法，
   lint 看不穿，但 `t` 仍是快照。helper 只收值：

   ```tsx
   // ❌ 读取藏在调用里，得到快照
   const t = label(props);

   // ✅ 读取留在 JSX / effect 的追踪上下文里
   return <h2>{label(props.title)}</h2>;
   ```

## 第 6 步：验证清单

- [ ] `npx tsc --noEmit` 通过（尤其是函数型 prop 的调用参数）
- [ ] `plaindev check src` 无新增错误
- [ ] 生产构建通过（`plaindev build` / 项目自己的构建命令）
- [ ] SSR 项目：服务端渲染 + 客户端 hydrate 各跑一次
- [ ] 运行时手测四条：
  - 父 signal 变化 → 子组件里直接读 `props.x` 的行跟着更新
  - `on*` 事件 prop 正常触发，且没有被“提前调用”
  - 函数型 prop（`render` / `format`）收到的是函数本身
  - `props.children()` 仍能渲染出插槽内容

## 常见问题

**Q：为什么不保留 `resolve`，让旧代码继续跑？**
A：保留它就是保留第二条官方路径，也是保留一个主动陷阱（`resolve(props.render)` 会把函数当场调用）。
两套约定并存时，AI 与人都要判断「这个 prop 要不要解包」，分支反而更多。见 `AGENTS.md` §7 第 9 条。

**Q：手动构造 props 的测试 / 工具代码怎么办？**
A：旧代码可能需要 `Card({ title: () => "x" })`；0.4 直接传值 `Card({ title: "x" })`。
`children` 仍要传 thunk：`Card({ children: () => node })`。

**Q：`{...props}` / `Object.keys(props)` 有变化吗？**
A：有。0.3 展开得到的是 thunk，0.4 得到的是值。若你把 props 透传给手写组件，
确认对方按「值」读取；不要再用 `typeof x === "function"` 判断「是不是动态 prop」。

**Q：`props.children` 也要去掉 `()` 吗？**
A：不要。`children` 是 lazy subtree，0.3 / 0.4 都必须显式调用 `props.children()`。

**Q：升级后 tsc 报 `resolve` 不存在？**
A：说明还有遗漏。用第 1 步的搜索命令清干净；`resolve` 不会再从 `plain` 导出。

## 回滚

0.4 是 clean break，回滚需要同时降级 `plain` 与 `plaindev`，并把代码恢复到带 `resolve` 的版本。
建议在独立分支完成迁移，确认第 6 步全部通过后再合并。
