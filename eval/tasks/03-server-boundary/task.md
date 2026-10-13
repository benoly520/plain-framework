# 任务：服务端边界

用 Plain 写一个文件，要求：

1. `export const getUser`：一个函数，接收 `id`，返回
   `{ id, name: "用户" + id, token: "secret-token" }`。
2. 这个函数**只在服务端运行**：它的函数体（尤其是 `"secret-token"` 这个字面量）
   **绝不能出现在客户端产物里**。

约束：只用 Plain 的 API，不要自己写 fetch / 手搓接口。
