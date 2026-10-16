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
    04-empty-branch/
    05-async-loading/
    06-conditional-toggle/
    07-input-add-list/
    08-derived-filter/
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
node eval/compare/run.mjs               # 跑候选实现（默认 --context task）
node eval/compare/run.mjs --reference   # 跑参考实现（自检 harness，不算指标）
node eval/compare/run.mjs counter       # 只跑名字含 counter 的用例
node eval/compare/run.mjs --context full           # 指定给代理的规则上下文（见下）
node eval/compare/run.mjs --prompt --context full  # 打印「提示词 + 规则上下文」，原样交给代理
```

代理产出的实现写到 `cases/<用例>/plain.candidate.tsx` 与 `react.candidate.jsx`（已 gitignore）。

## 上下文对照（它是一条自变量，必须和结果一起记）

同一个用例、同一个模型，**给代理多少 Plain 规则文档**会显著影响 Plain 侧的通过率；
不记下来，不同档位的数字之间没法比。三档与 [`eval/tasks/run.mjs`](../run.mjs) **完全一致**，
规则文本也从 `AGENTS.md` 现读现切（规则只有一份，不会出现「文档说 A、喂给代理的是 B」）：

| 档位 | 给代理什么 | 回答的问题 |
| --- | --- | --- |
| `--context task`（默认） | 只有 `task.md` | 代理**完全不了解 Plain** 时的下限 |
| `--context minimal` | `task.md` + `AGENTS.md` §1–2（简介 + 5 条规则） | 只给最核心的规则 |
| `--context full` | `task.md` + §1–3（再加反模式目录） | 文档给全 |

> **为什么只给 Plain 文档、不给 React 文档**：React 是模型已有知识，Plain 不是。
> 所以这一档量的是 **「Plain 要补多少文档才能追上 React」** —— 这个不对称是刻意的，
> 也正是这套对比最想测的东西。无论结果如何，都必须写清用的是哪一档。

## 交给代理的启动提示词（干净跑）

要拿到**有效**结果，代理必须是一个**没读过断言**的新会话（新窗口 / 新 agent）。
先跑一次 `node eval/compare/run.mjs --prompt --context <档位>`，把它的输出（提示词 + 规则上下文）
连同下面这段一起贴给代理：

```text
你在跑 Plain 框架的 AI 正确率对比实验（eval/compare），请严格遵守以下规则。

任务：
  读 eval/compare/cases/*/task.md，为每个用例写两份实现：
    · eval/compare/cases/<用例>/plain.candidate.tsx   ← 用 Plain 的惯用写法
    · eval/compare/cases/<用例>/react.candidate.jsx   ← 用 React 的惯用写法

硬性禁止（违反则实验作废）：
  不要读 cases/*/check.mjs、cases/*/plain.tsx、cases/*/react.jsx，
  也不要读 eval/RESULTS.md 与 eval/compare/README.md。
  只允许读 cases/*/task.md，以及本轮「上下文档位」明确给出的规则文档。

本轮「上下文档位」（只给这一档，由上面的 --prompt 输出提供）：
  〔task〕什么都不给，只有 task.md
  〔minimal〕额外给 AGENTS.md 的 §1–§2（简介 + 5 条规则）
  〔full〕额外给 AGENTS.md 的 §1–§3（再加反模式目录）

流程：
  写完所有实现（8 个用例 × 2 = 16 个文件）后，直接跑
    node eval/compare/run.mjs --context <档位>
  把完整输出贴回来，并声明你用的是哪个档位。
  不要为了对答案去读 check.mjs —— 首次尝试才算数。
```

> **为什么这么严**：一旦代理读了 `check.mjs` 或参考答案，这次数字就**只能当上界**，
> 记进 `RESULTS.md` 时必须标注（见下面的「自欺清单」与 `RESULTS.md` 的效度说明）。
> 更真实的数据是**同一个新会话跑两档**（`task` 与 `full`）—— 那才能看出「补多少文档才追得上」。

## 公平性规则

1. **同一份提示词**：`task.md` 里不出现任何框架名，也不暗示写法（见「反例」）。
2. **各自惯用写法**：React 版必须写成 React 的样子（`useState` / 解构 props / `onChange`），
   不能把 Plain 版翻译过去；Plain 版同理。
3. **同一份断言**：不是「表达同一件事的两份断言」，是**同一份文件**。这条最容易被破坏，也最值钱。
4. **同一个模型、同一批提示词**，记录模型名与版本；不能拿 A 的 Plain 结果比 B 的 React 结果。
5. **两侧都接构建期闸门**（详见下节）：Plain = 契约检查 + 编译；React = eslint。
6. 失败信息要能直接读懂 —— 断言文案要说清「什么行为没发生」。

## 构建期闸门：两侧对称（已落地）

Plain 卖的是「构建期把错误变便宜」。如果 React 侧只做 JSX 转换，那比出来的就是
**「框架带不带闸门」**，而不是「AI 写得更准」，结论会失真。

所以 React 侧已接上 lint（见 [`eslint.react.config.mjs`](eslint.react.config.mjs)），
让两侧都是「写错 → 构建期拦下」：

| Plain 规则 | 对应 React 规则 | 拦得住吗 |
| --- | --- | --- |
| `PLAIN_E1106`（就地改 signal 持有的值） | `@eslint-react/immutability` | ✅ 实测拦住 `items.push(x)`（纯 JSX 即可，无需类型） |
| `PLAIN_E1103`（React 习惯移植） | `react-hooks/rules-of-hooks` | ✅ |
| `PLAIN_E1110`（effect 里同步写状态） | `react-hooks/set-state-in-effect` | ⚠️ 保留为 warn（见下） |
| `PLAIN_E1105` / `E1112`（解构 props / 抓快照） | `react-hooks/immutability`（反应 compiler） | ⚠️ 需类型信息，JS 片段下可能漏报 |
| （Plain 无 deps 数组） | `react-hooks/exhaustive-deps` | ⚠️ 此项**使 React 侧更难**，属不对称 |

**实测记录（2026-10-16）**：同一个「就地改」错误，两侧都被构建期拦下：

| 用例 | Plain 侧写 `items().push(x)` | React 侧写 `items.push(x)` |
| --- | --- | --- |
| `02-list-update` | `PLAIN_E2001`（规则 `PLAIN_E1106`） | `@eslint-react/immutability` |

**已知边界（如实记录，不假装对称）**：

- 官方 `eslint-plugin-react-hooks` 的 `immutability` 是 React Compiler 规则，
  **未接编译器**时对 `items.push(x)` 这类 mutating method **会漏报**（已实测），
  故改用 `@eslint-react/immutability`（独立实现、不需要编译器）作为主闸门，两者并存。
- `react-hooks/set-state-in-effect` 官方默认是 `error`，但它**误伤了本仓的 React 参考实现**
  （`cases/05-async-loading/react.jsx` 里合理的「重置加载态」写法被判为级联渲染风险）。
  闸门只拦「确定错的」、不拦「有争议的」，故降为 `warn`。
- `exhaustive-deps` 是 React 独有负担（Plain 没有 deps 数组）——
  这一项**对 React 不公平**，记录结果时要意识到。
- 候选文件是孤立片段、无项目 tsconfig，类型感知规则的能力弱于真实项目。

开启方式：默认开启（`makeReactApi` 内联调用）。任何 `error` 级诊断都算「被构建期拦下」，
在结果表里以 `REACT_LINT/<规则名>` 呈现，与 Plain 的 `PLAIN_Exxxx` 并列统计。

## 哪些**不可**比（必须承认）

- **服务端边界类**（`eval/tasks/` 里的 `03` / `04` / `07`）在 React 侧没有等价物：
  React 的对应能力是 RSC / Server Actions，机制完全不同，塞进这套 harness 会变成比 RSC 而不是比框架。
  那几条留在 `eval/tasks/` 里，作为 Plain 自己的质量指标。
- 上节列出的闸门**残差**（`exhaustive-deps` 不对称、类型感知弱、`set-state-in-effect` 降级）。
- 只有 8 个用例，样本仍偏小 —— 任何结论都只是**方向性**的，不是统计显著。

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

接上 React 侧闸门后（2026-10-16），第一组**在构建期就被两侧各自拦下**，不再走到断言：

| 用例 | 坏例 | Plain 侧结果 | React 侧结果 |
| --- | --- | --- | --- |
| `02-list-update` | 就地改数组 | `PLAIN_E2001`（规则 `PLAIN_E1106`） | `@eslint-react/immutability` |

> 这正是「构建期闸门对称」的实证：**同一个概念错误，两边都在写代码时被拦下**，
> 而不是等到运行时断言失败。`03` 那组仍走断言（React 侧的
> `useState(title)` 快照检测需要类型信息，纯 JS 片段下漏报）—— 如实记录，不假装。
