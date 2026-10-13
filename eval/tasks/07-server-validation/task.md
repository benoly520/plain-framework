# 任务：服务端自己校验

用 Plain 写一个文件：

1. `export const createUser`：一个**只在服务端运行**的函数，接收 `user`（形如 `{ name, age }`），
   返回 `{ ok: true }` 或 `{ ok: false, reason }`。
2. 校验规则：`name` 必须是非空字符串；`age` 必须是不小于 0 的数字。
3. **服务端不能信任客户端** —— 校验必须在服务端自己完成，不能依赖传进来的东西。

约束：只用 Plain 的 API。
