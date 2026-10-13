# 任务：待办列表（不可变更新 + 关键点）

用 Plain 写一个文件，要求：

1. `export const items`：列表状态，初始
   `[{ id: 1, text: "a" }, { id: 2, text: "b" }]`。
2. `export function toggle(id)`：把对应项的 `done` 取反。
3. `export function prepend(text)`：在**头部**插入一条新项，`id` 自增（可用模块内的计数器）。
4. `export function App()`：渲染 `<ul>`，每行一个 `<li>`，文本是该项的 `text`；
   当该项 `done` 为真时，该 `<li>` 的 class 为 `"done"`。
5. **关键要求**：在头部插入新项之后，**原有列表行对应的 DOM 节点必须保持不变**
   —— 即节点的 DOM 身份要跟着数据走，而不是被重建或被别的数据顶替。

约束：只用 Plain 的 API。
