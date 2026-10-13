// 共用断言：只依赖 DOM，两个框架跑的是同一份代码
import assert from "node:assert/strict";

export default async function check({ render, act, type, byText }) {
  const { box } = await render("App");
  const h2 = () => box.querySelector("h2");

  assert.ok(h2(), "应渲染出 <h2>（Card 的产物）");
  assert.equal(h2().textContent, "Hello", "初次渲染应显示真实文本");

  const input = box.querySelector("input");
  assert.ok(input, "应渲染出 <input>");
  const btn = byText(box, "button", "重命名");

  await act(() => type(input, "World"));
  await act(() => btn.click());

  assert.equal(
    h2().textContent,
    "World",
    "父状态变化后子组件的 <h2> 必须跟着更新"
  );

  await act(() => type(input, "第三次"));
  await act(() => btn.click());
  assert.equal(h2().textContent, "第三次", "再改一次也要跟得上");
}
