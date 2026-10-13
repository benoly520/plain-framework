# 评测结果

> 协议与公平性要求见 [README.md](README.md)。**不要事后改断言**。

## 2026-10-13 · harness 自检（不算指标）

用 `reference.tsx` 跑通全部任务，并**故意**用坏实现验证 harness 能区分对错：

| 任务 | reference | 故意写坏的实现 | 坏例在哪一层被拦 |
| --- | --- | --- | --- |
| `01-counter` | 通过 | `count = 1` + `{count}` 未调用 | 构建期 `PLAIN_E2001` |
| `02-keyed-list` | 通过 | 不写 `key=` | 断言（DOM 节点身份） |
| `03-server-boundary` | 通过 | （未测坏例） | — |
| `04-server-config` | 通过 | 模块作用域读 env 再被 `server()` 引用 | 构建期 `PLAIN_E1006` |
| `05-immutable-update` | 通过 | `items().push(text)` / `items().pop()` | 断言（DOM 不更新） |
| `06-props-snapshot` | 通过 | `const t = resolve(props.title)` | 断言（**改第二次才暴露**） |
| `07-server-validation` | 通过 | 把校验函数当参数传进来 | 断言（服务端收到 `undefined`） |

三个坏例值得单独说明：

- `04` 的错法同时踩两个坑（配置读取逻辑留在客户端 + 闭包不跟到服务端），**构建期**就被拦下；
- `05` 的就地改完全不报错、不告警，signal 用 `Object.is` 比较所以 DOM 原地不动；
- `06` 的错法**初次渲染完全正确**，只有第二次改动才暴露 —— 这是最贵的一类静默失败，也是
  `07` 之前唯一能测到「更新路径」的任务。

结论：

- harness 可用，能区分「构建期被拦下」与「运行时才错」；
- 拦截率指标已接进 `run.mjs`（失败中被构建期拦下的比例 —— 越高说明错误越便宜）。
  上面这批坏例的拦截率是 **2 / 6**：也就是说这几个 AI 高频错误里，多数仍要等到运行时/断言才暴露。

## 2026-10-13 · 新增规则后复核上面这批坏例（不是新实验，只是重跑旧坏例）

不新增任务、不改断言，只把上面那批「故意写坏」的实现再跑一遍，看闸门有没有变强：

| 任务 | 坏例 | 之前在哪一层被拦 | 现在 | 拦它的规则 |
| --- | --- | --- | --- | --- |
| `01-counter` | `count = 1` + `{count}` | 构建期 `PLAIN_E2001` | 构建期 | `plain/signal-assign` / `signal-not-called` |
| `02-keyed-list` | 不写 `key=` | 断言 | 断言（不变） | —（key 复用是运行时节点身份，拦不了） |
| `04-server-config` | 模块作用域读 env 再被 `server()` 引用 | 构建期 `PLAIN_E1006` | 构建期 | `PLAIN_E1006` |
| `05-immutable-update` | `items().push(text)` / `items().pop()` | 断言（DOM 不更新） | **构建期** | `plain/no-signal-mutate` |
| `06-props-snapshot` | `const t = resolve(props.title)` | 断言（改第二次才暴露） | **构建期** | `plain/no-props-snapshot` |
| `07-server-validation` | 把校验函数当参数传进来 | 断言（服务端收到 `undefined`） | **构建期** | `PLAIN_E1007` |

坏例拦截率：**2 / 6 → 5 / 6**。剩下的 `02` 属于「行为在运行时才可观测」（DOM 节点身份），
编译期没有对应的静态事实可判，只能留在断言里。

## 2026-10-13 · 对比 harness 自检（不算指标）

Plain vs React 的对称对比（见 [compare/README.md](compare/README.md)）：
3 个用例、两个框架、**同一份断言**，reference 实现均 3/3 通过。

再用「各自惯用但错」的实现验证对称性 —— 两边的错法被**同一行断言**抓住：

| 用例 | Plain 的错法 | React 的错法 | 共同的失败断言 |
| --- | --- | --- | --- |
| `02-list-update` | `items().push(text)` | `items.push(text)` 后不 `setState` | `添加后应立刻变成 3 项` |
| `03-props-update` | `const t = resolve(props.title)` | `const [t] = useState(title)` | `父状态变化后子组件的 <h2> 必须跟着更新` |

这两组是**同一个概念错误的两种方言**（就地改 / 派生状态快照），说明这套对比测的是行为本身，
而不是某一方的实现细节。

## 真实实验结果（`eval/tasks/`，Plain 自己的质量指标）

（还没有。跑法：`node eval/run.mjs --prompt [--context …]` 把提示词给代理 →
实现写入 `candidate.tsx` → 跑 `node eval/run.mjs` → 把结果补到下面。
**上下文档位必须记下来**，否则三次跑的数字没法比 —— 见 [README.md](README.md)「上下文对照」。）

| 日期 | 模型 | 上下文 | 任务数 | 首次通过率 | 平均轮次 | 拦截率 | 备注 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| — | — | — | — | — | — | — | — |

## 真实对比结果（`eval/compare/`，Plain vs React）

（还没有。跑法：`node eval/compare/run.mjs --prompt` → 两边各写一份实现 → 跑 `node eval/compare/run.mjs`）

**同一个模型、同一批提示词**，两侧都要记录；「被构建期拦下」要单独记（Plain 的闸门是产品的一部分，
React 侧默认没有等价闸门 —— 见 `compare/README.md` 的公平性说明）。

| 日期 | 模型 | 用例数 | Plain 首次通过率 | React 首次通过率 | Plain 构建期拦下 | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| — | — | — | — | — | — | — |

## 发现的反模式（重要产出）

这个评测的副产品比数字更有用：代理**踩过的坑**要回填到 [`AGENTS.md`](../AGENTS.md) 第 3 节。

| 日期 | 任务 | 踩的坑 | 是否已加静态检查 |
| --- | --- | --- | --- |
| — | — | — | — |
