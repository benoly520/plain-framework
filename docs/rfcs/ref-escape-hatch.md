# RFC：DOM 命令式逃逸口（`ref`）

> **状态**：已接受，实现中（编译器 + 运行时 + 测试 + 配方）
> **判据依据**：[`SPEC.md` §1.1 功能取舍判据（AI-first 四道闸）](../../SPEC.md)
> **相关**：`AGENTS.md` §3 反模式目录 / §4 错误码、`README.md`「API 全表」、`docs/patterns.md`

---

## 1. 问题

Plain 组件是纯函数，函数体拿不到自己创建的 DOM 节点。于是这些**真实业务需求**无路可走：

| 场景 | 需要的命令式 API |
| --- | --- |
| 模态 | `dialog.showModal()` / `close()` |
| 焦点 | `input.focus()`、焦点陷阱 |
| 滚动 | `el.scrollIntoView()`、恢复滚动位置 |
| 画布 | `canvas.getContext("2d")` |
| 媒体 | `video.play()` / `pause()` |
| 测量 | `getBoundingClientRect()` / `offsetWidth` |
| 第三方库 | Monaco / 图表 / 地图都要吃一个 DOM 节点 |

更糟的是，`src/types.ts` 的 `CommonAttributes` 带索引签名 `[attr: string]: any`，所以今天写
`ref={fn}` **能通过类型检查、能通过编译，然后被当作普通属性静默丢弃** —— 正是本框架最想
消灭的「静默失败」。

## 2. 判据对照

| 闸 | 本设计如何过关 |
| --- | --- |
| **P1 可静态验证** | `ref` 只能出现在内建元素上（组件上报错）；明显的非函数值报错；`async` 回调报错 —— 全在编译期拦 |
| **P2 可本地推理** | 只有一种形态、写在元素上、类型由标签推导；语义直接对应平台的 `connectedCallback` / `disconnectedCallback` |
| **P3 重复优于抽象** | 不引入 `ref()` 工厂、不引入 `.current` box、不引入 Signal 形态 —— 没有第二种写法可选错 |
| **P4 平台优先** | 心智模型借用平台的 `connectedCallback`；命令式动作本身也是平台 API，框架只负责「把节点交到你手上」 |

## 3. 语法与语义

```tsx
<canvas ref={(el) => {
  const ctx = el.getContext("2d");   // el 由标签推导（HTMLCanvasElement）
  draw(ctx);
  return () => { /* 可选：元素销毁时清理 */ };
}} />
```

- **调用时机**：元素**连入 document 之后**调用一次（≈ `connectedCallback`）。
  这一点很关键 —— `dialog.showModal()` 在**游离节点上会抛 `InvalidStateError`**，
  所以必须是「已连接」语义，而不是「刚创建」。
- **返回值**：可选清理函数，注册进当前 owner（复用既有 `onCleanup` 机制），
  在组件卸载 / 列表行回收 / 分支切换时执行（≈ `disconnectedCallback`）。
- **分支与列表**：`when()` 切换、`each()` 行增删时，旧元素清理 → 新元素连接，一一对应；
  keyed 复用**移动**（不重建）的节点不重复触发。
- **SSR**：**不执行**（服务端 DOM 垫片没有 `isConnected`，天然不触发；服务端也不该跑副作用）。
- **注水 hydration**：认领完服务端节点后执行一次（拿到的是真实节点，与其他 effect 一致）。
- **作用域与顺序**：`ref` 回调在**该元素的 owner 作用域内**执行 —— 回调里创建的 `effect` /
  `onCleanup` 归这个元素的生命周期（随它一起回收）。注意：组件体的语句（含写在 `<jsx>` 之前的
  `effect`）先于 DOM 构建执行，那时节点还不存在。因此**凡是要用这个节点的响应式逻辑，都写进
  `ref` 回调**（回调内建的 effect 天然在节点就绪之后运行）。

## 4. 类型

`ref` 的类型由**标签推导**，AI 永远不写泛型、不做断言：

| 标签 | `el` 类型 |
| --- | --- |
| `<canvas>` | `HTMLCanvasElement` |
| `<dialog>` | `HTMLDialogElement` |
| `<img>` | `HTMLImageElement` |
| `<a>` | `HTMLAnchorElement` |
| `<form>` | `HTMLFormElement` |
| `<video>` / `<audio>` | `HTMLMediaElement` |
| 其余元素 | `HTMLElement` |

## 5. 编译产物

```js
const __el1 = document.createElement("canvas");
__ref(__el1, (el) => { const ctx = el.getContext("2d"); draw(ctx); return () => {}; });
```

`__ref` 是**内部符号**（归入 `__plainBeginModule` 那一类，不在对外 API 面里），只做两件事：
登记回调、在元素连接 / owner 回收时调度。公开文档里的运行时 API 列表不变。

## 6. 错误码（编译器侧，不可抑制）

| 码 | 触发 | hint |
| --- | --- | --- |
| `PLAIN_E1009` | `ref` 用在**组件**上（非内建元素） | 组件不保证有根节点；把 `ref` 放到组件内部的元素上 |
| `PLAIN_E1010` | `ref` 的值不是函数（`ref` / `ref="x"` / `ref={obj}` / 返回 JSX） | 写成 `ref={(el) => { … }}` |
| `PLAIN_E1011` | `ref` 回调是 `async` | 清理与异步不兼容；把 `await` 提到回调外 |

> 这一条同时堵住了第 1 节末尾的静默坑：以前 `ref={fn}` 被悄悄丢弃，现在要么正确生效、要么编译报错。

## 7. 主动「不做」清单

| 不做 | 理由（对应闸） |
| --- | --- |
| `.current` box 形态 | 引入 null 时序 + 不触发更新，P2/P3 都不过 |
| 同时支持 Signal 形态 | 两种写法 = AI 会选错，P3 不过 |
| 在组件上用 `ref` | 组件无稳定根节点，语义不确定 |
| SSR 期间执行 | 服务端无 DOM，且副作用不该跑，P4 |
| 声明式 `<dialog open>` 绑定 | 待评测数据确认「AI 反复写错」再加，先只出配方（ROADMAP「先做能验证的」） |

## 8. 实现落点

`flushRefs()` 在**所有把节点接入文档的出口**调用：

| 落点 | 覆盖 |
| --- | --- |
| `syncRange()`（`runtime/dom.ts`） | `mount` / `insert` / `when` / `each` / `createSlot.set` |
| `place()`（`runtime/dom.ts`） | 组件挂载到已连接父级 |
| `router.render()`（`runtime/router.ts`） | 路由页首次装配 |
| `hydrate` 的 `claim()`（`runtime/hydrate.ts`） | 注水认领后 |

未连接的元素留在待办队列，等被接入时再跑；owner 先于连接被回收时把条目摘掉，避免悬挂。

## 9. 验收标准

- [ ] `ref={fn}` 在元素连入文档后被调用一次，`el` 即该元素
- [ ] 回调返回的清理函数在 owner 回收（组件卸载 / 行删除 / 分支切换）时执行
- [ ] `when` 分支切换、`each` 行增删、keyed 复用移动的语义正确
- [ ] SSR 期间不执行；hydrate 后执行一次
- [ ] `PLAIN_E1009` / `PLAIN_E1010` / `PLAIN_E1011` 均有正 / 反测试
- [ ] `ref` 不再被当作普通属性静默丢弃

## 10. 已拍板的三项

1. **命名**：`ref`（回调形态）—— AI 先验最强（React / Solid 的回调形态同名），形态差异由编译期报错兜住。
2. **声明式 dialog 绑定**：延后，先用配方 + 评测数据决定是否提升为编译期语法。
3. **连接时机**：语义锁定为「已连接」，实现落在第 8 节的 4 个出口。
