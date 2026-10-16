# 任务：带格式的用户名显示

用 Plain 写一个文件，导出：

1. `export const first`：字符串状态，初始 `"Ada"`。
2. `export const last`：字符串状态，初始 `"Lovelace"`。
3. `export function App()`：渲染一个 `<p id="full">`，文本是 `姓, 名` 的格式，
   即 `Lovelace, Ada`（逗号+空格分隔，顺序是「姓」在前）。

要求：当 `first` 或 `last` 任一变化时，`<p id="full">` 必须**立刻**跟着变。

约束：只用 Plain 的 API。
