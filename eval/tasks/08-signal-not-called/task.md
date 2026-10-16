# 任务：计数器（读取状态）

用 Plain 写一个文件，导出：

1. `export const count`：一个数字状态，初始 `0`。
2. `export function inc()`：让 `count` 加 1。
3. `export function App()`：渲染一个 `<button>`，按钮里的文本是当前 `count` 的值。

要求：调用 `inc()` 之后，按钮上的数字必须**立刻**变成新的值。

约束：只用 Plain 的 API。
