# eval/compare —— Plain vs React 的对称对比

`eval/tasks/` 测的是「Plain 自己的免疫系统管不管用」（例如 `PLAIN_E1006` 拦不拦得住）。
这里测的是另一件事：

> **同一个提示词，同一个可观测行为，两个框架各自写成什么样。**

## 为什么单独一套

`eval/tasks/` 里的用例允许直接调导出函数（`mod.add("c")`），因为 Plain 的状态在模块作用域、外部够得着。
React 够不着组件内部 state —— 如果为了迁就 React 改成点击驱动，那 Plain 侧就被迫走一条不自然的路径。
**任何「一边这样、一边那样」的触发器都会污染结论。**

所以这里立了一条硬规则：

> **交互一律走 DOM 事件；断言只有一份，两个框架跑同一个 `check.mjs`。**

框架差异全部收在 `harness.mjs` 的两个适配器里。

## 目录结构

```
compare/
  README.md            本文件
  harness.mjs          Plain / React 两个适配器 + 共用交互助手
  run.mjs              跑两边，输出对称表格
  cases/
    01-counter/
      task.md          共用的提示词（框架无关）
      check.mjs        共用的断言（只依赖 DOM）
      plain.tsx        Plain 参考实现
      react.jsx        React 参考实现
    02-list-update/
    03-props-update/
```

## 交互协议

`check.mjs` 只拿到四个方法，不知道底下是哪个框架：

| 方法 | 作用 |
| --- | --- |
| `render(name)` | 渲染候选模块导出的组件（默认 `App`），返回 `{ box }` |
| `act(cb)` | 提交一次交互。React 用 `act()` flush；Plain 是同步的，直接执行 |
| `type(el, s)` | 往输入框打字。**两边共用同一条原生 `input` 事件路径**（走原型上的 value setter，否则 React 的 onChange 不触发） |
| `byText(box, sel, text)` | 按可见文本找元素；找不到时报出实际有哪些 |

> 所有交互（点按钮、打字）都必须在 `act()` 里做，否则 React 会告警「state update not wrapped in act」。

## 跑法

```bash
pnpm run build                  # eval 跑的是 dist/，必须先构建

node eval/compare/run.mjs --prompt      # 打印共用提示词，交给代理
node eval/compare/run.mjs               # 跑候选实现
node eval/compare/run.mjs --reference   # 跑参考实现（自检 harness，不算指标）
node eval/compare/run.mjs counter       # 只跑名字含 counter 的用例
```

代理产出的实现写到 `cases/<用例>/plain.candidate.tsx` 与 `react.candidate.jsx`（已 gitignore）。

## 公平性规则

1. **同一份提示词**：`task.md` 里不出现任何框架名，也不暗示写法（见「反例」）。
2. **各自惯用写法**：React 版必须写成 React 的样子（`useState` / 解构 props / `onChange`），
   不能把 Plain 版翻译过去；Plain 版同理。
3. **同一份断言**：不是「表达同一件事的两份断言」，是**同一份文件**。这条最容易被破坏，也最值钱。
4. **同一个模型、同一批提示词**，记录模型名与版本；不能拿 A 的 Plain 结果比 B 的 React 结果。
5. 失败信息要能直接读懂 —— 断言文案要说清「什么行为没发生」。

## 哪些**不可**比（必须承认）

- **服务端边界类**（`eval/tasks/` 里的 `03` / `04` / `07`）在 React 侧没有等价物：
  React 的对应能力是 RSC / Server Actions，机制完全不同，塞进这套 harness 会变成比 RSC 而不是比框架。
  那几条留在 `eval/tasks/` 里，作为 Plain 自己的质量指标。
- **构建期闸门不对称**：Plain 侧候选要走 `契约检查 → 编译`（会因 `PLAIN_E2001` / `E1005` / `E1006` 直接失败），
  React 侧只有 JSX 转换，**没有等价闸门**（没接 eslint / React Compiler）。
  这是**有意保留**的：Plain 卖的正是「构建期把错误变便宜」这件事，把它拿掉反而失真。
  但必须说清楚：**这一栏的优势来自框架自带闸门，不来自 I/O 或模型能力**。
  想更严格地比较，应给 React 侧也接上 lint / React Compiler，并把这个开关记进结果。
- 只有 3 个用例，样本极小 —— 任何结论都只是**方向性**的，不是统计显著。

## 自欺清单

和 `eval/README.md` 同三条，出现任何一条，结果作废：

1. 看完结果再改断言；
2. 临时调松断言（比如把 `deepEqual(texts(), ["a","b","c"])` 改成「长度是 3」）；
3. 只跑通过的那一侧。

## 已确立的对称性（自检记录）

用「各自惯用但错」的实现验证过：两边的错法会被**同一行断言**抓住。

| 用例 | Plain 的错法 | React 的错法 | 共同的失败断言 |
| --- | --- | --- | --- |
| `02-list-update` | `items().push(text)`（signal 按引用比较，不触发更新） | `items.push(text)` 后不 `setState`（不重渲染） | `添加后应立刻变成 3 项` |
| `03-props-update` | `const t = resolve(props.title)`（取值快照） | `const [t] = useState(title)`（派生 state 快照） | `父状态变化后子组件的 <h2> 必须跟着更新` |

这两组是**同一个概念错误的两种方言** —— 也正是这套对比想测的东西。
