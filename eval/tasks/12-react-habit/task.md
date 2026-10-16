# 任务：待办列表 + 完成数统计

用 Plain 写一个文件，导出：

1. `export const todos`：列表状态，每项是 `{ text, done }`，初始
   `[{ text: "写代码", done: false }, { text: "写测试", done: true }]`。
2. `export function toggle(i)`：翻转第 `i` 项的 `done`。
3. `export function App()`：渲染
   - 一个 `<ul>`，每项一个 `<li>`，文本是该项的 `text`
   - 一个 `<span id="done">`，显示**已完成**的项数

要求：
- 调用 `toggle(i)` 后，`<span id="done">` 里的数字必须**立刻**更新；
- 已完成数必须是**从 `todos` 算出来的**，不要单独再存一份数字状态。

约束：只用 Plain 的 API。
