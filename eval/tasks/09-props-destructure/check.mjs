// 验收断言（AI 看不到这个文件）
//
// 靶子：解构 props —— `const { title } = props`。
// props 是 getter 的集合，解构会拿到「读值那一刻」的结果，丢掉响应性。
// 首次渲染是对的，**第二次更新才暴露** —— 这类静默失败最贵。
import assert from "node:assert/strict";

export default async function check({ mod, mount }) {
  const { box } = mount();
  box.appendChild(mod.App());
  const h2 = () => box.querySelector("h2");
  const btn = () => box.querySelector("button");

  assert.ok(h2(), "应渲染出一个 <h2>");
  assert.equal(h2().textContent.trim(), "Hello", "首次渲染应为 Hello");

  btn().click();
  assert.equal(
    h2().textContent.trim(),
    "World",
    "改父状态后 <h2> 必须跟着更新（解构 props 会让它停在 Hello）"
  );
}
