// 共用断言：只依赖 DOM，两个框架跑的是同一份代码
import assert from "node:assert/strict";

export default async function check({ render, act, byText }) {
  const { box } = await render("App");
  const p = () => box.querySelector("p");

  assert.ok(p(), "应渲染出 <p>");
  assert.match(p().textContent, /计数\s*0/, "初始计数应为 0");
  assert.match(p().textContent, /两倍\s*0/, "初始派生值应为 0");

  const btn = byText(box, "button", "加一");
  await act(() => btn.click());

  assert.match(p().textContent, /计数\s*1/, "点击后计数应为 1");
  assert.match(p().textContent, /两倍\s*2/, "点击后派生值应为 2");

  await act(() => btn.click());
  assert.match(p().textContent, /计数\s*2/, "再点一次计数应为 2");
  assert.match(p().textContent, /两倍\s*4/, "再点一次派生值应为 4");
}
