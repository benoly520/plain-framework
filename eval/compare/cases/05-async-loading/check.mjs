// 共用断言：只依赖 DOM，两个框架跑的是同一份代码
import assert from "node:assert/strict";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default async function check({ render, act, byText }) {
  const { box } = await render("App");

  assert.match(
    box.textContent,
    /加载中/,
    "首次渲染时应处于加载中（还没拿到数据）"
  );

  // 等待请求完成：React 必须包在 act 里才会 flush 异步 state 更新
  await act(async () => {
    await sleep(60);
  });
  assert.match(box.textContent, /数据1/, "第一次请求完成后应显示 数据1");
  assert.ok(!/加载中/.test(box.textContent), "拿到数据后不该还留着「加载中」");

  const btn = byText(box, "button", "重新加载");
  await act(() => btn.click());
  await act(async () => {
    await sleep(60);
  });

  assert.match(
    box.textContent,
    /数据2/,
    "重新加载必须真的再发一次请求（只发一次的实现会停在上一次的数据）"
  );
}
