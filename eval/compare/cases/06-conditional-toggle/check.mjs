// 共用断言：只依赖 DOM，两个框架跑的是同一份代码
import assert from "node:assert/strict";

export default async function check({ render, act, byText }) {
  const { box } = await render("App");

  assert.equal(box.querySelector("p"), null, "初始应不可见（没有 <p>）");

  const show = byText(box, "button", "显示");
  await act(() => show.click());
  const p = box.querySelector("p");
  assert.ok(p, "点击后应出现 <p>");
  assert.match(p.textContent, /现在可见/);

  const hide = byText(box, "button", "隐藏");
  await act(() => hide.click());
  assert.equal(box.querySelector("p"), null, "再次点击应隐藏（<p> 消失）");
}
