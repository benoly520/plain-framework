# 任务：服务端读配置

用 Plain 写一个文件，要求：

1. 数据库地址取自环境变量 `DB_URL`；读不到时回落到 `"local://memory"`。
2. `export const query`：一个**只在服务端运行**的函数，接收 `sql`，
   返回 `{ sql, db: <数据库地址> }`。
3. 客户端产物里**不得出现** `DB_URL` / `process.env`，
   也不得残留任何环境变量读取逻辑。

约束：只用 Plain 的 API。
