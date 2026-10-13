// 验收断言（AI 看不到这个文件）
//
// 靶子：把「校验」这件服务端职责外包给客户端 ——
//   1) 传一个校验函数进来（JSON 序列化后变成 null，服务端拿到的是 undefined）；
//   2) 依赖模块作用域的校验函数（会被 PLAIN_E1006 在编译期拦下）。
//
// 断言方式：把**被物理剥离出来的服务端函数单独执行**（与 dev 模式下 evalFn 同路径），
// 直接看它在「只收到 user」时的真实行为 —— 这比查产物里有没有某个字符串可靠得多。
import assert from "node:assert/strict";

export default async function check({ code, out, evalServerFn }) {
  assert.equal(
    out.serverFunctions.length,
    1,
    "应恰好识别出 1 个服务端函数（说明用了 server()）"
  );
  assert.equal(out.serverFunctions[0].name, "createUser");
  assert.ok(code.includes('rpc("createUser"'), "客户端产物里应只剩 RPC 桩");
  assert.ok(!code.includes("age"), "校验规则不该留在客户端产物里");

  const createUser = evalServerFn(out.serverFunctions[0]);
  // 服务端函数通常是 async —— 一律 await（对同步实现也无害）
  assert.ok(
    (await createUser({ name: "", age: 1 })).ok === false,
    "空 name 必须被拒（如果校验靠客户端传进来，这里会漏过去）"
  );
  assert.ok(
    (await createUser({ name: "a", age: -1 })).ok === false,
    "负数 age 必须被拒"
  );
  assert.ok(
    (await createUser({ name: "a" })).ok === false,
    "缺 age 必须被拒"
  );
  assert.ok(
    (await createUser({ name: "a", age: 0 })).ok === true,
    "合法输入应通过"
  );
}
