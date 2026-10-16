// 验收断言（AI 看不到这个文件）
//
// 靶子：在组件体里把派生值「算一次存下来」——
//   const full = last() + ", " + first();  return <p>{full}</p>;
// 顶层组件体重跑的前提是 effect 依赖被追踪；但把求值结果存成普通变量后，
// 插值绑定的是一个字符串常量，不再跟随 signal 变化。
// 正确做法是让插值表达式本身成为追踪点（写进 JSX 里，或用 computed）。
import assert from "node:assert/strict";

export default async function check({ mod, mount }) {
  const { box } = mount();
  box.appendChild(mod.App());
  const full = () => box.querySelector("#full").textContent.trim();

  assert.equal(full(), "Lovelace, Ada", "初始应为 Lovelace, Ada");

  mod.first.set("Grace");
  assert.equal(
    full(),
    "Lovelace, Grace",
    "改 first 后必须立刻更新（把派生值存成变量会停在旧值）"
  );

  mod.last.set("Hopper");
  assert.equal(full(), "Hopper, Grace", "改 last 后也必须更新");
}
