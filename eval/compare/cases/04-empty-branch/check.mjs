// 共用断言：只依赖 DOM，两个框架跑的是同一份代码
import assert from "node:assert/strict";

export default async function check({ render, act, byText }) {
  const { box } = await render("App");
  const lis = () => Array.from(box.querySelectorAll("li"));
  const ul = () => box.querySelector("ul");
  const emptyTip = () =>
    Array.from(box.querySelectorAll("p")).find((p) => p.textContent.trim() === "空");

  assert.ok(ul(), "初始应渲染出 <ul>");
  assert.equal(lis().length, 2, "初始应有 2 项");
  assert.ok(!emptyTip(), "非空时不应出现「空」提示");

  const btn = byText(box, "button", "删除一个");

  await act(() => btn.click());
  assert.equal(lis().length, 1, "删一次后应剩 1 项");
  assert.ok(ul(), "还有项目时 <ul> 应保留");

  await act(() => btn.click());
  assert.equal(lis().length, 0, "删两次后应清空");
  assert.equal(
    ul(),
    null,
    "<ul> 必须从 DOM 里摘除，而不是隐藏（表现为 querySelector 拿不到）"
  );
  assert.ok(emptyTip(), "清空后应出现「空」提示");

  await act(() => btn.click());
  assert.equal(lis().length, 0, "在空列表上再点击不应出错");
  assert.ok(emptyTip(), "仍然显示「空」");
  assert.equal(ul(), null, "依然不应有 <ul>");
}
