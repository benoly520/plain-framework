// 参考实现（用于自检 harness：node eval/run.mjs --reference）
import { server } from "plain";

export const getUser = server(async (id) => {
  return { id, name: "用户" + id, token: "secret-token" };
});
