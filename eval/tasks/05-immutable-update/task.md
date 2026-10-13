# 任务：列表增删（状态更新）

用 Plain 写一个文件：

1. `export const items`：列表状态，初始 `["a", "b"]`。
2. `export function add(text)`：把 `text` 追加到列表末尾。
3. `export function removeLast()`：删掉最后一项。
4. `export function App()`：渲染 `<ul>`（每项一个 `<li>`）和一个 `<span>`，`<span>` 里显示当前项数。

要求：调用 `add` / `removeLast` 之后，页面必须**立刻**反映最新状态。

约束：只用 Plain 的 API。
