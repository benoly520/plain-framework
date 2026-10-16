# 任务：带 props 的卡片

用 Plain 写一个文件，导出两个东西：

1. `export function Card(props)`：接收一个 `title` prop，渲染一个 `<h2>`，文本就是 `title`。
2. `export function App()`：持有 `title` 状态（初始 `"Hello"`），并渲染一张 `<Card>`；
   另外渲染一个 `<button>`（文本 `重命名`），点击后把 `title` 改成 `"World"`。

要求：点击按钮后，`<Card>` 里的 `<h2>` 文本必须跟着变成 `World`。
