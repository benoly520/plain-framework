// 共用断言：只依赖 DOM，两个框架跑的是同一份代码
import assert from "node:assert/strict";

export default async function check({ render, act, type, byText }) {
  const { box } = await render("App");
  const input = box.querySelector("input");
  assert.ok(input, "应有输入框");
  assert.equal(box.querySelectorAll("li").length, 0, "初始列表应为空");

  await act(() => type(input, "苹果"));
  const add = byText(box, "button", "添加");
  await act(() => add.click());

  const items = box.querySelectorAll("li");
  assert.equal(items.length, 1, "应新增一条");
  assert.match(items[0].textContent, /苹果/);
  assert.equal(box.querySelector("input").value, "", "添加后输入框应清空");

  // 再添加一条，验证是「追加」而不是「替换」
  await act(() => type(input, "香蕉"));
  await act(() => add.click());
  const items2 = box.querySelectorAll("li");
  assert.equal(items2.length, 2, "应再追加一条，共 2 条");
  assert.match(items2[1].textContent, /香蕉/);
}
