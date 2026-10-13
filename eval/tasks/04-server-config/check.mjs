// 验收断言（AI 看不到这个文件）
//
// 这个任务测的是「服务端配置怎么读」这个高频坑：
// 直觉写法是在模块作用域读一次环境变量再被 server() 引用 —— 但那样
//   1) 环境变量读取逻辑会留在客户端产物里（泄漏配置面），
//   2) 且闭包不会跟到服务端（PLAIN_E1006）。
import assert from "node:assert/strict";

export default async function check({ code, out }) {
  assert.equal(
    out.serverFunctions.length,
    1,
    "应恰好识别出 1 个服务端函数（说明用了 server()）"
  );
  assert.equal(out.serverFunctions[0].name, "query");
  assert.ok(
    out.serverFunctions[0].body.includes("DB_URL"),
    "环境变量应在 server() 的函数体内部读取"
  );

  assert.ok(code.includes('rpc("query"'), "客户端产物里应只剩 RPC 桩");
  assert.ok(!code.includes("DB_URL"), "客户端产物里不得出现 DB_URL");
  assert.ok(!code.includes("process.env"), "客户端产物里不得出现 process.env");
}
