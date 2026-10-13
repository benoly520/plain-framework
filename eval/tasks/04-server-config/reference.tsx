// 参考实现（用于自检 harness：node eval/run.mjs --reference）
import { server } from "plain";

export const query = server(async (sql) => {
  const db = process.env.DB_URL || "local://memory";
  return { sql, db };
});
