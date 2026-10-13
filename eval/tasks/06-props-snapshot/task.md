# 任务：会变的外部输入

用 Plain 写一个文件：

1. `export const title`：字符串状态，初始 `"Hello"`。
2. `export function rename(next)`：把 `title` 改成 `next`。
3. `export function Card(props)`：接收一个 `title`，渲染 `<h2>` 显示它。
4. `export function App()`：使用 `<Card title={title()} />`。

要求：调用 `rename` 之后，`<h2>` 里的文字必须**立刻**变成新值。
