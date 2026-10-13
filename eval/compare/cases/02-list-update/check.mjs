// 共用断言：只依赖 DOM，两个框架跑的是同一份代码
import assert from "node:assert/strict";

export default async function check({ render, act, type, byText }) {
  const { box } = await render("App");
  const lis = () => Array.from(box.querySelectorAll("li"));
  const texts = () => lis().map((li) => li.textContent);
  const countText = () => box.querySelector("p").textContent;

  assert.equal(lis().length, 2, "初始应有 2 项");
  assert.deepEqual(texts(), ["a", "b"], "初始内容应为 a / b");
  assert.match(countText(), /2/, "初始项数应为 2");

  const input = box.querySelector("input");
  assert.ok(input, "应渲染出 <input>");
  const add = byText(box, "button", "添加");

  await act(() => type(input, "c"));
  await act(() => add.click());

  assert.equal(lis().length, 3, "添加后应立刻变成 3 项");
  assert.deepEqual(texts(), ["a", "b", "c"], "新项应追加到末尾");
  assert.match(countText(), /3/, "项数要跟着更新");
  assert.equal(input.value, "", "提交后输入框应清空");

  const removeLast = byText(box, "button", "删除末尾");
  await act(() => removeLast.click());

  assert.equal(lis().length, 2, "删除末尾后应回到 2 项");
  assert.deepEqual(texts(), ["a", "b"], "剩下的应是 a / b");
  assert.match(countText(), /2/, "项数要跟着更新");
}
