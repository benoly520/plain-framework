# 任务：加载态（异步副作用）

用 Plain 写一个文件，导出：

1. `export const loading`：布尔状态，初始 `true`。
2. `export function App()`：渲染
   - `loading` 为真时：一个 `<p>`，文本是 `加载中`
   - `loading` 为假时：一个 `<p>`，文本是 `完成`
3. 组件挂载后，用一个**副作用**在约 10ms 后把 `loading` 置为 `false`
   （用 `setTimeout` 模拟异步；**不要**用 async 副作用 —— 副作用是同步的）。

要求：挂载后，界面必须**自动**从 `加载中` 变成 `完成`。
