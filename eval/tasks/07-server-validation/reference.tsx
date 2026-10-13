// 参考实现（用于自检 harness：node eval/run.mjs --reference）
import { server } from "plain";

export const createUser = server(async (user) => {
  const name = user && user.name;
  const age = user && user.age;
  if (typeof name !== "string" || name.trim() === "") {
    return { ok: false, reason: "name 不能为空" };
  }
  if (typeof age !== "number" || Number.isNaN(age) || age < 0) {
    return { ok: false, reason: "age 必须是不小于 0 的数字" };
  }
  return { ok: true };
});
