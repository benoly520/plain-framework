// 验收断言（AI 看不到这个文件）
//
// 靶子：props 取值方式。
//   1) `const t = props.title`  —— 拿到的是 getter 函数本身，会渲染出函数源码；
//   2) `const t = resolve(props.title)` —— 初次渲染看起来完全正确，**但之后不再更新**（静默失败）；
//   3) `<h2>{props.title}</h2>` —— 忘了 resolve，同样渲染出函数源码。
// 只有「在会重跑的上下文里取值」（如直接在 JSX 里 `resolve(props.title)`）才能同时通过两条断言。
import assert from "node:assert/strict";

export default async function check({ mod, mount }) {
  const { box } = mount();
  box.appendChild(mod.App());
  const h2 = () => box.querySelector("h2");

  assert.ok(h2(), "应渲染出 <h2>");
  assert.equal(
    h2().textContent,
    "Hello",
    "初次渲染应显示真实文本，而不是函数源码"
  );

  mod.rename("Plain");
  assert.equal(
    h2().textContent,
    "Plain",
    "title 变化后 <h2> 必须跟着更新（把 props 取值快照到变量就会停在这里）"
  );

  mod.rename("");
  assert.equal(h2().textContent, "", "再改一次也要跟得上");
}
