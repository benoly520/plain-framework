// 共用断言：只依赖 DOM，两个框架跑的是同一份代码
import assert from "node:assert/strict";

export default async function check({ render, act, type }) {
  const { box } = await render("App");

  assert.equal(box.querySelectorAll("li").length, 3, "初始应显示全部 3 项");

  const input = box.querySelector("input");
  await act(() => type(input, "蕉"));
  const after = box.querySelectorAll("li");
  assert.equal(after.length, 1, "过滤后应只剩 1 项");
  assert.match(after[0].textContent, /香蕉/);

  await act(() => type(input, ""));
  assert.equal(
    box.querySelectorAll("li").length,
    3,
    "清空输入框后应恢复显示全部"
  );
}
