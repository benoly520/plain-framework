// 验收断言（AI 看不到这个文件）
//
// 这个任务只测「跨端边界」这一件事（渲染在别的任务里测），
// 因为它是 Plain 最核心、也最容易被 AI 写错的一条。
import assert from "node:assert/strict";

export default async function check({ code, out }) {
  assert.equal(
    out.serverFunctions.length,
    1,
    "应恰好识别出 1 个服务端函数（说明用了 server()）"
  );
  assert.equal(out.serverFunctions[0].name, "getUser");
  assert.ok(
    out.serverFunctions[0].body.includes("secret-token"),
    "函数体（含字面量）应被搬到服务端清单里"
  );

  assert.ok(code.includes('rpc("getUser"'), "客户端产物里应只剩 RPC 桩");
  assert.ok(
    !code.includes("secret-token"),
    "服务端函数体（含字面量）绝不能出现在客户端产物里"
  );
  assert.ok(
    !code.includes("用户"),
    "连拼接逻辑也不该留在客户端"
  );
}
