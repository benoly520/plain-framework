# 任务：计数器（状态 + 派生值 + 事件）

用 Plain 写一个文件，要求：

1. `export const count`：计数状态，初始值 `0`，外部可读可写。
2. `export const doubled`：派生值，等于 `count` 的两倍。
3. `export function App()`：渲染**一个 `<button>`**，其文本形如 `点我 0（翻倍 0）`。
4. 点击按钮时 `count` 加 1，按钮文本**立刻**同步更新。

约束：只用 Plain 的 API，不要引入其它框架。
