# eval —— AI 正确率评测

这个目录存在的理由只有一句话：

> **「Plain 比 React 更适合 AI」目前是一个主张，不是一个数据。**
> 这里把它变成数据。

## 指标定义

| 指标 | 定义 | 为什么是它 |
| --- | --- | --- |
| **首次通过率** | 代理**第一次**提交的实现就通过验收断言的比例 | 直接对应「AI 首次写对」 |
| **平均迭代轮次** | 从提示词到通过，平均需要几轮（含契约检查拦下的轮次） | 对应「自修复成本」；越接近 1 越好 |
| **拦截率** | 失败里有多少是被**构建时**拦下的（而不是运行时才炸） | 衡量「免疫系统」是否通电：被拦下 = 便宜的错误，运行时报错 = 昂贵的错误 |
| **Token 消耗**（可选） | 该任务总 token 数 | 成本对比用 |

传统 DX 指标（满意度、上手时间）**不**在这里。

## 跑法

```bash
pnpm run build                 # eval 跑的是 dist/，必须先构建

node eval/run.mjs --prompt     # 打印所有任务的提示词（把这段给代理）
node eval/run.mjs              # 跑所有 candidate.tsx，输出指标
node eval/run.mjs counter      # 只跑名字含 counter 的任务
node eval/run.mjs --reference  # 跑 reference 实现 —— 自检 harness 本身是否可用，不算指标
```

## 协议（很重要，别绕过）

1. **提示词只给代理 `task.md` 的内容**，不要给 `check.mjs`，也不要给 `reference.tsx`。
2. 代理把实现写到 `eval/tasks/<任务名>/candidate.tsx`。
3. 跑 `node eval/run.mjs`，把结果记进 `RESULTS.md`。
4. **同一个任务不要事后改 `check.mjs`**。如果断言写错了，要把该任务的结果作废重跑，
   并在 `RESULTS.md` 里注明 —— 否则这个数字就没有意义了。
5. 记录轮次：每轮结束在任务目录写 `attempts.json`：
   ```json
   { "attempts": 2, "model": "claude-sonnet-4", "tokens": 1423 }
   ```

## 任务怎么写

- `task.md`：**只写需求**，说清「要什么」和「可外部观测的接口名」，不说「怎么写」。
- 一个好的任务应当测到一条**真实的 AI 失败模式**：如果代理不用某个特性也能蒙对，这个任务就没有价值。
  （比如 `02-keyed-list` 只断言 DOM 节点身份 —— 不写 `key=` 就不可能通过。）
- `check.mjs`：`export default async ({ mod, code, out, mount, tick }) => { ... }`
  - `mod`：编译后模块（组件、状态、导出函数）
  - `code`：客户端产物源码（测「不该出现的东西」用）
  - `out`：`compile()` 的原始返回（含 `serverFunctions` / `map`）
  - `mount()`：返回 `{ box }`，一个干净的挂载容器
  - 断言用 `node:assert/strict`，抛错即失败。
- `reference.tsx`：参考实现，用来自检 harness。**不算指标。**

## 怎么对 React 做基线

同一批 `task.md` 的提示词，给 React 写一套等价的 `task.react.md` + `check.react.mjs`
（断言要表达同一件事，比如 React 版同样断言 DOM 节点身份 → 那就得写 `key`），
放在 `eval/baseline-react/`，用同样的协议跑。

**要注意的公平性问题**（不处理的话结论不可信）：

- 断言必须表达**同一个可观测行为**，不能一边严一边松；
- 两个版本都要用各自框架的**惯用写法**完成任务，不能把 React 版写成 Plain 风格；
- 记录模型与版本；同一个模型跑两边，不能拿 A 模型的 Plain 结果比 B 模型的 React 结果。

## 自欺清单

写这个评测最容易出的三种自欺，出现任何一种，指标就作废：

1. **看完结果再改断言。**
2. **临时调松断言**（比如把 `lis()[1] === a` 改成 `lis()[1].textContent === "a"`）。
3. **只跑通过的任务**，或把「未提供」算进通过率。
