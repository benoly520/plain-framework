# 任务：渲染用户输入的高亮文本

用 Plain 写一个文件，导出：

1. `export const input`：字符串状态，初始 `"<b>hi</b>"`。
2. `export function App()`：渲染
   - 一个 `<div id="out">`，里面显示 `input` 的**原样文本**（不要把 `<b>` 当成标签解析！）
   - 一个 `<input>`，`value` 绑定 `input`，`onInput` 写回 `input`

要求：`input` 变化时，`<div id="out">` 里的文本要跟着变，
并且**尖括号必须是文本、不能变成真的 HTML 元素**。
